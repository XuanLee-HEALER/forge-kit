import { matchesReleasePr } from "../ledger/delivery-tools";
import { type WorkbenchConfig } from "../config";
import { locateRepo, runGit } from "../git";
import { type ApprovedRunbookEntry } from "./runbook-state";
import { resolve } from "node:path";
import { matchesPinnedMerge, parseGhApi, readOnlyGraphql, extractGhPrSubcommand, parseGhPrMergeTarget, repoOrigin } from "../shared/gh-remote";
import {
  effectivePushRepo,
  evaluateFollowTagsSetting,
  extractCommandPositionGit,
  extractGitSubcommand,
  getCanonicalGitCommonDir,
  isFollowTagsEffective,
  isImplicitPushAmbiguous,
  parseGitPushArgs,
  parseGitTagCreation,
  resolveGitDirFlags,
} from "../shared/git-cmd";
import {
  expandEnvSplitStrings,
  hasOnlyAndSeparators,
  hasPrecedingDynamicCd,
  hasShellExpansion,
  hasUnquotedRedirect,
  isSimpleLiteralCdSegment,
  resolveSegmentCwd,
  splitShellSegments,
  splitShellTokens,
  splitShellTokensWithMeta,
  unwrapShellPrefix,
} from "../shared/shell";

export function parseDeliverySegment(toks: string[]) {
  const prefix = unwrapShellPrefix(toks);
  const words = prefix.ambiguous ? expandEnvSplitStrings(toks) : toks;
  return { prefix, git: extractGitSubcommand(words), gh: extractGhPrSubcommand(words, prefix) };
}

