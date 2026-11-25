import { normalizeReviewRole } from "../ledger/types";
import type { CapturedEvidence } from "./types";
import { runGit } from "../git";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

function parseReviewJsonOutput(
  outputText: string,
): {
  status?: string;
  passed?: boolean;
  errorCode?: string;
  head?: string;
  base?: string;
  role?: string;
  repo?: string;
  executionId?: string;
  startedAt?: string;
  reviewFloorSeq?: number;
  reviewTaskId?: string;
  reviewStarted?: boolean;
} | null {
  const receipts = outputText.split(/\r?\n/).filter(line => line.startsWith("FORGE_REVIEW_RECEIPT "));
  if (receipts.length > 1) return null;
  const candidates = receipts.map(line => line.slice("FORGE_REVIEW_RECEIPT ".length));
  const trimmed = outputText.trim();
  if (trimmed.startsWith("{")) candidates.push(trimmed);
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const raw of candidates) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        const execution = obj.reviewExecution as { id?: unknown; startedAt?: unknown } | undefined;
        return {
          repo: typeof obj.repo === "string" ? obj.repo : undefined,
          reviewStarted: obj.reviewStarted !== false,
          ...(Object.hasOwn(obj, "reviewTaskId") && { reviewTaskId: typeof obj.reviewTaskId === "string" ? obj.reviewTaskId : "" }),
          ...(Object.hasOwn(obj, "reviewFloorSeq") && { reviewFloorSeq: Number.isSafeInteger(obj.reviewFloorSeq) && Number(obj.reviewFloorSeq) >= 0 ? Number(obj.reviewFloorSeq) : -1 }),
          executionId: typeof execution?.id === "string" ? execution.id : undefined,
          startedAt: typeof execution?.startedAt === "string" ? execution.startedAt : undefined,
          status: typeof obj.status === "string" ? obj.status : undefined,
          passed: typeof obj.passed === "boolean" ? obj.passed : undefined,
          errorCode: typeof obj.errorCode === "string" ? obj.errorCode : undefined,
          head: typeof obj.head === "string" ? obj.head : undefined,
          base: typeof obj.base === "string" ? obj.base : undefined,
          role: typeof obj.role === "string" ? obj.role : undefined,
        };
      }
    } catch {
      // Try next candidate
    }
  }
  return null;
}

const CODEX_GLOBAL_VALUE_OPTS = new Set([
  "-c",
  "--config",
  "--enable",
  "--disable",
  "-i",
  "--image",
  "-m",
  "--model",
  "--local-provider",
  "-p",
  "--profile",
  "-s",
  "--sandbox",
  "-C",
  "--cd",
  "--add-dir",
  "-a",
  "--ask-for-approval",
]);

const CODEX_GLOBAL_BOOL_OPTS = new Set([
  "--strict-config",
  "--oss",
  "--approve-for-me",
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "--search",
  "--no-alt-screen",
  "--no-daemon",
]);

function isValidCodexConfigOverride(val: string | undefined): boolean {
  if (!val) return false;
  const eq = val.indexOf("=");
  return eq > 0 && val.slice(0, eq).trim().length > 0;
}

