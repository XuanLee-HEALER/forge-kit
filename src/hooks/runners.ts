import {
  BUN_BUILD_VALUE_FLAGS,
  isScriptNameKind,
  parsePkgManagerInvocation,
  resolvePkgManagerEffectiveDir,
  type ParsedPkgManager,
} from "./pkg-manager";
import { type ReportPhase, type VerificationHit } from "./types";
import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getGitTopLevel } from "../shared/git-cmd";
import { splitLeadingEnv, type ShellToken } from "../shared/shell";

export function parseLangCheckInvocation(cmdToks: string[]): {
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
  let endFlags = false;
  for (let i = argsStart; i < cmdToks.length; i++) {
    const t = cmdToks[i];
    if (!endFlags && t === "--") {
      endFlags = true;
      continue;
    }
    if (!endFlags) {
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
    }
    if (!targetPositional) targetPositional = t;
  }
  return { argsStart, mode, targetPositional };
}

export function extractEslintArgs(cmdToks: string[]): string[] | null {
  const [c0 = "", c1 = "", c2 = ""] = cmdToks;
  const bin0 = c0.split("/").pop() ?? "";
  if (bin0 === "eslint") return cmdToks.slice(1);
  if ((bin0 === "npx" || bin0 === "bunx") && c1 === "eslint") return cmdToks.slice(2);
  if (bin0 === "bunx" && c1 === "--bun" && c2 === "eslint") return cmdToks.slice(3);
  return null;
}

export function extractTscArgs(cmdToks: string[]): string[] | null {
  const [c0 = "", c1 = "", c2 = ""] = cmdToks;
  const bin0 = c0.split("/").pop() ?? "";
  if (bin0 === "npx" && c1 === "tsc") return cmdToks.slice(2);
  if (bin0 === "bunx" && c1 === "tsc") return cmdToks.slice(2);
  if (bin0 === "bunx" && c1 === "--bun" && c2 === "tsc") return cmdToks.slice(3);
  if (bin0 === "tsc") return cmdToks.slice(1);
  return null;
}

export function parseGoInvocation(cmdToks: string[]): {
  subcmd: "test" | "build" | "vet";
  argsStart: number;
  preDirs: string[];
} | null {
  const bin0 = (cmdToks[0] ?? "").split("/").pop() ?? "";
  if (bin0 !== "go") return null;
  const preDirs: string[] = [];
  let idx = 1;
  while (idx < cmdToks.length) {
    const t = cmdToks[idx];
    if (t === "-C" || t === "--C") {
      const val = cmdToks[++idx];
      if (!val) return null;
      preDirs.push(val);
      idx++;
      continue;
    }
    if (t.startsWith("-C=") || t.startsWith("--C=")) {
      const val = t.slice(t.indexOf("=") + 1);
      if (!val) return null;
      preDirs.push(val);
      idx++;
      continue;
    }
    if (t.startsWith("-C") && t.length > 2) {
      preDirs.push(t.slice(2));
      idx++;
      continue;
    }
    break;
  }
  const sub = cmdToks[idx];
  if (sub === "test" || sub === "build" || sub === "vet") {
    return { subcmd: sub, argsStart: idx + 1, preDirs };
  }
  return null;
}

export function isPytestInvocation(cmdToks: string[]): { argsStart: number } | null {
  const [c0 = "", c1 = "", c2 = ""] = cmdToks;
  const bin = c0.split("/").pop() ?? "";
  if (bin === "pytest") return { argsStart: 1 };
  if (/^python3?(?:\.\d+)?$/.test(bin) && c1 === "-m" && c2 === "pytest") {
    return { argsStart: 3 };
  }
  return null;
}

const NODE_TEST_ALLOWED_VALUE_FLAGS = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "-C",
  "--conditions",
  "--env-file",
  "--env-file-if-exists",
  "--test-name-pattern",
  "--test-skip-pattern",
  "--test-reporter",
  "--test-reporter-destination",
  "--test-shard",
  "--test-timeout",
  "--test-concurrency",
  "--max-old-space-size",
  "--redirect-warnings",
  "--title",
]);

const NODE_TEST_ALLOWED_BOOL_FLAGS = new Set([
  "--test",
  "--test-force-exit",
  "--experimental-test-coverage",
  "--experimental-strip-types",
  "--experimental-transform-types",
  "--experimental-vm-modules",
  "--no-warnings",
  "--enable-source-maps",
  "--trace-uncaught",
  "--trace-warnings",
]);

