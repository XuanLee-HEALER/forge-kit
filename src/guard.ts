import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  collectProdDbHosts,
  findWorkbenchRoot,
  loadWorkbenchConfig,
  parseYamlFile,
  type WorkbenchConfig,
} from "./config";
import {
  getBranchDiffStats,
  getHeadAndParents,
  getStagedDiffStats,
  locateRepo,
  runGit,
} from "./git";
import {
  type CodexHookInput,
  emitPreToolUseDeny,
  extractShellCommand,
  extractToolWorkdir,
  extractTouchedFilePaths,
  readHookStdinStrict,
} from "./hook-io";
import {
  canonicalizeOsPath,
  Ledger,
  normalizeKubectlTokens,
  type RunbookActions,
  type RunbookRecord,
  tokenizeSimpleShellCommand,
} from "./ledger";
import { redactSecrets } from "./cmdfmt";

const SQL_WRITE_RE =
  /\b(insert|update|delete|merge|replace|alter|drop|create|truncate|grant|revoke|copy|call|do|reindex|vacuum|refresh|comment|lock|set|begin|commit|setval|nextval|pg_terminate_backend|pg_cancel_backend|optimize|attach|detach|rename|kill)\b/i;

const SQL_FILE_FLAG_RE = /(^|\s)(-f|--file)(\s|=|$)|\\i\b/;

const KUBECTL_READ_VERBS = new Set([
  "get",
  "describe",
  "logs",
  "top",
  "port-forward",
  "version",
  "explain",
  "api-resources",
  "api-versions",
  "cluster-info",
  "events",
  "wait",
  "diff",
]);

const KUBECTL_READ_SUB: Record<string, Set<string>> = {
  rollout: new Set(["status", "history"]),
  auth: new Set(["can-i", "whoami"]),
  config: new Set(["current-context", "get-contexts"]),
};

const KUBECTL_VALUE_FLAGS = new Set([
  "-n",
  "--namespace",
  "--kubeconfig",
  "--context",
  "--cluster",
  "--user",
  "-s",
  "--server",
  "--as",
  "--request-timeout",
  "--token",
  "-o",
  "--output",
  "-l",
  "--selector",
]);

function pushUtf8Bytes(out: number[], s: string): void {
  for (const b of Buffer.from(s, "utf8")) {
    out.push(b);
  }
}

function decodeAnsiCChunkBytes(
  segment: string,
  startIdx: number,
): { bytes: number[]; nextIdx: number } | null {
  const bytes: number[] = [];
  let nulTruncated = false;
  const pushByte = (b: number): void => {
    if (nulTruncated) return;
    if ((b & 0xff) === 0) {
      nulTruncated = true;
      return;
    }
    bytes.push(b & 0xff);
  };
  const pushUtf8 = (s: string): void => {
    if (nulTruncated) return;
    for (const b of Buffer.from(s, "utf8")) {
      if (b === 0) {
        nulTruncated = true;
        return;
      }
      bytes.push(b);
    }
  };

  for (let i = startIdx; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === "'") {
      return { bytes, nextIdx: i };
    }
    if (ch === "\\" && i + 1 < segment.length) {
      const esc = segment[++i];
      if (esc === "a") pushByte(0x07);
      else if (esc === "b") pushByte(0x08);
      else if (esc === "e" || esc === "E") pushByte(0x1b);
      else if (esc === "f") pushByte(0x0c);
      else if (esc === "n") pushByte(0x0a);
      else if (esc === "r") pushByte(0x0d);
      else if (esc === "t") pushByte(0x09);
      else if (esc === "v") pushByte(0x0b);
      else if (esc === "\\" || esc === "'" || esc === '"' || esc === "?") pushUtf8(esc);
      else if (esc === "c" && i + 1 < segment.length) {
        const ctrlChar = segment[++i];
        pushByte(ctrlChar === "?" ? 0x7f : ctrlChar.toUpperCase().charCodeAt(0) & 0x1f);
      } else if (esc === "x") {
        const hex = segment.slice(i + 1, i + 3).match(/^[0-9a-fA-F]{1,2}/)?.[0];
        if (hex) {
          pushByte(Number.parseInt(hex, 16));
          i += hex.length;
        } else {
          pushUtf8("\\x");
        }
      } else if (esc === "u" || esc === "U") {
        const maxLen = esc === "u" ? 4 : 8;
        const hex = segment.slice(i + 1, i + 1 + maxLen).match(/^[0-9a-fA-F]{1,8}/)?.[0];
        if (hex) {
          const cp = Number.parseInt(hex, 16);
          if (cp === 0) pushByte(0);
          else if (cp <= 0x10ffff) pushUtf8(String.fromCodePoint(cp));
          else pushUtf8(`\\${esc}${hex}`);
          i += hex.length;
        } else {
          pushUtf8(`\\${esc}`);
        }
      } else if (esc >= "0" && esc <= "7") {
        const oct = segment.slice(i, i + 3).match(/^[0-7]{1,3}/)![0];
        pushByte(Number.parseInt(oct, 8));
        i += oct.length - 1;
      } else {
        pushUtf8(`\\${esc}`);
      }
      continue;
    }
    // Preserve full Unicode code points (including surrogate pairs such as emoji 🚀)
    const cp = segment.codePointAt(i)!;
    const fullChar = String.fromCodePoint(cp);
    pushUtf8(fullChar);
    if (fullChar.length > 1) i += fullChar.length - 1;
  }
  return null; // Unclosed $'...'
}

export interface ShellToken {
  value: string;
  /** True ONLY when the `NAME=` prefix (up to and including `=`) was completely unquoted and unescaped (POSIX ASSIGNMENT_WORD). */
  isEnvAssign: boolean;
}

export function splitShellTokensWithMeta(segment: string): ShellToken[] | null {
  const tokens: ShellToken[] = [];
  let curBytes: number[] = [];
  let hasToken = false;
  let quote: "'" | '"' | null = null;
  let escape = false;
  let sawEq = false;
  let sawQuoteOrEscapeBeforeEq = false;
  let validEnvAssign = false;

  const flushToken = (): void => {
    if (!hasToken) return;
    tokens.push({
      value: Buffer.from(curBytes).toString("utf8"),
      isEnvAssign: validEnvAssign,
    });
    curBytes = [];
    hasToken = false;
    sawEq = false;
    sawQuoteOrEscapeBeforeEq = false;
    validEnvAssign = false;
  };

  for (let i = 0; i < segment.length; i++) {
    const cp = segment.codePointAt(i)!;
    const fullChar = String.fromCodePoint(cp);
    const ch = segment[i];
    if (escape) {
      if (!sawEq) sawQuoteOrEscapeBeforeEq = true;
      pushUtf8Bytes(curBytes, fullChar);
      hasToken = true;
      escape = false;
      if (fullChar.length > 1) i += fullChar.length - 1;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") {
        quote = null;
      } else {
        pushUtf8Bytes(curBytes, fullChar);
        if (fullChar.length > 1) i += fullChar.length - 1;
      }
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
        const next = segment[i + 1];
        if (next === '"' || next === "\\" || next === "$" || next === "`") {
          pushUtf8Bytes(curBytes, next);
          i++;
        } else if (next === "\n") {
          // Line continuation inside double quotes removes both `\` and `\n`
          i++;
        } else {
          // Per POSIX/Bash: backslash inside `"..."` stays literal before all other characters
          pushUtf8Bytes(curBytes, "\\");
        }
      } else if (ch === '"') {
        quote = null;
      } else {
        pushUtf8Bytes(curBytes, fullChar);
        if (fullChar.length > 1) i += fullChar.length - 1;
      }
      continue;
    }
    if (ch === "\\") {
      if (segment[i + 1] === "\n") {
        // Line continuation outside quotes removes both `\` and `\n`
        i++;
      } else {
        if (!sawEq) sawQuoteOrEscapeBeforeEq = true;
        escape = true;
        hasToken = true;
      }
    } else if (ch === "$" && segment[i + 1] === "'") {
      if (!sawEq) sawQuoteOrEscapeBeforeEq = true;
      const decoded = decodeAnsiCChunkBytes(segment, i + 2);
      if (!decoded) return null;
      for (const b of decoded.bytes) curBytes.push(b);
      hasToken = true;
      i = decoded.nextIdx;
    } else if (ch === "'" || ch === '"') {
      if (!sawEq) sawQuoteOrEscapeBeforeEq = true;
      quote = ch;
      hasToken = true;
    } else if (ch === "#" && !hasToken) {
      // Unquoted `#` at start of a word begins a POSIX shell comment to end of line.
      while (i < segment.length && segment[i] !== "\n") i++;
    } else if (ch === " " || ch === "\t" || ch === "\n") {
      // Strictly POSIX shell IFS whitespace (ASCII space/tab/LF) — NEVER JS `/\s/` which splits U+00A0 NBSP!
      flushToken();
    } else {
      if (ch === "=" && !sawEq) {
        sawEq = true;
        if (!sawQuoteOrEscapeBeforeEq) {
          const namePart = Buffer.from(curBytes).toString("utf8");
          if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(namePart)) {
            validEnvAssign = true;
          }
        }
      }
      pushUtf8Bytes(curBytes, fullChar);
      hasToken = true;
      if (fullChar.length > 1) i += fullChar.length - 1;
    }
  }
  if (quote !== null) return null;
  flushToken();
  return tokens;
}

export function splitShellTokens(segment: string): string[] | null {
  const toks = splitShellTokensWithMeta(segment);
  return toks ? toks.map((t) => t.value) : null;
}

function trimAsciiWhitespace(s: string): string {
  return s.replace(/^[ \t\n]+|[ \t\n]+$/g, "");
}

export function splitShellSegments(cmd: string): string[] {
  const segs: string[] = [];
  let cur = "";
  let quote: "'" | '"' | "$'" | null = null;
  let escape = false;
  let atWordStart = true;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    const next = cmd[i + 1];
    if (escape) {
      cur += ch;
      escape = false;
      continue;
    }
    if (quote === "'") {
      cur += ch;
      if (ch === "'") quote = null;
      atWordStart = false;
      continue;
    }
    if (quote === "$'") {
      cur += ch;
      if (ch === "\\") escape = true;
      else if (ch === "'") quote = null;
      atWordStart = false;
      continue;
    }
    if (quote === '"') {
      cur += ch;
      if (ch === "\\") escape = true;
      else if (ch === '"') quote = null;
      atWordStart = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      cur += ch;
      if (next !== "\n") atWordStart = false;
      continue;
    }
    if (ch === "$" && next === "'") {
      quote = "$'";
      cur += "$'";
      atWordStart = false;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      atWordStart = false;
      continue;
    }
    if (ch === "#" && atWordStart) {
      // Unquoted `#` at a true POSIX word boundary starts a comment until `\n` or EOF.
      while (i + 1 < cmd.length && cmd[i + 1] !== "\n") i++;
      continue;
    }
    if (ch === ";" || ch === "\n") {
      const trimmed = trimAsciiWhitespace(cur);
      if (trimmed) segs.push(trimmed);
      cur = "";
      atWordStart = true;
      continue;
    }
    if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
      const trimmed = trimAsciiWhitespace(cur);
      if (trimmed) segs.push(trimmed);
      cur = "";
      atWordStart = true;
      i++;
      continue;
    }
    if (ch === "&") {
      const prev = cmd[i - 1];
      if (prev === ">" || prev === "<" || next === ">") {
        cur += ch;
        atWordStart = false;
        continue;
      }
      const trimmed = trimAsciiWhitespace(cur);
      if (trimmed) segs.push(trimmed);
      cur = "";
      atWordStart = true;
      continue;
    }
    if (ch === "|") {
      if (cmd[i - 1] === ">") {
        // Clobber redirection `>|` is part of the current command, NOT a pipe!
        cur += ch;
        atWordStart = false;
        continue;
      }
      const trimmed = trimAsciiWhitespace(cur);
      if (trimmed) segs.push(trimmed);
      cur = "";
      atWordStart = true;
      continue;
    }
    cur += ch;
    atWordStart = ch === " " || ch === "\t" || ch === "(" || ch === ")";
  }
  const tail = trimAsciiWhitespace(cur);
  if (tail) segs.push(tail);
  return segs;
}

/** Detect unquoted shell redirection (`<` or `>`) so SQL comparisons inside quotes don't false-positive. */
export function hasUnquotedRedirect(cmd: string, char: "<" | ">"): boolean {
  let quote: "'" | '"' | null = null;
  let escape = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") escape = true;
      else if (ch === '"') quote = null;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === char) {
      if (char === ">" && cmd[i + 1] === "&") continue; // fd dup like 2>&1
      return true;
    }
  }
  return false;
}

function matchesGlob(filePath: string, glob: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const base = normalized.split("/").pop() ?? normalized;
  const normGlob = glob.replace(/\\/g, "/").replace(/^\.\//, "");
  const target = normGlob.includes("/") ? normalized : base;
  let re = "^";
  let i = 0;
  while (i < normGlob.length) {
    const ch = normGlob[i];
    if (ch === "*") {
      if (normGlob[i + 1] === "*") {
        if (normGlob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
          continue;
        }
        re += ".*";
        i += 2;
        continue;
      }
      re += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      re += "[^/]";
      i += 1;
      continue;
    }
    re += /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
    i += 1;
  }
  re += "$";
  return new RegExp(re).test(target);
}

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

function hasUnquotedPipe(cmd: string): boolean {
  let quote: "'" | '"' | "$'" | null = null;
  let escape = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    const next = cmd[i + 1];
    if (escape) {
      escape = false;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === "$'") {
      if (ch === "\\") escape = true;
      else if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") escape = true;
      else if (ch === '"') quote = null;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === "$" && next === "'") {
      quote = "$'";
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "|") {
      if (next === "|") {
        i++;
        continue;
      }
      if (cmd[i - 1] === ">") continue; // clobber >|
      return true;
    }
  }
  return false;
}

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

/**
 * Parse a real Git remote URL (`git@host:owner/repo.git`, `https://host/owner/repo`, `ssh://...`).
 * NEVER accepts local filesystem paths like `/acme/svc` or `../acme/svc`.
 */
export function parseGitRemoteRepo(
  raw: string,
): { host: string; owner: string; repo: string } | null {
  const cleaned = raw.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  if (!cleaned) return null;
  // ssh scp-style: git@github.com:owner/repo
  const scp = cleaned.match(/^[^@/\s]+@([^:\s]+):([^/\s]+)\/([^/\s]+)$/);
  if (scp) {
    return {
      host: scp[1].toLowerCase(),
      owner: scp[2].toLowerCase(),
      repo: scp[3].toLowerCase(),
    };
  }
  // URL style: https://github.com/owner/repo or ssh://git@ghe.local/owner/repo
  const url = cleaned.match(/^(https?|ssh):\/\/(?:[^@/\s]+@)?([^:/\s]+)(?::(\d+))?\/([^/\s]+)\/([^/\s]+)$/i);
  if (url) {
    const [, scheme, hostname, port, owner, repo] = url;
    const defaultPort = scheme.toLowerCase() === "ssh" ? 22 : scheme.toLowerCase() === "https" ? 443 : 80;
    const host = hostname.toLowerCase() + (port && Number(port) !== defaultPort ? `:${Number(port)}` : "");
    return { host, owner: owner.toLowerCase(), repo: repo.toLowerCase() };
  }
  return null;
}

/**
 * Parse a `gh -R` / PR-URL repository spec (`[host/]owner/repo` or full remote URL).
 * Rejects absolute/relative filesystem paths (`/acme/svc`, `./acme/svc`, `../acme/svc`).
 */
export function parseGhRepoSpec(
  raw: string,
): { host: string; owner: string; repo: string } | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("/") || trimmed.startsWith(".")) return null;
  const asRemote = parseGitRemoteRepo(trimmed);
  if (asRemote) return asRemote;

  const cleaned = trimmed.replace(/\/+$/, "").replace(/\.git$/i, "");
  const parts = cleaned.split("/");
  if (parts.some((p) => !p || p === "." || p === "..")) return null;
  if (parts.length === 2) {
    return {
      host: "github.com",
      owner: parts[0].toLowerCase(),
      repo: parts[1].toLowerCase(),
    };
  }
  if (parts.length === 3 && /^[A-Za-z0-9][A-Za-z0-9._-]*(?::\d+)?$/.test(parts[0])) {
    return {
      host: parts[0].toLowerCase(),
      owner: parts[1].toLowerCase(),
      repo: parts[2].toLowerCase(),
    };
  }
  return null;
}

/**
 * Token-aware HTTP write / ClickHouse HTTP detection for curl, wget, and HTTPie.
 * Handles short attached flags (`-XPOST`, `-dfoo`, `-d@file`, `-Tfile`, `-Ffile=@x`),
 * all `--data*` variants (`--data-ascii`, `--data-binary`, `--data-raw`, `--data-urlencode`),
 * `--json`, `--request`, `--form`, `--upload-file`, wget `--post-*`/`--body-*`/`--method`,
 * and ClickHouse HTTP `:8123` / `query=`.
 */
const GH_PR_CREATE_SHORT_VALUE_FLAGS = new Set([
  "R",
  "H",
  "B",
  "a",
  "b",
  "F",
  "l",
  "m",
  "p",
  "r",
  "t",
  "T",
]);

const GH_PR_CREATE_SHORT_BOOL_FLAGS = new Set(["d", "e", "f", "w"]);

const GH_PR_CREATE_LONG_VALUE_FLAGS = new Set([
  "--repo",
  "--head",
  "--base",
  "--assignee",
  "--attach",
  "--body",
  "--body-file",
  "--label",
  "--milestone",
  "--project",
  "--recover",
  "--reviewer",
  "--template",
  "--title",
]);

const GH_PR_CREATE_LONG_BOOL_FLAGS = new Set([
  "--draft",
  "--dry-run",
  "--editor",
  "--fill",
  "--fill-first",
  "--fill-verbose",
  "--no-maintainer-edit",
  "--web",
  "--help",
]);

// Exact Go strconv.ParseBool spellings (case-sensitive, no whitespace trimming; used by spf13/pflag in gh CLI)
const PFLAG_BOOL_TRUE_VALUES = new Set(["1", "t", "T", "true", "True", "TRUE"]);
const PFLAG_BOOL_FALSE_VALUES = new Set(["0", "f", "F", "false", "False", "FALSE"]);

function parsePflagBool(rawVal: string): boolean | "invalid" {
  if (PFLAG_BOOL_TRUE_VALUES.has(rawVal)) return true;
  if (PFLAG_BOOL_FALSE_VALUES.has(rawVal)) return false;
  return "invalid";
}

const GH_PR_CREATE_CSV_LONG_FLAGS = new Set([
  "--assignee",
  "--label",
  "--project",
  "--reviewer",
]);

const GH_PR_CREATE_CSV_SHORT_FLAGS = new Set(["a", "l", "p", "r"]);

/**
 * Exact Go `encoding/csv` single-record (`Reader.Read()`) validator matching spf13/pflag `readAsCSV`
 * used by StringSlice flags (`--assignee`, `--label`, `--project`, `--reviewer`).
 * - Empty string `""` short-circuits in pflag and is valid.
 * - Leading blank lines (`\n` / `\r\n`) are skipped; if nothing remains, `csv.Reader.Read()` returns EOF (invalid).
 * - Unquoted `\n` or `\r\n` terminates record 1 immediately (trailing lines are ignored by pflag's single Read()).
 * - Quoted fields require closing `"` followed by `,`, `\n`, `\r\n`, or EOF.
 */