const CODEX_SANDBOX_MODES = new Set([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);

const CODEX_APPROVAL_POLICIES = new Set(["on-request", "never"]);

const CODEX_GLOBAL_REPEATABLE_OPTS = new Set([
  "-c",
  "--config",
  "--enable",
  "--disable",
  "--add-dir",
  "-i",
  "--image",
]);

const CODEX_GLOBAL_CANONICAL: Record<string, string> = {
  "-c": "--config",
  "-i": "--image",
  "-m": "--model",
  "-p": "--profile",
  "-s": "--sandbox",
  "-C": "--cd",
  "-a": "--ask-for-approval",
};

const CODEX_REVIEW_BOOL_OPTS = new Set([
  "--strict-config",
  "--trust",
  "--uncommitted",
]);

const CODEX_REVIEW_VALUE_OPTS = new Set([
  "-c",
  "--config",
  "--enable",
  "--disable",
  "--base",
  "--commit",
  "--title",
]);

/**
 * Parse a `codex [GLOBAL_OPTS] review [REVIEW_OPTS] [PROMPT]` invocation.
 * Returns `null` for non-`review` subcommands (e.g. `codex help review`, `codex exec "review"`),
 * help/version queries, invalid enum/conflicting/duplicate Clap flags, or unknown/ambiguous options.
 */
function parseCodexReviewCommand(
  cmdToks: string[],
  curDir: string,
): { targetDir: string; hasCommitFlag: boolean; commitVal: string | null } | null {
  if (cmdToks[0] !== "codex" && !cmdToks[0]?.endsWith("/codex")) return null;
  let targetDir = curDir;
  let reviewIdx = -1;
  const seenGlobalSingleOpts = new Set<string>();

  for (let i = 1; i < cmdToks.length; i++) {
    const tok = cmdToks[i];
    if (tok === "--") return null; // No subcommand before `--`
    if (tok === "-h" || tok === "--help" || tok === "-V" || tok === "--version") return null;
    if (tok.startsWith("-")) {
      const eqIdx = tok.indexOf("=");
      const rawFlag = eqIdx >= 0 ? tok.slice(0, eqIdx) : tok;
      if (CODEX_GLOBAL_BOOL_OPTS.has(rawFlag)) {
        if (eqIdx >= 0 || seenGlobalSingleOpts.has(rawFlag)) return null;
        seenGlobalSingleOpts.add(rawFlag);
        continue;
      }
      let flag: string | null = null;
      let val: string | undefined;
      let isSeparateVal = false;
      if (CODEX_GLOBAL_VALUE_OPTS.has(rawFlag)) {
        flag = rawFlag;
        if (eqIdx >= 0) {
          val = tok.slice(eqIdx + 1);
        } else {
          isSeparateVal = true;
          val = cmdToks[++i];
          if (val === undefined || val.startsWith("-")) return null;
        }
      } else if (
        tok.length > 2 &&
        !tok.startsWith("--") &&
        CODEX_GLOBAL_VALUE_OPTS.has(tok.slice(0, 2))
      ) {
        // Attached short flag e.g. `-C../dir`, `-mfoo`, `-sread-only`, `-anever`
        flag = tok.slice(0, 2);
        val = tok.slice(2);
      }
      if (flag) {
        const canon = CODEX_GLOBAL_CANONICAL[flag] ?? flag;
        if (!CODEX_GLOBAL_REPEATABLE_OPTS.has(flag)) {
          if (seenGlobalSingleOpts.has(canon)) return null;
          seenGlobalSingleOpts.add(canon);
        }
        if (canon === "--sandbox" && !CODEX_SANDBOX_MODES.has(val ?? "")) return null;
        if (canon === "--ask-for-approval" && !CODEX_APPROVAL_POLICIES.has(val ?? "")) return null;
        if (canon === "--config" && !isValidCodexConfigOverride(val)) return null;
        if ((canon === "--enable" || canon === "--disable") && !(val && val.trim().length > 0)) {
          return null;
        }
        if (canon === "--cd") {
          targetDir = resolve(targetDir, val ?? "");
        }
        // Variadic `-i` / `--image <FILE>...` greedily consumes following non-flag tokens (including `review`).
        if (canon === "--image" && isSeparateVal) {
          while (i + 1 < cmdToks.length && !cmdToks[i + 1].startsWith("-")) {
            i++;
          }
        }
        continue;
      }
      return null;
    }
    // First positional token is the subcommand — MUST be literally `review`!
    if (tok === "review") {
      reviewIdx = i;
      break;
    }
    return null;
  }

  if (reviewIdx < 0) return null;
  // Clap global mutual conflicts: `--approve-for-me` cannot be combined with bypass/sandbox/approval flags.
  if (
    seenGlobalSingleOpts.has("--approve-for-me") &&
    (seenGlobalSingleOpts.has("--dangerously-bypass-approvals-and-sandbox") ||
      seenGlobalSingleOpts.has("--sandbox") ||
      seenGlobalSingleOpts.has("--ask-for-approval"))
  ) {
    return null;
  }

  let hasUncommitted = false;
  let hasBase = false;
  let hasCommitFlag = false;
  let hasTitle = false;
  let commitVal: string | null = null;
  let promptCount = 0;
  let afterDoubleDash = false;
  const seenSingleOpts = new Set<string>();
  const repeatableReviewOpts = new Set(["-c", "--config", "--enable", "--disable"]);

  for (let i = reviewIdx + 1; i < cmdToks.length; i++) {
    const tok = cmdToks[i];
    if (!afterDoubleDash && tok === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && tok.startsWith("-") && tok !== "-") {
      const eqIdx = tok.indexOf("=");
      const flag = eqIdx >= 0 ? tok.slice(0, eqIdx) : tok;
      if (CODEX_REVIEW_BOOL_OPTS.has(flag)) {
        if (eqIdx >= 0 || seenSingleOpts.has(flag)) return null;
        seenSingleOpts.add(flag);
        if (flag === "--uncommitted") hasUncommitted = true;
        continue;
      }
      if (CODEX_REVIEW_VALUE_OPTS.has(flag)) {
        if (!repeatableReviewOpts.has(flag)) {
          if (seenSingleOpts.has(flag)) return null;
          seenSingleOpts.add(flag);
        }
        const val = eqIdx >= 0 ? tok.slice(eqIdx + 1) : cmdToks[++i];
        if (val === undefined || (eqIdx < 0 && val.startsWith("-"))) return null;
        if ((flag === "-c" || flag === "--config") && !isValidCodexConfigOverride(val)) return null;
        if ((flag === "--enable" || flag === "--disable") && val.trim().length === 0) return null;
        if (flag === "--base") hasBase = true;
        if (flag === "--title") hasTitle = true;
        if (flag === "--commit") {
          hasCommitFlag = true;
          commitVal = val;
        }
        continue;
      }
      // Attached `-c<key=value>` short option
      if (tok.startsWith("-c") && tok.length > 2) {
        if (!isValidCodexConfigOverride(tok.slice(2))) return null;
        continue;
      }
      // Reject `-h`, `--help`, `-hh`, `-V`, `--version`, and any unknown option (fail closed).
      return null;
    }
    promptCount++;
    if (promptCount > 1) return null;
  }

  // Clap mutual exclusivity: at most one of --uncommitted, --base, --commit, or [PROMPT].
  const targetModeCount = [hasUncommitted, hasBase, hasCommitFlag, promptCount > 0].filter(
    Boolean,
  ).length;
  if (targetModeCount > 1) {
    return null;
  }
  // Clap requires a target or [PROMPT] when --title is specified.
  if (hasTitle && targetModeCount === 0) {
    return null;
  }

  if (hasBase || (hasCommitFlag && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(commitVal ?? ""))) return null; // Only the launch-time ledger runner can attest this range.
  return { targetDir, hasCommitFlag, commitVal };
}

function extractCliFlagValue(toks: string[], flag: string): string | null {
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === flag && toks[i + 1]) return toks[i + 1];
    if (t.startsWith(`${flag}=`)) return t.slice(flag.length + 1);
  }
  return null;
}