function parseNodeTestInvocation(cmdToks: string[]): { files: string[] } | null {
  const bin0 = (cmdToks[0] ?? "").split("/").pop() ?? "";
  if (bin0 !== "node") return null;
  let sawTestFlag = false;
  let idx = 1;
  // Parse strictly allowlisted Node CLI options BEFORE the first positional entry point
  // (automatically rejects `--v8-options`, `-v`, `-h`, `-e`, `-p`, `-c`, `--watch`, `--test-only`, etc.)
  while (idx < cmdToks.length) {
    const t = cmdToks[idx];
    if (t === "--") {
      idx++;
      break;
    }
    if (!t.startsWith("-") || t === "-") {
      break;
    }
    const eq = t.indexOf("=");
    const name = eq >= 0 ? t.slice(0, eq) : t;
    if (name === "--test") {
      if (eq >= 0) return null;
      sawTestFlag = true;
      idx++;
      continue;
    }
    if (NODE_TEST_ALLOWED_BOOL_FLAGS.has(name) && eq < 0) {
      idx++;
      continue;
    }
    if (NODE_TEST_ALLOWED_VALUE_FLAGS.has(name)) {
      if (eq < 0) {
        if (idx + 1 >= cmdToks.length) return null;
        idx += 2;
      } else {
        idx++;
      }
      continue;
    }
    return null;
  }
  if (!sawTestFlag) return null;
  const files = cmdToks.slice(idx).filter((a) => a && a !== "--" && !a.startsWith("-"));
  return { files };
}

const VITEST_NON_RUN_SUBCMDS = new Set([
  "list",
  "watch",
  "dev",
  "bench",
  "typecheck",
  "init",
  "help",
]);

function extractVitestSubInvocation(
  cmdToks: string[],
): { pm: ParsedPkgManager | null; vitestArgs: string[] } | null {
  const [c0 = "", c1 = "", c2 = ""] = cmdToks;
  const bin0 = c0.split("/").pop() ?? "";
  if (bin0 === "vitest") {
    return { pm: null, vitestArgs: cmdToks.slice(1) };
  }
  if ((bin0 === "npx" || bin0 === "bunx") && c1 === "vitest") {
    return { pm: null, vitestArgs: cmdToks.slice(2) };
  }
  if (bin0 === "bunx" && c1 === "--bun" && c2 === "vitest") {
    return { pm: null, vitestArgs: cmdToks.slice(3) };
  }
  const pm = parsePkgManagerInvocation(cmdToks);
  if (pm && !pm.hasAmbiguousFilter && (pm.manager === "pnpm" || pm.manager === "yarn" || pm.manager === "bun")) {
    if (pm.subcmd === "vitest") {
      return { pm, vitestArgs: pm.rest };
    }
    if ((pm.subcmd === "exec" || pm.subcmd === "dlx") && pm.rest[0] === "vitest") {
      return { pm, vitestArgs: pm.rest.slice(1) };
    }
  }
  return null;
}

function parseVitestRunInvocation(
  cmdToks: string[],
  envToks: string[],
): { pm: ParsedPkgManager | null; vitestArgs: string[] } | null {
  const extracted = extractVitestSubInvocation(cmdToks);
  if (!extracted) return null;
  const args = extracted.vitestArgs;
  const VITEST_VALUE_FLAGS = new Set([
    "-r",
    "--root",
    "-c",
    "--config",
    "--dir",
    "-t",
    "--testNamePattern",
    "--reporter",
    "--outputFile",
    "--environment",
    "--shard",
    "--pool",
    "--project",
    "--maxWorkers",
    "--minWorkers",
    "--testTimeout",
    "--hookTimeout",
    "--bail",
    "--sequence",
  ]);
  let sawExplicitRun = false;
  let firstPositional: string | null = null;
  let stopFlags = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!stopFlags && a === "--") {
      stopFlags = true;
      continue;
    }
    if (!stopFlags && a.startsWith("-")) {
      const eq = a.indexOf("=");
      const name = eq >= 0 ? a.slice(0, eq) : a;
      const val = eq >= 0 ? a.slice(eq + 1).toLowerCase() : null;
      if (
        name === "--watch" ||
        name === "-w" ||
        name === "--ui" ||
        name === "--open" ||
        name === "--list" ||
        name === "--typecheck-only" ||
        name === "--passWithNoTests" ||
        name === "--pass-with-no-tests" ||
        name === "--no-run" ||
        name === "--merge-reports" ||
        name === "--mergeReports" ||
        name === "--clearCache" ||
        name === "--clear-cache" ||
        name === "--init" ||
        name === "--help" ||
        name === "-h" ||
        name === "--version" ||
        name === "-v"
      ) {
        if (name === "--watch" && val === "false") continue;
        return null;
      }
      if (name === "--run") {
        if (val === "false" || val === "0") return null;
        sawExplicitRun = true;
        continue;
      }
      if (eq < 0 && VITEST_VALUE_FLAGS.has(name)) {
        i++;
      }
      continue;
    }
    if (firstPositional === null) {
      firstPositional = a;
    }
  }
  if (firstPositional !== null && VITEST_NON_RUN_SUBCMDS.has(firstPositional)) {
    return null;
  }
  if (firstPositional === "run" || sawExplicitRun) {
    return extracted;
  }
  if (envToks.some((e) => /^CI=(?:1|true)$/i.test(e))) {
    return extracted;
  }
  return null;
}

