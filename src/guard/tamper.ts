import { type WorkbenchConfig } from "../config";
import { canonicalizeMaybePath } from "../shared/path";
import { extractGitSubcommand, resolveGitDirFlags } from "../shared/git-cmd";
import { SQL_WRITE_RE } from "./sql-http";
import {
  extractShellCommand,
  extractToolWorkdir,
  extractTouchedFilePaths,
  type CodexHookInput,
} from "../hook-io";
import { dirname, resolve } from "node:path";
import {
  copyDestination,
  policyPathLiterals,
  tarCreateDestination,
  hasUnquotedPipe,
  hasUnquotedRedirect,
  splitShellSegments,
  splitShellTokens,
  stripUnquotedShellRedirections,
  resolveSegmentCwd,
  unwrapShellPrefix,
} from "../shared/shell";

const LEDGER_HOOK_READONLY_INSPECTORS = new Set([
  "ls", "stat", "file", "readlink", "realpath", "shasum", "sha256sum", "md5",
  "wc", "rg", "grep", "which", "type", "cat", "head", "tail",
]);
const ALLOWED_INSPECTOR_DIRS = new Set(["/bin", "/usr/bin", "/opt/homebrew/bin", "/usr/local/bin"]);

function isReadonlyLedgerHookInspection(cmd: string, seg: string, toks: string[]): boolean {
  if (hasUnquotedPipe(cmd)) return false;
  if (hasUnquotedRedirect(seg, ">")) return false;
  if (seg.includes("$(") || seg.includes("`")) return false;
  let idx = 0;
  while (idx < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[idx])) idx++;
  if (idx >= toks.length) return false;
  const rawBin = toks[idx];
  const bin = rawBin.split("/").pop() ?? "";
  if (!LEDGER_HOOK_READONLY_INSPECTORS.has(bin)) return false;
  // Require bare binary name OR standard system binary directory (never `./ls` or `/tmp/evil/ls`)
  if (rawBin.includes("/") && !ALLOWED_INSPECTOR_DIRS.has(dirname(rawBin))) return false;
  // Reject write/helper-executing options per inspector (`file -C`/`-m` compiles magic DB; `rg --pre` executes external commands)
  for (const arg of toks.slice(idx + 1)) {
    if (arg === "--") break;
    const short = arg.startsWith("-") && !arg.startsWith("--");
    if (bin === "file" && (arg === "--compile" || /^--magic-file(?:=|$)/.test(arg) || short && /[Cm]/.test(arg))) return false;
    if (bin === "rg" && (/^--(?:pre|pre-glob|hostname-bin)(?:=|$)/.test(arg) || arg === "--search-zip" || short && arg.includes("z"))) return false;
  }
  return true;
}