function isValidPflagCsvSlice(raw: string): boolean {
  if (raw.length === 0) return true;
  // Go encoding/csv readLine() drops a single trailing `\r` right before EOF (dropCR)
  const input = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
  let i = 0;
  // Skip leading empty lines (`\n` or `\r\n`) as Go encoding/csv does
  while (i < input.length) {
    if (input[i] === "\n") {
      i++;
    } else if (input[i] === "\r" && input[i + 1] === "\n") {
      i += 2;
    } else {
      break;
    }
  }
  if (i >= input.length) return false; // EOF on newline/CR-only input

  let atFieldStart = true;
  let inQuotes = false;
  for (; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          i++; // Escaped quote
        } else if (
          i + 1 === input.length ||
          input[i + 1] === "\n" ||
          (input[i + 1] === "\r" && input[i + 2] === "\n")
        ) {
          return true; // Record 1 ended cleanly at EOF / LF / CRLF
        } else if (input[i + 1] === ",") {
          inQuotes = false;
          atFieldStart = true;
          i++;
        } else {
          return false; // Extraneous character after closing quote
        }
      }
      continue;
    }

    if (ch === "\n" || (ch === "\r" && input[i + 1] === "\n")) {
      return true; // Unquoted LF / CRLF terminates record 1
    }
    if (atFieldStart) {
      if (ch === '"') {
        inQuotes = true;
        atFieldStart = false;
      } else if (ch === ",") {
        atFieldStart = true;
      } else {
        atFieldStart = false;
      }
    } else {
      if (ch === '"') return false; // Bare quote in unquoted field
      if (ch === ",") atFieldStart = true;
    }
  }
  return !inQuotes;
}

export interface ParsedGhPrCreateArgs {
  parseError: boolean;
  help: boolean;
  dryRun: boolean;
  web: boolean;
  hasAttach: boolean;
  repo: string | null;
  head: string | null;
}

/**
 * Unified, single-pass pflag-accurate parser for `gh pr create` (and alias `gh pr new`) arguments.
 * Covers ALL value and boolean flags from `gh pr create --help`:
 * - Exact Go strconv.ParseBool validation on every boolean flag (`--draft`, `--dry-run`, `--web`, `--help`, etc.)
 * - Exact Go encoding/csv validation on StringSlice flags (`--assignee`, `--label`, `--project`, `--reviewer`)
 * - Immediate `parseError = true` on invalid bool/CSV values, unknown flags, missing flag values, or unexpected positionals
 * - Immediate `help = true` on short `-h` (matching gh CLI help interceptor precedence over `--help=f`)
 * - Last-write-wins for valid repeated flags (`--help --help=f`, `--head a --head b`, `--repo a --repo b`)
 */
export function parseGhPrCreateArgs(args: string[]): ParsedGhPrCreateArgs {
  const out: ParsedGhPrCreateArgs = {
    parseError: false,
    help: false,
    dryRun: false,
    web: false,
    hasAttach: false,
    repo: null,
    head: null,
  };
  let shortHelpSeen = false;
  let stopFlags = false;

  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (!stopFlags && t === "--") {
      stopFlags = true;
      continue;
    }
    if (stopFlags || !t.startsWith("-") || t === "-") {
      // `gh pr create` accepts zero positional arguments
      out.parseError = true;
      continue;
    }

    if (t.startsWith("--")) {
      const eqIdx = t.indexOf("=");
      const name = eqIdx === -1 ? t : t.slice(0, eqIdx);
      const eqVal = eqIdx === -1 ? null : t.slice(eqIdx + 1);

      if (GH_PR_CREATE_LONG_VALUE_FLAGS.has(name)) {
        let val: string;
        if (eqVal !== null) {
          val = eqVal;
        } else if (i + 1 < args.length) {
          val = args[++i];
        } else {
          out.parseError = true;
          continue;
        }
        if (GH_PR_CREATE_CSV_LONG_FLAGS.has(name) && !isValidPflagCsvSlice(val)) {
          out.parseError = true;
          continue;
        }
        if (name === "--repo") out.repo = val;
        else if (name === "--head") out.head = val;
        else if (name === "--attach") out.hasAttach = true;
        continue;
      }

      if (GH_PR_CREATE_LONG_BOOL_FLAGS.has(name)) {
        let bVal: boolean;
        if (eqVal !== null) {
          const parsed = parsePflagBool(eqVal);
          if (parsed === "invalid") {
            out.parseError = true;
            continue;
          }
          bVal = parsed;
        } else {
          bVal = true;
        }
        if (name === "--help" && !shortHelpSeen) out.help = bVal;
        else if (name === "--dry-run") out.dryRun = bVal;
        else if (name === "--web") out.web = bVal;
        continue;
      }

      // Unknown long flag (including `--version`, etc.)
      out.parseError = true;
      continue;
    }

    // Single-dash short flag cluster (e.g. `-d`, `-dHtopic`, `-w=F`, `-h=f`, `-dh=false`, `-t --help`)
    for (let k = 1; k < t.length; k++) {
      const ch = t[k];
      if (ch === "h") {
        // gh CLI intercepts `-h` unconditionally as help (even `-h=f` or followed by `--help=f`)
        shortHelpSeen = true;
        out.help = true;
        if (t[k + 1] === "=") break;
        continue;
      }
      if (GH_PR_CREATE_SHORT_VALUE_FLAGS.has(ch)) {
        let val: string;
        if (k < t.length - 1) {
          const rest = t.slice(k + 1);
          val = rest.startsWith("=") ? rest.slice(1) : rest;
        } else if (i + 1 < args.length) {
          val = args[++i];
        } else {
          out.parseError = true;
          break;
        }
        if (GH_PR_CREATE_CSV_SHORT_FLAGS.has(ch) && !isValidPflagCsvSlice(val)) {
          out.parseError = true;
          break;
        }
        if (ch === "R") out.repo = val;
        else if (ch === "H") out.head = val;
        break;
      }
      if (GH_PR_CREATE_SHORT_BOOL_FLAGS.has(ch)) {
        let bVal: boolean;
        if (t[k + 1] === "=") {
          const parsed = parsePflagBool(t.slice(k + 2));
          if (parsed === "invalid") {
            out.parseError = true;
            break;
          }
          bVal = parsed;
          if (ch === "w") out.web = bVal;
          break;
        }
        if (ch === "w") out.web = true;
        continue;
      }
      // Unknown short flag
      out.parseError = true;
      break;
    }
  }

  return out;
}

export function isHttpWriteCommand(cmd: string, depth = 0): boolean {
  for (const seg of splitShellSegments(cmd)) {
    const toks = splitShellTokens(seg);
    if (!toks || toks.length === 0) {
      // Fail closed on unparseable shell segment mentioning an HTTP client
      if (/\b(curl|wget|http|https)\b/.test(seg)) return true;
      continue;
    }
    let matchedDirect = false;
    for (let i = 0; i < toks.length; i++) {
      const bin = toks[i].split("/").pop() ?? "";
      if (bin !== "curl" && bin !== "wget" && bin !== "http" && bin !== "https") {
        // Inspect nested/wrapped shell arguments (e.g. `bash -c 'curl -XPOST ...'`).
        // Fail closed if nesting exceeds max depth so deeply nested wrappers cannot bypass!
        if (/\b(curl|wget|http|https)\b/.test(toks[i])) {
          if (depth >= 3) return true;
          if (isHttpWriteCommand(toks[i], depth + 1)) return true;
        }
        continue;
      }
      matchedDirect = true;
      const rest = toks.slice(i + 1);
      for (let j = 0; j < rest.length; j++) {
        const a = rest[j];
        if (/:8123\b/i.test(a) || /[?&]query=/i.test(a)) return true;

        if (bin === "curl") {
          if (a === "-X" || a === "--request") {
            const method = (rest[j + 1] ?? "").toUpperCase();
            if (method && method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
              return true;
            }
            j++;
            continue;
          }
          if (a.startsWith("-X") && a.length > 2) {
            const method = a.slice(2).toUpperCase();
            if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
              return true;
            }
            continue;
          }
          if (a.startsWith("--request=")) {
            const method = a.slice("--request=".length).toUpperCase();
            if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
              return true;
            }
            continue;
          }
          if (
            a === "-d" ||
            a.startsWith("-d") ||
            a === "-F" ||
            a.startsWith("-F") ||
            a === "-T" ||
            a.startsWith("-T") ||
            a === "--json" ||
            a.startsWith("--json=") ||
            a === "--form" ||
            a.startsWith("--form=") ||
            a === "--form-string" ||
            a.startsWith("--form-string=") ||
            a === "--upload-file" ||
            a.startsWith("--upload-file=") ||
            a === "--data" ||
            a.startsWith("--data-") ||
            a.startsWith("--data=")
          ) {
            return true;
          }
        } else if (bin === "wget") {
          if (
            a === "--post-data" ||
            a.startsWith("--post-data=") ||
            a === "--post-file" ||
            a.startsWith("--post-file=") ||
            a === "--body-data" ||
            a.startsWith("--body-data=") ||
            a === "--body-file" ||
            a.startsWith("--body-file=")
          ) {
            return true;
          }
          if (a === "--method" || a.startsWith("--method=")) {
            const method = (a === "--method" ? rest[j + 1] ?? "" : a.slice("--method=".length)).toUpperCase();
            if (method && method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
              return true;
            }
          }
        } else if (bin === "http" || bin === "https") {
          if (/^(POST|PUT|DELETE|PATCH)$/i.test(a)) {
            return true;
          }
        }
      }
      break;
    }
    if (!matchedDirect) {
      for (const t of toks) {
        if (/\b(curl|wget|http|https)\b/.test(t) && t !== seg) {
          if (depth >= 3) return true;
          if (isHttpWriteCommand(t, depth + 1)) return true;
        }
      }
    }
  }
  return false;
}

export type ApprovedRunbookEntry = { record: RunbookRecord; actions: RunbookActions };

function loadApprovedRunbooksForSession(
  workbenchRoot: string,
  sessionId?: string | null,
): ApprovedRunbookEntry[] {
  const sid = (sessionId ?? "").trim();
  if (!sid) return [];
  const ledger = new Ledger(workbenchRoot);
  try {
    return ledger.listActiveApprovedRunbooks(sid);
  } catch {
    return [];
  } finally {
    ledger.closeDb();
  }
}

function sha256FileForGuard(absPath: string): string | null {
  try {
    if (!existsSync(absPath) || !statSync(absPath).isFile()) return null;
    return createHash("sha256").update(readFileSync(absPath)).digest("hex");
  } catch {
    return null;
  }
}

function isAllowedDbcredSubstitution(
  inner: string,
  workbenchRoot: string,
  workdir: string,
): boolean {
  const trimmed = inner.trim();
  if (!trimmed || /[;|&`<>()\n\r\0'"]/.test(trimmed)) return false;
  const parts = trimmed.split(/[ \t]+/).filter(Boolean);
  if (parts.length !== 2) return false;
  const [bin, envArg] = parts;
  if (!/^[A-Za-z0-9._-]+$/.test(envArg)) return false;
  // Never permit bare `dbcred` resolved via PATH; must be an explicit relative/absolute path
  if (!bin.includes("/")) return false;
  const expectedReal = canonicalizeOsPath(workbenchRoot, ".workbench/bin/dbcred");
  const candidateReal = canonicalizeOsPath(workdir, bin);
  if (!expectedReal || !candidateReal) return false;
  return candidateReal === expectedReal;
}

/**
 * Quote-aware single-command safety check for Runbook-approved SQL migration files:
 * - Permits literal `&` / `?` inside single/double quotes (e.g. PostgreSQL DSN query params).
 * - Permits ONLY exact double-quoted `$(<path-to-.workbench/bin/dbcred> <env>)` credential substitution.
 * - Permits ONLY exact `2>&1` / `1>&2` fd duplication; rejects ALL other output redirections (`>`).
 * - Rejects shell chaining (`;`, `&&`, `||`, `|`, `&`, `\n`), subshells, backticks, heredocs, and arbitrary `$(...)`.
 */
function isSafeSingleSqlShellCommand(
  cmd: string,
  workbenchRoot: string,
  workdir: string,
): boolean {
  let quote: "'" | '"' | null = null;
  let escape = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    const next = cmd[i + 1];
    if (ch === "\0" || ch === "\n" || ch === "\r") return false;
    if (escape) {
      escape = false;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') {
        quote = null;
        continue;
      }
      if (ch === "`") return false;
      if (ch === "$" && next === "(") {
        const closeIdx = cmd.indexOf(")", i + 2);
        if (closeIdx === -1) return false;
        const inner = cmd.slice(i + 2, closeIdx);
        if (!isAllowedDbcredSubstitution(inner, workbenchRoot, workdir)) return false;
        i = closeIdx;
        continue;
      }
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === "$" && next === "'") {
      // Reject Bash ANSI-C `$'...'` quoting for approved SQL migrations to guarantee zero escape-decoding ambiguity
      return false;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    // Reject ALL unquoted `$(...)` (dbcred substitution is only allowed inside double quotes)
    if (ch === "$" && next === "(") return false;
    if (ch === "<") {
      if (next === "<" || next === ">" || next === "&") return false;
      // Reject numbered input redirections on non-stdin fds (e.g. `3< migration.sql`), allow only plain `<` or `0<`
      let dStart = i - 1;
      while (dStart >= 0 && cmd[dStart] >= "0" && cmd[dStart] <= "9") dStart--;
      const numStr = cmd.slice(dStart + 1, i);
      const beforeNum = dStart >= 0 ? cmd[dStart] : undefined;
      if (
        numStr.length > 0 &&
        (beforeNum === undefined || beforeNum === " " || beforeNum === "\t") &&
        numStr !== "0"
      ) {
        return false;
      }
      continue;
    }
    if (ch === ">") {
      // Allow ONLY standalone `2>&1` or `1>&2` fd duplication; reject all file output redirections (`> file`, `>> file`, etc.)
      const prev = cmd[i - 1];
      const beforePrev = cmd[i - 2];
      const targetFd = cmd[i + 2];
      const afterTarget = cmd[i + 3];
      const validSrcFd =
        (prev === "2" || prev === "1") &&
        (beforePrev === undefined || beforePrev === " " || beforePrev === "\t");
      const validDup =
        validSrcFd &&
        next === "&" &&
        (targetFd === "1" || targetFd === "2") &&
        targetFd !== prev &&
        (afterTarget === undefined || afterTarget === " " || afterTarget === "\t");
      if (!validDup) return false;
      i += 2; // consume `>&1` / `>&2`
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "`" || ch === "(" || ch === ")") {
      return false;
    }
  }
  return !escape && quote === null;
}

/**
 * Quote-aware tokenization for a validated single SQL command that separates `< file` / `<file`
 * stdin redirections and drops benign `2>&1` / `1>&2` fd duplications.
 */
function extractSqlTokensAndStdinRedirects(
  cmd: string,
): { args: string[]; stdinFiles: string[] } | null {
  const rawTokens: Array<{ kind: "word" | "stdin" | "fddup"; value: string }> = [];
  let cur = "";
  let hasWord = false;
  let quote: "'" | '"' | null = null;
  let escape = false;

  const flush = () => {
    if (!hasWord) return;
    if (cur === "2>&1" || cur === "1>&2") {
      rawTokens.push({ kind: "fddup", value: cur });
    } else {
      rawTokens.push({ kind: "word", value: cur });
    }
    cur = "";
    hasWord = false;
  };

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    const next = cmd[i + 1];
    if (escape) {
      cur += ch;
      hasWord = true;
      escape = false;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
      hasWord = true;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
        if (next === '"' || next === "\\" || next === "$" || next === "`") {
          escape = true;
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        quote = null;
      } else {
        cur += ch;
      }
      hasWord = true;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === "$" && next === "'") {
      return null;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasWord = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      flush();
      continue;
    }
    if (ch === "<") {
      if (hasWord && /^\d+$/.test(cur)) {
        if (cur !== "0") return null; // Only fd 0 (`0<` or `<`) feeds client stdin!
        cur = "";
        hasWord = false;
      } else {
        flush();
      }
      rawTokens.push({ kind: "stdin", value: "<" });
      continue;
    }
    cur += ch;
    hasWord = true;
  }
  if (quote !== null || escape) return null;
  flush();

  const args: string[] = [];
  const stdinFiles: string[] = [];
  for (let i = 0; i < rawTokens.length; i++) {
    const tok = rawTokens[i];
    if (tok.kind === "fddup") continue;
    if (tok.kind === "stdin") {
      const nextTok = rawTokens[++i];
      if (!nextTok || nextTok.kind !== "word" || !nextTok.value) return null;
      stdinFiles.push(nextTok.value);
      continue;
    }
    args.push(tok.value);
  }
  return { args, stdinFiles };
}

function extractHostsFromConnStr(connStr: string): { hosts: string[]; invalid: boolean } {
  const hosts: string[] = [];
  const trimmed = connStr.trim();
  const uriMatch = trimmed.match(/^(?:postgres(?:ql)?|mysql):\/\/(.*)$/i);
  if (uriMatch) {
    // Replace validated `$(.../dbcred <env>)` placeholders before URI authority/path splitting
    // so slashes inside the helper path (e.g. `.workbench/bin/dbcred`) never truncate the authority!
    const rest = uriMatch[1].replace(/\$\([^)]*\)/g, "CRED");
    const qIdx = rest.indexOf("?");
    const beforeQuery = qIdx >= 0 ? rest.slice(0, qIdx) : rest;
    const queryStr = qIdx >= 0 ? rest.slice(qIdx + 1) : "";
    const slashIdx = beforeQuery.indexOf("/");
    const authority = slashIdx >= 0 ? beforeQuery.slice(0, slashIdx) : beforeQuery;
    const atIdx = authority.lastIndexOf("@");
    const hostPortList = atIdx >= 0 ? authority.slice(atIdx + 1) : authority;
    let invalid = false;
    const addEncodedHost = (encoded: string) => {
      try {
        for (const entry of decodeURIComponent(encoded).split(",")) {
          if (entry.trim()) hosts.push(entry.trim());
          else invalid = true;
        }
      } catch {
        invalid = true;
      }
    };
    if (hostPortList.length > 0) {
      for (const part of hostPortList.split(",")) {
        const p = part.trim();
        let host = p;
        if (p.startsWith("[")) {
          const endBracket = p.indexOf("]");
          if (endBracket < 0) { invalid = true; continue; }
          host = p.slice(1, endBracket);
        } else {
          const colonIdx = p.lastIndexOf(":");
          if (colonIdx >= 0) host = p.slice(0, colonIdx);
        }
        addEncodedHost(host);
      }
    }
    if (queryStr) {
      for (const pair of queryStr.split("&")) {
        if (!pair) continue;
        const eqIdx = pair.indexOf("=");
        const rawKey = eqIdx >= 0 ? pair.slice(0, eqIdx) : pair;
        const rawVal = eqIdx >= 0 ? pair.slice(eqIdx + 1) : "";
        try {
          const key = decodeURIComponent(rawKey).toLowerCase();
          if (key === "host") {
            for (const entry of rawVal.split(",")) addEncodedHost(entry);
          } else {
            decodeURIComponent(rawVal);
            if (key === "service" || key === "hostaddr") invalid = true;
          }
        } catch {
          invalid = true;
        }
      }
    }
    return { hosts, invalid };
  }

  // libpq keyword=value connection string (e.g. `host = prod-db.internal dbname=app`)
  if (trimmed.includes("=")) {
    let i = 0;
    while (i < trimmed.length) {
      while (i < trimmed.length && (trimmed[i] === " " || trimmed[i] === "\t")) i++;
      if (i >= trimmed.length) break;
      const eqIdx = trimmed.indexOf("=", i);
      if (eqIdx < 0) return { hosts, invalid: true };
      const key = trimmed.slice(i, eqIdx).trim().toLowerCase();
      if (!/^[a-z_][a-z0-9_]*$/.test(key)) return { hosts, invalid: true };
      i = eqIdx + 1;
      while (i < trimmed.length && (trimmed[i] === " " || trimmed[i] === "\t")) i++;
      if (i >= trimmed.length) return { hosts, invalid: true };
      let val = "";
      if (trimmed[i] === "'") {
        i++;
        let closed = false;
        while (i < trimmed.length) {
          if (trimmed[i] === "\\" && i + 1 < trimmed.length) {
            val += trimmed[i + 1];
            i += 2;
          } else if (trimmed[i] === "'") {
            i++;
            closed = true;
            break;
          } else {
            val += trimmed[i++];
          }
        }
        if (!closed) return { hosts, invalid: true };
      } else {
        while (i < trimmed.length && trimmed[i] !== " " && trimmed[i] !== "\t") {
          if (trimmed[i] === "\\" && i + 1 < trimmed.length) {
            val += trimmed[i + 1];
            i += 2;
          } else {
            val += trimmed[i++];
          }
        }
      }
      if (key === "service" || key === "hostaddr") return { hosts, invalid: true };
      if (key === "host") {
        if (!val.trim()) return { hosts, invalid: true };
        for (const h of val.split(",")) {
          if (!h.trim()) return { hosts, invalid: true };
          hosts.push(h.trim());
        }
      }
    }
  }
  return { hosts, invalid: false };
}