function hasCliFlag(toks: string[], flag: string): boolean {
  return toks.some((t) => t === flag || t.startsWith(`${flag}=`));
}

// A matched review command can yield zero records (for example, a status poll).
export function classifyReviewEvidence(
  segCmdToks: string[], curDir: string, exitCode: number, outputText: string, nonCdCount: number,
): CapturedEvidence[] | null {
  const reviewCliMatch = segCmdToks[0]?.match(
    /(?:^|\/)(review-quality|review-performance|review-simplify|review-comments)$/,
  );
  const parsedCodexReview = !reviewCliMatch
    ? parseCodexReviewCommand(segCmdToks, curDir)
    : null;
  if (!reviewCliMatch && !parsedCodexReview) return null;

  // Never record status polling, help, version, or listing commands as review verdicts!
  if (
    reviewCliMatch &&
    segCmdToks.some(
      (t) =>
        hasCliFlag([t], "--status") ||
        hasCliFlag([t], "--list") ||
        t === "--help" ||
        t === "-h" ||
        t === "--version" ||
        t === "-V" ||
        t === "list",
    )
  ) {
    return [];
  }

  const role = normalizeReviewRole(reviewCliMatch ? reviewCliMatch[1] : "codex-review");
  const repoVal = reviewCliMatch ? extractCliFlagValue(segCmdToks, "--repo") : null;
  const resumed = Boolean(reviewCliMatch && hasCliFlag(segCmdToks, "--resume"));
  const parsedJson = reviewCliMatch ? parseReviewJsonOutput(outputText) : null;
  if (parsedJson?.reviewStarted === false) return [];
  if (reviewCliMatch && nonCdCount !== 1) return [];
  if (resumed && (!parsedJson?.repo || !parsedJson.head || ((exitCode === 0 || parsedJson.status === "findings") && !parsedJson.executionId))) return [];
  const headVal = reviewCliMatch ? extractCliFlagValue(segCmdToks, "--head") : null;
  const commitVal = parsedCodexReview ? parsedCodexReview.commitVal : null;
  const targetDir = parsedCodexReview
    ? parsedCodexReview.targetDir
    : resumed && parsedJson?.repo
      ? resolve(curDir, parsedJson.repo)
    : repoVal
      ? resolve(curDir, repoVal)
      : curDir;
  if (reviewCliMatch) {
    if (parsedJson?.role && normalizeReviewRole(parsedJson.role) !== role) return [];
    if (exitCode === 0 && parsedJson?.status === "pass") {
      if (!parsedJson.role || !parsedJson.repo || !parsedJson.head || !parsedJson.base) return [];
      try {
        const root = runGit(targetDir, ["rev-parse", "--show-toplevel"]);
        if (root.code || realpathSync(root.stdout.replace(/\n$/, "")) !== realpathSync(parsedJson.repo)) return [];
      } catch { return []; }
      for (const [ref, sha] of [[headVal, parsedJson.head], [extractCliFlagValue(segCmdToks, "--base"), parsedJson.base]]) {
        if (!sha || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sha)) return [];
        const commit = runGit(targetDir, ["rev-parse", "--verify", "--end-of-options", (ref ?? sha) + "^{commit}"]);
        if (commit.code || commit.stdout.trim() !== sha) return [];
      }
    }
    // Ignore in-flight / polling JSON statuses completely
    if (
      parsedJson?.status === "running" ||
      parsedJson?.status === "in_progress" ||
      parsedJson?.status === "pending" ||
      parsedJson?.status === "queued"
    ) {
      return [];
    }
    // The shipped CLI emits pass. Older executors emitted completed/passed.
    if (
      exitCode === 0 &&
      ((parsedJson?.status !== "completed" && parsedJson?.status !== "pass") || parsedJson.passed === false)
    ) {
      return [];
    }
  } else if (parsedCodexReview) {
    // Require standalone codex review (no other non-cd commands chained) so HEAD cannot drift mid-command,
    // and ignore pre-execution CLI parse / flag / config / provider rejections where review never started.
    // Anchor checks to the start of output (after any startup WARNING lines) so embedded markers inside
    // diagnostic values (e.g. a multiline provider name containing `OpenAI Codex v1` or `session id: ...`)
    // cannot masquerade as a started session, while any started-session failure still records `review/fail`.
    const trimmedBody = outputText
      .replace(/^(?:\s*WARNING:[^\r\n]*(?:\r?\n|$))+/i, "")
      .trim();
    const isClapParseError =
      exitCode === 2 &&
      (/^error:\s+[\s\S]*For more information, try '--help'\.?$/i.test(trimmedBody) ||
        /^(?:error:\s+[\s\S]*?)?\bUsage:\s+codex\b/i.test(trimmedBody));
    const isPreExecutionCliRejection =
      exitCode === 1 &&
      (/^Error loading config\.toml:/.test(trimmedBody) ||
        /^Error parsing -c overrides:/.test(trimmedBody) ||
        /^Error:\s+Unknown feature flag:/.test(trimmedBody) ||
        /^Error:\s+Model provider\s+`[\s\S]*`\s+not found$/.test(trimmedBody) ||
        /^Error:\s+No default OSS provider configured\b/.test(trimmedBody) ||
        /^Error:\s+OSS setup failed:/.test(trimmedBody) ||
        /^Error:\s+(?:Configuration )?profile\s+`[\s\S]*`\s+not found$/i.test(trimmedBody) ||
        /^Error:\s+`--[\s\S]*?`\s+(?:is only supported for interactive TUI commands|supports new interactive sessions)/i.test(
          trimmedBody,
        ) ||
        /^No prompt provided via stdin\./.test(trimmedBody) ||
        /^Not inside a trusted directory and --skip-git-repo-check was not specified\./.test(
          trimmedBody,
        ));
    if (nonCdCount > 1 || isClapParseError || isPreExecutionCliRejection) {
      return [];
    }
  }

  // Strict 3-condition machine check for credit_balance_exhausted!
  const creditExhausted =
    exitCode === 2 &&
    parsedJson?.status === "error" &&
    parsedJson?.errorCode === "credit_balance_exhausted";

  // Resolve pinned SHA / ref:
  // - For review-agents CLI: prefer parsedJson.head or explicit `--head <ref>` (requirePinnedSha = true).
  // - For `codex review --commit ...` (even empty `--commit=`!): ALWAYS set requirePinnedSha = true
  //   so an older or malformed `--commit` review NEVER falls back to live HEAD!
  const explicitHeadSha =
    headVal && /^[0-9a-f]{7,40}$/i.test(headVal) ? headVal : null;
  const pinnedSha = parsedJson?.head ?? explicitHeadSha;
  const pinnedRef = !pinnedSha ? (commitVal || headVal || null) : null;
  // Plain-text native output has no dependable passing verdict.
  let nativePass = false;
  if (parsedCodexReview && exitCode === 0) {
    try {
      const report = JSON.parse(outputText);
      nativePass = report.overall_correctness === "patch is correct" &&
        Array.isArray(report.findings) && report.findings.length === 0;
    } catch { /* Only structured verdicts can establish a pass. */ }
  }

  const status: "pass" | "fail" = exitCode === 0 && (!parsedCodexReview || nativePass) ? "pass" : "fail";
  return [{
    kind: "review",
    status,
    summary: `${role} exited ${exitCode}${creditExhausted ? " (credit_balance_exhausted)" : ""}`,
    targetDir,
    pinnedSha,
    pinnedRef,
    requirePinnedSha: true,
    meta: {
      role,
      ...(parsedJson?.executionId ? { execution_id: parsedJson.executionId, started_at: parsedJson.startedAt } : {}),
      ...(parsedJson?.reviewTaskId !== undefined ? { review_task_id: parsedJson.reviewTaskId } : {}),
      ...(parsedJson?.reviewFloorSeq !== undefined ? { review_floor_seq: parsedJson.reviewFloorSeq } : {}),
      ...(resumed ? { resumed: true } : {}),
      exit_code: exitCode,
      report_status: parsedJson?.status ?? null,
      error_code: parsedJson?.errorCode ?? null,
      credit_balance_exhausted: creditExhausted,
      base: parsedJson?.base ?? null,
      head: pinnedSha,
    },
  }];
}