export function isApprovedTagPushRefspec(params: {
  workbenchRoot: string;
  targetDir: string;
  refspec: string;
  isForce: boolean;
  isDelete: boolean;
  approvedRunbooks: ApprovedRunbookEntry[];
  cmd?: string;
  segments?: string[];
  segmentIndex?: number;
  toolWorkdir?: string;
  pushSegmentTokens: string[];
}): boolean {
  const { workbenchRoot, targetDir, refspec, isForce, isDelete, approvedRunbooks,
    cmd, segments, segmentIndex, toolWorkdir, pushSegmentTokens } = params;
  if (isForce || isDelete || approvedRunbooks.length === 0) return false;
  if (refspec.startsWith("+") || refspec.startsWith(":")) return false;
  const parts = refspec.split(":");
  if (parts.length > 2) return false;
  const srcRef = parts[0];
  const dstRef = parts.length === 2 ? parts[1] : parts[0];
  if (!srcRef || !dstRef) return false;
  const cleanSrc = srcRef.replace(/^refs\/tags\//, "");
  const cleanDst = dstRef.replace(/^refs\/tags\//, "");
  if (cleanSrc !== cleanDst) return false;

  const loc = locateRepo(workbenchRoot, targetDir);
  if (!loc) return false;

  const push = extractCommandPositionGit(pushSegmentTokens);
  if (!push || push.subcmd !== "push" || parseGitPushArgs(push.subArgs).hasPrune) return false;
  if (isFollowTagsEffective(push.subArgs, push.configs, loc.checkoutDir)) return false;

  const { remote } = parseGitPushArgs(push.subArgs);
  if (!remote) return false;
  const pushId = effectivePushRepo(loc.checkoutDir, remote, push.configs);
  const originId = repoOrigin(loc.checkoutDir);
  if (!originId || !pushId || pushId.host !== originId.host ||
      pushId.owner !== originId.owner || pushId.repo !== originId.repo) return false;

  const pushCommonDir = getCanonicalGitCommonDir(loc.checkoutDir);
  if (!pushCommonDir) return false;

  // Multi-segment command handling: ONLY permit strictly `&&`-chained optional literal `cd`
  // segments and at most ONE command-position `git tag` creating `cleanDst` in the same repo
  // (resolved in the creating worktree!). Any other preceding command fails closed so neither
  // `echo git tag ...` nor `git branch -f ...` can forge or drift the target commit!
  let pendingTagTargetRef: string | null = null;
  let pendingTagCheckoutDir: string | null = null;
  let sawPrecedingTagTouch = false;
  if (segments && segmentIndex !== undefined && segmentIndex > 0 && toolWorkdir) {
    if (!cmd || !hasOnlyAndSeparators(cmd)) return false;
    for (let k = 0; k < segmentIndex; k++) {
      const seg = segments[k];
      if (isSimpleLiteralCdSegment(seg)) continue;
      if (hasUnquotedRedirect(seg, ">") || hasUnquotedRedirect(seg, "<")) return false;
      if (seg.includes("$(") || seg.includes("`")) return false;
      const prevToks = splitShellTokens(seg);
      if (!prevToks) return false;
      const prevGit = extractCommandPositionGit(prevToks);
      if (!prevGit || prevGit.subcmd !== "tag") return false;
      if (sawPrecedingTagTouch) return false; // At most ONE preceding `git tag`
      if (prevGit.gitDirFlags.some((f) => hasShellExpansion(f))) return false;
      const prevCwd = resolveSegmentCwd(segments, k, toolWorkdir);
      const prevTargetDir = resolveGitDirFlags(prevCwd, prevGit.gitDirFlags, true);
      if (!prevTargetDir) return false;
      const prevLoc = locateRepo(workbenchRoot, prevTargetDir);
      if (!prevLoc) return false;
      const prevCommonDir = getCanonicalGitCommonDir(prevLoc.checkoutDir);
      if (!prevCommonDir || prevCommonDir !== pushCommonDir) return false;
      const parsedTag = parseGitTagCreation(prevGit.subArgs);
      if (!parsedTag || parsedTag.tagName !== cleanDst) return false;
      if (hasShellExpansion(parsedTag.targetRef)) return false;
      sawPrecedingTagTouch = true;
      pendingTagTargetRef = parsedTag.targetRef;
      pendingTagCheckoutDir = prevLoc.checkoutDir;
    }
  }

  let liveTagCommit: string;
  if (sawPrecedingTagTouch) {
    if (!pendingTagTargetRef || !pendingTagCheckoutDir) return false;
    // Resolve the target ref strictly inside the creating checkout (NOT the push worktree!)
    const targetRev = runGit(
      pendingTagCheckoutDir,
      ["rev-parse", "--verify", `${pendingTagTargetRef}^{commit}`],
      3000,
    );
    if (targetRev.code !== 0 || !targetRev.stdout.trim()) return false;
    liveTagCommit = targetRev.stdout.trim().toLowerCase();
  } else {
    const tagRev = runGit(
      loc.checkoutDir,
      ["rev-parse", "--verify", `refs/tags/${cleanDst}^{commit}`],
      3000,
    );
    if (tagRev.code !== 0 || !tagRev.stdout.trim()) return false;
    liveTagCommit = tagRev.stdout.trim().toLowerCase();
  }

  for (const rb of approvedRunbooks) {
    for (const entry of rb.actions.tags) {
      if (entry.repo.toLowerCase() !== loc.repo.toLowerCase()) continue;
      if (entry.tag !== cleanDst) continue;
      const expectedSha = entry.sha.toLowerCase();
      if (liveTagCommit === expectedSha) return true;
      const expectedRev = runGit(loc.checkoutDir, ["rev-parse", "--verify", `${expectedSha}^{commit}`], 3000);
      if (expectedRev.code === 0 && expectedRev.stdout.trim().toLowerCase() === liveTagCommit) {
        return true;
      }
    }
  }
  return false;
}

export function checkGitPhysicalFuse(
  workbenchRoot: string,
  cmd: string,
  toolWorkdir: string,
  cfg: WorkbenchConfig,
  approvedRunbooks: ApprovedRunbookEntry[] = [],
): string | null {
  const segments = splitShellSegments(cmd);
  const tagRegexes = cfg.guard.prod_tag_patterns.map((p) => new RegExp(p));
  const protectedBranches = new Set(cfg.guard.protected_branches);

  for (let i = 0; i < segments.length; i++) {
    const toks = splitShellTokens(segments[i]);
    if (!toks || toks.length === 0) continue;

    // gh pr merge fuse (allowed ONLY when exact repo + PR number is in an active approved Runbook)
    const { prefix, gh, git } = parseDeliverySegment(toks);
    if (prefix.bin === "gh" && prefix.args.includes("api")) {
      const api = parseGhApi(prefix.args.slice(prefix.args.indexOf("api") + 1));
      if (!api) return "安全护栏：无法确认 gh api 的请求参数。";
      const { endpoint, method, fields, body } = api;
      let pathname: string;
      try {
        pathname = decodeURIComponent(new URL(endpoint, "https://api.github.com/").pathname);
      } catch {
        return "安全护栏：无法解析 gh api 请求路径。";
      }
      const resource = pathname.replace(/\/{2,}/g, "/").replace(/^\/api\/v3\//i, "/")
        .replace(/^\/repos\/[^/]+\/[^/]+\//i, "/").replace(/^\//, "");
      const sensitive = /^(?:pulls|git\/refs|merges|releases)(?:[/?#]|$)/i.test(resource);
      if (/(?:^|\/)graphql\/?$/i.test(pathname)) {
        const queries = fields.filter(f => f.startsWith("query="));
        const query = queries[0]?.slice(6) ?? "";
        if (body || endpoint.includes("?") || splitShellTokensWithMeta(segments[i])?.some(t => t.hasExpansion && t.value.includes("query=")) || queries.length !== 1 || !readOnlyGraphql(query) || fields.some(f =>
            !/^[A-Za-z_]\w*(?:\[(?:[A-Za-z_]\w*)?\])*=/.test(f) || f.startsWith("query["))) {
          return "安全护栏：GraphQL 请求必须包含可核验的显式只读 query。";
        }
      }
      const effectiveMethod = (method || (fields.length || body ? "POST" : "GET")).toUpperCase();
      const writes = effectiveMethod !== "GET" && effectiveMethod !== "HEAD";
      if (sensitive && writes) {
        return "安全护栏：禁止通过 gh api 合并 PR 或修改发布资源。";
      }
    }
    if (git?.subcmd === "push" || git?.subcmd === "commit" || gh?.subcmd === "merge" || gh?.subcmd === "create" || gh?.subcmd === "new") {
      if (prefix.ambiguous) return "物理保险丝：无法解析 env 交付命令。";
      if (prefix.dirs.some(hasShellExpansion)) return "物理保险丝：检测到未展开的 shell 变量路径。";
    }
    if (gh?.subcmd === "merge") {
      if (approvedRunbooks.length && prefix.bin === "gh" && !hasPrecedingDynamicCd(segments, i)) {
        const cwd = resolveSegmentCwd(segments, i, toolWorkdir);
        const dir = resolveGitDirFlags(cwd, prefix.dirs, true);
        if (!dir) return "物理保险丝：无法解析 env 工作目录。";
        const loc = locateRepo(workbenchRoot, dir);
        const target = parseGhPrMergeTarget(gh.subArgs, loc?.checkoutDir ?? null, gh.prefix.effective, dir);
        if (
          target &&
          approvedRunbooks.some((rb) =>
            rb.actions.prs.some((p) => {
              if (p.number !== target.number || (p.pin && !(matchesPinnedMerge(gh.subArgs, p.pin) && matchesReleasePr(resolve(workbenchRoot, p.repo), p.pin)))) return false;
              const local = loc?.repo.toLowerCase() === p.repo.toLowerCase();
              if (!target.owner) return local;
              const origin = repoOrigin(local && loc ? loc.checkoutDir : resolve(workbenchRoot, p.repo));
              return origin?.repo === target.repo && origin.owner === target.owner &&
                (!target.host || origin.host === target.host);
            }),
          )
        ) {
          continue;
        }
      }
      return "物理保险丝：禁止 Agent 直接执行 `gh pr merge`，请由用户合并 PR 或先创建 Runbook 经用户回复「批准 <runbook_id>」后执行。";
    }
    if (!git) continue;

    // Shared worktree destructive operations
    if (cfg.guard.block_shared_worktree_ops) {
      if (git.subcmd === "stash") {
        // Allow strictly read-only `git stash list` and `git stash show`
        const firstArg = git.subArgs.find((a) => !a.startsWith("-")) ?? "";
        if (firstArg !== "list" && firstArg !== "show") {
          return "物理保险丝（共享工作树）：禁止写入型 `git stash`，工作树可能存在用户未提交改动。";
        }
      }
      if (git.subcmd === "restore") {
        return "物理保险丝（共享工作树）：禁止 `git restore`，工作树可能存在用户未提交改动。";
      }
      if (git.subcmd === "reset") {
        return "物理保险丝（共享工作树）：禁止 `git reset`，工作树可能存在用户未提交改动。";
      }
      if (git.subcmd === "clean" && git.subArgs.some((a) => /^-[a-z]*f/.test(a) || a === "--force")) {
        return "物理保险丝（共享工作树）：禁止 `git clean -f`。";
      }
      if (git.subcmd === "checkout" && git.subArgs.includes("--")) {
        return "物理保险丝（共享工作树）：禁止 `git checkout -- <path>` 丢弃工作区改动。";
      }
      if (git.subcmd === "commit" && git.subArgs.includes("--amend")) {
        return "物理保险丝（共享工作树）：禁止 `git commit --amend`。";
      }
      if (
        git.subcmd === "add" &&
        git.subArgs.some(
          (a) => a === "-A" || a === "--all" || a === "." || a === "./" || a === "-u" || a === "--update",
        )
      ) {
        return "物理保险丝（共享工作树）：禁止 `git add -A / . / -u`，请逐文件 `git add <file>` 并带 pathspec 提交。";
      }
    }

    // git push fuse: tags / force / direct push to main (explicit OR implicit current branch)
    if (git.subcmd === "push") {
      const args = git.subArgs;
      const parsedPush = parseGitPushArgs(args);
      if (parsedPush.hasTags) {
        return "物理保险丝：禁止批量推送全部 tag（`git push --tags`），请显式推送经 Runbook 批准的单个发版 tag。";
      }
      const isForce = parsedPush.isForce;
      const isDelete = parsedPush.isDelete;
      if (parsedPush.hasAllOrMirror) {
        return "物理保险丝：禁止 `git push --all` / `--branches` / `--mirror` 或批量 refspec，请显式指定要推送的单一分支。";
      }
      const { refspecs } = parsedPush;
      const segCwd = resolveSegmentCwd(segments, i, toolWorkdir);
      const dynamicTarget =
        hasPrecedingDynamicCd(segments, i) || git.gitDirFlags.some((f) => hasShellExpansion(f));
      const effectiveCwd = resolveGitDirFlags(segCwd, prefix.dirs, true);
      if (!effectiveCwd) return "物理保险丝：无法解析 env 工作目录。";
      const targetDir = dynamicTarget ? null : resolveGitDirFlags(effectiveCwd, git.gitDirFlags, true);
      // Unconditionally reject unresolved repository/config overrides (`GIT_*=` env vars or `--git-dir`/`--work-tree`/`--config-env`)
      // on git push so neither checkout identity nor effective push.followTags can diverge from what guard inspected!
      const hasLeadingGitEnvOverride = toks
        .slice(0, git.gitIdx)
        .some((t) => /^GIT_[A-Za-z0-9_]*=/.test(t));
      if (hasLeadingGitEnvOverride || git.hasUnsafeGlobalOverride) {
        return "物理保险丝：检测到命令行 GIT_* 环境变量或 --git-dir/--work-tree/--config-env 覆盖，禁止用于 git push，请直接用字面路径与 `-C` 执行。";
      }
      const followTagsState = evaluateFollowTagsSetting(args, git.configs, targetDir);
      if (
        followTagsState === "cli_true" ||
        followTagsState === "inline_true" ||
        followTagsState === "repo_true"
      ) {
        return "物理保险丝：检测到 --follow-tags 或 push.followTags=true，禁止隐式附带推送 tag，请显式传入 --no-follow-tags 或单独推送经 Runbook 批准的 tag。";
      }
      if (followTagsState === "unknown" && (!cfg.ledger.enabled || cfg.repos.length === 0)) {
        return "物理保险丝：无法解析目标仓库路径以核验 push.followTags 配置，请改用明确字面路径或显式传入 --no-follow-tags。";
      }
      for (const refspec of refspecs) {
        const rhs = (refspec.includes(":") ? refspec.split(":").pop() ?? "" : refspec).replace(/^\+/, "");
        if (rhs === "HEAD" || rhs === "@") {
          const branch = targetDir && !refspec.includes(":")
            ? runGit(targetDir, ["symbolic-ref", "--quiet", "--short", "HEAD"], 3000).stdout.trimEnd() : "";
          if (!branch || protectedBranches.has(branch)) return "物理保险丝：禁止通过 HEAD 直接推送到受保护主分支或未确定的目标。";
        }
        const cleanRef = rhs.replace(/^refs\/(heads|tags)\//, "");
        if (refspec.startsWith("refs/tags/") || tagRegexes.some((re) => re.test(cleanRef))) {
          if (
            !dynamicTarget &&
            targetDir !== null &&
            !hasShellExpansion(refspec) &&
            isApprovedTagPushRefspec({
              workbenchRoot,
              targetDir,
              refspec,
              isForce,
              isDelete,
              approvedRunbooks,
              cmd,
              segments,
              segmentIndex: i,
              toolWorkdir,
              pushSegmentTokens: toks,
            })
          ) {
            continue;
          }
          return `物理保险丝：禁止未批准推送生产发布 tag (${refspec})，请先用 \`ledger runbook create\` 生成发版单并经用户在对话中回复「批准 <runbook_id>」后再推送。`;
        }
        if (protectedBranches.has(cleanRef)) {
          return `物理保险丝：禁止直接推送到受保护主分支 (${cleanRef})，请提 PR 由用户合并。`;
        }
      }
      // Implicit push (`git push` or `git push origin`) -> inspect current checkout branch
      if (targetDir) {
        const reason = isImplicitPushAmbiguous(parsedPush, git.configs, targetDir, protectedBranches);
        if (reason) return `物理保险丝：${reason}`;
      }
      if (!refspecs.length && targetDir) {
        const loc = locateRepo(workbenchRoot, targetDir);
        if (loc && protectedBranches.has(loc.branch)) {
          return `物理保险丝：当前位于受保护主分支 (${loc.branch})，禁止隐式直接推送，请提 PR 由用户合并。`;
        }
      }
      if (isForce && refspecs.length === 0) {
        return "物理保险丝：禁止无显式目标分支的强推 (`git push --force`)。";
      }
    }
  }
  return null;
}