const DISALLOWED_PSQL_ENV_VARS = new Set([
  "PSQLRC",
  "PGSERVICE",
  "PGSERVICEFILE",
  "PGHOSTADDR",
]);
const DISALLOWED_MYSQL_ENV_VARS = new Set([
  "MYSQL_HOME",
  "MYSQL_GROUP_SUFFIX",
  "MYSQL_TEST_LOGIN_FILE",
]);
const DISALLOWED_USQL_ENV_VARS = new Set([
  "USQLRC",
  "PSQLRC",
  "PGSERVICE",
  "PGSERVICEFILE",
  "PGHOSTADDR",
  "MYSQL_HOME",
]);

const PSQL_LONG_VALUE_FLAGS = new Set([
  "--host",
  "--port",
  "--username",
  "--dbname",
  "--file",
  "--set",
  "--variable",
  "--pset",
]);
const PSQL_LONG_BOOL_FLAGS = new Set([
  "--no-psqlrc",
  "--quiet",
  "--echo-all",
  "--echo-errors",
  "--echo-queries",
  "--single-transaction",
  "--tuples-only",
  "--no-align",
  "--csv",
  "--expanded",
  "--no-password",
  "--password",
]);
const PSQL_SHORT_VALUE_FLAGS = new Set(["h", "p", "U", "d", "f", "v", "P"]);
const PSQL_SHORT_BOOL_FLAGS = new Set(["X", "q", "a", "b", "e", "1", "t", "A", "x", "w", "W"]);

const USQL_LONG_VALUE_FLAGS = new Set(["--file", "--set", "--variable", "--pset"]);
const USQL_LONG_BOOL_FLAGS = new Set([
  "--no-rc",
  "--quiet",
  "--single-transaction",
  "--no-align",
  "--tuples-only",
  "--json",
  "--csv",
]);
const USQL_SHORT_VALUE_FLAGS = new Set(["f", "v", "P"]);
const USQL_SHORT_BOOL_FLAGS = new Set(["X", "q", "1", "A", "t", "J", "C"]);

const MYSQL_LONG_VALUE_FLAGS = new Set([
  "--host",
  "--port",
  "--user",
  "--password",
  "--database",
  "--default-character-set",
  "--ssl-mode",
  "--protocol",
]);
const MYSQL_LONG_BOOL_FLAGS = new Set([
  "--verbose",
  "--batch",
  "--skip-column-names",
  "--silent",
  "--ssl",
  "--skip-ssl",
  "--no-auto-rehash",
]);
const MYSQL_SHORT_VALUE_FLAGS = new Set(["h", "P", "u", "p", "D"]);
const MYSQL_SHORT_BOOL_FLAGS = new Set(["v", "B", "N", "s", "A"]);

function normalizeSqlHosts(bin: string, values: string[]): string[] {
  return values.flatMap((value) => bin === "psql" ? value.split(",") : [value])
    .map((host) => host.trim().toLowerCase());
}

function parseSqlClientArgs(bin: "psql" | "mysql" | "usql", toks: string[], inspectWrites: boolean) {
  const hostCandidates: string[] = [];
  const longValueFlags =
    bin === "psql"
      ? PSQL_LONG_VALUE_FLAGS
      : bin === "usql"
        ? USQL_LONG_VALUE_FLAGS
        : MYSQL_LONG_VALUE_FLAGS;
  const longBoolFlags =
    bin === "psql"
      ? PSQL_LONG_BOOL_FLAGS
      : bin === "usql"
        ? USQL_LONG_BOOL_FLAGS
        : MYSQL_LONG_BOOL_FLAGS;
  const shortValueFlags =
    bin === "psql"
      ? PSQL_SHORT_VALUE_FLAGS
      : bin === "usql"
        ? USQL_SHORT_VALUE_FLAGS
        : MYSQL_SHORT_VALUE_FLAGS;
  const shortBoolFlags =
    bin === "psql"
      ? PSQL_SHORT_BOOL_FLAGS
      : bin === "usql"
        ? USQL_SHORT_BOOL_FLAGS
        : MYSQL_SHORT_BOOL_FLAGS;

  const flagFiles: string[] = [];
  const positionals: string[] = [];
  let dbname: string | undefined;
  let stopFlags = false;

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!stopFlags && t === "--") {
      stopFlags = true;
      continue;
    }
    if (!stopFlags && t.startsWith("--")) {
      const eq = t.indexOf("=");
      const name = eq >= 0 ? t.slice(0, eq) : t;
      const eqVal = eq >= 0 ? t.slice(eq + 1) : null;
      if (longBoolFlags.has(name)) {
        if (eqVal !== null) return null;
        continue;
      }
      if (longValueFlags.has(name) || (inspectWrites && name === (bin === "psql" ? "--command" : "--execute"))) {
        const val = eqVal !== null ? eqVal : toks[++i];
        if (val === undefined || val === "") return null;
        if (name === "--file") flagFiles.push(val);
        else if (name === "--host") hostCandidates.push(val);
        else if (name === "--dbname" && bin === "psql") {
          if (dbname !== undefined) return null;
          dbname = val;
        }
        continue;
      }
      return null; // Reject unknown or dangerous long flag (`--command`, `--execute`, `--output`, `--defaults-file`, etc.)
    }
    if (!stopFlags && t.startsWith("-") && t.length > 1) {
      for (let j = 1; j < t.length; j++) {
        const ch = t[j];
        if (shortBoolFlags.has(ch)) continue;
        if (shortValueFlags.has(ch) || (inspectWrites && ch === (bin === "psql" ? "c" : "e"))) {
          const val = j < t.length - 1 ? t.slice(j + 1) : toks[++i];
          if (val === undefined || val === "") return null;
          if (ch === "f") flagFiles.push(val);
          else if (ch === "h") hostCandidates.push(val);
          else if (ch === "d" && bin === "psql") {
            if (dbname !== undefined) return null;
            dbname = val;
          }
          break;
        }
        return null; // Reject unknown or dangerous short flag (`-c`, `-Xc`, `-e`, `-Be`, `-o`, etc.)
      }
      continue;
    }
    positionals.push(t);
  }

  // Parse positional connection targets per client grammar
  if (bin === "psql") {
    if (positionals.length > 2 || (dbname !== undefined && positionals.length > 0)) return null;
    const connection = dbname ?? positionals[0];
    if (connection) {
      const parsedConn = extractHostsFromConnStr(connection);
      if (parsedConn.invalid) return null;
      hostCandidates.push(...parsedConn.hosts);
    }
  } else if (bin === "usql") {
    // usql requires a single explicit URI DSN positional
    if (positionals.length !== 1 || !/^(?:postgres(?:ql)?|mysql):\/\//i.test(positionals[0])) {
      return null;
    }
    const parsedConn = extractHostsFromConnStr(positionals[0]);
    if (parsedConn.invalid) return null;
    hostCandidates.push(...parsedConn.hosts);
  } else {
    if (positionals.length > 1) return null;
  }

  return { hostCandidates, flagFiles };
}

function parseApprovedSqlMigrationCommand(
  workbenchRoot: string,
  cmd: string,
  workdir: string,
): { host: string; sqlRealPath: string } | null {
  if (!isSafeSingleSqlShellCommand(cmd, workbenchRoot, workdir)) return null;
  if (splitShellSegments(cmd).length !== 1) return null;
  const extracted = extractSqlTokensAndStdinRedirects(cmd);
  if (!extracted || extracted.args.length < 2) return null;
  const { args: toks, stdinFiles } = extracted;

  // Identify client binary FIRST, then apply case-sensitive client-specific env & option rules!
  const rawEnvPairs: Array<[string, string]> = [];
  let idx = 0;
  while (idx < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[idx])) {
    const eq = toks[idx].indexOf("=");
    rawEnvPairs.push([toks[idx].slice(0, eq), toks[idx].slice(eq + 1)]);
    idx++;
  }
  const bin = (toks[idx] ?? "").split("/").pop() ?? "";
  if (bin !== "psql" && bin !== "usql" && bin !== "mysql") return null;

  const disallowedEnv =
    bin === "psql"
      ? DISALLOWED_PSQL_ENV_VARS
      : bin === "usql"
        ? DISALLOWED_USQL_ENV_VARS
        : DISALLOWED_MYSQL_ENV_VARS;
  const inlineEnv = new Map(rawEnvPairs);
  for (const key of disallowedEnv) {
    if (inlineEnv.get(key) ?? process.env[key]) return null;
  }
  const hostEnvKey = bin === "psql" ? "PGHOST" : bin === "mysql" ? "MYSQL_HOST" : null;
  const parsed = parseSqlClientArgs(bin, toks.slice(idx + 1), false);
  if (!parsed) return null;
  const { hostCandidates, flagFiles } = parsed;
  const allFiles = [...flagFiles, ...stdinFiles];
  if (allFiles.length !== 1 || !allFiles[0]) return null;

  if (hostCandidates.length === 0 && hostEnvKey) {
    const host = inlineEnv.get(hostEnvKey) ?? process.env[hostEnvKey];
    if (host) hostCandidates.push(host);
  }
  const normalizedHosts = new Set(normalizeSqlHosts(bin, hostCandidates));
  if (normalizedHosts.has("") || normalizedHosts.size !== 1) return null;
  const effectiveHost = [...normalizedHosts][0];

  const sqlRealPath = canonicalizeOsPath(workdir, allFiles[0]);
  if (!sqlRealPath) return null;
  return { host: effectiveHost, sqlRealPath };
}

/**
 * Strip unquoted shell redirections (`> /dev/null`, `2>&1`, `>> log`, `< input`) from a command segment
 * while preserving quoted literal filenames (e.g. `"foo>bar.test.js"`).
 */