function parseSvelteCheckInvocation(
  cmdToks: string[],
): { pm: ParsedPkgManager | null; checkArgs: string[] } | null {
  const [c0 = "", c1 = "", c2 = ""] = cmdToks;
  const bin0 = c0.split("/").pop() ?? "";
  let extracted: { pm: ParsedPkgManager | null; checkArgs: string[] } | null = null;
  if (bin0 === "svelte-check") {
    extracted = { pm: null, checkArgs: cmdToks.slice(1) };
  } else if ((bin0 === "npx" || bin0 === "bunx") && c1 === "svelte-check") {
    extracted = { pm: null, checkArgs: cmdToks.slice(2) };
  } else if (bin0 === "bunx" && c1 === "--bun" && c2 === "svelte-check") {
    extracted = { pm: null, checkArgs: cmdToks.slice(3) };
  } else {
    const pm = parsePkgManagerInvocation(cmdToks);
    if (pm && !pm.hasAmbiguousFilter && (pm.manager === "pnpm" || pm.manager === "yarn" || pm.manager === "bun")) {
      if (pm.subcmd === "svelte-check") {
        extracted = { pm, checkArgs: pm.rest };
      } else if ((pm.subcmd === "exec" || pm.subcmd === "dlx") && pm.rest[0] === "svelte-check") {
        extracted = { pm, checkArgs: pm.rest.slice(1) };
      }
    }
  }
  if (!extracted) return null;
  for (const a of extracted.checkArgs) {
    if (a === "--") break;
    if (a === "-v" || a === "--version" || a === "-h" || a === "--help" || a === "--watch") {
      return null;
    }
  }
  return extracted;
}

/**
 * Token-based verification command classifier (handles line continuations, quoting, and leading ENV=VAL assignments).
 * Anchored strictly at command start so `echo "bun test"` / grep text never false-positives.
 */
export function classifyVerifyCommand(metaToks: ShellToken[]): VerificationHit | null {
  const { envToks, cmdToks } = splitLeadingEnv(metaToks);
  if (cmdToks.length === 0) return null;
  const [c0, c1 = "", c2 = ""] = cmdToks;
  const bin0 = c0.split("/").pop() ?? "";
  if (bin0 === "just") {
    for (let i = 2; i < cmdToks.length; i++) {
      if (["-d", "-f", "--working-directory", "--justfile"].includes(cmdToks[i])) i++;
      else if (!cmdToks[i].startsWith("-")) return null;
    }
  }
  const makeTarget = bin0 === "make" ? extractSingleMakeTarget(cmdToks.slice(1)) : null;

  // lang-check (forge-kit unified Go/TS/Python static & dynamic checker)
  if (parseLangCheckInvocation(cmdToks)) {
    return { kind: "lang-check", cmdToks, envToks };
  }

  // go test / vet / build (supports both `go -C <dir> vet` and `go vet -C <dir>`, and absolute paths)
  const goInv = parseGoInvocation(cmdToks);
  if (goInv) {
    const kind =
      goInv.subcmd === "test" ? "test" : goInv.subcmd === "vet" ? "lint" : "build";
    return { kind, cmdToks, envToks };
  }

  // Runner-specific invocations BEFORE generic package-manager scripts (handles `pnpm vitest run`, `pnpm svelte-check`, etc.)
  if (parseVitestRunInvocation(cmdToks, envToks) !== null) {
    return { kind: "test", cmdToks, envToks };
  }
  if (parseSvelteCheckInvocation(cmdToks) !== null) {
    return { kind: "lint", cmdToks, envToks };
  }
  if (parseNodeTestInvocation(cmdToks) !== null) {
    return { kind: "test", cmdToks, envToks };
  }

  // Unified package-manager script classification (`npm`, `pnpm`, `yarn`, `bun` with leading dir flags & explicit `run`)
  const pm = parsePkgManagerInvocation(cmdToks);
  if (pm && !pm.invalidDirFlag) {
    const scriptName = pm.scriptName;
    if (pm.manager === "bun") {
      if (pm.subcmd === "build") return { kind: "build", cmdToks, envToks };
      if (pm.subcmd === "test" || (pm.subcmd === "run" && isScriptNameKind(scriptName, "test"))) {
        return { kind: "test", cmdToks, envToks };
      }
      if (pm.subcmd === "run" && isScriptNameKind(scriptName, "lint")) {
        return { kind: "lint", cmdToks, envToks };
      }
      if (pm.subcmd === "run" && isScriptNameKind(scriptName, "build")) {
        return { kind: "build", cmdToks, envToks };
      }
    } else if (pm.manager === "npm") {
      if (pm.subcmd === "test" || (pm.subcmd === "run" && isScriptNameKind(scriptName, "test"))) {
        return { kind: "test", cmdToks, envToks };
      }
      if (pm.subcmd === "run" && isScriptNameKind(scriptName, "lint")) {
        return { kind: "lint", cmdToks, envToks };
      }
      if (pm.subcmd === "run" && isScriptNameKind(scriptName, "build")) {
        return { kind: "build", cmdToks, envToks };
      }
    } else {
      // pnpm and yarn support both shorthand (`pnpm lint`, `yarn build`) and explicit `run` (`pnpm run lint`, `yarn run lint`)
      if (isScriptNameKind(scriptName, "test")) return { kind: "test", cmdToks, envToks };
      if (isScriptNameKind(scriptName, "lint")) return { kind: "lint", cmdToks, envToks };
      if (isScriptNameKind(scriptName, "build")) return { kind: "build", cmdToks, envToks };
    }
  }

  // test
  if (
    isPytestInvocation(cmdToks) !== null ||
    (bin0 === "just" && c1 === "test") ||
    (bin0 === "make" && makeTarget === "test")
  ) {
    return { kind: "test", cmdToks, envToks };
  }

  // lint / static checks
  if (
    (bin0 === "make" && (makeTarget === "lint" || makeTarget === "harness-guard")) ||
    (bin0 === "just" && (c1 === "check" || c1 === "lint" || c1 === "typecheck" || c1 === "typecheck-server")) ||
    extractTscArgs(cmdToks) !== null ||
    extractEslintArgs(cmdToks) !== null ||
    (bin0 === "npx" && c1 === "biome" && c2 === "check") ||
    (bin0 === "bunx" && ((c1 === "biome" && c2 === "check") || (c1 === "--bun" && c2 === "biome" && cmdToks[3] === "check"))) ||
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
    (bin0 === "make" && (makeTarget === "build" || makeTarget === "compile")) ||
    (bin0 === "just" && c1 === "build")
  ) {
    return { kind: "build", cmdToks, envToks };
  }

  // hurl
  if (bin0 === "hurl") {
    return { kind: "hurl", cmdToks, envToks };
  }

  return null;
}

