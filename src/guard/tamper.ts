import { type WorkbenchConfig } from "../config";
import { SQL_WRITE_RE } from "./sql-http";
import {
  extractShellCommand,
  extractToolWorkdir,
  extractTouchedFilePaths,
  type CodexHookInput,
} from "../hook-io";
import { dirname, resolve } from "node:path";
import {
  hasUnquotedPipe,
  hasUnquotedRedirect,
  splitShellSegments,
  splitShellTokens,
} from "../shared/shell";

const LEDGER_HOOK_READONLY_INSPECTORS = new Set([
  "ls",
  "stat",
  "file",
  "readlink",
  "realpath",
  "shasum",
  "sha256sum",
  "md5",
  "wc",
  "rg",
  "grep",
  "which",
  "type",
  "cat",
  "head",
  "tail",
]);

const ALLOWED_INSPECTOR_DIRS = new Set([
  "/bin",
  "/usr/bin",
  "/opt/homebrew/bin",
  "/usr/local/bin",
]);

function isReadonlyLedgerHookInspection(
  cmd: string,
  seg: string,
  toks: string[],
): boolean {
  if (hasUnquotedPipe(cmd)) return false;
  if (hasUnquotedRedirect(seg, ">")) return false;
  if (seg.includes("$(") || seg.includes("`")) return false;
  let idx = 0;
  while (idx < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[idx])) idx++;
  if (idx >= toks.length) return false;
  const rawBin = toks[idx];
  const bin = rawBin.split("/").pop() ?? "";
  if (bin === "ledger-hook" || bin === "ledger-hook.js" || bin === "ledger-hook.ts") {
    return false;
  }
  if (!LEDGER_HOOK_READONLY_INSPECTORS.has(bin)) return false;
  // Require bare binary name OR standard system binary directory (never `./ls` or `/tmp/evil/ls`)
  if (rawBin.includes("/")) {
    const dir = dirname(rawBin);
    if (!ALLOWED_INSPECTOR_DIRS.has(dir)) return false;
  }
  // Reject write/helper-executing options per inspector (`file -C`/`-m` compiles magic DB; `rg --pre` executes external commands)
  if (bin === "file") {
    for (const arg of toks.slice(idx + 1)) {
      if (arg === "--") break;
      if (
        arg === "--compile" ||
        arg === "--magic-file" ||
        arg.startsWith("--magic-file=") ||
        (arg.startsWith("-") && !arg.startsWith("--") && /[Cm]/.test(arg.slice(1)))
      ) {
        return false;
      }
    }
  } else if (bin === "rg") {
    for (const arg of toks.slice(idx + 1)) {
      if (arg === "--") break;
      if (
        arg === "--pre" ||
        arg.startsWith("--pre=") ||
        arg === "--pre-glob" ||
        arg.startsWith("--pre-glob=") ||
        arg === "--hostname-bin" ||
        arg.startsWith("--hostname-bin=") ||
        arg === "--search-zip" ||
        (arg.startsWith("-") && !arg.startsWith("--") && arg.includes("z"))
      ) {
        return false;
      }
    }
  }
  return true;
}

export function checkLedgerTamper(
  workbenchRoot: string,
  input: CodexHookInput,
  cfg: WorkbenchConfig,
): string | null {
  if (!cfg.guard.block_ledger_direct_edits) return null;
  const ledgerDir = resolve(workbenchRoot, ".workbench", "ledger");
  const baseWorkdir = extractToolWorkdir(input);

  // 1. File-editing & apply_patch tools directly touching .workbench/ledger/
  for (const rawPath of extractTouchedFilePaths(input)) {
    const abs = resolve(baseWorkdir, rawPath);
    if (abs === ledgerDir || abs.startsWith(ledgerDir + "/")) {
      return "物理保险丝：禁止直接修改 .workbench/ledger/ 下的账本文件，请使用 ledger CLI。";
    }
  }

  // 2. Shell commands directly mutating .workbench/ledger/ or invoking ledger-hook directly (anti-forgery)
  const cmd = extractShellCommand(input);
  if (!cmd) return null;

  for (const seg of splitShellSegments(cmd)) {
    const toks = splitShellTokens(seg);
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
      return "物理保险丝：禁止通过 sqlite3 写/修改 .workbench/ledger/ 账本数据库，请使用 ledger CLI。";
    }

    const hasMutation =
      /\b(rm|mv|cp|truncate|chmod|python3?|perl|sed|awk|tee|dd|bun|node)\b/.test(seg) ||
      hasUnquotedRedirect(seg, ">");
    if (hasMutation) {
      return "物理保险丝：禁止通过 Shell 直接修改或删除 .workbench/ledger/ 原始文件，请使用 ledger CLI（如 ledger prune）。";
    }
  }
  return null;
}