export function stripUnquotedShellRedirections(seg: string): string {
  let out = "";
  let quote: "'" | '"' | "$'" | null = null;
  let escape = false;
  let i = 0;
  const skipTargetWord = () => {
    while (i < seg.length && (seg[i] === " " || seg[i] === "\t")) i++;
    let wQuote: "'" | '"' | "$'" | null = null;
    let wEscape = false;
    while (i < seg.length) {
      const c = seg[i];
      const nx = seg[i + 1];
      if (wEscape) {
        wEscape = false;
        i++;
        continue;
      }
      if (wQuote === "'") {
        if (c === "'") wQuote = null;
        i++;
        continue;
      }
      if (wQuote === "$'") {
        if (c === "\\") wEscape = true;
        else if (c === "'") wQuote = null;
        i++;
        continue;
      }
      if (wQuote === '"') {
        if (c === "\\") wEscape = true;
        else if (c === '"') wQuote = null;
        i++;
        continue;
      }
      if (c === "\\") {
        wEscape = true;
        i++;
        continue;
      }
      if (c === "$" && nx === "'") {
        wQuote = "$'";
        i += 2;
        continue;
      }
      if (c === "'" || c === '"') {
        wQuote = c;
        i++;
        continue;
      }
      if (c === " " || c === "\t" || c === "\n" || c === ">" || c === "<") break;
      i++;
    }
  };

  while (i < seg.length) {
    const ch = seg[i];
    const next = seg[i + 1];
    if (escape) {
      out += ch;
      escape = false;
      i++;
      continue;
    }
    if (quote === "'") {
      out += ch;
      if (ch === "'") quote = null;
      i++;
      continue;
    }
    if (quote === "$'") {
      out += ch;
      if (ch === "\\") escape = true;
      else if (ch === "'") quote = null;
      i++;
      continue;
    }
    if (quote === '"') {
      out += ch;
      if (ch === "\\") escape = true;
      else if (ch === '"') quote = null;
      i++;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      escape = true;
      i++;
      continue;
    }
    if (ch === "$" && next === "'") {
      quote = "$'";
      out += "$'";
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if ((ch === "&" && next === ">") || ch === ">" || ch === "<") {
      // Drop any immediately preceding unquoted fd digits at word start (e.g. `2>` or `1>`)
      if (ch === ">" || ch === "<") {
        let dEnd = out.length;
        while (dEnd > 0 && out[dEnd - 1] >= "0" && out[dEnd - 1] <= "9") dEnd--;
        if (dEnd < out.length && (dEnd === 0 || out[dEnd - 1] === " " || out[dEnd - 1] === "\t")) {
          out = out.slice(0, dEnd);
        }
      }
      if (ch === "&" && next === ">") {
        i += seg[i + 2] === ">" ? 3 : 2;
      } else if (ch === ">" && (next === ">" || next === "|" || next === "&")) {
        i += 2;
      } else if (ch === "<" && (next === "&" || next === ">")) {
        i += 2;
      } else {
        i += 1;
      }
      skipTargetWord();
      out += " ";
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

export function unwrapShellPrefix(toks: string[]) {
  let i = 0;
  let clearedEnv = false;
  let ambiguous = false;
  const env = new Map<string, string>();
  const unsetKeys = new Set<string>();
  const dirs: string[] = [];
  while (i < toks.length) {
    const tok = toks[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
      const eq = tok.indexOf("=");
      env.set(tok.slice(0, eq), tok.slice(eq + 1));
      unsetKeys.delete(tok.slice(0, eq));
      i++;
      continue;
    }
    const name = tok.split("/").pop();
    if (name === "command") {
      i++;
      while (toks[i] === "-p" || toks[i] === "--") i++;
      continue;
    }
    if (name !== "env") break;
    i++;
    while (toks[i]?.startsWith("-")) {
      const opt = toks[i++];
      if (opt === "--") break;
      if (["-i", "--ignore-environment", "-"].includes(opt)) {
        clearedEnv = true;
        env.clear();
        unsetKeys.clear();
      } else if (opt.startsWith("-u") || opt === "--unset" || opt.startsWith("--unset=")) {
        const key = opt === "-u" || opt === "--unset" ? toks[i++] :
          opt.startsWith("--unset=") ? opt.slice(8) : opt.slice(2);
        if (!key) { ambiguous = true; break; }
        unsetKeys.add(key);
        env.delete(key);
      } else if (opt.startsWith("-P")) {
        if (opt === "-P") i++;
      } else if (opt.startsWith("-C") || opt === "--chdir" || opt.startsWith("--chdir=")) {
        const dir = opt.startsWith("--chdir=") ? opt.slice(8) : opt.startsWith("-C") && opt.length > 2 ? opt.slice(2) : toks[i++];
        if (!dir) { ambiguous = true; break; }
        dirs.push(dir);
      } else {
        ambiguous = true;
        break;
      }
    }
    if (ambiguous) break;
  }
  const effective = (key: string) => env.get(key) ??
    (clearedEnv || unsetKeys.has(key) ? "" : process.env[key] ?? "");
  return { bin: toks[i]?.split("/").pop(), args: toks.slice(i + 1), effective, ambiguous, dirs };
}

// Inspect split-string arguments only to identify commands that must be gated.
function expandEnvSplitStrings(toks: string[]): string[] {
  return toks.flatMap((tok, i) => {
    if (toks[i - 1] === "-S" || toks[i - 1] === "--split-string") return splitShellTokens(tok) ?? [tok];
    if (tok.startsWith("--split-string=")) return splitShellTokens(tok.slice("--split-string=".length)) ?? [tok];
    if (tok.startsWith("-S") && tok.length > 2) return splitShellTokens(tok.slice(2)) ?? [tok];
    return [tok];
  });
}

function findSqlClient(toks: string[]) {
  const idx = toks.findIndex((tok) => /(?:^|\/)(psql|mysql|usql)$/.test(tok));
  return { bin: toks[idx]?.split("/").pop(), args: toks.slice(idx + 1) };
}

function extractCheckProdDbHosts(bin: "psql" | "usql" | "mysql", args: string[]) {
  const parsedArgs = parseSqlClientArgs(bin, args, true);
  if (parsedArgs) {
    const hosts = parsedArgs.hostCandidates;
    return { hosts, unsafeOverride: normalizeSqlHosts(bin, hosts).some((h) => !h || hasShellExpansion(h)) };
  }
  // Even with unsupported options, inspect known host selectors. Ambiguous operands
  // must not suppress the inherited host when deciding whether production is in scope.
  const hosts: string[] = [];
  let unsafeOverride = false;
  let stopFlags = false;
  let positionals = 0;
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (!stopFlags && tok === "--") { stopFlags = true; continue; }
    let conn = tok;
    if (!stopFlags && tok.startsWith("-")) {
      const eq = tok.indexOf("=");
      const opt = eq < 0 ? tok : tok.slice(0, eq);
      if (["--defaults-file", "--defaults-extra-file", "--defaults-group-suffix", "--login-path"].includes(opt)) {
        unsafeOverride = true;
      }
      if (opt === "--host" || opt === "--dbname" || /^-[hd]/.test(tok)) {
        const value = tok.startsWith("--") ? (eq < 0 ? args[++i] : tok.slice(eq + 1))
          : tok.slice(2) || args[++i];
        if (!value) { unsafeOverride = true; continue; }
        if (opt === "--host" || tok.startsWith("-h")) { hosts.push(value); continue; }
        conn = value;
      } else {
        const values = bin === "mysql" ? MYSQL_LONG_VALUE_FLAGS : PSQL_LONG_VALUE_FLAGS;
        if (eq < 0 && (values.has(opt) || ["-c", "-e", "-f", "-U", "-u", "-P", "-v", "--execute", "--command", "--connect-timeout"].includes(opt))) i++;
        else if (eq < 0 && !opt.startsWith("--")) unsafeOverride = true;
        else if (eq < 0 && opt.startsWith("--") &&
          !(bin === "mysql" ? MYSQL_LONG_BOOL_FLAGS : PSQL_LONG_BOOL_FLAGS).has(opt)) unsafeOverride = true;
        continue;
      }
    }
    if (stopFlags || !tok.startsWith("-")) positionals++;
    if (bin !== "mysql" && (/^(postgres(?:ql)?|mysql):\/\//i.test(conn) || conn.includes("="))) {
      if (positionals > 1) unsafeOverride = true;
      const parsed = extractHostsFromConnStr(conn);
      hosts.push(...parsed.hosts);
      if (parsed.invalid) unsafeOverride = true;
    }
  }
  if (normalizeSqlHosts(bin, hosts).some((h) => !h || hasShellExpansion(h))) unsafeOverride = true;
  return { hosts, unsafeOverride };
}

function hasSqlClientFileOption(cmd: string): boolean {
  for (const seg of splitShellSegments(cmd)) {
    const toks = splitShellTokens(seg);
    if (!toks || toks.length === 0) continue;
    const prefix = unwrapShellPrefix(toks);
    const { bin, args } = prefix.ambiguous ? findSqlClient(expandEnvSplitStrings(toks)) : prefix;
    if (bin !== "psql" && bin !== "usql" && bin !== "mysql") continue;
    for (const t of args) {
      if (t === "--") break;
      if (t === "--file" || t.startsWith("--file=")) return true;
      if (t.startsWith("-") && !t.startsWith("--") && t.length > 1) {
        if (bin === "psql" || bin === "usql") {
          for (let j = 1; j < t.length; j++) {
            const ch = t[j];
            if (ch === "f") return true;
            if (PSQL_SHORT_VALUE_FLAGS.has(ch) || ch === "c" || ch === "o" || ch === "L") break;
          }
        }
      }
    }
  }
  return false;
}

const SAFE_LEDGER_CLI_SUBCMDS = new Set([
  "runbook",
  "open",
  "close",
  "record",
  "decide",
  "blocker",
  "status",
  "query",
  "attach",
  "detach",
  "reopen",
  "set-endpoint",
  "cancel",
  "verify",
]);

/**
 * Verify that `cmd` is a standalone, metacharacter-free invocation of this workbench's own
 * canonical `.workbench/bin/ledger` CLI (which only operates on local `.workbench/ledger/ledger.sqlite`
 * and never connects to remote databases). Prevents `checkProdDb` from falsely blocking commands like
 * `.workbench/bin/ledger runbook create --sql <prod-host>:<file>` or `ledger record --summary "... <prod-host> ..."`.
 */
function isSafeWorkbenchLedgerCliCommand(
  cmd: string,
  workbenchRoot: string,
  workdir: string,
): boolean {
  let quote: "'" | '"' | null = null;
  let escape = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    const next = cmd[i + 1];
    if (ch === "\0" || ch === "\n" || ch === "\r") return false;
    if (escape) {
      escape = false;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') {
        quote = null;
        continue;
      }
      if (ch === "`" || (ch === "$" && next === "(")) return false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === "$" && next === "'") {
      return false;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "$" && next === "(") return false;
    if (
      ch === ";" ||
      ch === "|" ||
      ch === "&" ||
      ch === ">" ||
      ch === "<" ||
      ch === "`" ||
      ch === "(" ||
      ch === ")"
    ) {
      return false;
    }
  }
  if (escape || quote !== null) return false;
  if (splitShellSegments(cmd).length !== 1) return false;
  const toks = splitShellTokens(cmd);
  if (!toks || toks.length < 2) return false;
  const bin = toks[0];
  if (!bin.includes("/")) return false;
  const expectedLedger = canonicalizeOsPath(workbenchRoot, ".workbench/bin/ledger");
  const candidateLedger = canonicalizeOsPath(workdir, bin);
  if (!expectedLedger || !candidateLedger || candidateLedger !== expectedLedger) {
    return false;
  }
  return SAFE_LEDGER_CLI_SUBCMDS.has(toks[1]);
}

export function checkProdDb(
  cmd: string,
  prodHosts: string[],
  toolWorkdir = process.cwd(),
  approvedRunbooks: ApprovedRunbookEntry[] = [],
  workbenchRoot = toolWorkdir,
): string | null {
  if (prodHosts.length === 0) return null;
  if (isSafeWorkbenchLedgerCliCommand(cmd, workbenchRoot, toolWorkdir)) return null;
  const matchedHosts: string[] = [];
  for (const seg of splitShellSegments(cmd)) {
    const toks = splitShellTokens(stripUnquotedShellRedirections(seg)) ?? [];
    const { bin, effective, args, ambiguous } = unwrapShellPrefix(toks);
    let literal = seg;
    const hosts: string[] = [];
    if (ambiguous) {
      const client = findSqlClient(expandEnvSplitStrings(toks));
      if (client.bin === "psql" || client.bin === "mysql" || client.bin === "usql") {
        hosts.push(...normalizeSqlHosts(client.bin, extractCheckProdDbHosts(client.bin, client.args).hosts));
      }
      for (const key of ["PGHOST", "PGHOSTADDR", "MYSQL_HOST"]) {
        hosts.push(...normalizeSqlHosts("psql", [effective(key), process.env[key] ?? ""]));
      }
    } else if (bin === "psql" || bin === "mysql" || bin === "usql") {
      const parsed = extractCheckProdDbHosts(bin, args);
      hosts.push(...parsed.hosts);
      if (hosts.length && !parsed.unsafeOverride) literal = args.join(" ");
      else if (bin !== "usql") hosts.push(effective(bin === "psql" ? "PGHOST" : "MYSQL_HOST"));
      if (bin === "psql") hosts.push(effective("PGHOSTADDR"));
    }
    const normalized = normalizeSqlHosts(bin ?? "", hosts);
    matchedHosts.push(...prodHosts.filter((h) => literal.toLowerCase().includes(h.toLowerCase()) || normalized.includes(h.toLowerCase())));
  }
  if (matchedHosts.length === 0) return null;
  const matchedHost = matchedHosts[0];

  // ClickHouse HTTP write or POST/PUT/DELETE via curl/wget/http
  if (isHttpWriteCommand(cmd)) {
    if (SQL_WRITE_RE.test(cmd) || !/\bselect\b/i.test(cmd)) {
      return `物理保险丝：检测到向 prod 数据库 (${matchedHost}) 发送写请求，禁止自动执行。`;
    }
  }

  if (SQL_FILE_FLAG_RE.test(cmd) || hasUnquotedRedirect(cmd, "<") || hasSqlClientFileOption(cmd)) {
    if (approvedRunbooks.length > 0) {
      const parsed = parseApprovedSqlMigrationCommand(workbenchRoot, cmd, toolWorkdir);
      if (parsed && prodHosts.some((h) => h.toLowerCase() === parsed.host)) {
        const liveSha = sha256FileForGuard(parsed.sqlRealPath);
        if (
          liveSha &&
          approvedRunbooks.some((rb) =>
            rb.actions.sql_files.some(
              (sf) =>
                sf.host.toLowerCase() === parsed.host &&
                sf.path === parsed.sqlRealPath &&
                sf.sha256 === liveSha,
            ),
          )
        ) {
          return null;
        }
      }
    }
    return `物理保险丝：检测到连接 prod 数据库 (${matchedHost}) 且 SQL 来自文件或标准输入，禁止自动执行（如需发版迁移，请先创建 Runbook 登记 SQL 文件并由用户在对话中回复「批准 <runbook_id>」）。`;
  }
  const m = cmd.match(SQL_WRITE_RE);
  if (m) {
    return `物理保险丝：检测到连接 prod 数据库 (${matchedHost}) 且包含写操作关键字 ${m[1].toUpperCase()}，禁止自动执行。`;
  }
  return null;
}

export function checkKubectl(
  cmd: string,
  approvedRunbooks: ApprovedRunbookEntry[] = [],
): string | null {
  if (!cmd.includes("kubectl")) return null;
  const segments = splitShellSegments(cmd);
  for (const seg of segments) {
    if (!seg.includes("kubectl")) continue;
    const toks = splitShellTokens(seg);
    if (!toks) {
      return "物理保险丝：kubectl 命令无法安全解析，禁止自动执行。";
    }
    for (let i = 0; i < toks.length; i++) {
      const tok = toks[i].replace(/^[$`(\s]+/, "");
      if (tok !== "kubectl" && !tok.endsWith("/kubectl")) continue;

      const words: string[] = [];
      let skipNext = false;
      for (let j = i + 1; j < toks.length; j++) {
        const a = toks[j];
        if (skipNext) {
          skipNext = false;
          continue;
        }
        if (KUBECTL_VALUE_FLAGS.has(a)) {
          skipNext = true;
          continue;
        }
        if (a.startsWith("-")) continue;
        words.push(a);
      }
      if (words.length === 0) continue;

      // Permanent redline: NEVER allow secret access even via Runbook!
      for (const w of words.slice(1)) {
        for (const p of w.split(",")) {
          if (/^secrets?(\/|$|\.)/i.test(p.trim())) {
            return "物理保险丝：kubectl 读取 secret 资源，禁止自动执行。";
          }
        }
      }

      const verb = words[0];
      const sub = words[1] ?? "";
      const isReadonly =
        verb in KUBECTL_READ_SUB ? KUBECTL_READ_SUB[verb].has(sub) : KUBECTL_READ_VERBS.has(verb);
      if (!isReadonly) {
        if (approvedRunbooks.length > 0 && segments.length === 1 && !/[|;&`\n\r<>]|\$\(/.test(cmd)) {
          const normCur = normalizeKubectlTokens(toks.slice(i));
          if (
            normCur &&
            i === 0 &&
            approvedRunbooks.some((rb) =>
              rb.actions.kubectl_commands.some((allowed) => {
                const allowedToks = tokenizeSimpleShellCommand(allowed);
                const normAllowed = allowedToks ? normalizeKubectlTokens(allowedToks) : null;
                return normAllowed !== null && JSON.stringify(normAllowed) === JSON.stringify(normCur);
              }),
            )
          ) {
            continue;
          }
        }
        const label = verb in KUBECTL_READ_SUB ? `kubectl ${verb} ${sub}` : `kubectl ${verb}`;
        return `物理保险丝：${label} 属于非只读集群操作，禁止自动执行（如需发版变更，请先创建 Runbook 登记精确命令并由用户在对话中回复「批准 <runbook_id>」）。`;
      }
    }
  }
  return null;
}

export function checkCloudAndRedisOps(cmd: string): string | null {
  if (/\baliyun\s+sls\s+(create|delete|put|update|apply)-/i.test(cmd)) {
    return "物理保险丝：禁止执行阿里云 SLS 写操作命令。";
  }
  if (/\bredis-cli\b/i.test(cmd) && /\b(flushdb|flushall|config\s+set|shutdown)\b/i.test(cmd)) {
    return "物理保险丝：禁止执行破坏性 Redis 命令（FLUSHDB/FLUSHALL/CONFIG SET/SHUTDOWN）。";
  }
  return null;
}

/**
 * Resolve git `-C <dir>` flags sequentially matching Git's `chdir()` semantics:
 * each non-empty operand is resolved physically via `realpathSync.native` against the preceding physical directory
 * (preserving `..` across symlinks). When `strict` is true, returns `null` if any `-C` directory cannot be resolved.
 */
export function resolveGitDirFlags(
  baseCwd: string,
  flags: string[],
  strict = false,
): string | null {
  let dir = canonicalizeOsPath(baseCwd, ".") ?? baseCwd;
  for (const f of flags) {
    if (!f) continue; // Git treats empty `-C ""` as a no-op
    const phys = canonicalizeOsPath(dir, f);
    if (phys) {
      dir = phys;
    } else if (strict) {
      return null;
    } else {
      dir = resolve(dir, f);
    }
  }
  return dir;
}

export function extractGitSubcommand(
  tokens: string[],
): {
  gitIdx: number;
  gitDirFlags: string[];
  configs: string[];
  hasUnsafeGlobalOverride: boolean;
  subcmd: string;
  subArgs: string[];
} | null {
  const UNSAFE_GLOBAL_VALUE_FLAGS = new Set([
    "--git-dir",
    "--work-tree",
    "--namespace",
    "--config-env",
  ]);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t !== "git" && !t.endsWith("/git")) continue;
    const gitDirFlags: string[] = [];
    const configs: string[] = [];
    let hasUnsafeGlobalOverride = false;
    let j = i + 1;
    while (j < tokens.length) {
      const a = tokens[j];
      if (a === "-C" && j + 1 < tokens.length) {
        gitDirFlags.push(tokens[j + 1]);
        j += 2;
        continue;
      }
      if (a.startsWith("-C") && a.length > 2) {
        gitDirFlags.push(a.slice(2));
        j++;
        continue;
      }
      if (a === "-c" && j + 1 < tokens.length) {
        configs.push(tokens[j + 1]);
        j += 2;
        continue;
      }
      if (a.startsWith("-c") && a.length > 2) {
        configs.push(a.slice(2));
        j++;
        continue;
      }
      if (UNSAFE_GLOBAL_VALUE_FLAGS.has(a)) {
        hasUnsafeGlobalOverride = true;
        j += 2;
        continue;
      }
      if (
        a.startsWith("--git-dir=") ||
        a.startsWith("--work-tree=") ||
        a.startsWith("--namespace=") ||
        a.startsWith("--config-env=")
      ) {
        hasUnsafeGlobalOverride = true;
        j++;
        continue;
      }
      if (a.startsWith("-")) {
        j++;
        continue;
      }
      return {
        gitIdx: i,
        gitDirFlags,
        configs,
        hasUnsafeGlobalOverride,
        subcmd: a,
        subArgs: tokens.slice(j + 1),
      };
    }
  }
  return null;
}

function resolveSegmentCwd(
  segments: string[],
  targetIndex: number,
  initialCwd: string,
): string {
  let cwd = initialCwd;
  for (let i = 0; i < targetIndex; i++) {
    const toks = splitShellTokens(segments[i]);
    if (toks && toks[0] === "cd" && toks[1]) {
      cwd = resolve(cwd, toks[1]);
    }
  }
  return cwd;
}