export function checkLedgerTamper(
  workbenchRoot: string,
  input: CodexHookInput,
  cfg: WorkbenchConfig,
): string | null {
  const policyPath = canonicalizeMaybePath(resolve(workbenchRoot,".workbench/ship-policy.yaml"));
  const ledgerDir = resolve(workbenchRoot, ".workbench", "ledger");
  const baseWorkdir = extractToolWorkdir(input);

  for (const rawPath of extractTouchedFilePaths(input)) {
    const abs = resolve(baseWorkdir, rawPath);
    if (input.tool_name !== "Read" && canonicalizeMaybePath(abs) === policyPath) return "ship-policy.yaml requires an operator edit.";
    if (cfg.guard.block_ledger_direct_edits && (abs === ledgerDir || abs.startsWith(ledgerDir + "/"))) {
      return "物理保险丝：禁止直接修改 .workbench/ledger/ 下的账本文件，请使用 forge ledger CLI。";
    }
  }

  // 2. Shell commands directly mutating .workbench/ledger/ or invoking ledger-hook directly (anti-forgery)
  const cmd = extractShellCommand(input);
  if (!cmd) return null;

  const segments = splitShellSegments(cmd);
  for (const [index, seg] of segments.entries()) {
    const toks = splitShellTokens(seg);
    const cwd = resolveSegmentCwd(segments, index, baseWorkdir);
    const redirects: string[] = [];
    const command = stripUnquotedShellRedirections(seg, redirects);
    const words = splitShellTokens(command) ?? [];
    const { bin, args, dirs } = unwrapShellPrefix(words);
    const git = bin === "git" ? extractGitSubcommand(["git", ...args]) : null;
    const commandDir = resolveGitDirFlags(cwd, [...dirs, ...(git?.gitDirFlags ?? [])]) ?? cwd;
    const absolute = (path: string) => canonicalizeMaybePath(resolve(commandDir, path));
    const paths = (git?.subArgs ?? args).filter(t => !t.startsWith("-")).map(absolute);
    const fileCommand = git && ["rm", "mv"].includes(git.subcmd) ? git.subcmd : bin;
    const removesTree = ["rm", "mv", "rmdir", "rsync", "tar", "unzip", "ditto", "cp"].includes(fileCommand ?? "") ||
      (bin === "find" && args.includes("-delete"));
    if (bin === "find" && args[0]?.startsWith("-")) paths.push(canonicalizeMaybePath(commandDir));
    const destination = bin === "cp" ? copyDestination(args) : bin === "tar" ? tarCreateDestination(args) : undefined;
    const ancestors = destination ? [absolute(destination)] : bin === "rsync" || bin === "ditto" ? paths.slice(-1) : paths;
    const textOutput = (bin === "echo" || bin === "printf") && !/\$\(|`/.test(command);
    const targetsPolicy = paths.includes(policyPath) || (destination && absolute(destination) === policyPath) ||
      (!textOutput && policyPathLiterals(words).some(path => absolute(path) === policyPath));
    const readsOnly = textOutput || isReadonlyLedgerHookInspection(command, command, words) ||
      (git?.subcmd === "diff" && git.subArgs.every(t => t === "--" || absolute(t) === policyPath));
    if (redirects.some(p => canonicalizeMaybePath(resolve(cwd, p)) === policyPath) ||
        (removesTree && ancestors.some(p => policyPath.startsWith(p + "/"))) || (targetsPolicy && !readsOnly))
      return "ship-policy.yaml requires an operator edit.";
    if (!cfg.guard.block_ledger_direct_edits) continue;
    if (toks) {
      const mentionsLedgerHook = toks.some((tok) => {
        const base = tok.split("/").pop() ?? "";
        return base === "ledger-hook" || base === "ledger-hook.js" || base === "ledger-hook.ts";
      });
      if (mentionsLedgerHook && !isReadonlyLedgerHookInspection(cmd, seg, toks)) {
        return "物理保险丝：禁止通过 Shell 直接调用 ledger-hook（仅允许由 Codex 底层 Hook 运行时调用）。";
      }
    }
    if (!seg.includes(".workbench/ledger") && !seg.includes("ledger.sqlite")) {
      continue;
    }
    const first = toks?.[0]?.split("/").pop() ?? "";
    const isLedgerCli =
      first === "ledger" ||
      ((first === "bun" || first === "node") &&
        Boolean(toks?.[1]?.endsWith("/ledger.js") || toks?.[1]?.endsWith("/ledger.ts")));
    if (isLedgerCli) continue;

    // Allow strictly read-only sqlite3 queries (no write SQL keywords & no redirection)
    if (first === "sqlite3") {
      if (!SQL_WRITE_RE.test(seg) && !hasUnquotedRedirect(seg, ">") && !/\bpragma\b/i.test(seg)) {
        continue;
      }
      return "物理保险丝：禁止通过 sqlite3 写/修改 .workbench/ledger/ 账本数据库，请使用 forge ledger CLI。";
    }

    const hasMutation =
      /\b(rm|mv|cp|truncate|chmod|python3?|perl|sed|awk|tee|dd|bun|node)\b/.test(seg) ||
      hasUnquotedRedirect(seg, ">");
    if (hasMutation) {
      return "物理保险丝：禁止通过 Shell 直接修改或删除 .workbench/ledger/ 原始文件，请使用 forge ledger CLI（如 forge ledger prune）。";
    }
  }
  return null;
}