export function hasInfoOnlyFlag(toks: string[]): boolean {
  if (toks[1] === "help") return true;
  const pm = parsePkgManagerInvocation(toks);
  const bunValFlags =
    pm?.manager === "bun" && !pm.bunScript && pm.subcmd === "build"
      ? BUN_BUILD_VALUE_FLAGS
      : pm?.manager === "bun" && !pm.bunScript && pm.subcmd === "test"
        ? new Set(["--cwd", "-t", "--test-name-pattern", "--timeout", "--preload", "-r"])
        : null;
  // npm manager booleans are evaluated in order in hasNonExecutingVerifyFlag.
  const scan = pm?.manager === "npm" ? pm.managerFlags.filter(arg => !["--version", "--help", "-h"].includes(arg)) : toks;
  for (let i = 0; i < scan.length; i++) {
    const t = scan[i];
    if (t === "--") break;
    if (bunValFlags && !t.includes("=") && bunValFlags.has(t)) {
      i++;
      continue;
    }
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

function extractSingleMakeTarget(args: string[]): string | null {
  let target: string | null = null;
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
    if (target !== null) return null;
    target = tok;
  }
  return target;
}

export function hasMakeNonExecArgs(args: string[], inMakeflags = false): boolean {
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

export const TSC_BUILD_ALWAYS_VALUE_OPTS = new Set([
  "generatecpuprofile",
  "generatetrace",
  "locale",
  ...TSC_WATCH_ALWAYS_VALUE_OPTS,
]);

export const TSC_BUILD_LIST_OPTS = new Set(TSC_WATCH_LIST_OPTS);

export const TSC_NORMAL_ALWAYS_VALUE_OPTS = new Set([
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

export const TSC_NORMAL_LIST_OPTS = new Set([
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

function* jsonReportBlocks(text: string): Generator<string> {
  const start = /^[ \t]*\{/gm;
  let match: RegExpExecArray | null;
  while ((match = start.exec(text))) {
    let level = 1;
    let quoted = false;
    for (let i = start.lastIndex; i < text.length; i++) {
      const ch = text[i];
      if (quoted && ch === "\\") i++;
      else if (ch === '"') quoted = !quoted;
      else if (!quoted && ch === "{") level++;
      else if (!quoted && ch === "}" && --level === 0) {
        yield text.slice(match.index, i + 1);
        start.lastIndex = i + 1;
        break;
      }
    }
  }
}

export function parseLangCheckPhases(outputText: string, passed: boolean): ReportPhase[] {
  const phases: ReportPhase[] = [];
  for (const block of jsonReportBlocks(outputText)) {
    let parsedReport: {
      ok?: boolean;
      executed?: number;
      failed?: number;
      checks?: Array<{ phase?: string; status?: string }>;
    };
    try {
      parsedReport = JSON.parse(block);
    } catch {
      continue;
    }
    // Strict JSON schema & total reconciliation: require valid types for checks/executed/failed/ok,
    // validate EVERY entry in `checks` (including skipped rows), and enforce exact agreement!
    if (
      !Array.isArray(parsedReport.checks) ||
      typeof parsedReport.executed !== "number" ||
      !Number.isInteger(parsedReport.executed) ||
      parsedReport.executed <= 0 ||
      typeof parsedReport.failed !== "number" ||
      !Number.isInteger(parsedReport.failed) ||
      parsedReport.failed < 0 ||
      typeof parsedReport.ok !== "boolean"
    ) {
      continue;
    }
    const allEntriesValid = parsedReport.checks.every(
      (c): c is { phase: "static" | "dynamic"; status: "pass" | "fail" | "skipped" } =>
        c !== null &&
        typeof c === "object" &&
        !Array.isArray(c) &&
        (c.phase === "static" || c.phase === "dynamic") &&
        (c.status === "pass" || c.status === "fail" || c.status === "skipped"),
    );
    if (!allEntriesValid) {
      continue;
    }
    const nonSkipped = parsedReport.checks.filter((c) => c.status !== "skipped");
    const staticRan = nonSkipped.filter((c) => c.phase === "static");
    const dynamicRan = nonSkipped.filter((c) => c.phase === "dynamic");
    const totalRan = staticRan.length + dynamicRan.length;
    const totalFailed = nonSkipped.filter((c) => c.status === "fail").length;
    if (
      totalRan !== parsedReport.executed ||
      totalFailed !== parsedReport.failed ||
      parsedReport.ok !== (parsedReport.failed === 0) ||
      parsedReport.ok !== passed
    ) {
      continue;
    }
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

    return phases;
  }
  // Non-JSON summary output: require a complete `lang-check (...) -> executed=N, failed=M, ok=...`
  // header line AND match ONLY 2-space-indented check rows (`  [PASS|FAIL] (lang/phase) ...`)
  // after the header (never 4-space diagnostic excerpt lines!), reconciling exact row & fail counts.
  const lines = outputText.split(/\r?\n/);
  let headerIdx = -1;
  let declaredExecuted = -1;
  let declaredFailed = -1;
  let declaredOk = false;
  for (let li = 0; li < lines.length; li++) {
    const hm = lines[li].match(
      /^lang-check\s+\((?:static|dynamic|all)\)\s+\[[^\]]*\]\s*->\s*executed=(\d+),\s*failed=(\d+),\s*ok=(true|false)$/,
    );
    if (hm) {
      headerIdx = li;
      declaredExecuted = Number(hm[1]);
      declaredFailed = Number(hm[2]);
      declaredOk = hm[3] === "true";
      break;
    }
  }
  if (headerIdx < 0) return [];
  const staticStatuses: Array<"PASS" | "FAIL"> = [];
  const dynamicStatuses: Array<"PASS" | "FAIL"> = [];
  for (let li = headerIdx + 1; li < lines.length; li++) {
    const rm = lines[li].match(
      /^  \[(PASS|FAIL)\] \((?:go|ts|python)\/(static|dynamic)\) .+$/,
    );
    if (!rm) continue;
    if (rm[2] === "static") staticStatuses.push(rm[1] as "PASS" | "FAIL");
    else dynamicStatuses.push(rm[1] as "PASS" | "FAIL");
  }
  const totalParsed = staticStatuses.length + dynamicStatuses.length;
  const totalFailed =
    staticStatuses.filter((s) => s !== "PASS").length +
    dynamicStatuses.filter((s) => s !== "PASS").length;
  if (
    declaredExecuted <= 0 ||
    totalParsed !== declaredExecuted ||
    totalFailed !== declaredFailed ||
    declaredOk !== (declaredFailed === 0) ||
    declaredOk !== passed
  ) {
    return [];
  }
  if (staticStatuses.length > 0) {
    phases.push({
      kind: "lint",
      status: staticStatuses.every((s) => s === "PASS") ? "pass" : "fail",
    });
  }
  if (dynamicStatuses.length > 0) {
    phases.push({
      kind: "test",
      status: dynamicStatuses.every((s) => s === "PASS") ? "pass" : "fail",
    });
  }
  return phases;
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

function commonDirAncestor(dirs: string[]): string {
  if (dirs.length === 1) return dirs[0];
  const partsList = dirs.map((d) => resolve(d).split("/"));
  const common: string[] = [];
  const minLen = Math.min(...partsList.map((p) => p.length));
  for (let i = 0; i < minLen; i++) {
    const seg = partsList[0][i];
    if (partsList.every((p) => p[i] === seg)) common.push(seg);
    else break;
  }
  return common.join("/") || "/";
}

function resolvePathArgToDir(
  rawArg: string,
  curDir: string,
  stripPytestNodeId = false,
): string {
  let cleaned = stripPytestNodeId ? rawArg.split("::")[0] : rawArg;
  if (cleaned.endsWith("/...")) cleaned = cleaned.slice(0, -4) || ".";
  if (cleaned === "...") cleaned = ".";
  const abs = resolve(curDir, cleaned);
  if (existsSync(abs)) {
    try {
      return statSync(abs).isFile() ? dirname(abs) : abs;
    } catch {
      return abs;
    }
  }
  const base = cleaned.split("/").pop() ?? "";
  if (/\.[a-zA-Z0-9]{1,8}$/.test(base) && !base.startsWith(".")) {
    return dirname(abs);
  }
  return abs;
}

function resolvePositionalTargetDir(
  args: string[],
  curDir: string,
  opts: {
    valueFlags: Set<string>;
    requireSingleCheckout?: boolean;
    stripPytestNodeId?: boolean;
    onlyPathLike?: boolean;
    projectFlags?: Set<string>;
    rootDirFlags?: Set<string>;
  },
): string | null {
  const positionals: string[] = [];
  let explicitProject: string | null = null;
  let explicitRoot: string | null = null;
  let endFlags = false;
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (!endFlags && tok === "--") {
      endFlags = true;
      continue;
    }
    if (!endFlags && tok.startsWith("-") && tok.length > 1) {
      const eqIdx = tok.indexOf("=");
      const flagName = eqIdx >= 0 ? tok.slice(0, eqIdx) : tok;
      if (opts.projectFlags?.has(flagName)) {
        const val = eqIdx >= 0 ? tok.slice(eqIdx + 1) : args[++i];
        if (!val) return null;
        explicitProject = val;
        continue;
      }
      if (opts.rootDirFlags?.has(flagName)) {
        const val = eqIdx >= 0 ? tok.slice(eqIdx + 1) : args[++i];
        if (!val) return null;
        explicitRoot = val;
        continue;
      }
      if (eqIdx < 0 && opts.valueFlags.has(flagName)) {
        i++;
      }
      continue;
    }
    if (opts.onlyPathLike) {
      const isPathLike =
        tok.startsWith("./") ||
        tok.startsWith("../") ||
        tok.startsWith("/") ||
        tok.includes("/") ||
        existsSync(resolve(curDir, tok));
      if (!isPathLike) continue;
    }
    positionals.push(tok);
  }
  if (positionals.length > 0) {
    const dirs = positionals.map((p) =>
      resolvePathArgToDir(p, curDir, Boolean(opts.stripPytestNodeId)),
    );
    if (opts.requireSingleCheckout && dirs.length > 1) {
      const roots = new Set([...new Set(dirs)].map(getGitTopLevel));
      if (roots.size > 1) return null;
    }
    return commonDirAncestor(dirs);
  }
  if (explicitProject) {
    return resolvePathArgToDir(explicitProject, curDir);
  }
  if (explicitRoot) {
    return resolve(curDir, explicitRoot);
  }
  return curDir;
}

export function resolveVerifyTargetDir(
  cmdToks: string[],
  envToks: string[],
  curDir: string,
): string | null {
  const [c0 = "", c1 = "", c2 = ""] = cmdToks;
  const bin0 = c0.split("/").pop() ?? "";

  if (bin0 === "make") {
    // Per GNU Make docs, `-C` / `--directory` is ONLY honored on the command line (NEVER via MAKEFLAGS).
    return extractMakeDirs(cmdToks.slice(1), curDir);
  }

  if (bin0 === "just") {
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

  const goInv = parseGoInvocation(cmdToks);
  if (goInv) {
    let dir = curDir;
    for (const d of goInv.preDirs) {
      dir = resolve(dir, d);
    }
    const GO_VALUE_FLAGS = new Set([
      "-o",
      "-p",
      "-asmflags",
      "-buildmode",
      "-compiler",
      "-gccgoflags",
      "-gcflags",
      "-installsuffix",
      "-ldflags",
      "-mod",
      "-modfile",
      "-overlay",
      "-pgo",
      "-pkgdir",
      "-tags",
      "-toolexec",
      "-workfile",
      "-vet",
      "-vettool",
      "-bench",
      "-benchtime",
      "-blockprofile",
      "-blockprofilerate",
      "-count",
      "-covermode",
      "-coverpkg",
      "-coverprofile",
      "-cpu",
      "-cpuprofile",
      "-exec",
      "-fuzz",
      "-fuzzminimizetime",
      "-fuzztime",
      "-list",
      "-memprofile",
      "-memprofilerate",
      "-mutexprofile",
      "-mutexprofilefraction",
      "-outputdir",
      "-parallel",
      "-run",
      "-shuffle",
      "-skip",
      "-timeout",
      "-trace",
    ]);
    const pkgPaths: string[] = [];
    for (let i = goInv.argsStart; i < cmdToks.length; i++) {
      const tok = cmdToks[i];
      if (tok === "--" || tok === "-args" || tok === "--args") break;
      if (tok === "-C" || tok === "--C") {
        const val = cmdToks[++i];
        if (!val) return null;
        dir = resolve(dir, val);
        continue;
      }
      if (tok.startsWith("-C=") || tok.startsWith("--C=")) {
        const val = tok.slice(tok.indexOf("=") + 1);
        if (!val) return null;
        dir = resolve(dir, val);
        continue;
      }
      if (tok.startsWith("-")) {
        const eqIdx = tok.indexOf("=");
        const rawFlag = eqIdx >= 0 ? tok.slice(0, eqIdx) : tok;
        const normFlag = rawFlag.startsWith("--") ? rawFlag.slice(1) : rawFlag;
        if (eqIdx < 0 && GO_VALUE_FLAGS.has(normFlag)) {
          i++;
        }
        continue;
      }
      if (
        tok === "." ||
        tok === "./..." ||
        tok.startsWith("./") ||
        tok.startsWith("../") ||
        tok.startsWith("/")
      ) {
        pkgPaths.push(tok);
      }
    }
    if (pkgPaths.length > 0) {
      return commonDirAncestor(pkgPaths.map((p) => resolvePathArgToDir(p, dir)));
    }
    return dir;
  }

  // Resolve runner-specific targets FIRST (including when invoked via `pnpm`/`yarn`/`npx`/`bunx`)
  const vitestInv = parseVitestRunInvocation(cmdToks, envToks);
  if (vitestInv) {
    const dir = vitestInv.pm ? resolvePkgManagerEffectiveDir(vitestInv.pm, curDir) : curDir;
    if (!dir) return null;
    let rootDir: string | null = null;
    let discoveryDir: string | null = null;
    let configDir: string | null = null;
    const args = vitestInv.vitestArgs;
    const posStart = args[0] === "run" ? 1 : 0;
    const positionalArgs: string[] = [];
    const VITEST_VALUE_FLAGS = new Set([
      "-t",
      "--testNamePattern",
      "--reporter",
      "--outputFile",
      "--environment",
      "--shard",
      "--pool",
      "--project",
      "--maxWorkers",
      "--minWorkers",
      "--testTimeout",
      "--hookTimeout",
      "--bail",
      "--sequence",
    ]);
    let stopFlags = false;
    for (let i = posStart; i < args.length; i++) {
      const tok = args[i];
      if (!stopFlags && tok === "--") {
        stopFlags = true;
        continue;
      }
      if (!stopFlags && (tok === "--root" || tok === "-r")) {
        const val = args[++i];
        if (!val) return null;
        rootDir = resolve(dir, val);
        continue;
      }
      if (!stopFlags && (tok.startsWith("--root=") || tok.startsWith("-r="))) {
        const val = tok.slice(tok.indexOf("=") + 1);
        if (!val) return null;
        rootDir = resolve(dir, val);
        continue;
      }
      if (!stopFlags && tok === "--dir") {
        const val = args[++i];
        if (!val) return null;
        discoveryDir = val;
        continue;
      }
      if (!stopFlags && tok.startsWith("--dir=")) {
        const val = tok.slice("--dir=".length);
        if (!val) return null;
        discoveryDir = val;
        continue;
      }
      if (!stopFlags && (tok === "--config" || tok === "-c")) {
        const val = args[++i];
        if (!val) return null;
        const abs = resolve(dir, val);
        configDir = dirname(abs);
        continue;
      }
      if (!stopFlags && (tok.startsWith("--config=") || tok.startsWith("-c="))) {
        const val = tok.slice(tok.indexOf("=") + 1);
        if (!val) return null;
        const abs = resolve(dir, val);
        configDir = dirname(abs);
        continue;
      }
      if (!stopFlags && tok.startsWith("-")) {
        if (!tok.includes("=") && VITEST_VALUE_FLAGS.has(tok)) i++;
        continue;
      }
      if (
        tok.startsWith("./") ||
        tok.startsWith("../") ||
        tok.startsWith("/") ||
        tok.includes("/") ||
        existsSync(resolve(rootDir ?? dir, tok))
      ) {
        positionalArgs.push(tok);
      }
    }
    const effectiveRoot = rootDir ?? dir;
    const effectiveDiscovery = discoveryDir ? resolve(effectiveRoot, discoveryDir) : null;
    const baseDir = effectiveDiscovery ?? effectiveRoot;
    // A shared external `--config ../shared/vitest.config.ts` can override `root` internally;
    // unless an explicit `--root`, `--dir`, or positional test path anchors the repo, suppress attribution
    // so neither the shared config repo nor an unverified root receives misattributed evidence.
    if (
      configDir &&
      !rootDir &&
      !discoveryDir &&
      positionalArgs.length === 0 &&
      configDir !== effectiveRoot &&
      !configDir.startsWith(effectiveRoot + "/")
    ) {
      return null;
    }
    if (positionalArgs.length > 0) {
      return commonDirAncestor(positionalArgs.map((p) => resolvePathArgToDir(p, baseDir)));
    }
    return baseDir;
  }

  const svelteInv = parseSvelteCheckInvocation(cmdToks);
  if (svelteInv) {
    const dir = svelteInv.pm ? resolvePkgManagerEffectiveDir(svelteInv.pm, curDir) : curDir;
    if (!dir) return null;
    let rawWs: string | null = null;
    let rawTsconfig: string | null = null;
    const args = svelteInv.checkArgs;
    for (let i = 0; i < args.length; i++) {
      const tok = args[i];
      if (tok === "--") break;
      if (tok === "--workspace") {
        const val = args[++i];
        if (!val) return null;
        rawWs = val;
      } else if (tok.startsWith("--workspace=")) {
        const val = tok.slice("--workspace=".length);
        if (!val) return null;
        rawWs = val;
      } else if (tok === "--tsconfig") {
        const val = args[++i];
        if (!val) return null;
        rawTsconfig = val;
      } else if (tok.startsWith("--tsconfig=")) {
        const val = tok.slice("--tsconfig=".length);
        if (!val) return null;
        rawTsconfig = val;
      }
    }
    // Per svelte-check CLI: relative `--tsconfig` resolves against the effective `--workspace` directory!
    const effectiveWs = rawWs ? resolve(dir, rawWs) : dir;
    if (rawTsconfig) {
      const absTs = resolve(effectiveWs, rawTsconfig);
      const tsDir = absTs.endsWith(".json") ? dirname(absTs) : absTs;
      return rawWs ? commonDirAncestor([effectiveWs, tsDir]) : tsDir;
    }
    return effectiveWs;
  }

  const nodeTestInv = parseNodeTestInvocation(cmdToks);
  if (nodeTestInv) {
    if (nodeTestInv.files.length > 0) {
      return commonDirAncestor(nodeTestInv.files.map((f) => resolvePathArgToDir(f, curDir)));
    }
    return curDir;
  }

  const pmInv = parsePkgManagerInvocation(cmdToks);
  if (pmInv) {
    const dir = resolvePkgManagerEffectiveDir(pmInv, curDir);
    if (!dir) return null;
    if (pmInv.manager === "bun" && pmInv.subcmd === "build" && !pmInv.bunScript) {
      return resolvePositionalTargetDir(pmInv.rest, dir, {
        valueFlags: BUN_BUILD_VALUE_FLAGS, onlyPathLike: true, requireSingleCheckout: true,
      });
    }
    if (pmInv.manager === "bun" && pmInv.subcmd === "test" && !pmInv.bunScript) {
      return resolvePositionalTargetDir(pmInv.rest, dir, {
        valueFlags: new Set(["--cwd", "-t", "--test-name-pattern", "--timeout", "--preload", "-r"]),
        onlyPathLike: true,
      });
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
    const sourceFiles: string[] = [];
    for (let i = isBuildMode ? 1 : 0; i < tscArgs.length; i++) {
      const tok = tscArgs[i];
      const optName = stripTscOpt(tok);
      if (!optName) {
        if (isBuildMode) buildProjects.push(tok);
        else sourceFiles.push(tok);
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
    if (!isBuildMode && sourceFiles.length > 0) {
      return commonDirAncestor(sourceFiles.map((f) => resolvePathArgToDir(f, curDir)));
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

  const pytestInv = isPytestInvocation(cmdToks);
  if (pytestInv) {
    return resolvePositionalTargetDir(cmdToks.slice(pytestInv.argsStart), curDir, {
      valueFlags: new Set([
        "-k",
        "-m",
        "-c",
        "-o",
        "-W",
        "-p",
        "-n",
        "--maxfail",
        "--tb",
        "--capture",
        "--junitxml",
        "--basetemp",
        "--confcutdir",
        "--ignore",
        "--ignore-glob",
        "--deselect",
        "--durations",
      ]),
      rootDirFlags: new Set(["--rootdir"]),
      stripPytestNodeId: true,
    });
  }

  if (bin0 === "mypy") {
    return resolvePositionalTargetDir(cmdToks.slice(1), curDir, {
      valueFlags: new Set([
        "-m",
        "--module",
        "-p",
        "--package",
        "-c",
        "--command",
        "--config-file",
        "--python-version",
        "--python-executable",
        "--platform",
        "--cache-dir",
        "--exclude",
        "--follow-imports",
        "--output",
      ]),
    });
  }

  if (bin0 === "pyright") {
    return resolvePositionalTargetDir(cmdToks.slice(1), curDir, {
      valueFlags: new Set([
        "--pythonpath",
        "--pythonplatform",
        "--pythonversion",
        "--typeshedpath",
        "--venvpath",
        "--level",
        "--threads",
      ]),
      projectFlags: new Set(["-p", "--project"]),
    });
  }

  if (bin0 === "ruff" && c1 === "check") {
    return resolvePositionalTargetDir(cmdToks.slice(2), curDir, {
      valueFlags: new Set([
        "--config",
        "--select",
        "--extend-select",
        "--ignore",
        "--exclude",
        "--output-format",
        "--target-version",
        "--cache-dir",
      ]),
    });
  }

  if (
    (bin0 === "biome" && c1 === "check") ||
    ((bin0 === "npx" || bin0 === "bunx") && c1 === "biome" && c2 === "check") ||
    (bin0 === "bunx" && c1 === "--bun" && c2 === "biome" && cmdToks[3] === "check")
  ) {
    const startIdx = bin0 === "biome" ? 2 : c1 === "--bun" ? 4 : 3;
    return resolvePositionalTargetDir(cmdToks.slice(startIdx), curDir, {
      valueFlags: new Set([
        "--config-path",
        "--diagnostic-level",
        "--max-diagnostics",
        "--reporter",
        "--since",
      ]),
    });
  }

  const eslintTargetArgs = extractEslintArgs(cmdToks);
  if (eslintTargetArgs) {
    return resolvePositionalTargetDir(eslintTargetArgs, curDir, {
      valueFlags: new Set([
        "-c",
        "--config",
        "--ext",
        "--format",
        "-f",
        "--ignore-path",
        "--ignore-pattern",
        "--max-warnings",
        "--rule",
        "--parser",
        "--cache-location",
      ]),
    });
  }

  if (bin0 === "golangci-lint" && c1 === "run") {
    return resolvePositionalTargetDir(cmdToks.slice(2), curDir, {
      valueFlags: new Set([
        "-c",
        "--config",
        "--timeout",
        "--out-format",
        "--build-tags",
        "--enable",
        "--disable",
        "--new-from-rev",
      ]),
    });
  }

  if (bin0 === "hurl") {
    return resolvePositionalTargetDir(cmdToks.slice(1), curDir, {
      valueFlags: new Set([
        "--variable",
        "--variables-file",
        "--file-root",
        "--connect-timeout",
        "--max-time",
        "--retry",
        "--retry-interval",
        "--report-html",
        "--report-json",
        "--report-junit",
        "--report-tap",
        "--output",
        "-o",
        "--cookie",
        "-b",
        "--cookie-jar",
        "-c",
        "--proxy",
        "-x",
        "--user",
        "-u",
        "--jobs",
      ]),
    });
  }

  return curDir;
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

export function isValidHurlExecution(
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
