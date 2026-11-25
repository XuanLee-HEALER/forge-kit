import { redactSecrets } from "../cmdfmt";
import { findWorkbenchRoot, loadWorkbenchConfig } from "../config";
import { getHeadAndParents, locateRepo, runGit } from "../git";
import {
  emitPostCompactMessage,
  emitSessionStartContext,
  emitUserPromptSubmitContext,
  extractResponseExitCode,
  extractResponseText,
  extractShellCommand,
  extractToolWorkdir,
  readHookStdinStrict,
  type CodexHookInput,
} from "../hook-io";
import {
  hasAmbiguousControlFlow,
  hasNonExecutingVerifyFlag,
  isFailFastSetSegment,
  safeTrailingSegments,
} from "./manifest-verify";
import { classifyReviewEvidence } from "./review-evidence";
import { handleUserPromptRunbookDirectives } from "./runbook-prompt";
import {
  classifyVerifyCommand,
  extractTscArgs,
  hasInfoOnlyFlag,
  isValidHurlExecution,
  parseLangCheckInvocation,
  parseLangCheckPhases,
  resolveVerifyTargetDir,
} from "./runners";
import { SHELL_CONTROL_OR_STATE_BUILTINS, type CapturedEvidence } from "./types";
import { Ledger } from "../ledger/store";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  extractGhPrSubcommand,
  parseGhPrCreateArgs,
  parseGhRepoSpec,
  parseGitRemoteRepo,
  qualifyGhRepoSpec,
} from "../shared/gh-remote";
import { extractGitSubcommand, resolveGitDirFlags } from "../shared/git-cmd";
import {
  resolveCdTarget,
  splitLeadingEnv,
  splitShellSegments,
  splitShellTokensWithMeta,
  stripUnquotedShellRedirections,
  unwrapShellPrefix,
} from "../shared/shell";

