import {
  accessSync,
  appendFileSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { redactSecrets } from "./cmdfmt";
import { findWorkbenchRoot, loadWorkbenchConfig } from "./config";
import { getHeadAndParents, locateRepo, runGit } from "./git";
import {
  extractGitSubcommand,
  parseGhPrCreateArgs,
  parseGhRepoSpec,
  parseGitRemoteRepo,
  type ShellToken,
  splitShellSegments,
  splitShellTokensWithMeta,
} from "./guard";
import {
  type CodexHookInput,
  emitPostCompactMessage,
  emitSessionStartContext,
  extractResponseExitCode,
  extractResponseText,
  extractShellCommand,
  extractToolWorkdir,
  readHookStdinStrict,
} from "./hook-io";
import { Ledger, normalizeReviewRole } from "./ledger";

export interface CapturedEvidence {
  kind: "commit" | "build" | "test" | "lint" | "review" | "hurl" | "pr";
  status: "pass" | "fail" | "fallback";
  summary: string;
  targetDir: string;
  targetBranch?: string | null;
  targetOwner?: string | null;
  targetRepoSpec?: string | null;
  prUrlRepoSpec?: string | null;
  pinnedSha?: string | null;
  pinnedRef?: string | null;
  requirePinnedSha?: boolean;
  meta?: Record<string, unknown>;
}

function parseLangCheckInvocation(cmdToks: string[]): {
  argsStart: number;
  mode: "static" | "dynamic" | "all";
  targetPositional: string | null;
} | null {
  const [c0 = "", c1 = ""] = cmdToks;
  let argsStart = -1;
  if (c0 === "lang-check" || c0.endsWith("/lang-check")) {
    argsStart = 1;
  } else if (
    (c0 === "bun" || c0.endsWith("/bun")) &&
    (c1.endsWith("/lang-check.js") || c1.endsWith("/lang-check.ts"))
  ) {
    argsStart = 2;
  }
  if (argsStart < 0) return null;

  let mode: "static" | "dynamic" | "all" = "all";
  let targetPositional: string | null = null;
  for (let i = argsStart; i < cmdToks.length; i++) {
    const t = cmdToks[i];
    if (t === "--") break;
    if (t === "--mode") {
      const v = cmdToks[++i];
      if (v === "static" || v === "dynamic" || v === "all") mode = v;
      else return null;
      continue;
    }
    if (t.startsWith("--mode=")) {
      const v = t.slice("--mode=".length);
      if (v === "static" || v === "dynamic" || v === "all") mode = v;
      else return null;
      continue;
    }
    if (t === "--lang") {
      i++;
      continue;
    }
    if (t.startsWith("--lang=") || t === "--json") continue;
    if (t.startsWith("-")) continue;
    if (!targetPositional) targetPositional = t;
  }
  return { argsStart, mode, targetPositional };
}

function extractTscArgs(cmdToks: string[]): string[] | null {
  const [c0 = "", c1 = "", c2 = ""] = cmdToks;
  if (c0 === "npx" && c1 === "tsc") return cmdToks.slice(2);
  if (c0 === "bunx" && c1 === "tsc") return cmdToks.slice(2);
  if (c0 === "bunx" && c1 === "--bun" && c2 === "tsc") return cmdToks.slice(3);
  if (c0 === "tsc" || c0.endsWith("/tsc")) return cmdToks.slice(1);
  return null;
}

function isPytestInvocation(cmdToks: string[]): { argsStart: number } | null {
  const [c0 = "", c1 = "", c2 = ""] = cmdToks;
  const bin = c0.split("/").pop() ?? "";
  if (bin === "pytest") return { argsStart: 1 };
  if (/^python3?(?:\.\d+)?$/.test(bin) && c1 === "-m" && c2 === "pytest") {
    return { argsStart: 3 };
  }
  return null;
}

/**
 * Token-based verification command classifier (handles line continuations, quoting, and leading ENV=VAL assignments).
 * Anchored strictly at command start so `echo "bun test"` / grep text never false-positives.
 */
function classifyVerifyCommand(metaToks: ShellToken[]): {
  kind: "test" | "build" | "lint" | "hurl" | "lang-check";
  cmdToks: string[];
  envToks: string[];
} | null {
  const { envToks, cmdToks } = splitLeadingEnv(metaToks);
  if (cmdToks.length === 0) return null;
  const [c0, c1 = "", c2 = ""] = cmdToks;
  const bin0 = c0.split("/").pop() ?? "";
  const makeTarget = bin0 === "make" ? extractMakeFirstTarget(cmdToks.slice(1)) : null;

  // lang-check (forge-kit unified Go/TS/Python static & dynamic checker)
  if (parseLangCheckInvocation(cmdToks)) {
    return { kind: "lang-check", cmdToks, envToks };
  }

  // test
  if (
    (bin0 === "go" && c1 === "test") ||
    (bin0 === "bun" && c1 === "test") ||
    (bin0 === "bun" && c1 === "run" && (c2 === "test" || c2.startsWith("test:"))) ||
    (bin0 === "npm" && c1 === "run" && (c2 === "test" || c2.startsWith("test:"))) ||
    isPytestInvocation(cmdToks) !== null ||
    (bin0 === "just" && c1 === "test") ||
    (bin0 === "make" && makeTarget === "test")
  ) {
    return { kind: "test", cmdToks, envToks };
  }

  // lint / static checks
  if (
    (bin0 === "go" && c1 === "vet") ||
    (bin0 === "make" && (makeTarget === "lint" || makeTarget === "harness-guard")) ||
    (bin0 === "just" && (c1 === "check" || c1 === "lint" || c1 === "typecheck" || c1 === "typecheck-server")) ||
    (bin0 === "bun" && c1 === "run" && (c2 === "check" || c2.startsWith("check:") || c2 === "lint" || c2.startsWith("lint:"))) ||
    (bin0 === "npm" && c1 === "run" && (c2 === "lint" || c2.startsWith("lint:") || c2 === "check" || c2.startsWith("check:"))) ||
    extractTscArgs(cmdToks) !== null ||
    (bin0 === "npx" && (c1 === "eslint" || (c1 === "biome" && c2 === "check"))) ||
    (bin0 === "bunx" && (c1 === "eslint" || (c1 === "biome" && c2 === "check") || (c1 === "--bun" && c2 === "biome" && cmdToks[3] === "check"))) ||
    (bin0 === "biome" && c1 === "check") ||
    (bin0 === "ruff" && c1 === "check") ||
    bin0 === "pyright" ||
    bin0 === "mypy" ||
    (bin0 === "golangci-lint" && c1 === "run")
  ) {
    return { kind: "lint", cmdToks, envToks };
  }

  // build
  if (
    (bin0 === "go" && c1 === "build") ||
    (bin0 === "make" && (makeTarget === "build" || makeTarget === "compile")) ||
    (bin0 === "just" && c1 === "build") ||
    (bin0 === "bun" && c1 === "run" && (c2 === "build" || c2.startsWith("build:"))) ||
    (bin0 === "npm" && c1 === "run" && /^(?:local:|fat:|prod:)?build(?::|$)/.test(c2))
  ) {
    return { kind: "build", cmdToks, envToks };
  }

  // hurl
  if (bin0 === "hurl") {
    return { kind: "hurl", cmdToks, envToks };
  }

  return null;
}

function parseReviewJsonOutput(
  outputText: string,
  outFilePath?: string,
): {
  status?: string;
  passed?: boolean;
  errorCode?: string;
  head?: string;
  base?: string;
  role?: string;
} | null {
  const candidates: string[] = [];
  if (outFilePath && existsSync(outFilePath)) {
    try {
      candidates.push(readFileSync(outFilePath, "utf8"));
    } catch {
      // Ignore unreadable out file
    }
  }
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
        return {
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

/**
 * Only capture evidence for unambiguous single-line shell invocations.
 * Avoid fabricating pass results when a command uses `||`, pipes, `;`, newlines, or subshells that mask exit codes.
 */
function hasAmbiguousControlFlow(cmd: string): boolean {
  let quote: "'" | '"' | "$'" | null = null;
  let escape = false;
  let atWordStart = true;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    const next = cmd[i + 1];
    if (escape) {
      escape = false;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      atWordStart = false;
      continue;
    }
    if (quote === "$'") {
      if (ch === "\\") escape = true;
      else if (ch === "'") quote = null;
      atWordStart = false;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") escape = true;
      else if (ch === '"') quote = null;
      else if (ch === "`" || (ch === "$" && next === "(")) return true;
      atWordStart = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      if (next !== "\n") atWordStart = false;
      continue;
    }
    if (ch === "$" && next === "'") {
      quote = "$'";
      atWordStart = false;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      atWordStart = false;
      continue;
    }
    if (ch === "#" && atWordStart) {
      // Unquoted `#` at a true POSIX word boundary starts a comment until `\n` or EOF.
      while (i + 1 < cmd.length && cmd[i + 1] !== "\n") i++;
      continue;
    }
    if (ch === "\n" || ch === "\r") return true; // Multi-line script masks earlier line's exit code!
    if (ch === "|") return true; // Both `|` (e.g. `bun test | tee log`) and `||` mask exit codes!
    if (ch === ";") return true; // `;` masks earlier segment exit code!
    if (ch === "&") {
      if (next === "&") {
        atWordStart = true;
        i++; // `&&` preserves failure exit codes
        continue;
      }
      const prev = cmd[i - 1];
      if (prev === ">" || prev === "<" || next === ">") {
        atWordStart = false;
        continue; // Redirection (`2>&1`, `<&0`, `&>file`), not backgrounding
      }
      return true; // Single `&` backgrounds the command and masks its exit code!
    }
    if (ch === "`" || ch === "(" || ch === ")") return true; // Subshells, command/process substitution, and function definitions
    atWordStart = ch === " " || ch === "\t";
  }
  return false;
}

function hasInfoOnlyFlag(toks: string[]): boolean {
  if (toks[1] === "help") return true;
  for (const t of toks) {
    if (t === "--") break;
    if (
      t === "--help" ||
      t === "-h" ||
      t === "--version" ||
      t === "-V" ||
      /^-[hV]+$/.test(t)
    ) {
      return true;
    }
  }
  return false;
}

const MAKE_ALL_LONG_OPTS = [
  "always-make",
  "directory",
  "debug",
  "environment-overrides",
  "file",
  "makefile",
  "help",
  "ignore-errors",
  "include-dir",
  "jobs",
  "keep-going",
  "load-average",
  "max-load",
  "check-symlink-times",
  "just-print",
  "dry-run",
  "recon",
  "old-file",
  "assume-old",
  "print-data-base",
  "question",
  "no-builtin-rules",
  "no-builtin-variables",
  "silent",
  "quiet",
  "no-keep-going",
  "stop",
  "touch",
  "version",
  "print-directory",
  "no-print-directory",
  "what-if",
  "new-file",
  "assume-new",
  "warn-undefined-variables",
  "NeXT-option",
  "eval",
  "output-sync",
  "trace",
];
const MAKE_NON_EXEC_LONG = new Set([
  "just-print",
  "dry-run",
  "recon",
  "question",
  "touch",
  "version",
  "help",
  "ignore-errors",
  "old-file",
  "assume-old",
  "eval",
]);
const MAKE_VALUE_LONG = new Set([
  "directory",
  "file",
  "makefile",
  "include-dir",
  "what-if",
  "new-file",
  "assume-new",
  "NeXT-option",
]);
const MAKE_VALUE_SHORT = new Set(["C", "f", "I", "W", "N"]);
const MAKE_OPT_VALUE_SHORT = new Set(["j", "l", "O"]);
const MAKE_NON_EXEC_SHORT = new Set(["n", "q", "t", "v", "h", "i", "o"]);

function shouldConsumeMakeOptArg(opt: string, next: string | undefined): boolean {
  if (!next) return false;
  if (opt === "j" || opt === "jobs") return /^\d+$/.test(next);
  if (opt === "l" || opt === "load-average" || opt === "max-load") {
    // Matches GNU Make `decode_switches` floating arg: starts with digit or '.', parsed completely by C `strtod`
    // (decimal float with optional scientific exponent, or C99 hex float).
    return /^(?:(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|0[xX](?:[0-9a-fA-F]+\.?[0-9a-fA-F]*|\.[0-9a-fA-F]+)(?:[pP][+-]?\d+)?)$/.test(
      next,
    );
  }
  return false;
}

function extractMakeFirstTarget(args: string[]): string | null {
  let afterDoubleDash = false;
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (!afterDoubleDash) {
      if (tok === "--") {
        afterDoubleDash = true;
        continue;
      }
      if (tok.startsWith("--") && tok.length > 2) {
        const eqIdx = tok.indexOf("=");
        const name = eqIdx >= 0 ? tok.slice(2, eqIdx) : tok.slice(2);
        const matches = MAKE_ALL_LONG_OPTS.filter((opt) => opt.startsWith(name));
        if (eqIdx < 0 && matches.length === 1) {
          const m = matches[0];
          if (
            MAKE_VALUE_LONG.has(m) ||
            m === "old-file" ||
            m === "assume-old" ||
            m === "eval" ||
            shouldConsumeMakeOptArg(m, args[i + 1])
          ) {
            i++;
          }
        }
        continue;
      }
      if (tok.startsWith("-") && tok.length > 1) {
        for (let j = 1; j < tok.length; j++) {
          const ch = tok[j];
          if (MAKE_VALUE_SHORT.has(ch) || ch === "o") {
            if (j === tok.length - 1) i++;
            break;
          }
          if (MAKE_OPT_VALUE_SHORT.has(ch)) {
            if (j === tok.length - 1 && shouldConsumeMakeOptArg(ch, args[i + 1])) {
              i++;
            }
            break;
          }
        }
        continue;
      }
    }
    if (/^[A-Za-z_][A-Za-z0-9_.-]*\s*(?:::=|:=|\+=|\?=|=)/.test(tok)) {
      continue;
    }
    return tok;
  }
  return null;
}

function hasMakeNonExecArgs(args: string[], inMakeflags = false): boolean {
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (tok === "--") break;
    if (tok.startsWith("--") && tok.length > 2) {
      const eqIdx = tok.indexOf("=");
      const name = eqIdx >= 0 ? tok.slice(2, eqIdx) : tok.slice(2);
      const matches = MAKE_ALL_LONG_OPTS.filter((opt) => opt.startsWith(name));
      const nonExecMatch = matches.some((m) => {
        if (inMakeflags && (m === "old-file" || m === "assume-old")) return false;
        return MAKE_NON_EXEC_LONG.has(m);
      });
      if (nonExecMatch) return true;
      if (eqIdx < 0 && matches.length === 1 && MAKE_VALUE_LONG.has(matches[0])) {
        i++;
      }
      continue;
    }
    if ((tok.startsWith("-") && tok.length > 1) || (inMakeflags && i === 0 && !tok.includes("="))) {
      const letters = tok.startsWith("-") ? tok.slice(1) : tok;
      for (let j = 0; j < letters.length; j++) {
        const ch = letters[j];
        if (MAKE_NON_EXEC_SHORT.has(ch) && !(inMakeflags && ch === "o")) return true;
        if (MAKE_VALUE_SHORT.has(ch) || (inMakeflags && ch === "o")) {
          if (j === letters.length - 1) i++;
          break;
        }
        if (MAKE_OPT_VALUE_SHORT.has(ch)) break;
      }
    }
  }
  return false;
}

const TSC_WATCH_ALWAYS_VALUE_OPTS = [
  "fallbackpolling",
  "watchdirectory",
  "watchfile",
];
const TSC_WATCH_LIST_OPTS = [
  "excludedirectories",
  "excludefiles",
];
const TSC_BUILD_ALWAYS_VALUE_OPTS = new Set([
  "generatecpuprofile",
  "generatetrace",
  "locale",
  ...TSC_WATCH_ALWAYS_VALUE_OPTS,
]);
const TSC_BUILD_LIST_OPTS = new Set(TSC_WATCH_LIST_OPTS);
const TSC_NORMAL_ALWAYS_VALUE_OPTS = new Set([
  "baseurl",
  "charset",
  "declarationdir",
  "generatecpuprofile",
  "generatetrace",
  "ignoredeprecations",
  "importsnotusedasvalues",
  "jsx",
  "jsxfactory",
  "jsxfragmentfactory",
  "jsximportsource",
  "locale",
  "m",
  "maproot",
  "maxnodemodulejsdepth",
  "module",
  "moduledetection",
  "moduleresolution",
  "newline",
  "out",
  "outdir",
  "outfile",
  "p",
  "project",
  "reactnamespace",
  "rootdir",
  "sourceroot",
  "t",
  "target",
  "tsbuildinfofile",
  ...TSC_WATCH_ALWAYS_VALUE_OPTS,
]);
const TSC_NORMAL_LIST_OPTS = new Set([
  "customconditions",
  "lib",
  "modulesuffixes",
  "paths",
  "plugins",
  "rootdirs",
  "typeroots",
  "types",
  ...TSC_WATCH_LIST_OPTS,
]);

function hasNonExecutingVerifyFlag(cmdToks: string[], envToks: string[] = []): boolean {
  const [c0, c1 = ""] = cmdToks;

  if (c0 === "make") {
    // 1. Startup environment: process.env overlaid ONLY by shell env prefix (`envToks`).
    const startupMakeEnv = new Map<string, string>();
    if (process.env.MAKEFLAGS !== undefined) startupMakeEnv.set("MAKEFLAGS", process.env.MAKEFLAGS);
    if (process.env.GNUMAKEFLAGS !== undefined) startupMakeEnv.set("GNUMAKEFLAGS", process.env.GNUMAKEFLAGS);
    for (const raw of envToks) {
      const m = raw.match(/^(GNU)?MAKEFLAGS=(.*)$/);
      if (m) {
        startupMakeEnv.set(m[1] ? "GNUMAKEFLAGS" : "MAKEFLAGS", m[2]);
      }
    }
    for (const val of startupMakeEnv.values()) {
      const mfArgs = val.trim().split(/[ \t]+/).filter(Boolean);
      if (hasMakeNonExecArgs(mfArgs, true)) return true;
    }
    // 2. Command-line variable assignments (`make test MAKEFLAGS=-n`, `MAKEFLAGS:=-n`, `MAKEFLAGS+=-n`, etc.)
    //    are additive for dry-run/ignore-errors flags and NEVER clear startup environment flags.
    for (const raw of cmdToks.slice(1)) {
      const m = raw.match(/^(?:GNU)?MAKEFLAGS\s*(?:::=|:=|\+=|\?=|=)(.*)$/);
      if (m) {
        const mfArgs = m[1].trim().split(/[ \t]+/).filter(Boolean);
        if (hasMakeNonExecArgs(mfArgs, true)) return true;
      }
    }
    return hasMakeNonExecArgs(cmdToks.slice(1), false);
  }

  if (c0 === "just") {
    const effectiveJustEnv = new Map<string, string>();
    if (process.env.JUST_DRY_RUN !== undefined) effectiveJustEnv.set("JUST_DRY_RUN", process.env.JUST_DRY_RUN);
    if (process.env.JUST_ALLOW_MISSING !== undefined) {
      effectiveJustEnv.set("JUST_ALLOW_MISSING", process.env.JUST_ALLOW_MISSING);
    }
    for (const raw of envToks) {
      const eq = raw.indexOf("=");
      if (eq < 0) continue;
      const k = raw.slice(0, eq);
      if (k === "JUST_DRY_RUN" || k === "JUST_ALLOW_MISSING") {
        effectiveJustEnv.set(k, raw.slice(eq + 1));
      }
    }
    for (const val of effectiveJustEnv.values()) {
      if (val !== "" && !/^(?:0|false)$/i.test(val)) return true;
    }
    const justNonExecLong = new Set([
      "--dry-run",
      "--allow-missing",
      "--list",
      "--show",
      "--summary",
      "--dump",
      "--evaluate",
      "--variables",
      "--choose",
      "--clean",
      "--command",
      "--shell-command",
      "--fmt",
      "--groups",
      "--init",
      "--json",
      "--usage",
      "--changelog",
      "--completions",
      "--man",
      "--edit",
    ]);
    const justValueShort = new Set(["f", "d", "E", "F"]);
    const justNonExecShort = new Set(["n", "l", "s", "c", "e", "h", "V"]);
    for (let i = 1; i < cmdToks.length; i++) {
      const tok = cmdToks[i];
      if (tok === "--") break;
      const flagName = tok.includes("=") ? tok.slice(0, tok.indexOf("=")) : tok;
      if (justNonExecLong.has(flagName)) return true;
      if (tok.startsWith("-") && !tok.startsWith("--") && tok.length > 1) {
        for (let j = 1; j < tok.length; j++) {
          const ch = tok[j];
          if (justNonExecShort.has(ch)) return true;
          if (justValueShort.has(ch)) {
            if (j === tok.length - 1) i++;
            break;
          }
        }
      }
    }
    return false;
  }

  if (c0 === "go" && (c1 === "test" || c1 === "build" || c1 === "vet")) {
    const isGoBoolOn = (norm: string, name: string): boolean => {
      if (norm === name) return true;
      if (!norm.startsWith(`${name}=`)) return false;
      const val = norm.slice(name.length + 1).toLowerCase();
      return val !== "false" && val !== "0" && val !== "f";
    };
    for (let i = 2; i < cmdToks.length; i++) {
      const tok = cmdToks[i];
      if (tok === "--") break;
      const norm = tok.startsWith("--") ? tok.slice(1) : tok;
      if (isGoBoolOn(norm, "-n") || norm === "-help" || norm === "-h") return true;
      if (
        c1 === "test" &&
        (isGoBoolOn(norm, "-c") || norm === "-list" || norm.startsWith("-list="))
      ) {
        return true;
      }
    }
    return false;
  }

  const pytestInv = isPytestInvocation(cmdToks);
  if (pytestInv) {
    const pytestNonExec = new Set([
      "--collect-only",
      "--co",
      "--fixtures",
      "--fixtures-per-test",
      "--markers",
      "--setup-only",
      "--setup-plan",
    ]);
    for (let i = pytestInv.argsStart; i < cmdToks.length; i++) {
      const tok = cmdToks[i];
      if (tok === "--") break;
      if (pytestNonExec.has(tok)) return true;
    }
    return false;
  }

  const tscArgs = extractTscArgs(cmdToks);
  if (tscArgs) {
    const stripTscOpt = (tok: string): string | null => {
      if (!tok.startsWith("-") || tok.startsWith("---")) return null;
      const name = (tok.startsWith("--") ? tok.slice(2) : tok.slice(1)).toLowerCase();
      return name || null;
    };
    const firstOpt = tscArgs[0] ? stripTscOpt(tscArgs[0]) : null;
    const isBuildMode = firstOpt === "b" || firstOpt === "build";
    const alwaysValueOpts = isBuildMode ? TSC_BUILD_ALWAYS_VALUE_OPTS : TSC_NORMAL_ALWAYS_VALUE_OPTS;
    const listValueOpts = isBuildMode ? TSC_BUILD_LIST_OPTS : TSC_NORMAL_LIST_OPTS;
    const tscFlags = new Map<string, boolean>();
    const mapCanon = (optName: string): string | null => {
      if (optName === "help" || optName === "h" || optName === "?") return "help";
      if (optName === "version" || (!isBuildMode && optName === "v")) return "version";
      if (optName === "showconfig") return "showConfig";
      if (optName === "listfilesonly") return "listFilesOnly";
      if (optName === "init") return "init";
      if (optName === "all") return "all";
      if (optName === "nocheck") return "noCheck";
      if (optName === "clean") return "clean";
      if (optName === "dry" || (isBuildMode && optName === "d")) return "dry";
      return null;
    };
    for (let i = isBuildMode ? 1 : 0; i < tscArgs.length; i++) {
      const tok = tscArgs[i];
      // Fail closed on positional `@file` response files (e.g. `@/dev/stdin`), which can inject `--version`/`--dry`/`--help`.
      if (tok.startsWith("@")) return true;
      const optName = stripTscOpt(tok);
      if (!optName) continue;
      // Non-list value options always consume the next argument verbatim (e.g. `--outDir --version`).
      if (alwaysValueOpts.has(optName)) {
        i++;
        continue;
      }
      // List / tsconfig-only non-bool options (e.g. `--types`, `--lib`) only consume the next arg
      // when it is `"null"` or does not start with `"-"` after trimming (matching TypeScript parseListTypeOption).
      if (listValueOpts.has(optName)) {
        const next = tscArgs[i + 1];
        if (next !== undefined && (next === "null" || !next.trim().startsWith("-"))) {
          i++;
        }
        continue;
      }
      const canon = mapCanon(optName);
      if (!canon) continue;
      let val = true;
      // Per TypeScript parseCommandLine: boolean option values are strictly lowercase "true" / "false" / "null" (clears option).
      const next = tscArgs[i + 1];
      if (next === "true" || next === "false" || next === "null") {
        val = next === "true";
        i++;
      }
      tscFlags.set(canon, val);
    }
    return Array.from(tscFlags.values()).some(Boolean);
  }

  if (c0 === "npx" && c1 === "eslint") {
    for (let i = 2; i < cmdToks.length; i++) {
      const tok = cmdToks[i];
      if (tok === "--") break;
      if (tok === "--print-config" || tok === "--init" || tok === "-v") return true;
    }
    return false;
  }

  if (c0 === "ruff" && c1 === "check") {
    for (let i = 2; i < cmdToks.length; i++) {
      const tok = cmdToks[i];
      if (tok === "--") break;
      if (tok === "--show-settings" || tok === "--show-files") return true;
    }
    return false;
  }

  if (c0 === "npm" || c0 === "bun") {
    const flags = new Map<string, boolean>();
    const parseBoolVal = (v: string): boolean => {
      const low = v.toLowerCase();
      return low !== "false" && low !== "0" && low !== "";
    };
    if (c0 === "npm") {
      for (const [rawKey, rawVal] of Object.entries(process.env)) {
        if (rawVal === undefined) continue;
        const k = rawKey.toLowerCase();
        if (k === "npm_config_if_present") flags.set("if-present", parseBoolVal(rawVal));
        if (k === "npm_config_dry_run") flags.set("dry-run", parseBoolVal(rawVal));
      }
      for (const raw of envToks) {
        const eq = raw.indexOf("=");
        if (eq < 0) continue;
        const k = raw.slice(0, eq).toLowerCase();
        const v = raw.slice(eq + 1);
        if (k === "npm_config_if_present") flags.set("if-present", parseBoolVal(v));
        if (k === "npm_config_dry_run") flags.set("dry-run", parseBoolVal(v));
      }
    }
    const checkKeys =
      c0 === "bun" && c1 === "test"
        ? ["dry-run", "pass-with-no-tests"]
        : ["dry-run", "if-present", "no-exit-on-error"];
    for (let i = 1; i < cmdToks.length; i++) {
      const tok = cmdToks[i];
      if (tok === "--") break;
      if (tok === "-v") return true;
      for (const key of checkKeys) {
        if (tok === `--${key}`) {
          flags.set(key, true);
        } else if (tok === `--no-${key}`) {
          flags.set(key, false);
        } else if (tok.startsWith(`--${key}=`)) {
          flags.set(key, parseBoolVal(tok.slice(key.length + 3)));
        }
      }
    }
    return Array.from(flags.values()).some(Boolean);
  }

  return false;
}

/**
 * Resolve the effective repository/working directory for a verification command when
 * directory-switching flags or env vars are present (`make -C/--directory`, `just -d/--working-directory/-f`,
 * `go -C`, `bun --cwd`, `npm -C/--prefix`, `npx tsc -p/--project`).
 * Returns `null` if the target directory is ambiguous (e.g. missing value or multi-repo tsc --build).
 */
function extractMakeDirs(args: string[], startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (tok === "--") break;
    if (tok.startsWith("--") && tok.length > 2) {
      const eqIdx = tok.indexOf("=");
      const name = eqIdx >= 0 ? tok.slice(2, eqIdx) : tok.slice(2);
      const matches = MAKE_ALL_LONG_OPTS.filter((opt) => opt.startsWith(name));
      if (matches.length === 1 && matches[0] === "directory") {
        const val = eqIdx >= 0 ? tok.slice(eqIdx + 1) : args[++i];
        if (!val) return null;
        dir = resolve(dir, val);
        continue;
      }
      if (eqIdx < 0 && matches.length === 1 && MAKE_VALUE_LONG.has(matches[0])) {
        i++;
      }
      continue;
    }
    if (tok.startsWith("-") && tok.length > 1) {
      for (let j = 1; j < tok.length; j++) {
        const ch = tok[j];
        if (ch === "C") {
          const val = j < tok.length - 1 ? tok.slice(j + 1) : args[++i];
          if (!val) return null;
          dir = resolve(dir, val);
          break;
        }
        if (MAKE_VALUE_SHORT.has(ch)) {
          if (j === tok.length - 1) i++;
          break;
        }
        if (MAKE_OPT_VALUE_SHORT.has(ch)) break;
      }
    }
  }
  return dir;
}

