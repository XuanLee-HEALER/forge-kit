import { verifiedPr } from "../ledger/delivery-tools";
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
import { handleUserPromptRunbookDirectives } from "./runbook-prompt";
import type { CapturedEvidence } from "./types";
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
  tokenizeSimpleShellCommand,
  resolveCdTarget,
  splitLeadingEnv,
  splitShellSegments,
  splitShellTokensWithMeta,
  hasOnlyAndSeparators,
  unwrapShellPrefix,
} from "../shared/shell";

export function classifyPostToolEvidence(
  cmd: string,
  workdir: string,
  exitCode: number | null,
  outputText: string,
): CapturedEvidence[] {
  if (exitCode === null) return [];
  const script = cmd.replace(/^[ \t]*set[ \t]+(?:-e|-eu|-euo[ \t]+pipefail|-o[ \t]+errexit)[ \t]*(?:\r?\n|&&|;)[ \t]*/, "");
  if (!hasOnlyAndSeparators(script.trimEnd(), script !== cmd)) return [];
  const results: CapturedEvidence[] = [];
  const segments = splitShellSegments(script);
  const passed = exitCode === 0;
  // Attribute the observed HEAD only across literal, read-only suffixes.
  while (passed && segments.length > 1) {
    const tail = tokenizeSimpleShellCommand(segments.at(-1)!) ?? [];
    const last = extractGitSubcommand(tail);
    const { bin } = unwrapShellPrefix(tail);
    if (!(bin === "echo" || bin === "true" || (bin === "git" && last && ["status", "log", "rev-parse"].includes(last.subcmd)))) break;
    segments.pop();
  }
  let curDir = workdir;
  let prevDir: string | null = null;
  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const seg = segments[segIdx];
    const metaToks = splitShellTokensWithMeta(seg);
    if (!metaToks || metaToks.length === 0) continue;
    const toks = metaToks.map((t) => t.value);
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

    const git = extractGitSubcommand(toks);
    if (segIdx !== segments.length - 1) {
      if (passed && git && unwrapShellPrefix(toks).bin === "git" && ["add", "diff", "status"].includes(git.subcmd)) continue;
      return [];
    }
    if (git?.subcmd === "commit" && passed) {
      const prefix = unwrapShellPrefix(toks);
      if (git.hasUnsafeGlobalOverride || git.subArgs.some(a => /^(--dry-run|--short|--porcelain(?:=.*)?|--long|--help)$/.test(a))) continue;
      if (prefix.effective("GIT_DIR") || prefix.effective("GIT_WORK_TREE")) continue;
      if (prefix.bin !== "git" || prefix.ambiguous || prefix.dirs.some((d) => /[$`]/.test(d))) continue;
      const baseDir = resolveGitDirFlags(curDir, prefix.dirs, true);
      if (!baseDir) continue;
      const targetDir = resolveGitDirFlags(baseDir, git.gitDirFlags, false);
      if (!targetDir) continue;
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
        prUrl: urlMatch?.[0].trim(),
        ghEnv: Object.fromEntries(["GH_HOST", "GH_REPO", "GH_CONFIG_DIR"].map(k => [k, gh.prefix.effective(k)])),
      });
      continue;
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
      for (const [idx, item] of items.entries()) {
        const loc = locateRepo(workbenchRoot, item.targetDir);
        if (!loc || !registeredRepos.has(loc.repo)) continue;

        // Verify explicit `-R` / `--repo` AND created PR URL repo match current repo's origin (host/owner/repo)
        if (item.targetRepoSpec || item.prUrlRepoSpec || item.targetHost) {
          const originUrl = runGit(loc.checkoutDir, ["remote", "get-url", "origin"], 3000).stdout.trim();
          const originId = parseGitRemoteRepo(originUrl);
          if (item.targetHost && item.targetHost !== originId?.host) continue;
          const specs = [item.targetRepoSpec, item.prUrlRepoSpec].filter((v): v is string => !!v);
          if (specs.some(spec => {
            const id = parseGhRepoSpec(spec);
            return !id || !originId || id.host !== originId.host || id.owner !== originId.owner || id.repo !== originId.repo;
          })) continue;
        }

        // Resolve explicit target branch (e.g. `gh pr create --head feat/other`) instead of current checkout
        let effectiveBranch = loc.branch;
        let effectiveDetached = loc.isDetached;
        let effectiveSha = loc.headSha;
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
        if (item.kind === "pr" && item.status === "pass") {
          if (!item.prUrl || effectiveDetached || !effectiveSha) continue;
          try {
            const pr = verifiedPr(loc.checkoutDir, effectiveBranch, effectiveSha, item.prUrl, { ...process.env, ...item.ghEnv });
            item.meta = { pr_url: pr.url, pr_head_oid: pr.headRefOid };
          }
          catch { continue; }
        }
        ledger.recordEvidence({
          source: "hook",
          task_id: openTasks[0].task_id,
          kind: item.kind,
          status: item.status,
          summary: item.summary,
          repo: loc.repo,
          branch: effectiveDetached ? null : effectiveBranch,
          sha: effectiveSha,
          meta: item.meta,
          actor: "hook",
          session_id: input.session_id ?? null,
          tool_use_id: input.tool_use_id ? `${input.tool_use_id}:${idx}` : null,
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