export function classifyPostToolEvidence(
  cmd: string,
  workdir: string,
  exitCode: number | null,
  outputText: string,
): CapturedEvidence[] {
  if (exitCode === null) return [];
  if (hasAmbiguousControlFlow(cmd)) return [];

  const results: CapturedEvidence[] = [];
  const segments = splitShellSegments(cmd);
  const passed = exitCode === 0;
  let curDir = workdir;
  let prevDir: string | null = null;

  const hasLeadingFailFastSet =
    segments.length > 0 && isFailFastSetSegment(segments[0]);

  // Reject any command containing shell control/state-mutating builtins (e.g. `exit 0 && make test`,
  // `exec true && make test`, `pushd ../other && make test`, `! make test`, `export MAKEFLAGS=-n && make test`),
  // function definitions, or bare shell variable assignments in a multi-segment chain.
  // Exception: a verified fail-fast `set -e` / `set -euo pipefail` header strictly at segment 0.
  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    if (segIdx === 0 && hasLeadingFailFastSet) continue;
    const seg = segments[segIdx];
    const meta = splitShellTokensWithMeta(seg);
    if (!meta || meta.length === 0) continue;
    const { envToks, cmdToks } = splitLeadingEnv(meta);
    if (cmdToks.length === 0) {
      if (envToks.length > 0 && segments.length > 1) return [];
      continue;
    }
    const head = cmdToks[0];
    if (SHELL_CONTROL_OR_STATE_BUILTINS.has(head)) {
      return [];
    }
  }

  const nonCdSegments = segments.filter((s, idx) => {
    if (idx === 0 && hasLeadingFailFastSet) return false;
    const t = splitShellTokensWithMeta(s);
    if (!t || t.length === 0) return false;
    return splitLeadingEnv(t).cmdToks[0] !== "cd";
  });

  // In a multi-segment chain that exits non-zero, only an optional leading fail-fast `set -e`
  // plus leading valid `cd` segments followed by a single final command unambiguously attribute
  // the failure to that final command.
  // Any other multi-segment failure (e.g. `false && make test`, `make test && cd /dev/null`,
  // `cd missing/.. && make test`) is ambiguous and MUST NOT record a false `fail`.
  if (!passed && segments.length > 1) {
    let probeDir = workdir;
    let probePrev: string | null = null;
    for (let i = 0; i < segments.length - 1; i++) {
      if (i === 0 && hasLeadingFailFastSet) continue;
      const t = splitShellTokensWithMeta(segments[i]);
      if (!t || splitLeadingEnv(t).cmdToks[0] !== "cd") {
        return [];
      }
      const nextDir = resolveCdTarget(probeDir, probePrev, t);
      if (!nextDir) {
        return [];
      }
      probePrev = probeDir;
      probeDir = nextDir;
    }
    const lastToks = splitShellTokensWithMeta(segments[segments.length - 1]);
    if (
      !lastToks ||
      lastToks.length === 0 ||
      splitLeadingEnv(lastToks).cmdToks[0] === "cd" ||
      (segments.length - 1 === 0 && hasLeadingFailFastSet)
    ) {
      return [];
    }
  }

  let sawVerification = false;
  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    if (segIdx === 0 && hasLeadingFailFastSet) continue;
    const seg = segments[segIdx];
    const metaToks = splitShellTokensWithMeta(seg);
    if (!metaToks || metaToks.length === 0) continue;
    const toks = metaToks.map((t) => t.value);
    // Shell pipeline negation (`! make test`) flips non-zero failures into exit 0 — reject entire command!
    if (toks[0] === "!" || toks[0] === "coproc") {
      return [];
    }
    if (splitLeadingEnv(metaToks).cmdToks[0] === "cd") {
      const nextDir = resolveCdTarget(curDir, prevDir, metaToks);
      if (!nextDir) return [];
      prevDir = curDir;
      curDir = nextDir;
      continue;
    }

    // 1. git commit
    const git = extractGitSubcommand(toks);
    if (git?.subcmd === "commit" && passed && !sawVerification) {
      const prefix = unwrapShellPrefix(toks);
      if (prefix.bin !== "git" || prefix.ambiguous || prefix.dirs.some((d) => /[$`]/.test(d))) continue;
      const baseDir = resolveGitDirFlags(curDir, prefix.dirs, true);
      if (!baseDir) continue;
      const targetDir = resolveGitDirFlags(baseDir, git.gitDirFlags, false) ?? baseDir;
      results.push({
        kind: "commit",
        status: "pass",
        summary: redactSecrets(seg).slice(0, 160),
        targetDir,
      });
      continue;
    }

    // 1b. gh pr create / gh pr new (standalone non-cd segment; unified pflag parser; verify PR URL & origin parity on pass!)
    const gh = extractGhPrSubcommand(toks);
    if (gh && (gh.subcmd === "create" || gh.subcmd === "new")) {
      if (gh.prefix.bin !== "gh" || gh.prefix.ambiguous || gh.prefix.dirs.some((dir) => /[$`]/.test(dir))) continue;
      const targetDir = resolveGitDirFlags(curDir, gh.prefix.dirs, true);
      if (!targetDir) continue;
      const parsedGh = parseGhPrCreateArgs(gh.subArgs);
      if (
        nonCdSegments.length > 1 ||
        parsedGh.parseError ||
        parsedGh.help ||
        parsedGh.dryRun ||
        parsedGh.web
      ) {
        continue;
      }
      // Per `gh pr create --help`:
      // - On exit 0, require an actual created PR URL in output (and verify its repo against origin).
      // - When `--attach` is used and some attachments fail to upload, `gh` STILL creates the PR,
      //   prints the new PR URL, and exits non-zero -> treat that as `pr/pass` (still verified via prUrlRepoSpec)!
      // Require a STANDALONE PR URL line so error messages mentioning a URL (e.g. `open https://.../pull/42: no such file`)
      // NEVER fabricate `pr/pass`!
      const urlMatch = outputText.match(
        /^[ \t]*https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/\d+[ \t\r]*$/im,
      );
      const prCreatedWithPartialAttachFail =
        !passed &&
        parsedGh.hasAttach &&
        Boolean(urlMatch) &&
        !/already exists/i.test(outputText);
      const prSucceeded = passed || prCreatedWithPartialAttachFail;

      let prUrlRepoSpec: string | null = null;
      if (prSucceeded) {
        if (!urlMatch) continue;
        prUrlRepoSpec = urlMatch[0].trim().replace(/\/pull\/\d+$/i, "");
      }

      const host = gh.prefix.effective("GH_HOST").toLowerCase();
      const spec = parsedGh.repo ?? (gh.prefix.effective("GH_REPO") || null);
      const targetRepoSpec = spec ? qualifyGhRepoSpec(spec, gh.prefix.effective, targetDir) : null;
      const prHead = parsedGh.head;
      let targetBranch: string | null = null;
      let targetOwner: string | null = null;
      if (prHead) {
        if (prHead.includes(":")) {
          const [owner, ...restParts] = prHead.split(":");
          targetOwner = owner || null;
          targetBranch = restParts.join(":").replace(/^refs\/heads\//, "") || null;
        } else {
          targetBranch = prHead.replace(/^refs\/heads\//, "");
        }
      }
      results.push({
        kind: "pr",
        status: prSucceeded ? "pass" : "fail",
        summary: prCreatedWithPartialAttachFail
          ? `${redactSecrets(seg).slice(0, 120)} (PR created; partial attachment failure)`
          : redactSecrets(seg).slice(0, 160),
        targetDir,
        targetBranch,
        targetOwner,
        targetRepoSpec,
        targetHost: targetRepoSpec ? null : host || null,
        prUrlRepoSpec,
      });
      continue;
    }

    const reviews = classifyReviewEvidence(splitLeadingEnv(metaToks).cmdToks, curDir, exitCode, outputText, nonCdSegments.length);
    if (reviews) {
      results.push(...reviews);
      continue;
    }

    // 3. Direct build / test / lint / hurl / lang-check execution (token-based; strips unquoted redirections so `> /dev/null` is never treated as a test path!)
    const strippedMetaToks = splitShellTokensWithMeta(stripUnquotedShellRedirections(seg)) ?? metaToks;
    const verifyHit = classifyVerifyCommand(strippedMetaToks);
    if (verifyHit) {
      sawVerification = true;
      // Suppress attribution if ANY later segment in the same shell invocation can mutate git checkout/HEAD
      // (e.g. `set -e\nnpm test\ngit switch other` or `npm test && git commit`), so the post-tool live SHA
      // never falsely credits an untested branch/commit!
      if (!safeTrailingSegments(segments.slice(segIdx + 1), curDir, 0, [], prevDir)) {
        continue;
      }
      const targetDir = resolveVerifyTargetDir(verifyHit.cmdToks, verifyHit.envToks, curDir);
      if (!targetDir) {
        continue;
      }
      // Never record `--help` / `--version` / `help` / dry-run / collect-only commands as passing verification!
      // Note: `tsc` handles its own `--help`/`--version` boolean values (e.g. `--help false` still typechecks).
      const isTscCmd = extractTscArgs(verifyHit.cmdToks) !== null;
      if (
        (!isTscCmd && hasInfoOnlyFlag(verifyHit.cmdToks)) ||
        hasNonExecutingVerifyFlag(verifyHit.cmdToks, verifyHit.envToks, targetDir, outputText, passed)
      ) {
        continue;
      }
      if (
        verifyHit.kind === "hurl" &&
        !isValidHurlExecution(verifyHit.cmdToks, curDir, outputText)
      ) {
        continue;
      }
      if (verifyHit.kind === "lang-check") {
        // Exit 2 means no applicable checks executed (fail-closed) -> never record pass/fail!
        if (exitCode === 2) continue;
        const parsedLc = parseLangCheckInvocation(verifyHit.cmdToks);
        if (!parsedLc) continue;
        // For `--mode all`, check JSON/text report if present to record per-phase outcomes accurately
        let phases: Array<{ kind: "lint" | "test"; status: "pass" | "fail" }> = [];
        if (parsedLc.mode === "static") {
          phases = [{ kind: "lint", status: passed ? "pass" : "fail" }];
        } else if (parsedLc.mode === "dynamic") {
          phases = [{ kind: "test", status: passed ? "pass" : "fail" }];
        } else {
          // mode === "all": requires standalone invocation (`nonCdSegments.length === 1`) so combined
          // output from chained `lang-check repoA && lang-check repoB` can never cross-credit phases!
          if (nonCdSegments.length > 1) continue;
          phases = parseLangCheckPhases(outputText, passed);
        }
        for (const ph of phases) {
          results.push({
            kind: ph.kind,
            status: ph.status,
            summary: `${redactSecrets(seg).slice(0, 140)} (exit=${exitCode})`,
            targetDir,
            meta: { exit_code: exitCode, mode: parsedLc.mode },
          });
        }
        continue;
      }
      results.push({
        kind: verifyHit.kind,
        status: passed ? "pass" : "fail",
        summary: `${redactSecrets(seg).slice(0, 140)} (exit=${exitCode})`,
        targetDir,
        meta: { exit_code: exitCode },
      });
    }
  }

  return results;
}