function resolveVerifyTargetDir(
  cmdToks: string[],
  envToks: string[],
  curDir: string,
): string | null {
  const [c0, c1 = ""] = cmdToks;

  if (c0 === "make") {
    // Per GNU Make docs, `-C` / `--directory` is ONLY honored on the command line (NEVER via MAKEFLAGS).
    return extractMakeDirs(cmdToks.slice(1), curDir);
  }

  if (c0 === "just") {
    let explicitDir: string | null = process.env.JUST_WORKING_DIRECTORY || null;
    let justfile: string | null = process.env.JUST_JUSTFILE || null;
    for (const raw of envToks) {
      if (raw.startsWith("JUST_WORKING_DIRECTORY=")) explicitDir = raw.slice("JUST_WORKING_DIRECTORY=".length) || null;
      if (raw.startsWith("JUST_JUSTFILE=")) justfile = raw.slice("JUST_JUSTFILE=".length) || null;
    }
    for (let i = 1; i < cmdToks.length; i++) {
      const tok = cmdToks[i];
      if (tok === "--") break;
      if (tok === "--working-directory") {
        const val = cmdToks[++i];
        if (!val) return null;
        explicitDir = val;
      } else if (tok.startsWith("--working-directory=")) {
        explicitDir = tok.slice("--working-directory=".length);
      } else if (tok === "--justfile") {
        const val = cmdToks[++i];
        if (!val) return null;
        justfile = val;
      } else if (tok.startsWith("--justfile=")) {
        justfile = tok.slice("--justfile=".length);
      } else if (tok.startsWith("-") && !tok.startsWith("--") && tok.length > 1) {
        for (let j = 1; j < tok.length; j++) {
          const ch = tok[j];
          if (ch === "d") {
            const val = j < tok.length - 1 ? tok.slice(j + 1) : cmdToks[++i];
            if (!val) return null;
            explicitDir = val;
            break;
          }
          if (ch === "f") {
            const val = j < tok.length - 1 ? tok.slice(j + 1) : cmdToks[++i];
            if (!val) return null;
            justfile = val;
            break;
          }
          if (ch === "E" || ch === "F") {
            if (j === tok.length - 1) i++;
            break;
          }
        }
      }
    }
    if (explicitDir) return resolve(curDir, explicitDir);
    if (justfile && justfile !== "-") return dirname(resolve(curDir, justfile));
    return curDir;
  }

  const langCheckInv = parseLangCheckInvocation(cmdToks);
  if (langCheckInv) {
    return langCheckInv.targetPositional
      ? resolve(curDir, langCheckInv.targetPositional)
      : curDir;
  }

  if (c0 === "go" && (c1 === "test" || c1 === "build" || c1 === "vet")) {
    let dir = curDir;
    for (let i = 2; i < cmdToks.length; i++) {
      const tok = cmdToks[i];
      if (tok === "--") break;
      if (tok === "-C" || tok === "--C") {
        const val = cmdToks[++i];
        if (!val) return null;
        dir = resolve(dir, val);
      } else if (tok.startsWith("-C=") || tok.startsWith("--C=")) {
        const val = tok.slice(tok.indexOf("=") + 1);
        if (!val) return null;
        dir = resolve(dir, val);
      }
    }
    return dir;
  }

  if (c0 === "bun") {
    let dir = curDir;
    for (let i = 1; i < cmdToks.length; i++) {
      const tok = cmdToks[i];
      if (tok === "--") break;
      if (tok === "--cwd") {
        const val = cmdToks[++i];
        if (!val) return null;
        dir = resolve(dir, val);
      } else if (tok.startsWith("--cwd=")) {
        const val = tok.slice("--cwd=".length);
        if (!val) return null;
        dir = resolve(dir, val);
      }
    }
    return dir;
  }

  if (c0 === "npm") {
    let dir = curDir;
    for (let i = 1; i < cmdToks.length; i++) {
      const tok = cmdToks[i];
      if (tok === "--") break;
      if (tok === "--prefix" || tok === "-C") {
        const val = cmdToks[++i];
        if (!val) return null;
        dir = resolve(dir, val);
      } else if (tok.startsWith("--prefix=") || tok.startsWith("-C=")) {
        const val = tok.slice(tok.indexOf("=") + 1);
        if (!val) return null;
        dir = resolve(dir, val);
      }
    }
    return dir;
  }

  const tscArgs = extractTscArgs(cmdToks);
  if (tscArgs) {
    const stripTscOpt = (tok: string): string | null => {
      if (!tok.startsWith("-") || tok.startsWith("---")) return null;
      const name = (tok.startsWith("--") ? tok.slice(2) : tok.slice(1)).toLowerCase();
      return name || null;
    };
    const firstOpt = tscArgs[0] ? stripTscOpt(tscArgs[0]) : null;
    const isBuildMode = firstOpt === "b" || firstOpt === "build";
    const alwaysValueOpts = isBuildMode ? TSC_BUILD_ALWAYS_VALUE_OPTS : TSC_NORMAL_ALWAYS_VALUE_OPTS;
    const listValueOpts = isBuildMode ? TSC_BUILD_LIST_OPTS : TSC_NORMAL_LIST_OPTS;
    let projectPath: string | null = null;
    const buildProjects: string[] = [];
    for (let i = isBuildMode ? 1 : 0; i < tscArgs.length; i++) {
      const tok = tscArgs[i];
      const optName = stripTscOpt(tok);
      if (!optName) {
        if (isBuildMode) buildProjects.push(tok);
        continue;
      }
      if (!isBuildMode && (optName === "p" || optName === "project")) {
        const val = tscArgs[++i];
        if (!val) return null;
        projectPath = val === "null" ? null : val;
        continue;
      }
      if (alwaysValueOpts.has(optName)) {
        i++;
        continue;
      }
      if (listValueOpts.has(optName)) {
        const next = tscArgs[i + 1];
        if (next !== undefined && (next === "null" || !next.trim().startsWith("-"))) i++;
        continue;
      }
      const next = tscArgs[i + 1];
      if (next === "true" || next === "false" || next === "null") i++;
    }
    if (!isBuildMode && projectPath) {
      const resolved = resolve(curDir, projectPath);
      return resolved.endsWith(".json") ? dirname(resolved) : resolved;
    }
    if (isBuildMode && buildProjects.length > 0) {
      const dirs = new Set(
        buildProjects.map((p) => {
          const resolved = resolve(curDir, p);
          return resolved.endsWith(".json") ? dirname(resolved) : resolved;
        }),
      );
      if (dirs.size > 1) return null;
      return Array.from(dirs)[0];
    }
    return curDir;
  }

  return curDir;
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

const HURL_KNOWN_BOOL_FLAGS = new Set([
  "--test",
  "-v",
  "--verbose",
  "--very-verbose",
  "--color",
  "--no-color",
  "-k",
  "--insecure",
  "-L",
  "--location",
  "--location-trusted",
  "--continue-on-error",
  "--compressed",
  "--ignore-asserts",
  "--no-output",
  "--path-as-is",
  "--ipv4",
  "-4",
  "--ipv6",
  "-6",
  "--http1.0",
  "--http1.1",
  "--http2",
  "--http3",
  "--netrc",
  "-n",
  "--netrc-optional",
  "--ssl-no-revoke",
  "--interactive",
]);

function hasCliFlag(toks: string[], flag: string): boolean {
  return toks.some((t) => t === flag || t.startsWith(`${flag}=`));
}

function isValidHurlExecution(
  toks: string[],
  curDir: string,
  outputText: string,
): boolean {
  const hurlIdx = toks.findIndex((t) => t === "hurl" || t.endsWith("/hurl"));
  if (hurlIdx === -1) return false;
  if (hasInfoOnlyFlag(toks)) return false;

  // Reject runs where Hurl explicitly reports 0 executed files/entries/requests
  if (
    /(?:executed\s+(?:files|entries|requests)\s*:\s*0\b|succeeded\s+files\s*:\s*0\b|\b0\s+executed\b)/i.test(
      outputText,
    )
  ) {
    return false;
  }

  // Fail-closed flag value skipping: any flag NOT in HURL_KNOWN_BOOL_FLAGS (and without `=`)
  // consumes the following token as its option value, so `--file-root ./tests` or `--max-redirs 5`
  // is NEVER mistaken for a positional input file!
  let stopFlags = false;
  for (let i = hurlIdx + 1; i < toks.length; i++) {
    const a = toks[i];
    if (!stopFlags && a === "--") {
      stopFlags = true;
      continue;
    }
    if (!stopFlags && a.startsWith("-")) {
      if (!a.includes("=") && !HURL_KNOWN_BOOL_FLAGS.has(a)) {
        i++; // Skip option's value argument
      }
      continue;
    }
    const candidate = resolve(curDir, a);
    if (!existsSync(candidate)) continue;
    try {
      const st = statSync(candidate);
      if (st.isDirectory() || a.endsWith(".hurl")) {
        return true;
      }
    } catch {
      // Ignore unreadable path
    }
  }
  return false;
}

/**
 * POSIX/Bash `cd` target resolver (supports no-arg `$HOME`, `-L` logical default, `-P` physical,
 * `--`, and in-chain `cd -`). Returns `null` if `cd` would fail or target is indeterminate.
 */
function splitLeadingEnv(toks: ShellToken[]): { envToks: string[]; cmdToks: string[] } {
  let start = 0;
  while (start < toks.length && toks[start].isEnvAssign) {
    start++;
  }
  return {
    envToks: toks.slice(0, start).map((t) => t.value),
    cmdToks: toks.slice(start).map((t) => t.value),
  };
}

function resolveCdTarget(
  curDir: string,
  prevDir: string | null,
  toks: ShellToken[],
): string | null {
  const { envToks, cmdToks } = splitLeadingEnv(toks);
  if (cmdToks[0] !== "cd") return null;
  let effectiveHome = process.env.HOME;
  let effectiveCdpath = process.env.CDPATH;
  let explicitOldPwd: string | undefined;
  for (const raw of envToks) {
    if (raw.startsWith("HOME=")) effectiveHome = raw.slice("HOME=".length);
    else if (raw.startsWith("CDPATH=")) effectiveCdpath = raw.slice("CDPATH=".length);
    else if (raw.startsWith("OLDPWD=")) explicitOldPwd = raw.slice("OLDPWD=".length);
  }
  let physical = false;
  let idx = 1;
  while (idx < cmdToks.length) {
    const arg = cmdToks[idx];
    if (arg === "--") {
      idx++;
      break;
    }
    if (arg === "-" || !arg.startsWith("-")) break;
    // POSIX / macOS `/bin/bash` `cd` accepts ONLY `-L` and `-P` (can be bundled e.g. `-LP`).
    for (let j = 1; j < arg.length; j++) {
      const ch = arg[j];
      if (ch === "P") physical = true;
      else if (ch === "L") physical = false;
      else return null;
    }
    idx++;
  }
  const rest = cmdToks.slice(idx);
  if (rest.length > 1) return null;

  let target: string;
  if (rest.length === 0) {
    // Per Bash: unset HOME fails, whereas empty `HOME=""` acts as `cd ""` (no-op in curDir).
    if (effectiveHome === undefined) return null;
    target = effectiveHome;
  } else if (rest[0] === "-") {
    if (explicitOldPwd !== undefined) {
      // Per Bash: empty `OLDPWD=""` is still set, acting as `cd ""` (stays in curDir).
      target = explicitOldPwd;
    } else {
      if (!prevDir) return null;
      target = prevDir;
    }
  } else {
    target = rest[0];
    if (
      effectiveCdpath &&
      !target.startsWith("/") &&
      target !== "." &&
      target !== ".." &&
      !target.startsWith("./") &&
      !target.startsWith("../")
    ) {
      return null;
    }
  }

  if (physical) {
    // Per Bash 3.2: `cd -P ""` (including empty HOME= / OLDPWD=) calls chdir("") -> ENOENT!
    if (target === "") return null;
    const rawTarget = target.startsWith("/") ? target : `${curDir}/${target}`;
    try {
      if (!statSync(rawTarget).isDirectory()) return null;
      accessSync(rawTarget, fsConstants.X_OK);
      // Use OS native realpath(3) so symlinks are resolved BEFORE `..` (e.g. `/tmp/..` -> `/private`).
      return realpathSync.native(rawTarget);
    } catch {
      return null;
    }
  }

  // POSIX logical `cd -L` (Bash default): walk components, verifying current path is a directory BEFORE popping `..`.
  const parts = target.startsWith("/")
    ? []
    : curDir.split("/").filter((p) => p.length > 0);
  const currentLogicalPath = () => `/${parts.join("/")}`;

  for (const comp of target.split("/")) {
    if (comp === "" || comp === ".") continue;
    if (comp === "..") {
      const beforePop = currentLogicalPath();
      try {
        if (!statSync(beforePop).isDirectory()) return null;
      } catch {
        return null;
      }
      parts.pop();
    } else {
      parts.push(comp);
    }
  }

  const finalPath = currentLogicalPath();
  try {
    if (!statSync(finalPath).isDirectory()) return null;
    accessSync(finalPath, fsConstants.X_OK);
    return finalPath;
  } catch {
    return null;
  }
}

/**
 * Shell builtins / keywords that can terminate the shell early, flip exit codes,
 * change directories outside `cd`, or redefine commands/environment mid-chain.
 */
const SHELL_CONTROL_OR_STATE_BUILTINS = new Set([
  "!",
  "coproc",
  "exit",
  "exec",
  "return",
  "logout",
  "suspend",
  "kill",
  "eval",
  "source",
  ".",
  "alias",
  "unalias",
  "enable",
  "builtin",
  "command",
  "function",
  "trap",
  "set",
  "shopt",
  "export",
  "unset",
  "declare",
  "typeset",
  "local",
  "readonly",
  "hash",
  "pushd",
  "popd",
  "break",
  "continue",
]);

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

  // Reject any command containing shell control/state-mutating builtins (e.g. `exit 0 && make test`,
  // `exec true && make test`, `pushd ../other && make test`, `! make test`, `export MAKEFLAGS=-n && make test`),
  // function definitions, or bare shell variable assignments in a multi-segment chain.
  for (const seg of segments) {
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

  const nonCdSegments = segments.filter((s) => {
    const t = splitShellTokensWithMeta(s);
    if (!t || t.length === 0) return false;
    return splitLeadingEnv(t).cmdToks[0] !== "cd";
  });

  // In a multi-segment `&&` chain that exits non-zero, only leading valid `cd` segments
  // followed by a single final command unambiguously attribute the failure to that final command.
  // Any other multi-segment failure (e.g. `false && make test`, `make test && cd /dev/null`,
  // `cd missing/.. && make test`) is ambiguous and MUST NOT record a false `fail`.
  if (!passed && segments.length > 1) {
    let probeDir = workdir;
    let probePrev: string | null = null;
    for (let i = 0; i < segments.length - 1; i++) {
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
    if (!lastToks || lastToks.length === 0 || splitLeadingEnv(lastToks).cmdToks[0] === "cd") {
      return [];
    }
  }

  for (const seg of segments) {
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
    if (git?.subcmd === "commit" && passed) {
      const targetDir = git.gitDirFlag ? resolve(curDir, git.gitDirFlag) : curDir;
      results.push({
        kind: "commit",
        status: "pass",
        summary: redactSecrets(seg).slice(0, 160),
        targetDir,
      });
      continue;
    }

    // 1b. gh pr create / gh pr new (standalone non-cd segment; unified pflag parser; verify PR URL & origin parity on pass!)
    if (
      (toks[0] === "gh" || toks[0]?.endsWith("/gh")) &&
      toks[1] === "pr" &&
      (toks[2] === "create" || toks[2] === "new")
    ) {
      const parsedGh = parseGhPrCreateArgs(toks.slice(3));
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
        prUrlRepoSpec = `${urlMatch[1]}/${urlMatch[2]}/${urlMatch[3]}`;
      }

      const targetRepoSpec = parsedGh.repo;
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
        targetDir: curDir,
        targetBranch,
        targetOwner,
        targetRepoSpec,
        prUrlRepoSpec,
      });
      continue;
    }

    // 2. review-agents CLI or codex review
    const { cmdToks: segCmdToks } = splitLeadingEnv(metaToks);
    const reviewCliMatch = segCmdToks[0]?.match(
      /(?:^|\/)(review-quality|review-performance|review-simplify|review-comments)$/,
    );
    const parsedCodexReview = !reviewCliMatch
      ? parseCodexReviewCommand(segCmdToks, curDir)
      : null;
    if (reviewCliMatch || parsedCodexReview) {
      // Never record status polling, help, version, or listing commands as review verdicts!
      if (
        reviewCliMatch &&
        segCmdToks.some(
          (t) =>
            t === "--status" ||
            t === "--help" ||
            t === "-h" ||
            t === "--version" ||
            t === "-V" ||
            t === "list",
        )
      ) {
        continue;
      }

      const role = normalizeReviewRole(reviewCliMatch ? reviewCliMatch[1] : "codex-review");
      const repoVal = reviewCliMatch ? extractCliFlagValue(segCmdToks, "--repo") : null;
      const outVal = reviewCliMatch ? extractCliFlagValue(segCmdToks, "--out") : null;
      const headVal = reviewCliMatch ? extractCliFlagValue(segCmdToks, "--head") : null;
      const commitVal = parsedCodexReview ? parsedCodexReview.commitVal : null;
      const targetDir = parsedCodexReview
        ? parsedCodexReview.targetDir
        : repoVal
          ? resolve(curDir, repoVal)
          : curDir;
      const outFilePath = outVal ? resolve(curDir, outVal) : undefined;
      const parsedJson = reviewCliMatch
        ? parseReviewJsonOutput(outputText, outFilePath)
        : null;

      if (reviewCliMatch) {
        // Ignore in-flight / polling JSON statuses completely
        if (
          parsedJson?.status === "running" ||
          parsedJson?.status === "in_progress" ||
          parsedJson?.status === "pending" ||
          parsedJson?.status === "queued"
        ) {
          continue;
        }
        // On exit 0, require terminal status === "completed" and passed !== false
        if (
          exitCode === 0 &&
          (parsedJson?.status !== "completed" || parsedJson?.passed === false)
        ) {
          continue;
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
        if (nonCdSegments.length > 1 || isClapParseError || isPreExecutionCliRejection) {
          continue;
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
      const hasCommitFlag = parsedCodexReview ? parsedCodexReview.hasCommitFlag : false;
      const hasHeadFlag = reviewCliMatch ? hasCliFlag(segCmdToks, "--head") : false;
      const explicitHeadSha =
        headVal && /^[0-9a-f]{7,40}$/i.test(headVal) ? headVal : null;
      const pinnedSha = parsedJson?.head ?? explicitHeadSha;
      const pinnedRef = !pinnedSha ? (commitVal || headVal || null) : null;
      const requirePinnedSha = Boolean(reviewCliMatch) || hasCommitFlag || hasHeadFlag;

      const status: "pass" | "fail" = exitCode === 0 ? "pass" : "fail";
      results.push({
        kind: "review",
        status,
        summary: `${role} exited ${exitCode}${creditExhausted ? " (credit_balance_exhausted)" : ""}`,
        targetDir,
        pinnedSha,
        pinnedRef,
        requirePinnedSha,
        meta: {
          role,
          exit_code: exitCode,
          report_status: parsedJson?.status ?? null,
          error_code: parsedJson?.errorCode ?? null,
          credit_balance_exhausted: creditExhausted,
          base: parsedJson?.base ?? null,
          head: pinnedSha,
        },
      });
      continue;
    }

    // 3. Direct build / test / lint / hurl / lang-check execution (token-based; handles line continuations & unquoted env prefixes)
    const verifyHit = classifyVerifyCommand(metaToks);
    if (verifyHit) {
      // Never record `--help` / `--version` / `help` / dry-run / collect-only commands as passing verification!
      // Note: `tsc` handles its own `--help`/`--version` boolean values (e.g. `--help false` still typechecks).
      const isTscCmd = extractTscArgs(verifyHit.cmdToks) !== null;
      if (
        (!isTscCmd && hasInfoOnlyFlag(verifyHit.cmdToks)) ||
        hasNonExecutingVerifyFlag(verifyHit.cmdToks, verifyHit.envToks)
      ) {
        continue;
      }
      if (
        verifyHit.kind === "hurl" &&
        !isValidHurlExecution(verifyHit.cmdToks, curDir, outputText)
      ) {
        continue;
      }
      const targetDir = resolveVerifyTargetDir(verifyHit.cmdToks, verifyHit.envToks, curDir);
      if (!targetDir) {
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
          // mode === "all": parse JSON report if available so static-only repos don't fabricate test/pass
          const trimmedOut = outputText.trim();
          let parsedReport: {
            checks?: Array<{ phase?: string; status?: string }>;
          } | null = null;
          if (trimmedOut.startsWith("{")) {
            try {
              parsedReport = JSON.parse(trimmedOut) as {
                checks?: Array<{ phase?: string; status?: string }>;
              };
            } catch {
              parsedReport = null;
            }
          }
          if (parsedReport?.checks) {
            const staticRan = parsedReport.checks.filter(
              (c) => c.phase === "static" && c.status !== "skipped",
            );
            const dynamicRan = parsedReport.checks.filter(
              (c) => c.phase === "dynamic" && c.status !== "skipped",
            );
            if (staticRan.length > 0) {
              phases.push({
                kind: "lint",
                status: staticRan.every((c) => c.status === "pass") ? "pass" : "fail",
              });
            }
            if (dynamicRan.length > 0) {
              phases.push({
                kind: "test",
                status: dynamicRan.every((c) => c.status === "pass") ? "pass" : "fail",
              });
            }
          } else {
            // Non-JSON summary output: inspect `[PASS]`/`[FAIL]` `(lang/phase)` lines so static-only runs don't fabricate dynamic test/pass!
            const staticMatches = [...outputText.matchAll(/\[(PASS|FAIL)\]\s+\([^/]+\/static\)/g)];
            const dynamicMatches = [...outputText.matchAll(/\[(PASS|FAIL)\]\s+\([^/]+\/dynamic\)/g)];
            if (staticMatches.length > 0) {
              phases.push({
                kind: "lint",
                status: staticMatches.every((m) => m[1] === "PASS") ? "pass" : "fail",
              });
            }
            if (dynamicMatches.length > 0) {
              phases.push({
                kind: "test",
                status: dynamicMatches.every((m) => m[1] === "PASS") ? "pass" : "fail",
              });
            }
            if (phases.length === 0) {
              // Fallback when output was truncated: record lint (never fabricate both without proof)
              phases = [{ kind: "lint", status: passed ? "pass" : "fail" }];
            }
          }
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
): { sessionContext?: string; compactMessage?: string; recorded: number } {
  const cfg = loadWorkbenchConfig(workbenchRoot);
  if (!cfg.ledger.enabled) return { recorded: 0 };

  const evName = input.hook_event_name ?? "";

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
        if (item.targetRepoSpec || item.prUrlRepoSpec) {
          const originUrl = runGit(loc.checkoutDir, ["remote", "get-url", "origin"], 3000).stdout.trim();
          const originId = parseGitRemoteRepo(originUrl);
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
  } catch (err) {
    // Telemetry hook never blocks user session, but records sanitized diagnostics!
    logHookError(root, err);
  }
}