function hasShellExpansion(s: string): boolean {
  return /[$`]/.test(s);
}

function hasPrecedingDynamicCd(segments: string[], targetIndex: number): boolean {
  for (let i = 0; i < targetIndex; i++) {
    const toks = splitShellTokens(segments[i]);
    if (toks && toks[0] === "cd" && toks[1] && hasShellExpansion(toks[1])) {
      return true;
    }
  }
  return false;
}

// Shortest accepted spellings for the push options that affect guard decisions.
const PUSH_OPTIONS = [
  ["--mi", "--mirror"], ["--al", "--all"], ["--br", "--branches"], ["--ta", "--tags"],
  ["--fo", "--force"], ["--force-w", "--force-with-lease"], ["--force-i", "--force-if-includes"],
  ["--de", "--delete"], ["--no-de", "--no-delete"], ["--pr", "--prune"], ["--rep", "--repo"],
  ["--fol", "--follow-tags"], ["--no-fol", "--no-follow-tags"],
  ["--pu", "--push-option"], ["--rec", "--receive-pack"], ["--ex", "--exec"],
];

function canonicalPushOption(token: string): string {
  const name = token.split("=", 1)[0];
  const match = PUSH_OPTIONS.find(([min, full]) => name.startsWith(min) && full.startsWith(name));
  if (match) return match[1];
  // Git also accepts shorter unambiguous prefixes (for example --m for --mirror).
  const candidates = PUSH_OPTIONS.filter(([, full]) => full.startsWith(name));
  if (!name.startsWith("--no-") && candidates.length === 1) return candidates[0][1];
  if (name.startsWith("--force-") && candidates.length) return "--force";
  return name;
}

function parseGitPushArgs(args: string[]): {
  refspecs: string[];
  remote: string | undefined;
  hasAllOrMirror: boolean;
  hasTags: boolean;
  isForce: boolean;
  isDelete: boolean;
  hasPrune: boolean;
  cliFollowTags: boolean | null;
} {
  const VALUE_FLAGS = new Set([
    "-o",
    "--push-option",
    "--repo",
    "--receive-pack",
    "--exec",
  ]);
  const positional: string[] = [];
  let repoValue: string | undefined;
  let hasAllOrMirror = false;
  let hasTags = false;
  let isForce = false;
  let isDelete = false;
  let hasPrune = false;
  let cliFollowTags: boolean | null = null;
  let stopFlags = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!stopFlags && a === "--") {
      stopFlags = true;
      continue;
    }
    if (!stopFlags && a.startsWith("--")) {
      const option = canonicalPushOption(a);
      if (option === "--repo") {
        repoValue = a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[i + 1];
      } else if (option === "--all" || option === "--branches" || option === "--mirror") {
        hasAllOrMirror = true;
      } else if (option === "--tags") {
        hasTags = true;
      } else if (
        option === "--force" ||
        option === "--force-with-lease" ||
        option === "--force-if-includes"
      ) {
        isForce = true;
      } else if (option === "--delete") {
        isDelete = true;
      } else if (option === "--no-delete") {
        isDelete = false;
      } else if (option === "--prune") {
        hasPrune = true;
      } else if (option === "--follow-tags") {
        cliFollowTags = true;
      } else if (option === "--no-follow-tags") {
        cliFollowTags = false;
      }
      if (VALUE_FLAGS.has(option) && !a.includes("=")) {
        i++;
      }
      continue;
    }
    if (!stopFlags && a.startsWith("-") && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const ch = a[j];
        if (ch === "f") isForce = true;
        else if (ch === "d") isDelete = true;
        else if (ch === "o") {
          if (j === a.length - 1) i++;
          break;
        }
      }
      continue;
    }
    positional.push(a);
  }
  const refspecs = positional.slice(1);
  if (refspecs.some((ref) => ref === ":" || ref === "+:" || ref.includes("*"))) hasAllOrMirror = true;
  return {
    refspecs,
    remote: positional[0] ?? repoValue,
    hasAllOrMirror,
    hasTags,
    isForce,
    isDelete,
    hasPrune,
    cliFollowTags,
  };
}

function resolveEffectivePushRemote(dir: string, explicit: string | undefined, branch: string, overrides: string[]) {
  if (explicit) return explicit;
  const get = (key: string) => runGit(dir, [...overrides, "config", "--get", key], 3000).stdout.trim();
  const configured = (branch && get(`branch.${branch}.pushRemote`)) || get("remote.pushDefault")
    || (branch && get(`branch.${branch}.remote`));
  if (configured) return configured;
  const remotes = runGit(dir, [...overrides, "remote"], 3000).stdout.trim().split("\n").filter(Boolean);
  return remotes.length === 1 ? remotes[0] : "origin";
}

function isImplicitPushAmbiguous(
  parsedPush: ReturnType<typeof parseGitPushArgs>,
  gitConfigs: string[],
  targetDir: string,
  protectedBranches: Set<string>,
): string | null {
  if (parsedPush.refspecs.length && parsedPush.refspecs.every((ref) => ref.includes(":"))) return null;
  const overrides = gitConfigs.flatMap((value) => ["-c", value]);
  const config = (key: string) =>
    runGit(targetDir, [...overrides, "config", "--get", key], 3000).stdout.trim();
  const branch = runGit(targetDir, ["symbolic-ref", "--quiet", "--short", "HEAD"], 3000).stdout.trimEnd();
  const remote = resolveEffectivePushRemote(targetDir, parsedPush.remote, branch, overrides);
  const key = `remote.${remote}.push`;
  if (runGit(targetDir, [...overrides, "config", "--get-all", key], 3000).code === 0) {
    return `检测到 ${key} 推送配置，请显式指定 src:dst refspec。`;
  }
  if (parsedPush.refspecs.length) return null;
  const pushDefault = config("push.default").toLowerCase();
  if (pushDefault === "matching") {
    return "push.default=matching 可能推送多个分支，请显式指定 refspec。";
  }
  if (!["", "simple", "current", "nothing", "upstream", "tracking"].includes(pushDefault)) {
    return "未知 push.default，请显式指定 refspec。";
  }

  if (branch && (pushDefault === "upstream" || pushDefault === "tracking")) {
    const merge = config(`branch.${branch}.merge`);
    if (merge && (!merge.startsWith("refs/heads/") || protectedBranches.has(merge.slice("refs/heads/".length)))) {
      return "隐式推送的上游目标受保护，请显式指定 refspec。";
    }
  }
  if (!parsedPush.remote) {
    const pushRef = runGit(targetDir, [...overrides, "rev-parse", "--symbolic-full-name", "@{push}"], 3000);
    const prefix = `refs/remotes/${remote}/`;
    const ref = pushRef.stdout.trimEnd();
    if (pushRef.code === 0 && ref.startsWith(prefix) && protectedBranches.has(ref.slice(prefix.length))) {
      return "隐式推送的目标分支受保护，请显式指定 refspec。";
    }
  }
  if (runGit(targetDir, [...overrides, "config", "--bool", "--get", `remote.${remote}.mirror`], 3000).stdout.trim() === "true") {
    return "mirror 远端禁止隐式推送，请显式指定 refspec。";
  }
  return null;
}

function repoOrigin(dir: string) {
  const result = runGit(dir, ["remote", "get-url", "origin"], 3000);
  return result.code === 0 ? parseGitRemoteRepo(result.stdout) : null;
}

export function resolveGhDefaultHost(effective: (key: string) => string, cwd = process.cwd()): string {
  const host = effective("GH_HOST");
  if (host) return host.toLowerCase();
  const home = effective("HOME");
  const configHome = effective("XDG_CONFIG_HOME") || (home && join(home, ".config"));
  const configDir = effective("GH_CONFIG_DIR") || (configHome && join(configHome, "gh"));
  if (configDir) {
    const config = parseYamlFile<Record<string, unknown>>(resolve(cwd, configDir, "hosts.yml"));
    const hosts = Object.keys(config ?? {}).map((key) => key.toLowerCase());
    if (hosts.length === 1) return hosts[0];
  }
  return "github.com";
}

const HOSTLESS_GH_REPO = /^[^/@:]+\/[^/]+$/;

export function qualifyGhRepoSpec(spec: string, effective: (key: string) => string, cwd: string): string {
  return HOSTLESS_GH_REPO.test(spec) ? `${resolveGhDefaultHost(effective, cwd)}/${spec}` : spec;
}

function resolveGhDefaultRepo(dir: string) {
  const getRemote = (name: string) => {
    const url = runGit(dir, ["remote", "get-url", "--", name], 3000);
    return url.code === 0 ? parseGitRemoteRepo(url.stdout) : null;
  };
  const config = runGit(dir, ["config", "--null", "--get-regexp", "^remote\\..*\\.gh-resolved$"], 3000);
  if (config.code === 1) {
    const remotes = runGit(dir, ["remote"], 3000);
    const rank = (name: string) => {
      const index = ["upstream", "github", "origin"].indexOf(name.toLowerCase());
      return index < 0 ? 3 : index;
    };
    const names = remotes.stdout.trimEnd().split("\n").filter(Boolean).sort((a, b) => rank(a) - rank(b));
    const [best, second] = names;
    if (remotes.code !== 0 || !best || (second && rank(best) === rank(second))) return null;
    return getRemote(best);
  }
  if (config.code !== 0) return null;
  let resolved: ReturnType<typeof parseGitRemoteRepo> = null;
  for (const line of config.stdout.split("\0").filter(Boolean)) {
    const match = line.match(/^remote\.(.+)\.gh-resolved\n([^\n]+)$/);
    if (!match) return null;
    const remoteRepo = getRemote(match[1]);
    if (!remoteRepo) return null;
    const spec = match[2] === "base" ? remoteRepo : parseGhRepoSpec(match[2]);
    if (!spec) return null;
    const repo = { ...spec, host: remoteRepo.host };
    if (resolved && (repo.host !== resolved.host || repo.owner !== resolved.owner ||
        repo.repo !== resolved.repo)) return null;
    resolved = repo;
  }
  return resolved;
}

function ghDefaultMatchesOrigin(dir: string, origin: ReturnType<typeof parseGitRemoteRepo>): boolean {
  const repo = resolveGhDefaultRepo(dir);
  return !!repo && !!origin && repo.host === origin.host && repo.owner === origin.owner && repo.repo === origin.repo;
}

export function extractGhPrSubcommand(toks: string[], prefix = unwrapShellPrefix(toks)) {
  const index = toks.findIndex((tok) => tok === "gh" || tok.endsWith("/gh"));
  if (index < 0) return null;
  const args = prefix.bin === "gh" ? prefix.args : toks.slice(index + 1);
  const flags: string[] = [];
  let sawPr = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("-")) {
      flags.push(arg);
      if (arg === "-R" || arg === "--repo") flags.push(args[++i] ?? "");
      continue;
    }
    if (sawPr) return { subcmd: arg, subArgs: [...flags, ...args.slice(i + 1)], prefix };
    if (arg !== "pr") return null;
    sawPr = true;
  }
  return null;
}

function parseDeliverySegment(toks: string[]) {
  const prefix = unwrapShellPrefix(toks);
  const words = prefix.ambiguous ? expandEnvSplitStrings(toks) : toks;
  return { prefix, git: extractGitSubcommand(words), gh: extractGhPrSubcommand(words, prefix) };
}

function parseGhPrMergeTarget(args: string[], checkoutDir: string | null, effective: (key: string) => string, cwd: string) {
  const VALUE_FLAGS = new Set([
    "-R",
    "--repo",
    "-t",
    "--subject",
    "-b",
    "--body",
    "-F",
    "--body-file",
    "--match-head-commit",
    "--author-email",
  ]);
  let repoFlag: string | null = null;
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (a === "-R" || a === "--repo") {
      repoFlag = args[++i] ?? null;
      continue;
    }
    if (a.startsWith("--repo=")) {
      repoFlag = a.slice("--repo=".length);
      continue;
    }
    if (a.startsWith("-R") && a.length > 2) {
      repoFlag = a.slice(2);
      continue;
    }
    if (VALUE_FLAGS.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    positionals.push(a);
  }
  if (positionals.length !== 1) return null;
  const pos = positionals[0];
  const url = pos.match(/^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:\/.*)?$/i);
  const number = Number(url ? url[4] : pos.match(/^#?(\d+)$/)?.[1]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  if (!url && repoFlag === null) repoFlag = effective("GH_REPO") || null;
  const flag = repoFlag !== null ? parseGhRepoSpec(qualifyGhRepoSpec(repoFlag, effective, cwd)) : null;
  if (repoFlag !== null && !flag) return null;
  const urlHost = url ? parseGitRemoteRepo(pos.replace(/\/pull\/\d+(?:\/.*)?$/i, ""))?.host : null;
  if (url && !urlHost) return null;
  const host = urlHost ?? flag?.host ?? (effective("GH_HOST").toLowerCase() || null);
  const owner = url?.[2].toLowerCase() ?? flag?.owner ?? null;
  const repo = url?.[3].toLowerCase() ?? flag?.repo;
  if (flag && (flag.repo !== repo || flag.owner !== owner || flag.host !== host)) return null;
  const origin = checkoutDir ? repoOrigin(checkoutDir) : null;
  if (checkoutDir && (!origin || (repo && repo !== origin.repo) ||
      (host && host !== origin.host) || (owner && owner !== origin.owner))) return null;
  if (checkoutDir && !url && repoFlag === null && !ghDefaultMatchesOrigin(checkoutDir, origin)) return null;
  const targetRepo = repo ?? origin?.repo;
  return targetRepo ? { host, owner, repo: targetRepo, number } : null;
}

function hasOnlyAndSeparators(cmd: string): boolean {
  let quote: "'" | '"' | "$'" | null = null;
  let escape = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    const next = cmd[i + 1];
    if (escape) {
      escape = false;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === "$'") {
      if (ch === "\\") escape = true;
      else if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") escape = true;
      else if (ch === '"') quote = null;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === "$" && next === "'") {
      quote = "$'";
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "\r" || ch === "|") return false;
    if (ch === "&") {
      if (next === "&") {
        i++;
        continue;
      }
      const prev = cmd[i - 1];
      if (prev === ">" || prev === "<" || next === ">") continue;
      return false;
    }
  }
  return !escape && quote === null;
}

/**
 * Strict command-position git parser (used for Runbook approval exceptions so
 * non-git commands or git info queries like `git --exec-path tag ...` NEVER count as tag creation).
 * Allowlists ONLY `-C <dir>` (accumulated sequentially) and `-c <key[=val]>`.
 */
function extractCommandPositionGit(
  tokens: string[],
): { gitDirFlags: string[]; subcmd: string; subArgs: string[]; configs: string[] } | null {
  let idx = 0;
  while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx])) {
    // Reject `GIT_*=` repository/config override environment variables (e.g. `GIT_DIR`, `GIT_WORK_TREE`, `GIT_CONFIG_PARAMETERS`)
    const key = tokens[idx].slice(0, tokens[idx].indexOf("="));
    if (key.startsWith("GIT_")) return null;
    idx++;
  }
  const bin = tokens[idx] ?? "";
  if (bin !== "git" && !bin.endsWith("/git")) return null;
  const gitDirFlags: string[] = [];
  const configs: string[] = [];
  let j = idx + 1;
  while (j < tokens.length) {
    const a = tokens[j];
    if (a === "-C") {
      if (j + 1 >= tokens.length) return null;
      gitDirFlags.push(tokens[j + 1]);
      j += 2;
      continue;
    }
    if (a.startsWith("-C") && a.length > 2) {
      gitDirFlags.push(a.slice(2));
      j++;
      continue;
    }
    if (a === "-c") {
      if (j + 1 >= tokens.length) return null;
      configs.push(tokens[j + 1]);
      j += 2;
      continue;
    }
    if (a.startsWith("-c") && a.length > 2) {
      configs.push(a.slice(2));
      j++;
      continue;
    }
    if (a.startsWith("-")) {
      // Reject ALL other global options (`--exec-path`, `--version`, `--git-dir`, `--work-tree`, etc.)
      return null;
    }
    return { gitDirFlags, subcmd: a, subArgs: tokens.slice(j + 1), configs };
  }
  return null;
}

function getCanonicalGitCommonDir(dir: string): string | null {
  const res = runGit(dir, ["rev-parse", "--git-common-dir"], 3000);
  if (res.code !== 0 || !res.stdout.trim()) return null;
  try {
    return realpathSync(resolve(dir, res.stdout.trim()));
  } catch {
    return resolve(dir, res.stdout.trim());
  }
}

function isSimpleLiteralCdSegment(seg: string): boolean {
  if (hasUnquotedRedirect(seg, ">") || hasUnquotedRedirect(seg, "<")) return false;
  if (seg.includes("$(") || seg.includes("`")) return false;
  const toks = splitShellTokens(seg);
  if (!toks || toks.length !== 2) return false;
  return toks[0] === "cd" && !toks[1].startsWith("-") && !hasShellExpansion(toks[1]);
}

function parseGitTagCreation(subArgs: string[]): { tagName: string; targetRef: string } | null {
  const ALLOWED_VALUE_FLAGS = new Set([
    "-m",
    "--message",
    "-F",
    "--file",
    "-u",
    "--local-user",
    "--cleanup",
  ]);
  const ALLOWED_BOOL_FLAGS = new Set([
    "-a",
    "--annotate",
    "-s",
    "--sign",
    "--no-sign",
    "-f",
    "--force",
    "-e",
    "--edit",
    "--create-reflog",
  ]);
  const SHORT_BOOL = new Set(["a", "s", "f", "e"]);
  const SHORT_VALUE = new Set(["m", "F", "u"]);
  const positionals: string[] = [];
  let stopFlags = false;
  for (let i = 0; i < subArgs.length; i++) {
    const a = subArgs[i];
    if (!stopFlags && a === "--") {
      stopFlags = true;
      continue;
    }
    if (!stopFlags && a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq >= 0 ? a.slice(0, eq) : a;
      if (ALLOWED_BOOL_FLAGS.has(name) && eq < 0) continue;
      if (ALLOWED_VALUE_FLAGS.has(name)) {
        if (eq < 0 && ++i >= subArgs.length) return null;
        continue;
      }
      return null;
    }
    if (!stopFlags && a.startsWith("-") && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const ch = a[j];
        if (SHORT_BOOL.has(ch)) continue;
        if (SHORT_VALUE.has(ch)) {
          if (j === a.length - 1 && ++i >= subArgs.length) return null;
          break;
        }
        return null;
      }
      continue;
    }
    positionals.push(a);
  }
  if (positionals.length < 1 || positionals.length > 2) return null;
  return { tagName: positionals[0], targetRef: positionals[1] ?? "HEAD" };
}

/**
 * Evaluate follow-tags behavior:
 * - `"explicit_true"` / `"explicit_false"`: explicitly decided by CLI flags (`--follow-tags` / `--no-follow-tags`)
 *   or inline `-c push.followTags[=...]` (independent of checkout resolution!).
 * - `"repo_true"` / `"repo_false"`: read from repo config when `checkoutDir` is known.
 * - `"unknown"`: no explicit setting and `checkoutDir` could not be resolved (dynamic/nonexistent path).
 */
function evaluateFollowTagsSetting(
  pushSubArgs: string[],
  gitConfigs: string[],
  checkoutDir: string | null,
): "cli_true" | "cli_false" | "inline_true" | "inline_false" | "repo_true" | "repo_false" | "unknown" {
  // 1. Unified push option parser respects grouped flags (`-vo <val>`) and option arity (`-o --no-follow-tags`)
  const parsed = parseGitPushArgs(pushSubArgs);
  if (parsed.cliFollowTags !== null) return parsed.cliFollowTags ? "cli_true" : "cli_false";

  // 2. Check inline `-c push.followTags[=...]` (valueless `-c push.followTags` is `true` in Git!)
  let inlineFollowTags: boolean | null = null;
  for (const cfg of gitConfigs) {
    const eq = cfg.indexOf("=");
    if (eq < 0) {
      if (cfg.trim().toLowerCase() === "push.followtags") {
        inlineFollowTags = true;
      }
      continue;
    }
    const key = cfg.slice(0, eq).trim().toLowerCase();
    if (key !== "push.followtags") continue;
    const val = cfg.slice(eq + 1).trim().toLowerCase();
    inlineFollowTags = !["false", "0", "no", "off", ""].includes(val);
  }
  if (inlineFollowTags !== null) return inlineFollowTags ? "inline_true" : "inline_false";

  // 3. Check repo effective git config (`push.followTags`)
  if (!checkoutDir) return "unknown";
  const cfgRes = runGit(checkoutDir, ["config", "--get", "--bool", "push.followTags"], 3000);
  if (cfgRes.code === 0 && cfgRes.stdout.trim().toLowerCase() === "true") {
    return "repo_true";
  }
  return "repo_false";
}

function isFollowTagsEffective(
  pushSubArgs: string[],
  gitConfigs: string[],
  checkoutDir: string | null,
): boolean {
  const state = evaluateFollowTagsSetting(pushSubArgs, gitConfigs, checkoutDir);
  return state === "cli_true" || state === "inline_true" || state === "repo_true" || state === "unknown";
}

function effectivePushRepo(dir: string, remote: string, configs: string[]) {
  const overrides = configs.flatMap((value) => ["-c", value]);
  const urls = runGit(dir, [...overrides, "remote", "get-url", "--push", "--all", "--", remote], 3000);
  if (urls.code === 0) {
    const lines = urls.stdout.trimEnd().split("\n");
    return lines.length === 1 ? parseGitRemoteRepo(lines[0]) : null;
  }
  if (!parseGitRemoteRepo(remote)) return null;
  const rules = runGit(dir, [...overrides, "config", "--null", "--get-regexp", "^url\\..*\\.(push)?insteadof$"], 3000);
  if (rules.code !== 0 && rules.code !== 1) return null;
  for (const suffix of [".pushinsteadof", ".insteadof"]) {
    let longest = -1;
    const receivers = new Set<string>();
    for (const record of rules.stdout.split("\0")) {
      const delim = record.indexOf("\n");
      if (delim < 0) continue;
      const key = record.slice(0, delim);
      const prefix = record.slice(delim + 1);
      if (!key.endsWith(suffix) || !remote.startsWith(prefix) || prefix.length < longest) continue;
      if (prefix.length > longest) receivers.clear();
      longest = prefix.length;
      receivers.add(key.slice(4, -suffix.length) + remote.slice(longest));
    }
    if (receivers.size) return receivers.size === 1 ? parseGitRemoteRepo([...receivers][0]) : null;
  }
  return parseGitRemoteRepo(remote);
}