export function handleLedgerHook(
  workbenchRoot: string,
  input: CodexHookInput,
): {
  sessionContext?: string;
  compactMessage?: string;
  userPromptContext?: string;
  recorded: number;
} {
  const evName = input.hook_event_name ?? "";
  if (evName === "UserPromptSubmit") {
    const userPromptContext = handleUserPromptRunbookDirectives(workbenchRoot, input);
    return { userPromptContext, recorded: 0 };
  }

  const cfg = loadWorkbenchConfig(workbenchRoot);
  if (!cfg.ledger.enabled) return { recorded: 0 };

  // FAST PATH for PostToolUse: do NOT open SQLite for non-shell or non-dev commands!
  if (evName === "PostToolUse") {
    const cmd = extractShellCommand(input);
    if (!cmd) return { recorded: 0 };
    const registeredRepos = new Set(cfg.repos);
    if (registeredRepos.size === 0) return { recorded: 0 };

    const exitCode = extractResponseExitCode(input.tool_response);
    const outputText = extractResponseText(input.tool_response);
    const workdir = extractToolWorkdir(input);
    const items = classifyPostToolEvidence(cmd, workdir, exitCode, outputText);
    if (items.length === 0) return { recorded: 0 };

    const ledger = new Ledger(workbenchRoot);
    try {
      let recorded = 0;
      for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        const loc = locateRepo(workbenchRoot, item.targetDir);
        if (!loc || !registeredRepos.has(loc.repo)) continue;

        // Verify explicit `-R` / `--repo` AND created PR URL repo match current repo's origin (host/owner/repo)
        if (item.targetRepoSpec || item.prUrlRepoSpec || item.targetHost) {
          const originUrl = runGit(loc.checkoutDir, ["remote", "get-url", "origin"], 3000).stdout.trim();
          const originId = parseGitRemoteRepo(originUrl);
          if (item.targetHost && item.targetHost !== originId?.host) continue;
          if (item.targetRepoSpec) {
            const targetId = parseGhRepoSpec(item.targetRepoSpec);
            if (
              !originId ||
              !targetId ||
              originId.host !== targetId.host ||
              originId.owner !== targetId.owner ||
              originId.repo !== targetId.repo
            ) {
              continue;
            }
          }
          if (item.prUrlRepoSpec) {
            const urlId = parseGhRepoSpec(item.prUrlRepoSpec);
            if (
              !originId ||
              !urlId ||
              originId.host !== urlId.host ||
              originId.owner !== urlId.owner ||
              originId.repo !== urlId.repo
            ) {
              continue;
            }
          }
        }

        // Resolve explicit target branch (e.g. `gh pr create --head feat/other`) instead of current checkout
        let effectiveBranch = loc.branch;
        let effectiveDetached = loc.isDetached;
        let resolvedPinnedSha = item.pinnedSha ?? null;
        if (!resolvedPinnedSha && item.pinnedRef) {
          const refRes = runGit(
            loc.checkoutDir,
            ["rev-parse", "--verify", `${item.pinnedRef}^{commit}`],
            3000,
          );
          if (refRes.code === 0 && refRes.stdout.trim()) {
            resolvedPinnedSha = refRes.stdout.trim();
          }
        }
        let effectiveSha = resolvedPinnedSha ?? loc.headSha;
        if (item.targetBranch) {
          if (item.targetOwner) {
            const originUrl = runGit(loc.checkoutDir, ["remote", "get-url", "origin"], 3000).stdout.trim();
            const originId = parseGitRemoteRepo(originUrl);
            if (!originId || originId.owner !== item.targetOwner.toLowerCase()) {
              // Cross-fork owner mismatch -> do not misattribute to local repo branch
              continue;
            }
          }
          const rev = runGit(
            loc.checkoutDir,
            ["rev-parse", "--verify", `refs/heads/${item.targetBranch}`],
            3000,
          );
          if (rev.code !== 0 || !rev.stdout.trim()) continue;
          const localBranchSha = rev.stdout.trim();
          // If origin/<branch> exists locally and has diverged from local branch, do not record PR pass on stale SHA
          const remoteRev = runGit(
            loc.checkoutDir,
            ["rev-parse", "--verify", `refs/remotes/origin/${item.targetBranch}`],
            3000,
          );
          if (remoteRev.code === 0 && remoteRev.stdout.trim() && remoteRev.stdout.trim() !== localBranchSha) {
            continue;
          }
          effectiveBranch = item.targetBranch;
          effectiveDetached = false;
          effectiveSha = localBranchSha;
        } else if (item.kind === "pr" && !effectiveDetached && effectiveSha) {
          const remoteRev = runGit(
            loc.checkoutDir,
            ["rev-parse", "--verify", `refs/remotes/origin/${effectiveBranch}`],
            3000,
          );
          if (remoteRev.code === 0 && remoteRev.stdout.trim() && remoteRev.stdout.trim() !== effectiveSha) {
            continue;
          }
        }

        // If committing on an exempted branch, bind resulting HEAD SHA to the exemption!
        if (item.kind === "commit" && !effectiveDetached && effectiveSha) {
          const ex = ledger.findActiveExemption(loc.repo, effectiveBranch);
          if (ex && !ex.head_sha) {
            ledger.bindExemptionHeadSha(ex.id, effectiveSha);
          }
        }

        const openTasks = effectiveDetached
          ? ledger.findOpenTasksByRepoCommits(loc.repo, getHeadAndParents(loc.checkoutDir))
          : ledger.findOpenTasksByRepoBranch(loc.repo, effectiveBranch);
        if (openTasks.length !== 1) continue;

        if (item.requirePinnedSha && !resolvedPinnedSha) {
          // Do not guess live checkout HEAD when pinned SHA/ref is required!
          continue;
        }
        const targetSha = effectiveSha;
        const toolUseKey = input.tool_use_id
          ? `${input.tool_use_id}:${idx}`
          : null;

        ledger.recordEvidence({
          task_id: openTasks[0].task_id,
          kind: item.kind,
          status: item.status,
          summary: item.summary,
          repo: loc.repo,
          branch: effectiveDetached ? null : effectiveBranch,
          sha: targetSha,
          meta:
            item.meta && resolvedPinnedSha
              ? { ...item.meta, head: resolvedPinnedSha }
              : item.meta,
          actor: "hook",
          session_id: input.session_id ?? null,
          tool_use_id: toolUseKey,
        });
        recorded++;
      }
      return { recorded };
    } finally {
      ledger.closeDb();
    }
  }

  if (evName === "SessionStart" || evName === "PostCompact") {
    const ledger = new Ledger(workbenchRoot);
    try {
      const summary = ledger.formatCompactContext(8);
      if (evName === "SessionStart") {
        return { sessionContext: summary || undefined, recorded: 0 };
      }
      return { compactMessage: summary || undefined, recorded: 0 };
    } finally {
      ledger.closeDb();
    }
  }

  return { recorded: 0 };
}

function logHookError(root: string, err: unknown): void {
  try {
    const logPath = join(root, ".workbench", "ledger", "hook-errors.log");
    mkdirSync(dirname(logPath), { recursive: true });
    const msg = redactSecrets(err instanceof Error ? err.message : String(err));
    appendFileSync(logPath, `${new Date().toISOString()} [ledger-hook] ${msg}\n`);
  } catch {
    // Ignore log failure
  }
}

export async function runLedgerHookCli(): Promise<void> {
  const parsed = await readHookStdinStrict();
  if (!parsed.ok || !parsed.input) return;

  const root = findWorkbenchRoot(parsed.input.cwd);
  try {
    const res = handleLedgerHook(root, parsed.input);
    if (res.sessionContext) emitSessionStartContext(res.sessionContext);
    if (res.compactMessage) emitPostCompactMessage(res.compactMessage);
    if (res.userPromptContext) emitUserPromptSubmitContext(res.userPromptContext);
  } catch (err) {
    // Telemetry hook never blocks user session, but records sanitized diagnostics!
    logHookError(root, err);
  }
}
