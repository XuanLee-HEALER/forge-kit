import { type WorkbenchConfig } from "../config";
import { getBranchDiffStats, getHeadAndParents, getStagedDiffStats, locateRepo, runGit } from "../git";
import { isApprovedTagPushRefspec, parseDeliverySegment } from "./git-gh";
import { type ApprovedRunbookEntry } from "./runbook-state";
import { getSpecState } from "../ledger/spec";
import { handedOffBranches, handedOffOwner, Ledger } from "../ledger/store";
import { join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { usesV05 } from "../ledger/types";
import {
  ghDefaultMatchesOrigin,
  parseGhPrCreateArgs,
  parseGhRepoSpec,
  parseGitRemoteRepo,
  qualifyGhRepoSpec,
} from "../shared/gh-remote";
import { isImplicitPushAmbiguous, parseGitPushArgs, resolveGitDirFlags } from "../shared/git-cmd";
import { matchesGlob } from "../shared/path";
import {
  hasPrecedingDynamicCd,
  hasShellExpansion,
  resolveSegmentCwd,
  splitShellSegments,
  splitShellTokens,
} from "../shared/shell";
function evaluateDiffExemptEligibility(
  stats: { files: string[]; changedLines: number },
  cfg: WorkbenchConfig,
): { eligible: boolean; files: string[]; changedLines: number; reason?: string } {
  const rules = cfg.ledger;
  let reason: string | undefined;
  if (stats.files.length > rules.exempt_max_files) reason = "改动文件数超出豁免上限";
  else if (stats.changedLines > rules.exempt_max_lines) reason = "改动行数超出豁免上限";
  else {
    const protectedFile = stats.files.find(f => rules.protected_code_globs.some(g => matchesGlob(f, g)));
    const outside = stats.files.find(f => rules.exempt_allowed_globs.length && !rules.exempt_allowed_globs.some(g => matchesGlob(f, g)));
    if (protectedFile) reason = "涉及受保护业务代码文件 " + protectedFile;
    else if (outside) reason = "不在允许免账本范围 " + outside;
  }
  return { ...stats, eligible: !reason, reason };
}
function pathBelongsToRegisteredRepo(
  workbenchRoot: string,
  targetDir: string,
  registeredRepos: Set<string>,
): string | null {
  const abs = resolve(targetDir);
  for (const r of registeredRepos) {
    const repoPath = resolve(workbenchRoot, r);
    const wtRoot = resolve(workbenchRoot, `${r}.worktrees`);
    if (
      abs === repoPath ||
      abs.startsWith(repoPath + "/") ||
      abs === wtRoot ||
      abs.startsWith(wtRoot + "/")
    ) {
      return r;
    }
  }
  return null;
}
export function checkLedgerGate(
  workbenchRoot: string,
  cmd: string,
  toolWorkdir: string,
  cfg: WorkbenchConfig,
  approvedRunbooks: ApprovedRunbookEntry[] = [],
): string | null {
  if (!cfg.ledger.enabled) return null;
  const registeredRepos = new Set(cfg.repos);
  if (registeredRepos.size === 0) return null;
  const lockPath = join(workbenchRoot, ".workbench", "kit-lock.json");
  const currentInstall = existsSync(lockPath) &&
    /^0\.5(?:\.|$)/.test(JSON.parse(readFileSync(lockPath, "utf8")).kit_version ?? "");
  const segments = splitShellSegments(cmd);
  let ledger: Ledger | null = null;
  try {
    for (let i = 0; i < segments.length; i++) {
      const toks = splitShellTokens(segments[i]);
      if (!toks || toks.length === 0) continue;
      const segCwd = resolveSegmentCwd(segments, i, toolWorkdir);
      const { prefix, gh, git } = parseDeliverySegment(toks);
      const isGhPrCreate = gh?.subcmd === "create" || gh?.subcmd === "new";
      const isGitCommit = git?.subcmd === "commit";
      const isGitPush = git?.subcmd === "push";
      if (!isGitCommit && !isGitPush && !isGhPrCreate) continue;
      if (prefix.ambiguous) return "账本门禁：无法解析 env 交付命令。";
      if (
        prefix.dirs.some(hasShellExpansion) ||
        (git && git.gitDirFlags.some((f) => hasShellExpansion(f))) ||
        hasPrecedingDynamicCd(segments, i)
      ) {
        return "账本门禁（fail-closed）：检测到未展开的 shell 变量路径用于 git/gh 交付命令，请改用明确字面路径。";
      }
      const targetDir = resolveGitDirFlags(segCwd, [...prefix.dirs, ...(git?.gitDirFlags ?? [])], true);
      if (!targetDir) {
        return "账本门禁（fail-closed）：无法解析 git -C 目标目录，拒绝放行交付操作。";
      }
      const loc = locateRepo(workbenchRoot, targetDir);
      if (!loc) {
        const regName = pathBelongsToRegisteredRepo(workbenchRoot, targetDir, registeredRepos);
        if (regName) {
          return `账本门禁（fail-closed）：无法识别已登记仓库 ${regName} (${targetDir}) 的 Git 状态，拒绝放行交付操作。`;
        }
        continue;
      }
      if (!registeredRepos.has(loc.repo)) continue;
      if (!ledger) ledger = new Ledger(workbenchRoot);
      const current = { branch: loc.branch, sha: loc.headSha, isDetached: loc.isDetached };
      const targets: (typeof current)[] = [];
      if (isGitPush && git) {
        const parsedPush = parseGitPushArgs(git.subArgs);
        const handedOff = new Set(handedOffBranches(ledger, loc.repo));
        const reason = isImplicitPushAmbiguous(parsedPush, git.configs, targetDir, new Set([...cfg.guard.protected_branches, ...handedOff]));
        const destinations = parsedPush.refspecs.map(ref =>
          ref.replace(/^\+/, "").split(":").at(-1)!.replace(/^refs\/heads\//, ""));
        if ((handedOff.size && parsedPush.hasPrune) || destinations.some(branch => handedOff.has(branch)))
          return "分支已交接，修改远端目标前请先执行 forge ledger resume <task_id>。";
        if (reason) return `账本门禁：${reason}`;
        if (parsedPush.hasAllOrMirror) {
          return "账本门禁（fail-closed）：禁止 `git push --all` / `--branches` / `--mirror` 或批量 refspec，请显式指定目标分支。";
        }
        if (parsedPush.isDelete) continue;
        const { refspecs } = parsedPush;
        if (refspecs.length === 0) {
          targets.push(current);
        } else {
          for (const spec of refspecs) {
            const rawSrc = spec.includes(":") ? spec.split(":")[0] : spec;
            const srcRef = rawSrc.replace(/^\+/, "");
            if (!srcRef) {
              // Empty source refspec (`:branch`) is remote branch deletion
              continue;
            }
            if (
              isApprovedTagPushRefspec({
                workbenchRoot,
                targetDir,
                refspec: spec,
                isForce: parsedPush.isForce,
                isDelete: false,
                approvedRunbooks,
                cmd,
                segments,
                segmentIndex: i,
                toolWorkdir,
                pushSegmentTokens: toks,
              })
            ) {
              // Approved release tag push targets an already-merged main commit, not an unmerged feature branch.
              continue;
            }
            if (srcRef === "HEAD" || srcRef === "@") {
              targets.push(current);
            } else {
              const rev = runGit(loc.checkoutDir, ["rev-parse", "--verify", srcRef], 3000);
              if (rev.code !== 0 || !rev.stdout.trim()) {
                return `账本门禁（fail-closed）：无法解析推送源 ref \`${srcRef}\`，拒绝放行 git push。`;
              }
              targets.push({
                branch: srcRef.replace(/^refs\/heads\//, ""),
                sha: rev.stdout.trim(),
                isDetached: false,
              });
            }
          }
          if (targets.length === 0) continue;
        }
      } else if (isGhPrCreate) {
        const parsedGh = parseGhPrCreateArgs(gh.subArgs);
        // Fail closed if `-R` / `--repo` (including attached `-Rowner/repo`) points to a different repository than origin
        const explicitGhRepo = parsedGh.repo ?? (prefix.effective("GH_REPO") || null);
        const envHost = prefix.effective("GH_HOST").toLowerCase();
        const originUrl = runGit(loc.checkoutDir, ["remote", "get-url", "origin"], 3000).stdout.trim();
        const originIdentity = parseGitRemoteRepo(originUrl);
        if (explicitGhRepo) {
          const targetIdentity = parseGhRepoSpec(qualifyGhRepoSpec(explicitGhRepo, prefix.effective, targetDir));
          if (!targetIdentity || !originIdentity) {
            return `账本门禁（fail-closed）：无法完整核验 \`gh pr create -R ${explicitGhRepo}\` 与当前仓 origin (${originUrl || "未配置"}) 的 owner/repo 身份，拒绝放行。`;
          }
          if (
            targetIdentity.host !== originIdentity.host ||
            targetIdentity.owner !== originIdentity.owner ||
            targetIdentity.repo !== originIdentity.repo
          ) {
            return `账本门禁（fail-closed）：\`gh pr create\` 指定目标仓 ${explicitGhRepo} 与当前仓 origin (${originIdentity.host}/${originIdentity.owner}/${originIdentity.repo}) 不一致，请在目标仓内执行。`;
          }
        }
        if (!explicitGhRepo && envHost && envHost !== originIdentity?.host) {
          return "账本门禁：GH_HOST 与当前仓 origin 不一致。";
        }
        if (!explicitGhRepo && !ghDefaultMatchesOrigin(loc.checkoutDir, originIdentity)) {
          return "账本门禁：无法确认 gh 默认目标仓与当前仓 origin 一致，请显式指定 -R。";
        }
        let branch = loc.branch, sha = loc.headSha, isDetached = loc.isDetached;
        if (parsedGh.head) {
          const parts = parsedGh.head.split(":");
          if (parts.length > 1 && parts.shift()?.toLowerCase() !== originIdentity?.owner)
            return "账本门禁：PR head 的 owner 与当前仓 origin 不匹配，拒绝放行跨 fork 未核验 PR。";
          branch = parts.join(":").replace(/^refs\/heads\//, "");
          const rev = runGit(loc.checkoutDir, ["rev-parse", "--verify", "refs/heads/" + branch], 3000);
          if (rev.code || !rev.stdout.trim()) return "账本门禁：无法解析本地 PR head 分支。";
          sha = rev.stdout.trim();
          isDetached = false;
        }
        if (!isDetached && sha) {
          const tracking = runGit(loc.checkoutDir, ["rev-parse", "--verify", "refs/remotes/origin/" + branch], 3000);
          if (!tracking.code && tracking.stdout.trim() !== sha) return "账本门禁：本地分支与远端跟踪分支已分叉，请先推送对齐后再创建 PR。";
        }
        targets.push({ branch, sha, isDetached });
      } else {
        targets.push(current);
      }
      for (const target of targets) {
        const deliveryBranch = target.branch;
        const deliverySha = target.sha;
        const deliveryDetached = target.isDetached;

        const owner = !deliveryDetached && handedOffOwner(ledger,loc.repo,deliveryBranch);
        if (owner) return "分支已交接，继续开发请执行 forge ledger resume " + owner.task_id;
        const openTasks = deliveryDetached
          ? ledger.findOpenTasksByRepoCommits(loc.repo, getHeadAndParents(loc.checkoutDir))
          : ledger.findOpenTasksByRepoBranch(loc.repo, deliveryBranch);
        // Physical high-risk checks run independently. Ordinary development is observed by PostToolUse.
        if (currentInstall && openTasks.every(task => usesV05(ledger!, task.task_id))) continue;
        const exemption = deliveryDetached
          ? null
          : ledger.findActiveExemption(loc.repo, deliveryBranch);

        if (isGitCommit) {
          if (openTasks.length === 1) continue;
          if (openTasks.length > 1) {
            const ids = openTasks.map((t) => t.task_id).join(", ");
            return `账本门禁：${loc.repo}:${deliveryBranch} 命中多个 OPEN 账本 (${ids})，请先收敛归属后再提交。`;
          }

          const eligibility = evaluateDiffExemptEligibility(getStagedDiffStats(loc.checkoutDir), cfg);
          if (exemption && eligibility.eligible) continue;

          const allOpen = ledger.listOpenTasks();
          const attachHint =
            allOpen.length > 0
              ? `\n  2) 归属已有跨仓任务：.workbench/bin/forge ledger attach <task_id> --repo ${loc.repo} --branch ${deliveryBranch}（当前 OPEN：${allOpen.map((t) => t.task_id).join(", ")}）`
              : "";

          if (!eligibility.eligible) {
            return (
              `账本门禁：业务仓 ${loc.repo} (${deliveryBranch}) 即将提交（${eligibility.files.length} 文件 / ${eligibility.changedLines} 行：${eligibility.reason}），不可沿用或静默豁免。\n` +
              `请选择：\n` +
              `  1) 新开账本：.workbench/bin/forge ledger open --id <YYYYMMDD-slug> --title "<标题>" --endpoint <local|pr> --depth <targeted|full> --repo ${loc.repo} --branch ${deliveryBranch}${attachHint}\n` +
              `  3) 若确认完全不涉及逻辑/设定，拿不准请先询问用户确认。`
            );
          }

          return (
            `账本门禁：业务仓 ${loc.repo} (${deliveryBranch}) 尚未绑定开发账本。\n` +
            `请选择：\n` +
            `  1) 新开账本：.workbench/bin/forge ledger open --id <YYYYMMDD-slug> --title "<标题>" --endpoint <local|pr> --depth <targeted|full> --repo ${loc.repo} --branch ${deliveryBranch}${attachHint}\n` +
            `  3) 若为不涉及逻辑/设定的极小改动（纯文档/注释/typo）：.workbench/bin/forge ledger exempt --repo ${loc.repo} --branch ${deliveryBranch} --reason "<原因>"`
          );
        }

        if (isGitPush || isGhPrCreate) {
          if (!deliverySha) {
            return `账本门禁（fail-closed）：无法解析 ${loc.repo} (${deliveryBranch}) 的有效 HEAD SHA，拒绝放行 ${isGitPush ? "git push" : "gh pr create"}。`;
          }

          // Exemption passes push/PR ONLY if bound to this exact SHA AND aggregate branch diff qualifies!
          if (exemption && exemption.head_sha === deliverySha) {
            const branchStats = getBranchDiffStats(
              loc.checkoutDir,
              deliverySha,
              cfg.guard.protected_branches,
            );
            if (branchStats && evaluateDiffExemptEligibility(branchStats, cfg).eligible) {
              for (const task of openTasks) {
                const spec = getSpecState(ledger, task.task_id, { delivery: { repo: loc.repo, head_sha: deliverySha, checkoutDir: loc.isDetached ? loc.checkoutDir : undefined } });
                if (spec.state === "AMENDED" || spec.drift_detected) {
                  return `账本门禁：${task.task_id} 冻结规范或测试尚未就绪 ${[...spec.drifted_files, ...spec.drifted_locked_tests].join(", ")}`;
                }
              }
              continue;
            }
            return `账本门禁：${loc.repo}@${deliverySha.slice(0, 8)} 的实际提交改动不满足免账本豁免条件，请开立正式开发账本并完成验证。`;
          }

          if (openTasks.length === 0) {
            return (
              `账本门禁：${loc.repo} (${deliveryBranch}${deliveryDetached ? " detached" : ""}) 尚未绑定有效开发账本（或豁免未绑定当前 SHA ${deliverySha.slice(0, 8)}），禁止直接执行 ${isGitPush ? "git push" : "gh pr create"}。\n` +
              `请先绑定账本（跨仓或独立交付分支可用 forge ledger attach；极小无逻辑改动须登记当前 SHA 的合规 exempt）。`
            );
          }
          if (openTasks.length > 1) {
            return `账本门禁：${loc.repo} 命中多个 OPEN 账本 (${openTasks.map((t) => t.task_id).join(", ")})，无法自动校验推送条件。`;
          }

          const task = openTasks[0];

          // On a detached integration worktree: check merged HEAD first; ONLY fall back to parent feature SHA
          // if merged HEAD had NO explicit test/build/review failure!
          let readiness = ledger.checkPushReadiness({
            task_id: task.task_id,
            repo: loc.repo,
            branch: deliveryDetached ? undefined : deliveryBranch,
            head_sha: deliverySha,
            checkoutDir: loc.isDetached ? loc.checkoutDir : undefined,
          });
          if (!readiness.ready && !readiness.hasExplicitFailure && deliveryDetached) {
            const parents = new Set(getHeadAndParents(loc.checkoutDir).slice(1));
            const matches = ledger
              .getTaskRepos(task.task_id)
              .filter((r) => r.repo === loc.repo && r.head_sha && parents.has(r.head_sha));
            const boundRepo = matches.length === 1 ? matches[0] : undefined;
            if (boundRepo?.head_sha) {
              readiness = ledger.checkPushReadiness({
                task_id: task.task_id,
                repo: loc.repo,
                branch: boundRepo.branch,
                head_sha: boundRepo.head_sha,
                checkoutDir: loc.checkoutDir,
              });
            }
          }

          if (!readiness.ready) {
            return (
              `账本门禁：任务 ${task.task_id} (${loc.repo}@${deliverySha.slice(0, 8)}) 尚未满足交付前检查：\n` +
              readiness.missing.map((m) => `  - ${m}`).join("\n") +
              `\n请补跑对应验证/评审工具以产出真实证据后再重试。`
            );
          }
        }
      }
    }
  } finally {
    ledger?.closeDb();
  }

  return null;
}