function isApprovedTagPushRefspec(params: {
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
  const {
    workbenchRoot,
    targetDir,
    refspec,
    isForce,
    isDelete,
    approvedRunbooks,
    cmd,
    segments,
    segmentIndex,
    toolWorkdir,
    pushSegmentTokens,
  } = params;
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
              if (p.number !== target.number) return false;
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

function evaluateDiffExemptEligibility(
  stats: { files: string[]; changedLines: number },
  cfg: WorkbenchConfig,
): { eligible: boolean; files: string[]; changedLines: number; reason?: string } {
  if (stats.files.length === 0) {
    return { eligible: true, ...stats };
  }
  if (stats.files.length > cfg.ledger.exempt_max_files) {
    return {
      eligible: false,
      ...stats,
      reason: `改动文件数 (${stats.files.length}) 超出豁免上限 (${cfg.ledger.exempt_max_files})`,
    };
  }
  if (stats.changedLines > cfg.ledger.exempt_max_lines) {
    return {
      eligible: false,
      ...stats,
      reason: `改动行数 (${stats.changedLines}) 超出豁免上限 (${cfg.ledger.exempt_max_lines})`,
    };
  }
  const protectedHit = stats.files.find((f) =>
    cfg.ledger.protected_code_globs.some((g) => matchesGlob(f, g)),
  );
  if (protectedHit) {
    return {
      eligible: false,
      ...stats,
      reason: `涉及受保护业务代码文件 (${protectedHit})`,
    };
  }
  if (cfg.ledger.exempt_allowed_globs.length > 0) {
    const disallowed = stats.files.find(
      (f) => !cfg.ledger.exempt_allowed_globs.some((g) => matchesGlob(f, g)),
    );
    if (disallowed) {
      return {
        eligible: false,
        ...stats,
        reason: `文件 ${disallowed} 不在允许免账本范围 (exempt_allowed_globs) 内`,
      };
    }
  }
  return { eligible: true, ...stats };
}

function isStagedDiffExemptEligible(
  checkoutDir: string,
  cfg: WorkbenchConfig,
): { eligible: boolean; files: string[]; changedLines: number; reason?: string } {
  return evaluateDiffExemptEligibility(getStagedDiffStats(checkoutDir), cfg);
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
      if (!registeredRepos.has(loc.repo)) {
        continue;
      }

      if (!ledger) ledger = new Ledger(workbenchRoot);

      type DeliveryTarget = {
        branch: string;
        sha: string | null;
        isDetached: boolean;
      };

      const targets: DeliveryTarget[] = [];
      if (isGitPush && git) {
        const parsedPush = parseGitPushArgs(git.subArgs);
        const reason = isImplicitPushAmbiguous(parsedPush, git.configs, targetDir, new Set(cfg.guard.protected_branches));
        if (reason) return `账本门禁：${reason}`;
        if (parsedPush.isDelete) {
          // Deleting a remote feature branch (protected branches already blocked by Tier 1)
          continue;
        }
        if (parsedPush.hasAllOrMirror) {
          return "账本门禁（fail-closed）：禁止 `git push --all` / `--branches` / `--mirror` 或批量 refspec，请显式指定目标分支。";
        }
        const { refspecs } = parsedPush;
        if (refspecs.length === 0) {
          targets.push({
            branch: loc.branch,
            sha: loc.headSha,
            isDetached: loc.isDetached,
          });
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
              targets.push({
                branch: loc.branch,
                sha: loc.headSha,
                isDetached: loc.isDetached,
              });
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

        const prHead = parsedGh.head;
        if (prHead) {
          let branchName = prHead;
          if (prHead.includes(":")) {
            const [owner, ...restParts] = prHead.split(":");
            branchName = restParts.join(":");
            if (
              !owner ||
              !originIdentity ||
              owner.toLowerCase() !== originIdentity.owner
            ) {
              return `账本门禁（fail-closed）：PR head \`${prHead}\` 的 owner 与当前仓 origin 不匹配，拒绝放行跨 fork 未核验 PR。`;
            }
          }
          const cleanBranch = branchName.replace(/^refs\/heads\//, "");
          const rev = runGit(
            loc.checkoutDir,
            ["rev-parse", "--verify", `refs/heads/${cleanBranch}`],
            3000,
          );
          if (rev.code !== 0 || !rev.stdout.trim()) {
            return `账本门禁（fail-closed）：无法解析本地 PR head 分支 \`${prHead}\`，拒绝放行 gh pr create。`;
          }
          const localSha = rev.stdout.trim();
          // If origin/<branch> exists locally and has diverged from local branch, fail closed!
          const remoteRev = runGit(
            loc.checkoutDir,
            ["rev-parse", "--verify", `refs/remotes/origin/${cleanBranch}`],
            3000,
          );
          if (remoteRev.code === 0 && remoteRev.stdout.trim() && remoteRev.stdout.trim() !== localSha) {
            return `账本门禁（fail-closed）：本地分支 \`${cleanBranch}\` (${localSha.slice(0, 8)}) 与远端跟踪分支 \`origin/${cleanBranch}\` (${remoteRev.stdout.trim().slice(0, 8)}) 已分叉，请先推送对齐后再创建 PR。`;
          }
          targets.push({
            branch: cleanBranch,
            sha: localSha,
            isDetached: false,
          });
        } else {
          if (!loc.isDetached && loc.headSha) {
            const remoteRev = runGit(
              loc.checkoutDir,
              ["rev-parse", "--verify", `refs/remotes/origin/${loc.branch}`],
              3000,
            );
            if (remoteRev.code === 0 && remoteRev.stdout.trim() && remoteRev.stdout.trim() !== loc.headSha) {
              return `账本门禁（fail-closed）：当前分支 \`${loc.branch}\` (${loc.headSha.slice(0, 8)}) 与远端跟踪分支 \`origin/${loc.branch}\` (${remoteRev.stdout.trim().slice(0, 8)}) 已分叉，请先推送对齐后再创建 PR。`;
            }
          }
          targets.push({
            branch: loc.branch,
            sha: loc.headSha,
            isDetached: loc.isDetached,
          });
        }
      } else {
        targets.push({
          branch: loc.branch,
          sha: loc.headSha,
          isDetached: loc.isDetached,
        });
      }

      for (const target of targets) {
        const deliveryBranch = target.branch;
        const deliverySha = target.sha;
        const deliveryDetached = target.isDetached;

        // Resolve owning OPEN task(s)
        const openTasks = deliveryDetached
          ? ledger.findOpenTasksByRepoCommits(loc.repo, getHeadAndParents(loc.checkoutDir))
          : ledger.findOpenTasksByRepoBranch(loc.repo, deliveryBranch);
        const exemption = deliveryDetached
          ? null
          : ledger.findActiveExemption(loc.repo, deliveryBranch);

        if (isGitCommit) {
          if (openTasks.length === 1) continue;
          if (openTasks.length > 1) {
            const ids = openTasks.map((t) => t.task_id).join(", ");
            return `账本门禁：${loc.repo}:${deliveryBranch} 命中多个 OPEN 账本 (${ids})，请先收敛归属后再提交。`;
          }

          const eligibility = isStagedDiffExemptEligible(loc.checkoutDir, cfg);
          if (exemption && eligibility.eligible) {
            continue;
          }

          const allOpen = ledger.listOpenTasks();
          const attachHint =
            allOpen.length > 0
              ? `\n  2) 归属已有跨仓任务：.workbench/bin/ledger attach <task_id> --repo ${loc.repo} --branch ${deliveryBranch}（当前 OPEN：${allOpen.map((t) => t.task_id).join(", ")}）`
              : "";

          if (!eligibility.eligible) {
            return (
              `账本门禁：业务仓 ${loc.repo} (${deliveryBranch}) 即将提交（${eligibility.files.length} 文件 / ${eligibility.changedLines} 行：${eligibility.reason}），不可沿用或静默豁免。\n` +
              `请选择：\n` +
              `  1) 新开账本：.workbench/bin/ledger open --id <YYYYMMDD-slug> --title "<标题>" --endpoint <local|fat|pr> --depth <targeted|full> --repo ${loc.repo} --branch ${deliveryBranch}${attachHint}\n` +
              `  3) 若确认完全不涉及逻辑/设定，拿不准请先询问用户确认。`
            );
          }

          return (
            `账本门禁：业务仓 ${loc.repo} (${deliveryBranch}) 尚未绑定开发账本。\n` +
            `请选择：\n` +
            `  1) 新开账本：.workbench/bin/ledger open --id <YYYYMMDD-slug> --title "<标题>" --endpoint <local|fat|pr> --depth <targeted|full> --repo ${loc.repo} --branch ${deliveryBranch}${attachHint}\n` +
            `  3) 若为不涉及逻辑/设定的极小改动（纯文档/注释/typo）：.workbench/bin/ledger exempt --repo ${loc.repo} --branch ${deliveryBranch} --reason "<原因>"`
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
              continue;
            }
            return `账本门禁：${loc.repo}@${deliverySha.slice(0, 8)} 的实际提交改动不满足免账本豁免条件，请开立正式开发账本并完成验证。`;
          }

          if (openTasks.length === 0) {
            return (
              `账本门禁：${loc.repo} (${deliveryBranch}${deliveryDetached ? " detached" : ""}) 尚未绑定有效开发账本（或豁免未绑定当前 SHA ${deliverySha.slice(0, 8)}），禁止直接执行 ${isGitPush ? "git push" : "gh pr create"}。\n` +
              `请先绑定账本（跨仓或独立 FAT 分支可用 ledger attach；极小无逻辑改动须登记当前 SHA 的合规 exempt）。`
            );
          }
          if (openTasks.length > 1) {
            return `账本门禁：${loc.repo} 命中多个 OPEN 账本 (${openTasks.map((t) => t.task_id).join(", ")})，无法自动校验推送条件。`;
          }

          const task = openTasks[0];

          // On detached FAT merge worktree: check merged HEAD first; ONLY fall back to parent feature SHA
          // if merged HEAD had NO explicit test/build/review failure!
          let readiness = ledger.checkPushReadiness({
            task_id: task.task_id,
            repo: loc.repo,
            head_sha: deliverySha,
          });
          if (!readiness.ready && !readiness.hasExplicitFailure && deliveryDetached) {
            const parents = new Set(getHeadAndParents(loc.checkoutDir));
            const boundRepo = ledger
              .getTaskRepos(task.task_id)
              .find((r) => r.repo === loc.repo && r.head_sha && parents.has(r.head_sha));
            if (boundRepo?.head_sha) {
              readiness = ledger.checkPushReadiness({
                task_id: task.task_id,
                repo: loc.repo,
                head_sha: boundRepo.head_sha,
              });
            }
          }

          if (!readiness.ready) {
            return (
              `账本门禁：任务 ${task.task_id} (${loc.repo}@${deliverySha.slice(0, 8)}) 尚未满足交付前检查：\n` +
              readiness.missing.map((m) => `  - ${m}`).join("\n") +
              `\n请补跑对应验证/评审（PostToolUse 将自动记账）或通过 ledger record 补录证据后再重试。`
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

function canonicalizeMaybePath(p: string): string {
  const abs = resolve(p);
  let cur = abs;
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return abs;
    tail.unshift(basename(cur));
    cur = parent;
  }
  try {
    const real = realpathSync(cur);
    return tail.length > 0 ? join(real, ...tail) : real;
  } catch {
    return abs;
  }
}

const INLINE_WRITE_INDICATOR_RE =
  /\b(open|write|writelines|writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|truncate|truncateSync|unlink|unlinkSync|rm|rmSync|rmdir|rename|renameSync|replace|copyFile|copyFileSync|cpSync|chmod|chmodSync|shutil|pathlib|Path|os\.remove|os\.unlink|os\.rename|os\.replace|os\.system|subprocess|child_process|exec|execSync|spawn|spawnSync|Bun\.write|File\.write|File\.open|File\.delete|File\.unlink|File\.rename|IO\.write|FileUtils|syswrite|system|qx)\b|['"]\s*,\s*['"][wax+]/;

function unwrapCommandPrefix(
  metaToks: ShellToken[],
  startCwd: string,
): { bin: string; cmdToks: string[]; effectiveCwd: string; readOnly: boolean } {
  let idx = 0;
  let cwd = startCwd;
  let readOnly = false;
  while (idx < metaToks.length) {
    if (metaToks[idx].isEnvAssign) {
      idx++;
      continue;
    }
    const val = metaToks[idx].value;
    const base = val.split("/").pop() ?? "";
    if (base === "env") {
      idx++;
      while (idx < metaToks.length) {
        const t = metaToks[idx].value;
        if (t === "--") {
          idx++;
          break;
        }
        if (t === "-C" || t === "--chdir") {
          const dir = metaToks[idx + 1]?.value;
          if (dir) cwd = resolve(cwd, dir);
          idx += 2;
          continue;
        }
        if (t.startsWith("--chdir=")) {
          const dir = t.slice("--chdir=".length);
          if (dir) cwd = resolve(cwd, dir);
          idx++;
          continue;
        }
        if (t === "-u" || t === "--unset") {
          idx += 2;
          continue;
        }
        if (t.startsWith("-")) {
          idx++;
          continue;
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
          idx++;
          continue;
        }
        break;
      }
      continue;
    }
    if (base === "command") {
      idx++;
      while (idx < metaToks.length && metaToks[idx].value.startsWith("-")) {
        const flag = metaToks[idx].value;
        if (flag === "--") {
          idx++;
          break;
        }
        if (flag.includes("v") || flag.includes("V")) readOnly = true;
        idx++;
      }
      continue;
    }
    if (base === "nohup" || base === "time") {
      idx++;
      while (idx < metaToks.length && metaToks[idx].value.startsWith("-")) idx++;
      continue;
    }
    if (base === "nice") {
      idx++;
      while (idx < metaToks.length && metaToks[idx].value.startsWith("-")) {
        if (metaToks[idx].value === "-n") idx += 2;
        else idx++;
      }
      continue;
    }
    break;
  }
  const cmdToks = metaToks.slice(idx).map((t) => t.value);
  const bin = cmdToks[0]?.split("/").pop() ?? "";
  return { bin, cmdToks, effectiveCwd: cwd, readOnly };
}

function parseShellRedirections(
  seg: string,
  segCwd: string,
): { writeTargets: string[]; readInputs: string[]; strippedSeg: string } {
  const writeTargets: string[] = [];
  const readInputs: string[] = [];
  const strippedParts: string[] = [];
  let quote: "'" | '"' | "$'" | null = null;
  let escape = false;
  let i = 0;

  const readWord = (start: number): { word: string; nextIdx: number } => {
    let j = start;
    while (j < seg.length && (seg[j] === " " || seg[j] === "\t")) j++;
    let w = "";
    let q: "'" | '"' | null = null;
    let esc = false;
    while (j < seg.length) {
      const c = seg[j];
      if (esc) {
        w += c;
        esc = false;
        j++;
        continue;
      }
      if (q === "'") {
        if (c === "'") q = null;
        else w += c;
        j++;
        continue;
      }
      if (q === '"') {
        if (c === "\\") {
          if (j + 1 < seg.length) w += seg[++j];
        } else if (c === '"') {
          q = null;
        } else {
          w += c;
        }
        j++;
        continue;
      }
      if (c === "\\") {
        esc = true;
        j++;
        continue;
      }
      if (c === "'" || c === '"') {
        q = c;
        j++;
        continue;
      }
      if (c === " " || c === "\t" || c === "\n" || c === ";" || c === "&" || c === "|" || c === ">" || c === "<") {
        break;
      }
      w += c;
      j++;
    }
    return { word: w, nextIdx: j };
  };

  while (i < seg.length) {
    const ch = seg[i];
    const next = seg[i + 1];
    if (escape) {
      strippedParts.push(ch);
      escape = false;
      i++;
      continue;
    }
    if (quote === "'") {
      strippedParts.push(ch);
      if (ch === "'") quote = null;
      i++;
      continue;
    }
    if (quote === "$'") {
      strippedParts.push(ch);
      if (ch === "\\") escape = true;
      else if (ch === "'") quote = null;
      i++;
      continue;
    }
    if (quote === '"') {
      strippedParts.push(ch);
      if (ch === "\\") escape = true;
      else if (ch === '"') quote = null;
      i++;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      strippedParts.push(ch);
      i++;
      continue;
    }
    if (ch === "$" && next === "'") {
      quote = "$'";
      strippedParts.push("$'");
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      strippedParts.push(ch);
      i++;
      continue;
    }

    // Output redirections: `>`, `>>`, `>|`, `<>`, `&>`, `&>>`, `[fd]>`, `[fd]>>`, `[fd]>|`
    const isAmpRedir = ch === "&" && next === ">";
    const isOutRedir = ch === ">";
    const isReadWriteRedir = ch === "<" && next === ">";
    const isInRedir = ch === "<" && next !== "<" && next !== "&" && next !== ">";

    if (isAmpRedir || isOutRedir || isReadWriteRedir) {
      // Strip optional preceding single-digit fd from strippedParts when at word boundary
      if (
        isOutRedir &&
        strippedParts.length > 0 &&
        /^[0-9]$/.test(strippedParts[strippedParts.length - 1]) &&
        (strippedParts.length === 1 ||
          strippedParts[strippedParts.length - 2] === " " ||
          strippedParts[strippedParts.length - 2] === "\t")
      ) {
        strippedParts.pop();
      }
      let opLen = 1;
      if (isAmpRedir) {
        opLen = seg[i + 2] === ">" ? 3 : 2;
      } else if (isReadWriteRedir) {
        opLen = 2;
      } else if (next === ">" || next === "|") {
        opLen = 2;
      } else if (next === "&") {
        // fd dup like `2>&1` or `>&2` or `>&-` -> skip operator and target fd
        const { nextIdx } = readWord(i + 2);
        strippedParts.push(" ");
        i = nextIdx;
        continue;
      }
      const { word, nextIdx } = readWord(i + opLen);
      if (word && !word.includes("://") && word !== "/dev/null") {
        writeTargets.push(canonicalizeMaybePath(resolve(segCwd, word)));
      }
      strippedParts.push(" ");
      i = nextIdx;
      continue;
    }

    if (isInRedir) {
      const { word, nextIdx } = readWord(i + 1);
      if (word && word !== "/dev/null") {
        readInputs.push(canonicalizeMaybePath(resolve(segCwd, word)));
      }
      strippedParts.push(" ");
      i = nextIdx;
      continue;
    }

    strippedParts.push(ch);
    i++;
  }

  return { writeTargets, readInputs, strippedSeg: strippedParts.join("") };
}

const STRICT_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const PATCH_HEADER_PREFIXES = [
  Buffer.from("diff --git "),
  Buffer.from("--- "),
  Buffer.from("+++ "),
  Buffer.from("*** "),
  Buffer.from("rename from "),
  Buffer.from("rename to "),
  Buffer.from("copy from "),
  Buffer.from("copy to "),
  Buffer.from("Index: "),
];

function decodeGitCQuotedPath(quoted: string): string | null {
  if (!quoted.startsWith('"') || !quoted.endsWith('"') || quoted.length < 2) return null;
  const inner = quoted.slice(1, -1);
  if (inner.includes("\0")) return null;
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch !== "\\") {
      const cp = inner.codePointAt(i)!;
      if (cp === 0) return null;
      const full = String.fromCodePoint(cp);
      pushUtf8Bytes(bytes, full);
      if (full.length > 1) i += full.length - 1;
      continue;
    }
    if (i + 1 >= inner.length) return null;
    const esc = inner[++i];
    if (esc === "a") bytes.push(0x07);
    else if (esc === "b") bytes.push(0x08);
    else if (esc === "t") bytes.push(0x09);
    else if (esc === "n") bytes.push(0x0a);
    else if (esc === "v") bytes.push(0x0b);
    else if (esc === "f") bytes.push(0x0c);
    else if (esc === "r") bytes.push(0x0d);
    else if (esc === '"') bytes.push(0x22);
    else if (esc === "\\") bytes.push(0x5c);
    else if (esc >= "0" && esc <= "3") {
      const oct = inner.slice(i, i + 3);
      if (!/^[0-3][0-7][0-7]$/.test(oct)) return null;
      const val = Number.parseInt(oct, 8);
      if (val === 0) return null;
      bytes.push(val);
      i += 2;
    } else {
      return null;
    }
  }
  try {
    return STRICT_UTF8_DECODER.decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

function readGitDiffHeaderToken(
  s: string,
  start: number,
): { value: string; nextIdx: number } | null {
  if (start >= s.length) return null;
  if (s[start] === '"') {
    let i = start + 1;
    while (i < s.length) {
      if (s[i] === "\\") {
        i += 2;
        continue;
      }
      if (s[i] === '"') {
        const decoded = decodeGitCQuotedPath(s.slice(start, i + 1));
        if (decoded === null) return null;
        return { value: decoded, nextIdx: i + 1 };
      }
      i++;
    }
    return null;
  }
  let end = s.indexOf(" ", start);
  if (end < 0) end = s.length;
  return { value: s.slice(start, end), nextIdx: end };
}

function bufferStartsWith(buf: Uint8Array, start: number, end: number, prefix: Uint8Array): boolean {
  if (end - start < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (buf[start + i] !== prefix[i]) return false;
  }
  return true;
}

function extractPatchFileTargets(
  patchAbsPath: string,
  baseDir: string,
  stripLevel: number | null,
): { targets: string[]; uninspectable: boolean } {
  if (!existsSync(patchAbsPath)) return { targets: [], uninspectable: true };
  try {
    const st = statSync(patchAbsPath);
    if (!st.isFile() || st.size > 4 * 1024 * 1024) {
      return { targets: [], uninspectable: true };
    }
    const rawBuf = readFileSync(patchAbsPath);
    const out: string[] = [];
    let anyUninspectableHeader = false;

    const pushPath = (
      rawPath: string,
      defaultStripIfPrefixed: boolean,
      alreadyDecoded = false,
    ): "pushed" | "devnull" | "invalid" => {
      let raw = rawPath;
      if (!alreadyDecoded) {
        if (raw.startsWith('"')) {
          const decoded = decodeGitCQuotedPath(raw);
          if (decoded === null) return "invalid";
          raw = decoded;
        }
      }
      if (raw.includes("\0")) return "invalid";
      if (!raw || raw === "/dev/null") return "devnull";
      const parts = raw.split("/").filter((seg) => seg.length > 0);
      const effectiveStrip =
        stripLevel !== null
          ? defaultStripIfPrefixed
            ? stripLevel
            : 0
          : defaultStripIfPrefixed && (parts[0] === "a" || parts[0] === "b")
            ? 1
            : 0;
      const rel = parts.slice(effectiveStrip).join("/");
      if (!rel) return "devnull";
      out.push(canonicalizeMaybePath(resolve(baseDir, rel)));
      return "pushed";
    };

    const parseDiffGitLine = (line: string): [string, string] | null => {
      const rest = line.slice("diff --git ".length);
      if (!rest || rest.includes("\0")) return null;
      // 1. C-quoted path(s) (handles spaces, escaped quotes, and octal UTF-8 bytes like `\303\251`)
      if (rest.includes('"')) {
        const first = readGitDiffHeaderToken(rest, 0);
        if (!first || rest[first.nextIdx] !== " ") return null;
        const secondStart = first.nextIdx + 1;
        if (rest[secondStart] === '"') {
          const second = readGitDiffHeaderToken(rest, secondStart);
          if (!second || second.nextIdx !== rest.length) return null;
          return [first.value, second.value];
        }
        const tail = rest.slice(secondStart);
        if (!tail || tail.includes('"')) return null;
        return [first.value, tail];
      }
      // 2. Unquoted identical path with optional spaces (e.g. `a/plan notes.md b/plan notes.md`)
      if (rest.length % 2 === 1) {
        const mid = (rest.length - 1) / 2;
        if (rest[mid] === " ") {
          const left = rest.slice(0, mid);
          const right = rest.slice(mid + 1);
          const lSlash = left.indexOf("/");
          const rSlash = right.indexOf("/");
          if (lSlash > 0 && rSlash > 0 && left.slice(lSlash + 1) === right.slice(rSlash + 1)) {
            return [left, right];
          }
        }
      }
      // 3. Unquoted rename/different paths with spaces separated by unique ` b/` boundary
      const bMatches = [...rest.matchAll(/ (b\/)/g)];
      if (bMatches.length === 1 && bMatches[0].index !== undefined) {
        const idx = bMatches[0].index;
        const left = rest.slice(0, idx);
        const right = rest.slice(idx + 1);
        if (left && right) return [left, right];
      }
      // 4. Plain two whitespace-separated paths without internal spaces
      const plain = rest.split(" ");
      if (plain.length === 2 && plain[0] && plain[1]) {
        return [plain[0], plain[1]];
      }
      return null;
    };

    const AT_AT_PREFIX = Buffer.from("@@ ");
    let hunkOldRem = 0;
    let hunkNewRem = 0;

    // Scan lines at the byte level and strictly UTF-8 decode header lines (fatal + ignoreBOM)
    // while tracking unified-diff hunk line counts so hunk body lines starting with `+++ `/`--- `
    // are never misclassified as file headers!
    let lineStart = 0;
    while (lineStart <= rawBuf.length) {
      let lineEnd = rawBuf.indexOf(0x0a, lineStart);
      if (lineEnd < 0) lineEnd = rawBuf.length;
      const trimmedEnd =
        lineEnd > lineStart && rawBuf[lineEnd - 1] === 0x0d ? lineEnd - 1 : lineEnd;

      // Consume unified-diff hunk body lines before header matching
      if (hunkOldRem > 0 || hunkNewRem > 0) {
        if (lineStart === trimmedEnd) {
          if (hunkOldRem > 0 && hunkNewRem > 0) {
            hunkOldRem--;
            hunkNewRem--;
          }
          if (lineEnd === rawBuf.length) break;
          lineStart = lineEnd + 1;
          continue;
        }
        const firstByte = rawBuf[lineStart];
        if (firstByte === 0x20 && hunkOldRem > 0 && hunkNewRem > 0) {
          hunkOldRem--;
          hunkNewRem--;
          if (lineEnd === rawBuf.length) break;
          lineStart = lineEnd + 1;
          continue;
        }
        if (firstByte === 0x2d && hunkOldRem > 0) {
          hunkOldRem--;
          if (lineEnd === rawBuf.length) break;
          lineStart = lineEnd + 1;
          continue;
        }
        if (firstByte === 0x2b && hunkNewRem > 0) {
          hunkNewRem--;
          if (lineEnd === rawBuf.length) break;
          lineStart = lineEnd + 1;
          continue;
        }
        if (firstByte === 0x5c) {
          // `\ No newline at end of file` inside hunk
          if (lineEnd === rawBuf.length) break;
          lineStart = lineEnd + 1;
          continue;
        }
        // Unexpected non-hunk line ends hunk tracking so following headers are never skipped
        hunkOldRem = 0;
        hunkNewRem = 0;
      }

      if (bufferStartsWith(rawBuf, lineStart, trimmedEnd, AT_AT_PREFIX)) {
        const hunkHdr = rawBuf.subarray(lineStart, trimmedEnd).toString("latin1");
        const hm = hunkHdr.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/);
        if (hm) {
          hunkOldRem = hm[1] !== undefined ? Number(hm[1]) : 1;
          hunkNewRem = hm[2] !== undefined ? Number(hm[2]) : 1;
        }
        if (lineEnd === rawBuf.length) break;
        lineStart = lineEnd + 1;
        continue;
      }

      const isHeader = PATCH_HEADER_PREFIXES.some((pfx) =>
        bufferStartsWith(rawBuf, lineStart, trimmedEnd, pfx),
      );
      if (isHeader) {
        let line: string;
        try {
          line = STRICT_UTF8_DECODER.decode(rawBuf.subarray(lineStart, trimmedEnd));
        } catch {
          anyUninspectableHeader = true;
          lineStart = lineEnd + 1;
          continue;
        }
        if (line.startsWith("diff --git ")) {
          const pair = parseDiffGitLine(line);
          if (!pair) {
            // Fail closed unconditionally on any ambiguous or malformed `diff --git` header
            anyUninspectableHeader = true;
          } else {
            const r1 = pushPath(pair[0], true, true);
            const r2 = pushPath(pair[1], true, true);
            if (r1 === "invalid" || r2 === "invalid") anyUninspectableHeader = true;
          }
        } else {
          const std = line.match(/^(?:---|\+\+\+|\*\*\*) ([^\t\r\n]+)/);
          if (std) {
            const res = pushPath(std[1], true);
            if (res === "invalid") anyUninspectableHeader = true;
          } else {
            const metaPath = line.match(
              /^(?:rename from|rename to|copy from|copy to|Index:) ([^\r\n]+)/,
            );
            if (metaPath) {
              const res = pushPath(metaPath[1], false);
              if (res === "invalid") anyUninspectableHeader = true;
            }
          }
        }
      }
      if (lineEnd === rawBuf.length) break;
      lineStart = lineEnd + 1;
    }
    // Fail closed if a readable patch yielded zero recognized target paths or any header was uninspectable
    if (out.length === 0 || anyUninspectableHeader) {
      return { targets: [], uninspectable: true };
    }
    return { targets: [...new Set(out)], uninspectable: false };
  } catch {
    return { targets: [], uninspectable: true };
  }
}

function extractQuotedStrings(script: string): string[] {
  const out: string[] = [];
  const re = /'([^'\n]{1,300})'|"([^"\n]{1,300})"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(script)) !== null) {
    const s = m[1] ?? m[2] ?? "";
    if (s) out.push(s);
  }
  return out;
}

function collectDestOperands(
  args: string[],
  valueFlags: Set<string>,
): { operands: string[]; targetDir: string | null } {
  const operands: string[] = [];
  let targetDir: string | null = null;
  let endFlags = false;
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (!endFlags && t === "--") {
      endFlags = true;
      continue;
    }
    if (!endFlags && t.startsWith("-") && t.length > 1) {
      if (t === "-t" || t === "--target-directory") {
        targetDir = args[++i] ?? null;
        continue;
      }
      if (t.startsWith("--target-directory=")) {
        targetDir = t.slice("--target-directory=".length);
        continue;
      }
      if (t.startsWith("-t") && t.length > 2) {
        targetDir = t.slice(2);
        continue;
      }
      if (valueFlags.has(t)) {
        i++;
        continue;
      }
      continue;
    }
    operands.push(t);
  }
  return { operands, targetDir };
}

function expandCopyDestPaths(
  srcs: string[],
  dest: string,
  cwd: string,
): string[] {
  const destAbs = canonicalizeMaybePath(resolve(cwd, dest));
  const out = [destAbs];
  const destIsDir =
    dest.endsWith("/") ||
    (existsSync(destAbs) &&
      (() => {
        try {
          return statSync(destAbs).isDirectory();
        } catch {
          return false;
        }
      })());
  if (destIsDir) {
    for (const s of srcs) {
      const b = basename(s);
      if (b) out.push(canonicalizeMaybePath(join(destAbs, b)));
    }
  }
  return out;
}

export function checkSpecAndTestLocks(
  workbenchRoot: string,
  input: CodexHookInput,
  cfg: WorkbenchConfig,
): string | null {
  if (!cfg.ledger.enabled) return null;
  const dbPath = join(workbenchRoot, ".workbench", "ledger", "ledger.sqlite");
  if (!existsSync(dbPath)) return null;

  const wbReal = canonicalizeMaybePath(workbenchRoot);
  const baseWorkdir = extractToolWorkdir(input);
  const touchedFilePaths = extractTouchedFilePaths(input).map((p) =>
    canonicalizeMaybePath(resolve(baseWorkdir, p)),
  );
  const cmd = extractShellCommand(input);
  if (touchedFilePaths.length === 0 && !cmd) return null;

  let ledger: Ledger | null = null;
  try {
    ledger = new Ledger(workbenchRoot);
    const activeLocks = ledger.listActiveSpecLocks();
    if (activeLocks.length === 0) return null;

    const allOpenBoundWorktrees = new Set<string>();
    for (const openTask of ledger.listOpenTasks()) {
      for (const r of ledger.getTaskRepos(openTask.task_id)) {
        if (r.worktree) {
          allOpenBoundWorktrees.add(canonicalizeMaybePath(r.worktree));
        }
      }
    }

    type UnboundWorktreeMatcher = { worktreesDir: string; branch: string };
    type ResolvedLock = {
      task_id: string;
      lockedSpecFiles: Array<{ kind: "ssot" | "tech_spec" | "test_spec"; abs: string; rel: string }>;
      lockedTestGlobs: string[];
      explicitRoots: string[];
      unboundWorktrees: UnboundWorktreeMatcher[];
    };

    const resolvedLocks: ResolvedLock[] = activeLocks.map((st) => {
      const scopes = new Set(st.state === "AMENDED" ? st.amend_scopes : []);
      const unlockedSsot = scopes.has("requirement") || scopes.has("invariant");
      const unlockedTech = unlockedSsot || scopes.has("tech_spec");
      const unlockedTest = unlockedSsot || scopes.has("test_spec");

      const lockedSpecFiles: ResolvedLock["lockedSpecFiles"] = [];
      if (st.files) {
        if (!unlockedSsot) {
          lockedSpecFiles.push({
            kind: "ssot",
            rel: st.files.ssot,
            abs: canonicalizeMaybePath(resolve(wbReal, st.files.ssot)),
          });
        }
        if (!unlockedTech) {
          lockedSpecFiles.push({
            kind: "tech_spec",
            rel: st.files.tech_spec,
            abs: canonicalizeMaybePath(resolve(wbReal, st.files.tech_spec)),
          });
        }
        if (!unlockedTest) {
          lockedSpecFiles.push({
            kind: "test_spec",
            rel: st.files.test_spec,
            abs: canonicalizeMaybePath(resolve(wbReal, st.files.test_spec)),
          });
        }
      }

      const taskRepos = ledger!.getTaskRepos(st.task_id);
      const explicitRoots: string[] = [];
      const unboundWorktrees: UnboundWorktreeMatcher[] = [];
      for (const r of taskRepos) {
        if (r.worktree) {
          explicitRoots.push(canonicalizeMaybePath(r.worktree));
        } else {
          explicitRoots.push(canonicalizeMaybePath(resolve(wbReal, r.repo)));
          unboundWorktrees.push({
            worktreesDir: canonicalizeMaybePath(resolve(wbReal, `${r.repo}.worktrees`)),
            branch: r.branch,
          });
        }
      }
      explicitRoots.sort((a, b) => b.length - a.length);

      return {
        task_id: st.task_id,
        lockedSpecFiles,
        lockedTestGlobs: unlockedTest ? [] : st.locked_test_globs,
        explicitRoots,
        unboundWorktrees,
      };
    });

    const wtBranchCache = new Map<string, string | null>();
    const getWorktreeBranch = (wtRoot: string): string | null => {
      if (wtBranchCache.has(wtRoot)) return wtBranchCache.get(wtRoot)!;
      const res = runGit(wtRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
      const b = res.code === 0 ? res.stdout.trim() : null;
      wtBranchCache.set(wtRoot, b);
      return b;
    };

    const resolveRelWithinLock = (lock: ResolvedLock, absTarget: string): string | null => {
      const relFromWb = relative(wbReal, absTarget).replace(/\\/g, "/");
      if (lock.explicitRoots.length === 0 && lock.unboundWorktrees.length === 0) {
        return relFromWb && !relFromWb.startsWith("..") ? relFromWb : null;
      }
      for (const rr of lock.explicitRoots) {
        if (absTarget === rr || absTarget.startsWith(rr + "/")) {
          return relative(rr, absTarget).replace(/\\/g, "/");
        }
      }
      for (const uw of lock.unboundWorktrees) {
        if (absTarget.startsWith(uw.worktreesDir + "/")) {
          const sub = relative(uw.worktreesDir, absTarget).replace(/\\/g, "/");
          const wtName = sub.split("/")[0];
          if (!wtName) continue;
          const wtRoot = canonicalizeMaybePath(join(uw.worktreesDir, wtName));
          if (allOpenBoundWorktrees.has(wtRoot)) continue;
          const b = getWorktreeBranch(wtRoot);
          if (b && b === uw.branch) {
            return relative(wtRoot, absTarget).replace(/\\/g, "/");
          }
        }
      }
      return null;
    };

    const matchLockedPath = (absTarget: string): string | null => {
      for (const lock of resolvedLocks) {
        for (const sf of lock.lockedSpecFiles) {
          if (absTarget === sf.abs) {
            const suggestedScope =
              sf.kind === "ssot" ? "requirement|invariant" : sf.kind;
            return (
              `物理锁（冻结 Spec 保护）：任务 ${lock.task_id} 的 ${sf.rel} 处于周期冻结态，禁止直接修改。\n` +
              `如确需变更，请先经用户确认并执行：ledger amend ${lock.task_id} --scope ${suggestedScope} --reason "<变更原因>"`
            );
          }
        }
        if (lock.lockedTestGlobs.length > 0) {
          const relFromWb = relative(wbReal, absTarget).replace(/\\/g, "/");
          const relWithinTask = resolveRelWithinLock(lock, absTarget);
          if (
            relWithinTask &&
            lock.lockedTestGlobs.some((g) => matchesGlob(relWithinTask, g))
          ) {
            return (
              `物理锁（冻结测试防篡改）：任务 ${lock.task_id} 已锁定测试文件 (${relFromWb})，实现/修 bug 阶段禁止私自修改测试断言迎合代码。\n` +
              `如确认是测试用例本身有误，请经用户确认后执行：ledger amend ${lock.task_id} --scope test_spec --reason "<原因>"`
            );
          }
        }
      }
      return null;
    };

    // 1. Check direct file-edit & apply_patch targets
    for (const abs of touchedFilePaths) {
      const hit = matchLockedPath(abs);
      if (hit) return hit;
    }

    // 2. Check mutating shell commands (with bounded recursion for `sh -c` / `bash -c` / `zsh -c`)
    const checkShellString = (shellCmd: string, cwdStart: string, depth: number): string | null => {
      if (depth > 3) return null;
      const segments = splitShellSegments(shellCmd);
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const segCwd = resolveSegmentCwd(segments, i, cwdStart);

        // Always inspect unquoted shell output redirections (`>`, `>>`, `>|`, `&>`, `<>`, etc.)
        const { writeTargets: redirWrites, readInputs: redirReads, strippedSeg } =
          parseShellRedirections(seg, segCwd);
        for (const targetAbs of redirWrites) {
          const hit = matchLockedPath(targetAbs);
          if (hit) return hit;
        }

        const metaToks = splitShellTokensWithMeta(strippedSeg);
        if (!metaToks || metaToks.length === 0) continue;
        const { bin, cmdToks, effectiveCwd, readOnly } = unwrapCommandPrefix(metaToks, segCwd);
        if (readOnly || !bin) continue;

        const isLedgerCli =
          bin === "ledger" ||
          ((bin === "bun" || bin === "node") &&
            Boolean(cmdToks[1]?.endsWith("/ledger.js") || cmdToks[1]?.endsWith("/ledger.ts")));
        if (isLedgerCli) continue;

        const args = cmdToks.slice(1);

        // Nested shell invocation (`sh -c`, `bash -lc`, `zsh -c`, `dash -c`, `ksh -c`)
        if (/^(sh|bash|zsh|dash|ksh)$/.test(bin)) {
          for (let j = 0; j < args.length; j++) {
            const a = args[j];
            if (a === "--") break;
            if (a === "-o" || a === "+o") {
              j++;
              continue;
            }
            if (a.startsWith("-") && !a.startsWith("--") && a.includes("c")) {
              const nested = args[j + 1];
              if (nested) {
                const nestedHit = checkShellString(nested, effectiveCwd, depth + 1);
                if (nestedHit) return nestedHit;
              }
              break;
            }
          }
          continue;
        }

        const candidateTargets: string[] = [];

        const failClosedForUninspectablePatchDir = (dirPath: string): string | null => {
          const canonDir = canonicalizeMaybePath(dirPath);
          for (const lock of resolvedLocks) {
            for (const sf of lock.lockedSpecFiles) {
              if (
                dirname(sf.abs) === canonDir ||
                sf.abs.startsWith(canonDir + "/") ||
                canonDir.startsWith(dirname(sf.abs) + "/")
              ) {
                return matchLockedPath(sf.abs);
              }
            }
            if (lock.lockedTestGlobs.length > 0) {
              const dirInsideLock = resolveRelWithinLock(lock, canonDir) !== null;
              const lockInsideDir = lock.explicitRoots.some(
                (rr) => rr === canonDir || rr.startsWith(canonDir + "/"),
              );
              if (dirInsideLock || lockInsideDir) {
                return (
                  `物理锁（冻结测试防篡改）：无法在预检查阶段安全解析补丁目标，禁止在包含锁定测试文件的目录 (${relative(wbReal, canonDir) || "."}) 中应用未检视补丁（任务 ${lock.task_id}）。`
                );
              }
            }
          }
          return null;
        };

        if (bin === "cp" || bin === "install") {
          const valFlags =
            bin === "install"
              ? new Set(["-m", "-o", "-g", "-S", "-B", "--mode", "--owner", "--group", "--suffix"])
              : new Set(["-S", "--suffix", "--backup"]);
          const { operands, targetDir } = collectDestOperands(args, valFlags);
          if (targetDir) {
            candidateTargets.push(...expandCopyDestPaths(operands, targetDir, effectiveCwd));
          } else if (operands.length >= 2) {
            const dest = operands[operands.length - 1];
            const srcs = operands.slice(0, -1);
            candidateTargets.push(...expandCopyDestPaths(srcs, dest, effectiveCwd));
          }
        } else if (bin === "mv") {
          const { operands, targetDir } = collectDestOperands(
            args,
            new Set(["-S", "--suffix", "--backup"]),
          );
          if (targetDir) {
            for (const s of operands) {
              candidateTargets.push(canonicalizeMaybePath(resolve(effectiveCwd, s)));
            }
            candidateTargets.push(...expandCopyDestPaths(operands, targetDir, effectiveCwd));
          } else if (operands.length >= 2) {
            const dest = operands[operands.length - 1];
            const srcs = operands.slice(0, -1);
            for (const s of srcs) {
              candidateTargets.push(canonicalizeMaybePath(resolve(effectiveCwd, s)));
            }
            candidateTargets.push(...expandCopyDestPaths(srcs, dest, effectiveCwd));
          }
        } else if (bin === "rm" || bin === "touch" || bin === "tee") {
          const { operands } = collectDestOperands(args, new Set());
          for (const op of operands) {
            candidateTargets.push(canonicalizeMaybePath(resolve(effectiveCwd, op)));
          }
        } else if (bin === "truncate") {
          const { operands } = collectDestOperands(
            args,
            new Set(["-s", "--size", "-r", "--reference"]),
          );
          for (const op of operands) {
            candidateTargets.push(canonicalizeMaybePath(resolve(effectiveCwd, op)));
          }
        } else if (bin === "chmod" || bin === "chown") {
          const hasRef = args.some((a) => a === "--reference" || a.startsWith("--reference="));
          const { operands } = collectDestOperands(args, new Set(["--reference"]));
          const files = hasRef ? operands : operands.slice(1);
          for (const f of files) {
            candidateTargets.push(canonicalizeMaybePath(resolve(effectiveCwd, f)));
          }
        } else if (bin === "dd") {
          for (const a of args) {
            if (a.startsWith("of=") && a.length > 3) {
              candidateTargets.push(canonicalizeMaybePath(resolve(effectiveCwd, a.slice(3))));
            }
          }
        } else if (bin === "sed") {
          let inPlace = false;
          let hasExplicitScript = false;
          const scripts: string[] = [];
          const positionals: string[] = [];
          let endFlags = false;
          for (let j = 0; j < args.length; j++) {
            const a = args[j];
            if (!endFlags && a === "--") {
              endFlags = true;
              continue;
            }
            if (!endFlags && a.startsWith("-") && a.length > 1) {
              if (a === "--in-place" || a.startsWith("--in-place=")) {
                inPlace = true;
                continue;
              }
              if (a === "-i") {
                inPlace = true;
                // GNU vs BSD sed `-i ''` or `-i .bak`: if next arg is empty string, consume it
                if (args[j + 1] === "") j++;
                continue;
              }
              if (!a.startsWith("--") && /^-[a-zA-Z]*i/.test(a)) {
                inPlace = true;
                continue;
              }
              if (a === "-e" || a === "--expression") {
                hasExplicitScript = true;
                if (args[j + 1]) scripts.push(args[++j]);
                continue;
              }
              if (a === "-f" || a === "--file") {
                hasExplicitScript = true;
                j++;
                continue;
              }
              continue;
            }
            positionals.push(a);
          }
          let fileArgs = positionals;
          if (!hasExplicitScript && positionals.length > 0) {
            scripts.push(positionals[0]);
            fileArgs = positionals.slice(1);
          }
          if (inPlace) {
            for (const f of fileArgs) {
              candidateTargets.push(canonicalizeMaybePath(resolve(effectiveCwd, f)));
            }
          }
          for (const sc of scripts) {
            const wm = sc.match(/(?:^|[;\n\s])w\s+([^\s;]+)/);
            if (wm?.[1]) {
              candidateTargets.push(canonicalizeMaybePath(resolve(effectiveCwd, wm[1])));
            }
          }
        } else if (bin === "awk" || bin === "gawk" || bin === "mawk") {
          let inPlace = false;
          let hasProgFile = false;
          const progs: string[] = [];
          const positionals: string[] = [];
          for (let j = 0; j < args.length; j++) {
            const a = args[j];
            if (a === "--") {
              positionals.push(...args.slice(j + 1));
              break;
            }
            if (a === "-i" && args[j + 1] === "inplace") {
              inPlace = true;
              j++;
              continue;
            }
            if (a === "-f" || a === "--file") {
              hasProgFile = true;
              j++;
              continue;
            }
            if (a === "-F" || a === "-v") {
              j++;
              continue;
            }
            if (a.startsWith("-")) continue;
            positionals.push(a);
          }
          let fileArgs = positionals;
          if (!hasProgFile && positionals.length > 0) {
            progs.push(positionals[0]);
            fileArgs = positionals.slice(1);
          }
          if (inPlace) {
            for (const f of fileArgs) {
              candidateTargets.push(canonicalizeMaybePath(resolve(effectiveCwd, f)));
            }
          }
          for (const pr of progs) {
            for (const m of pr.matchAll(/>>?\s*["']([^"'\n]+)["']/g)) {
              if (m[1]) candidateTargets.push(canonicalizeMaybePath(resolve(effectiveCwd, m[1])));
            }
          }
        } else if (bin === "patch") {
          let stripLevel: number | null = null;
          let patchDir = effectiveCwd;
          let dryRun = false;
          let hasOutputFlag = false;
          const patchInputs: string[] = [...redirReads];
          const positionals: string[] = [];
          for (let j = 0; j < args.length; j++) {
            const a = args[j];
            if (a === "--") {
              positionals.push(...args.slice(j + 1));
              break;
            }
            if (a === "--dry-run" || a === "--check" || a === "-C") {
              dryRun = true;
              continue;
            }
            if (a === "-p" && args[j + 1] !== undefined) {
              const n = Number(args[++j]);
              if (Number.isInteger(n) && n >= 0) stripLevel = n;
              continue;
            }
            if (/^-p\d+$/.test(a)) {
              stripLevel = Number(a.slice(2));
              continue;
            }
            if (a === "-d" || a === "--directory") {
              if (args[j + 1]) patchDir = resolve(effectiveCwd, args[++j]);
              continue;
            }
            if (a.startsWith("--directory=")) {
              patchDir = resolve(effectiveCwd, a.slice("--directory=".length));
              continue;
            }
            if (a === "-i" || a === "--input") {
              if (args[j + 1]) patchInputs.push(canonicalizeMaybePath(resolve(effectiveCwd, args[++j])));
              continue;
            }
            if (a.startsWith("--input=")) {
              patchInputs.push(canonicalizeMaybePath(resolve(effectiveCwd, a.slice("--input=".length))));
              continue;
            }
            if (a === "-o" || a === "--output") {
              hasOutputFlag = true;
              if (args[j + 1]) candidateTargets.push(canonicalizeMaybePath(resolve(effectiveCwd, args[++j])));
              continue;
            }
            if (a === "-r" || a === "-b" || a === "-B" || a === "-z" || a === "-V") {
              if (a !== "-b") j++;
              continue;
            }
            if (a.startsWith("-")) continue;
            positionals.push(a);
          }
          if (dryRun && !hasOutputFlag) continue;
          if (positionals[0]) {
            candidateTargets.push(canonicalizeMaybePath(resolve(patchDir, positionals[0])));
          }
          if (positionals[1]) {
            patchInputs.push(canonicalizeMaybePath(resolve(effectiveCwd, positionals[1])));
          }
          let anyUninspectable = false;
          for (const pf of patchInputs) {
            const parsed = extractPatchFileTargets(pf, patchDir, stripLevel);
            candidateTargets.push(...parsed.targets);
            if (parsed.uninspectable) anyUninspectable = true;
          }
          if (
            anyUninspectable ||
            (candidateTargets.length === 0 && patchInputs.length === 0)
          ) {
            const failHit = failClosedForUninspectablePatchDir(patchDir);
            if (failHit) return failHit;
          }
        } else if (bin === "git") {
          const git = extractGitSubcommand(cmdToks);
          if (git) {
            const gitDir = resolveGitDirFlags(effectiveCwd, git.gitDirFlags, false) ?? effectiveCwd;
            const subArgs = git.subArgs;
            if (git.subcmd === "checkout" || git.subcmd === "restore") {
              const ddIdx = subArgs.indexOf("--");
              let pathArgs: string[] = [];
              if (ddIdx >= 0) {
                pathArgs = subArgs.slice(ddIdx + 1);
              } else if (git.subcmd === "restore") {
                const { operands } = collectDestOperands(subArgs, new Set(["-s", "--source"]));
                pathArgs = operands;
              } else {
                const { operands } = collectDestOperands(subArgs, new Set(["-b", "-B", "--orphan"]));
                pathArgs = operands.slice(1);
              }
              for (const p of pathArgs) {
                candidateTargets.push(canonicalizeMaybePath(resolve(gitDir, p)));
              }
            } else if (git.subcmd === "rm" || git.subcmd === "mv") {
              const { operands } = collectDestOperands(subArgs, new Set());
              for (const p of operands) {
                candidateTargets.push(canonicalizeMaybePath(resolve(gitDir, p)));
              }
            } else if (git.subcmd === "apply") {
              let stripLevel: number | null = 1;
              let applyDir = gitDir;
              let hasReportOrCheckFlag = false;
              let hasExplicitApplyFlag = false;
              let hasFakeAncestorFlag = false;
              const patchFiles: string[] = [...redirReads];
              for (let j = 0; j < subArgs.length; j++) {
                const a = subArgs[j];
                if (a === "--") {
                  for (const pf of subArgs.slice(j + 1)) {
                    patchFiles.push(canonicalizeMaybePath(resolve(gitDir, pf)));
                  }
                  break;
                }
                if (a === "--check" || a === "--stat" || a === "--numstat" || a === "--summary") {
                  hasReportOrCheckFlag = true;
                  continue;
                }
                if (a === "--apply") {
                  hasExplicitApplyFlag = true;
                  continue;
                }
                if (a === "--build-fake-ancestor") {
                  hasFakeAncestorFlag = true;
                  const target = subArgs[++j];
                  if (target) {
                    candidateTargets.push(canonicalizeMaybePath(resolve(gitDir, target)));
                  }
                  continue;
                }
                if (a.startsWith("--build-fake-ancestor=")) {
                  hasFakeAncestorFlag = true;
                  const target = a.slice("--build-fake-ancestor=".length);
                  if (target) {
                    candidateTargets.push(canonicalizeMaybePath(resolve(gitDir, target)));
                  }
                  continue;
                }
                if (a === "-p" && subArgs[j + 1] !== undefined) {
                  const n = Number(subArgs[++j]);
                  if (Number.isInteger(n) && n >= 0) stripLevel = n;
                  continue;
                }
                if (/^-p\d+$/.test(a)) {
                  stripLevel = Number(a.slice(2));
                  continue;
                }
                if (a === "--directory" && subArgs[j + 1] !== undefined) {
                  applyDir = resolve(gitDir, subArgs[++j]);
                  continue;
                }
                if (a.startsWith("--directory=")) {
                  applyDir = resolve(gitDir, a.slice("--directory=".length));
                  continue;
                }
                if (
                  a === "--include" ||
                  a === "--exclude" ||
                  a === "--whitespace" ||
                  a === "-C"
                ) {
                  j++;
                  continue;
                }
                if (a.startsWith("-")) continue;
                patchFiles.push(canonicalizeMaybePath(resolve(gitDir, a)));
              }
              // In git apply, `--apply` overrides `--stat`/`--numstat`/`--summary`/`--check` regardless of flag order!
              if (hasReportOrCheckFlag && !hasExplicitApplyFlag && !hasFakeAncestorFlag) continue;
              let anyUninspectable = false;
              for (const pf of patchFiles) {
                const parsed = extractPatchFileTargets(pf, applyDir, stripLevel);
                candidateTargets.push(...parsed.targets);
                if (parsed.uninspectable) anyUninspectable = true;
              }
              if (anyUninspectable || patchFiles.length === 0) {
                const failHit = failClosedForUninspectablePatchDir(applyDir);
                if (failHit) return failHit;
              }
            }
          }
        } else if (/^(python3?(?:\.\d+)?|node|bun|perl|ruby)$/.test(bin)) {
          let inPlace = false;
          const inlineScripts: string[] = [];
          const fileArgs: string[] = [];
          let endFlags = false;
          for (let j = 0; j < args.length; j++) {
            const a = args[j];
            if (!endFlags && a === "--") {
              endFlags = true;
              continue;
            }
            if (!endFlags && a.startsWith("-") && a.length > 1) {
              if ((bin === "perl" || bin === "ruby") && /^-[a-zA-Z]*i/.test(a)) {
                inPlace = true;
              }
              if (
                a === "-c" ||
                a === "-e" ||
                a === "-E" ||
                a === "--eval" ||
                ((bin === "perl" || bin === "ruby") && /^-[a-zA-Z]*[eE]$/.test(a))
              ) {
                if (args[j + 1] !== undefined) inlineScripts.push(args[++j]);
                continue;
              }
              continue;
            }
            fileArgs.push(a);
          }

          if (inPlace) {
            for (const f of fileArgs) {
              candidateTargets.push(canonicalizeMaybePath(resolve(effectiveCwd, f)));
            }
          }

          if (inlineScripts.length > 0) {
            const combinedScript = inlineScripts.join("\n");
            const looksMutating = inPlace || INLINE_WRITE_INDICATOR_RE.test(combinedScript);
            if (looksMutating) {
              // 1. Resolve all quoted string literals as candidate paths
              for (const lit of extractQuotedStrings(combinedScript)) {
                candidateTargets.push(canonicalizeMaybePath(resolve(effectiveCwd, lit)));
              }
              // 2. Check explicit spec file / task-owned locked glob references
              const canonEffCwd = canonicalizeMaybePath(effectiveCwd);
              for (const lock of resolvedLocks) {
                for (const sf of lock.lockedSpecFiles) {
                  const baseName = sf.rel.split("/").pop() ?? sf.rel;
                  const inSpecDir = canonEffCwd === dirname(sf.abs);
                  if (
                    combinedScript.includes(sf.rel) ||
                    combinedScript.includes(sf.abs) ||
                    (inSpecDir && combinedScript.includes(baseName))
                  ) {
                    const suggestedScope =
                      sf.kind === "ssot" ? "requirement|invariant" : sf.kind;
                    return (
                      `物理锁（冻结 Spec 保护）：禁止通过内联脚本修改任务 ${lock.task_id} 的冻结文档 (${sf.rel})。\n` +
                      `如确需变更，请先经用户确认并执行：ledger amend ${lock.task_id} --scope ${suggestedScope} --reason "<变更原因>"`
                    );
                  }
                }
                if (lock.lockedTestGlobs.length > 0) {
                  const cwdInLock = resolveRelWithinLock(lock, canonEffCwd) !== null;
                  const hasDynamicPathBuild =
                    /\+|\$\{|\#\{|\b(?:join|resolve|format)\s*\(|f["']/.test(combinedScript);
                  if (
                    cwdInLock &&
                    hasDynamicPathBuild &&
                    lock.lockedTestGlobs.some((g) => g.includes(".hurl")) &&
                    combinedScript.includes(".hurl")
                  ) {
                    return (
                      `物理锁（冻结测试防篡改）：禁止通过内联脚本修改任务 ${lock.task_id} 锁定的 .hurl 测试文件。\n` +
                      `如确认是测试用例本身有误，请经用户确认后执行：ledger amend ${lock.task_id} --scope test_spec --reason "<原因>"`
                    );
                  }
                }
              }
            }
          }
        }

        for (const candidateAbs of candidateTargets) {
          const hit = matchLockedPath(candidateAbs);
          if (hit) return hit;
        }
      }
      return null;
    };

    if (cmd) {
      const shellHit = checkShellString(cmd, baseWorkdir, 0);
      if (shellHit) return shellHit;
    }
  } finally {
    ledger?.closeDb();
  }

  return null;
}

export function evaluatePreToolUse(
  workbenchRoot: string,
  input: CodexHookInput,
): string | null {
  const cfg = loadWorkbenchConfig(workbenchRoot);

  // Tier 1a: Ledger immutability & frozen spec/test physical locks (applies to ALL tools: file-edit, apply_patch, shell)
  const tamper = checkLedgerTamper(workbenchRoot, input, cfg);
  if (tamper) return tamper;
  const specLock = checkSpecAndTestLocks(workbenchRoot, input, cfg);
  if (specLock) return specLock;

  // Shell-only checks (never run on apply_patch / file-edit tools!)
  const cmd = extractShellCommand(input);
  if (!cmd) return null;

  const toolWorkdir = extractToolWorkdir(input);

  // Tier 1b: Physical fuses (strict env parsing so corrupted environments.json fails closed!)
  const prodHosts = collectProdDbHosts(workbenchRoot, cfg, { strict: true });
  if (
    cfg.guard.require_prod_db_hosts &&
    prodHosts.length === 0 &&
    (/\b(usql|psql|mysql)\b/.test(cmd) || isHttpWriteCommand(cmd))
  ) {
    return "物理保险丝（fail-closed）：工作台已启用 require_prod_db_hosts，但未配置任何 prod_db_hosts，拒绝执行数据库/HTTP 写命令直至补齐配置。";
  }
  const approvedRunbooks = loadApprovedRunbooksForSession(workbenchRoot, input.session_id);
  const fuseReason =
    checkProdDb(cmd, prodHosts, toolWorkdir, approvedRunbooks, workbenchRoot) ??
    checkKubectl(cmd, approvedRunbooks) ??
    checkCloudAndRedisOps(cmd) ??
    checkGitPhysicalFuse(workbenchRoot, cmd, toolWorkdir, cfg, approvedRunbooks);
  if (fuseReason) return fuseReason;

  // Tier 2: Passive dev ledger gate
  return checkLedgerGate(workbenchRoot, cmd, toolWorkdir, cfg, approvedRunbooks);
}

function logGuardError(root: string, err: unknown): void {
  try {
    const logPath = join(root, ".workbench", "ledger", "hook-errors.log");
    mkdirSync(dirname(logPath), { recursive: true });
    const msg = redactSecrets(err instanceof Error ? err.message : String(err));
    appendFileSync(logPath, `${new Date().toISOString()} [guard] ${msg}\n`);
  } catch {
    // Ignore log failure
  }
}

export async function runGuardCli(): Promise<void> {
  const parsed = await readHookStdinStrict();
  if (!parsed.ok) {
    // Fail-closed on malformed hook input so high-risk tools never bypass silently.
    emitPreToolUseDeny(`安全守卫输入解析失败（fail-closed）：${parsed.error}`);
    return;
  }
  if (!parsed.input) return;

  const root = findWorkbenchRoot(parsed.input.cwd);
  try {
    const denyReason = evaluatePreToolUse(root, parsed.input);
    if (denyReason) {
      emitPreToolUseDeny(denyReason);
    }
  } catch (err) {
    logGuardError(root, err);
    const safeMsg = redactSecrets(err instanceof Error ? err.message : String(err));
    emitPreToolUseDeny(
      `安全守卫执行异常（fail-closed，防止高风险操作被静默放行）：${safeMsg}`,
    );
  }
}
