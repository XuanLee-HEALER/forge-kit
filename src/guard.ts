import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  collectProdDbHosts,
  findWorkbenchRoot,
  loadWorkbenchConfig,
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
import { Ledger } from "./ledger";
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
function hasUnquotedRedirect(cmd: string, char: "<" | ">"): boolean {
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

  // 2. Shell commands directly mutating .workbench/ledger/
  const cmd = extractShellCommand(input);
  if (!cmd) return null;

  for (const seg of splitShellSegments(cmd)) {
    if (!seg.includes(".workbench/ledger") && !seg.includes("ledger.sqlite")) {
      continue;
    }
    const toks = splitShellTokens(seg);
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
  const url = cleaned.match(/^https?:\/\/(?:[^@/\s]+@)?([^:/\s]+)(?::\d+)?\/([^/\s]+)\/([^/\s]+)$|^ssh:\/\/(?:[^@/\s]+@)?([^:/\s]+)(?::\d+)?\/([^/\s]+)\/([^/\s]+)$/i);
  if (url) {
    const host = (url[1] ?? url[4]).toLowerCase();
    const owner = (url[2] ?? url[5]).toLowerCase();
    const repo = (url[3] ?? url[6]).toLowerCase();
    return { host, owner, repo };
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
  if (parts.length === 3 && parts[0].includes(".")) {
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

export function checkProdDb(cmd: string, prodHosts: string[]): string | null {
  if (prodHosts.length === 0) return null;
  const matchedHost = prodHosts.find((h) => cmd.includes(h));
  if (!matchedHost) return null;

  // ClickHouse HTTP write or POST/PUT/DELETE via curl/wget/http
  if (isHttpWriteCommand(cmd)) {
    if (SQL_WRITE_RE.test(cmd) || !/\bselect\b/i.test(cmd)) {
      return `物理保险丝：检测到向 prod 数据库 (${matchedHost}) 发送写请求，禁止自动执行。`;
    }
  }

  if (SQL_FILE_FLAG_RE.test(cmd) || hasUnquotedRedirect(cmd, "<")) {
    return `物理保险丝：检测到连接 prod 数据库 (${matchedHost}) 且 SQL 来自文件或标准输入，禁止自动执行。`;
  }
  const m = cmd.match(SQL_WRITE_RE);
  if (m) {
    return `物理保险丝：检测到连接 prod 数据库 (${matchedHost}) 且包含写操作关键字 ${m[1].toUpperCase()}，禁止自动执行。`;
  }
  return null;
}

export function checkKubectl(cmd: string): string | null {
  if (!cmd.includes("kubectl")) return null;
  for (const seg of splitShellSegments(cmd)) {
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

      const verb = words[0];
      const sub = words[1] ?? "";
      if (verb in KUBECTL_READ_SUB) {
        if (!KUBECTL_READ_SUB[verb].has(sub)) {
          return `物理保险丝：kubectl ${verb} ${sub} 属于非只读集群操作，禁止自动执行。`;
        }
      } else if (!KUBECTL_READ_VERBS.has(verb)) {
        return `物理保险丝：kubectl ${verb} 属于非只读集群操作，禁止自动执行。`;
      }

      // Check secrets including comma-separated resource lists like `cm,secret`
      for (const w of words.slice(1)) {
        for (const p of w.split(",")) {
          if (/^secrets?(\/|$|\.)/i.test(p.trim())) {
            return "物理保险丝：kubectl 读取 secret 资源，禁止自动执行。";
          }
        }
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

export function extractGitSubcommand(
  tokens: string[],
): { gitIdx: number; gitDirFlag: string | null; subcmd: string; subArgs: string[] } | null {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t !== "git" && !t.endsWith("/git")) continue;
    let gitDirFlag: string | null = null;
    let j = i + 1;
    while (j < tokens.length) {
      const a = tokens[j];
      if (a === "-C" && j + 1 < tokens.length) {
        gitDirFlag = tokens[j + 1];
        j += 2;
        continue;
      }
      if (a === "-c" && j + 1 < tokens.length) {
        j += 2;
        continue;
      }
      if (a.startsWith("-")) {
        j++;
        continue;
      }
      return {
        gitIdx: i,
        gitDirFlag,
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

function parseGitPushArgs(args: string[]): {
  positional: string[];
  hasRepoFlag: boolean;
  hasAllOrMirror: boolean;
} {
  const VALUE_FLAGS = new Set([
    "-o",
    "--push-option",
    "--repo",
    "--receive-pack",
    "--exec",
  ]);
  const positional: string[] = [];
  let hasRepoFlag = false;
  let hasAllOrMirror = false;
  let stopFlags = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!stopFlags && a === "--") {
      stopFlags = true;
      continue;
    }
    if (!stopFlags && a.startsWith("-")) {
      if (a === "--repo" || a.startsWith("--repo=")) {
        hasRepoFlag = true;
      }
      if (a === "--all" || a === "--mirror") {
        hasAllOrMirror = true;
      }
      if (VALUE_FLAGS.has(a)) {
        i++;
      }
      continue;
    }
    positional.push(a);
  }
  return { positional, hasRepoFlag, hasAllOrMirror };
}

export function checkGitPhysicalFuse(
  workbenchRoot: string,
  cmd: string,
  toolWorkdir: string,
  cfg: WorkbenchConfig,
): string | null {
  const segments = splitShellSegments(cmd);
  const tagRegexes = cfg.guard.prod_tag_patterns.map((p) => new RegExp(p));
  const protectedBranches = new Set(cfg.guard.protected_branches);

  for (let i = 0; i < segments.length; i++) {
    const toks = splitShellTokens(segments[i]);
    if (!toks || toks.length === 0) continue;

    // gh pr merge fuse
    const ghIdx = toks.findIndex((t) => t === "gh" || t.endsWith("/gh"));
    if (ghIdx !== -1 && toks[ghIdx + 1] === "pr" && toks[ghIdx + 2] === "merge") {
      return "物理保险丝：禁止 Agent 直接执行 `gh pr merge`，PR 合并到主分支由用户确认并执行。";
    }

    const git = extractGitSubcommand(toks);
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
      if (args.includes("--tags")) {
        return "物理保险丝：禁止自动推送 tag（`git push --tags` 可能直接触发生产部署），须由用户明确授权或亲自推送。";
      }
      const isForce = args.some(
        (a) => a === "-f" || a === "--force" || a.startsWith("--force-with-lease"),
      );
      const parsedPush = parseGitPushArgs(args);
      if (parsedPush.hasAllOrMirror) {
        return "物理保险丝：禁止 `git push --all` / `--mirror`，请显式指定要推送的单一分支。";
      }
      const refspecs = parsedPush.hasRepoFlag
        ? parsedPush.positional
        : parsedPush.positional.slice(1);
      for (const refspec of refspecs) {
        const rhs = refspec.includes(":") ? refspec.split(":").pop() ?? "" : refspec;
        const cleanRef = rhs.replace(/^refs\/(heads|tags)\//, "");
        if (refspec.startsWith("refs/tags/") || tagRegexes.some((re) => re.test(cleanRef))) {
          return `物理保险丝：禁止自动推送生产发布 tag (${refspec})，推送 tag 会立即触发生产部署。`;
        }
        if (protectedBranches.has(cleanRef)) {
          return `物理保险丝：禁止直接推送到受保护主分支 (${cleanRef})，请提 PR 由用户合并。`;
        }
      }
      // Implicit push (`git push` or `git push origin`) -> inspect current checkout branch
      if (refspecs.length === 0) {
        const segCwd = resolveSegmentCwd(segments, i, toolWorkdir);
        const targetDir = git.gitDirFlag ? resolve(segCwd, git.gitDirFlag) : segCwd;
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
      const git = extractGitSubcommand(toks);
      const ghIdx = toks.findIndex((t) => t === "gh" || t.endsWith("/gh"));
      const isGhPrCreate =
        ghIdx !== -1 &&
        toks[ghIdx + 1] === "pr" &&
        (toks[ghIdx + 2] === "create" || toks[ghIdx + 2] === "new");

      const isGitCommit = git?.subcmd === "commit";
      const isGitPush = git?.subcmd === "push";

      if (!isGitCommit && !isGitPush && !isGhPrCreate) continue;

      if (
        (git?.gitDirFlag && hasShellExpansion(git.gitDirFlag)) ||
        hasPrecedingDynamicCd(segments, i)
      ) {
        return "账本门禁（fail-closed）：检测到未展开的 shell 变量路径用于 git/gh 交付命令，请改用明确字面路径。";
      }

      const targetDir = git?.gitDirFlag
        ? resolve(segCwd, git.gitDirFlag)
        : segCwd;
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
        const isDeleteFlag = git.subArgs.some((a) => a === "--delete" || a === "-d");
        if (isDeleteFlag) {
          // Deleting a remote feature branch (protected branches already blocked by Tier 1)
          continue;
        }
        const parsedPush = parseGitPushArgs(git.subArgs);
        if (parsedPush.hasAllOrMirror) {
          return "账本门禁（fail-closed）：禁止 `git push --all` / `--mirror`，请显式指定目标分支。";
        }
        const refspecs = parsedPush.hasRepoFlag
          ? parsedPush.positional
          : parsedPush.positional.slice(1);
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
            if (srcRef === "HEAD") {
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
        const parsedGh = parseGhPrCreateArgs(toks.slice(ghIdx + 3));
        // Fail closed if `-R` / `--repo` (including attached `-Rowner/repo`) points to a different repository than origin
        const explicitGhRepo = parsedGh.repo;
        const originUrl = runGit(loc.checkoutDir, ["remote", "get-url", "origin"], 3000).stdout.trim();
        const originIdentity = parseGitRemoteRepo(originUrl);

        if (explicitGhRepo) {
          const targetIdentity = parseGhRepoSpec(explicitGhRepo);
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
    const content = readFileSync(patchAbsPath, "utf8");
    const out: string[] = [];
    for (const line of content.split(/\r?\n/)) {
      const m = line.match(/^(?:---|\+\+\+)\s+([^\t\r\n]+)/);
      if (!m) continue;
      let raw = m[1].trim();
      if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
      if (!raw || raw === "/dev/null") continue;
      const parts = raw.replace(/\\/g, "/").split("/").filter(Boolean);
      const effectiveStrip =
        stripLevel !== null
          ? stripLevel
          : parts[0] === "a" || parts[0] === "b"
            ? 1
            : 0;
      const rel = parts.slice(effectiveStrip).join("/");
      if (rel) {
        out.push(canonicalizeMaybePath(resolve(baseDir, rel)));
      }
    }
    return { targets: out, uninspectable: false };
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
            const gitDir = git.gitDirFlag ? resolve(effectiveCwd, git.gitDirFlag) : effectiveCwd;
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
              let readOnlyCheck = false;
              const patchFiles: string[] = [...redirReads];
              for (let j = 0; j < subArgs.length; j++) {
                const a = subArgs[j];
                if (a === "--") {
                  for (const pf of subArgs.slice(j + 1)) {
                    patchFiles.push(canonicalizeMaybePath(resolve(effectiveCwd, pf)));
                  }
                  break;
                }
                if (a === "--check" || a === "--stat" || a === "--numstat" || a === "--summary") {
                  readOnlyCheck = true;
                  continue;
                }
                if (/^-p\d+$/.test(a)) {
                  stripLevel = Number(a.slice(2));
                  continue;
                }
                if (a.startsWith("--directory=")) {
                  applyDir = resolve(gitDir, a.slice("--directory=".length));
                  continue;
                }
                if (a.startsWith("-")) continue;
                patchFiles.push(canonicalizeMaybePath(resolve(effectiveCwd, a)));
              }
              if (readOnlyCheck) continue;
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
  const fuseReason =
    checkProdDb(cmd, prodHosts) ??
    checkKubectl(cmd) ??
    checkCloudAndRedisOps(cmd) ??
    checkGitPhysicalFuse(workbenchRoot, cmd, toolWorkdir, cfg);
  if (fuseReason) return fuseReason;

  // Tier 2: Passive dev ledger gate
  return checkLedgerGate(workbenchRoot, cmd, toolWorkdir, cfg);
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
