import { hasNonExecutingTscFlags } from "../shared/tsc";
import {
  delegatesToScript,
  findNearestPackageDir,
  getScriptKind,
  ignoresLifecycleScripts,
  npmCliBoolean,
  parseBoolVal,
  parsePkgManagerInvocation,
  resolvePkgManagerEffectiveDir,
} from "./pkg-manager";
import {
  classifyVerifyCommand,
  extractEslintArgs,
  extractTscArgs,
  hasInfoOnlyFlag,
  hasMakeNonExecArgs,
  isPytestInvocation,
  isValidHurlExecution,
  parseGoInvocation,
  parseLangCheckInvocation,
  parseLangCheckPhases,
  resolveVerifyTargetDir,
} from "./runners";
import {
  BENIGN_TRAILING_CMDS,
  SHELL_CONTROL_OR_STATE_BUILTINS,
  type ScriptKind,
  type VerificationHit,
} from "./types";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getGitTopLevel } from "../shared/git-cmd";
import {
  hasUnquotedRedirect,
  resolveCdTarget,
  splitLeadingEnv,
  splitShellSegments,
  splitShellTokensWithMeta,
  stripUnquotedShellRedirections,
} from "../shared/shell";

const ALLOWED_FAILFAST_SET_O_OPTS = new Set([
  "errexit",
  "nounset",
  "pipefail",
  "xtrace",
  "verbose",
  "noglob",
]);

export function isFailFastSetSegment(seg: string): boolean {
  const meta = splitShellTokensWithMeta(seg.trim());
  if (!meta || meta.length < 2) return false;
  if (meta[0].isEnvAssign || meta[0].value !== "set") return false;
  let sawErrexit = false;
  for (let i = 1; i < meta.length; i++) {
    const tok = meta[i].value;
    if (tok === "-o") {
      const opt = meta[++i]?.value;
      if (!opt || !ALLOWED_FAILFAST_SET_O_OPTS.has(opt)) return false;
      if (opt === "errexit") sawErrexit = true;
      continue;
    }
    if (!/^-[a-zA-Z]+$/.test(tok)) return false;
    const letters = tok.slice(1);
    for (let j = 0; j < letters.length; j++) {
      const ch = letters[j];
      if (!"euoxvf".includes(ch)) return false;
      if (ch === "e") sawErrexit = true;
      if (ch === "o") {
        // `-o` in a short cluster (e.g. `set -euo pipefail`) must be at the end and consume a valid option name
        if (j !== letters.length - 1) return false;
        const opt = meta[++i]?.value;
        if (!opt || !ALLOWED_FAILFAST_SET_O_OPTS.has(opt)) return false;
        if (opt === "errexit") sawErrexit = true;
      }
    }
  }
  return sawErrexit;
}

/**
 * Only capture evidence for unambiguous shell invocations where no failing check can be masked.
 * Allows:
 * - Single-line commands chained with `&&` (and harmless redirections like `> /tmp/log 2>&1`).
 * - Multi-line scripts ONLY when either:
 *   (a) Line 1 enables fail-fast `set -e` (e.g. `set -euo pipefail`) and subsequent lines contain no
 *       `set`, `trap`, errexit-exempt flow control (`if`/`while`/`until`/etc.), or `!` negation, OR
 *   (b) Every preceding line is strictly a `cd <dir>` command followed by a single final verification line.
 * Rejects `||`, pipes (`|`), `;`, single `&`, subshells, command substitutions, and unguarded multi-line scripts.
 */
export function hasAmbiguousControlFlow(cmd: string): boolean {
  let quote: "'" | '"' | "$'" | null = null;
  let escape = false;
  let atWordStart = true;
  let sawUnquotedNewline = false;
  let sawUnquotedAndAnd = false;
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
    if (ch === "\r") return true;
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
      while (i + 1 < cmd.length && cmd[i + 1] !== "\n") i++;
      continue;
    }
    if (ch === "\n") {
      sawUnquotedNewline = true;
      atWordStart = true;
      continue;
    }
    if (ch === "<" && next === "<") return true; // Reject heredocs/here-strings so data lines cannot masquerade as commands
    if (ch === "|") return true;
    if (ch === ";") return true;
    if (ch === "&") {
      if (next === "&") {
        sawUnquotedAndAnd = true;
        atWordStart = true;
        i++;
        continue;
      }
      const prev = cmd[i - 1];
      if (prev === ">" || prev === "<" || next === ">") {
        atWordStart = false;
        continue;
      }
      return true;
    }
    if (ch === "`" || ch === "(" || ch === ")") return true;
    atWordStart = ch === " " || ch === "\t";
  }
  if (!sawUnquotedNewline) return false;

  // Multi-line validation: split logical non-empty, non-comment lines (after joining `\` line continuations)
  const logicalLines = cmd
    .replace(/\\\n/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  if (logicalLines.length <= 1) return false;

  // Case (a): fail-fast `set -e` / `set -euo pipefail` on line 1.
  // Reject ANY unquoted `&&` on subsequent lines (since the LHS of `&&` is exempt from `errexit` in Bash!)
  // and reject any line whose command-position word is a shell reserved/state word (`if`, `while`, `set`, `trap`, `!`, etc.)
  // while permitting ordinary filenames containing reserved substrings like `tests/edge-case.test.ts`.
  const SHELL_ERREXIT_EXEMPT_OR_STATE_WORDS = new Set([
    "if",
    "then",
    "elif",
    "else",
    "fi",
    "while",
    "until",
    "for",
    "do",
    "done",
    "case",
    "esac",
    "select",
    "trap",
    "set",
    "!",
    "coproc",
    "{",
    "}",
    "[[",
  ]);
  if (isFailFastSetSegment(logicalLines[0]) && !sawUnquotedAndAnd) {
    const rest = logicalLines.slice(1);
    const hasUnsafeLine = rest.some((l) => {
      if (splitShellSegments(l).length !== 1) return true;
      const meta = splitShellTokensWithMeta(l);
      if (!meta || meta.length === 0) return true;
      const firstWord = meta[0].value;
      const cmdWord = splitLeadingEnv(meta).cmdToks[0] ?? "";
      return (
        SHELL_ERREXIT_EXEMPT_OR_STATE_WORDS.has(firstWord) ||
        SHELL_ERREXIT_EXEMPT_OR_STATE_WORDS.has(cmdWord)
      );
    });
    if (!hasUnsafeLine) return false;
  }

  // Case (b): every line prior to the final line is strictly a simple `cd <dir>` command
  const precedingAllSimpleCd = logicalLines.slice(0, -1).every((l) => {
    const toks = splitShellTokensWithMeta(l);
    if (!toks || toks.length !== 2) return false;
    return !toks[0].isEnvAssign && toks[0].value === "cd" && !toks[1].value.startsWith("-");
  });
  if (precedingAllSimpleCd) return false;

  return true;
}

function canVerifyCommandMutateFiles(hit: VerificationHit): boolean {
  if (hit.kind === "build") return true;
  const tsc = extractTscArgs(hit.cmdToks);
  if (tsc) {
    const index = tsc.map(arg => arg.toLowerCase()).lastIndexOf("--noemit");
    const next = tsc[index + 1]?.toLowerCase();
    if (index < 0 || next === "false" || next === "null") return true;
  }
  if (hit.kind === "lint" && hit.cmdToks.some(arg => arg === "-w" || arg.startsWith("-o"))) return true;
  return hit.cmdToks.some(arg => /^--(?:fix|fix-type|fix-unsafe|unsafe-fixes|write|apply|apply-unsafe|output-file|out-file|output|out)(?:=|$)/.test(arg));
}

export function safeTrailingSegments(
  segments: string[], dir: string, depth = 0, forwarded: string[] = [], previous: string | null = null,
  inheritedEnv: string[] = [],
): boolean {
  for (const [i, segment] of segments.entries()) {
    if (hasUnquotedRedirect(segment, ">")) return false;
    const meta = splitShellTokensWithMeta(stripUnquotedShellRedirections(segment));
    if (!meta) return false;
    if (i === segments.length - 1) meta.push(...forwarded.map(value => ({ value, isEnvAssign: false })));
    const { cmdToks, envToks: localEnv } = splitLeadingEnv(meta);
    const envToks = [...inheritedEnv, ...localEnv];
    if (!cmdToks.length || SHELL_CONTROL_OR_STATE_BUILTINS.has(cmdToks[0])) return false;
    if (cmdToks[0] === "cd") {
      const next = resolveCdTarget(dir, previous, meta);
      if (!next) return false;
      previous = dir;
      dir = next;
      continue;
    }
    if (BENIGN_TRAILING_CMDS.has(cmdToks[0].replace(/^\/(?:usr\/)?bin\//, ""))) continue;
    const hit = classifyVerifyCommand(meta);
    if (hit && canVerifyCommandMutateFiles(hit)) return false;
    const pm = parsePkgManagerInvocation(cmdToks);
    if (!pm || !delegatesToScript(pm, hit)) {
      if (!hit) return false;
      continue;
    }
    if (depth >= 6) return false;
    const target = resolvePkgManagerEffectiveDir(pm, dir);
    const pkg = target && findNearestPackageDir(target, pm.manager === "npm");
    if (!pkg) return false;
    try {
      const scripts = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).scripts;
      const script = scripts?.[pm.scriptName];
      if (typeof script !== "string" || hasAmbiguousControlFlow(script) ||
          !safeTrailingSegments(splitShellSegments(script), pkg, depth + 1, pm.forwarded, null, envToks)) return false;
      if (!ignoresLifecycleScripts(pm, envToks)) {
        for (const prefix of ["pre", "post"]) {
          const hook = scripts[prefix + pm.scriptName];
          if (typeof hook === "string" && (hasAmbiguousControlFlow(hook) ||
              !safeTrailingSegments(splitShellSegments(hook), pkg, depth + 1, [], null, envToks))) return false;
        }
      }
    } catch {
      return false;
    }
  }
  return true;
}

function matchesScriptKind(hit: VerificationHit, expected: ScriptKind, dir: string, outputText: string, passed: boolean): boolean {
  if (hit.kind === "hurl") return expected === "test" && isValidHurlExecution(hit.cmdToks, dir, outputText);
  if (hit.kind !== "lang-check") return hit.kind === expected;
  const mode = parseLangCheckInvocation(hit.cmdToks)?.mode;
  if (mode === "all") return parseLangCheckPhases(outputText, passed).some(p => p.kind === expected && p.status === (passed ? "pass" : "fail"));
  return expected !== "build" && mode === (expected === "test" ? "dynamic" : "static");
}

function hasExecutingScriptSegment(
  segments: string[], pkgDir: string, depth: number, expectedKind: ScriptKind, forwarded: string[], outputText: string, passed: boolean, inheritedEnv: string[],
): boolean {
  const originTop = getGitTopLevel(pkgDir);
  let dir = pkgDir;
  let previous: string | null = null;
  let verified = false;
  for (const [index, seg] of segments.entries()) {
    if (verified) {
      if (!safeTrailingSegments(segments.slice(index), dir, depth, forwarded, previous, inheritedEnv)) return false;
      if (!forwarded.includes("-v")) return true;
      verified = false; // The final runner must still accept the forwarded verbose flag.
    }
    const meta = splitShellTokensWithMeta(stripUnquotedShellRedirections(seg));
    if (!meta) return false;
    if (index === segments.length - 1 && forwarded.length) {
      meta.push(...forwarded.map(value => ({ value, isEnvAssign: false })));
    }
    const { cmdToks, envToks: localEnv } = splitLeadingEnv(meta);
    const envToks = [...inheritedEnv, ...localEnv];
    if (!cmdToks.length && localEnv.length) return false;
    if (!cmdToks.length) continue;
    if (SHELL_CONTROL_OR_STATE_BUILTINS.has(cmdToks[0])) return false;
    if (cmdToks[0] === "cd") {
      const next = resolveCdTarget(dir, previous, meta);
      if (!next) return false;
      previous = dir;
      dir = next;
      continue;
    }
    const hit = classifyVerifyCommand(meta);
    const pm = parsePkgManagerInvocation(cmdToks);
    const delegates = delegatesToScript(pm, hit);
    if (index === segments.length - 1 && forwarded.includes("-v")) {
      if (hasUnquotedRedirect(seg, ">") || hasUnquotedRedirect(seg, "<")) return false;
      if (!delegates && !isPytestInvocation(cmdToks) && parseGoInvocation(cmdToks)?.subcmd !== "test") return false;
    }
    if (!hit && !delegates) {
      continue;
    }
    const target = hit ? resolveVerifyTargetDir(cmdToks, envToks, dir) : resolvePkgManagerEffectiveDir(pm!, dir);
    if (!target || (originTop && getGitTopLevel(target) !== originTop)) return false;
    if (!delegates && hit && !matchesScriptKind(hit, expectedKind, dir, outputText, passed)) continue;
    if (!extractTscArgs(cmdToks) && hasInfoOnlyFlag(cmdToks)) continue;
    if (!hasNonExecutingVerifyFlag(cmdToks, envToks, target, outputText, passed, depth + 1, !!delegates, expectedKind)) verified = true;
  }
  return verified;
}

export function hasNonExecutingVerifyFlag(
  cmdToks: string[], envToks: string[], targetDir: string, outputText: string, passed: boolean, depth = 0, requireManifestScript = false, expectedKind?: ScriptKind,
): boolean {
  if (depth >= 6) return true;
  const [c0 = "", c1 = ""] = cmdToks;
  const bin0 = c0.split("/").pop() ?? "";

  if (bin0 === "make") {
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

  if (bin0 === "just") {
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

  const goInv = parseGoInvocation(cmdToks);
  if (goInv) {
    const isGoBoolOn = (norm: string, name: string): boolean => {
      if (norm === name) return true;
      if (!norm.startsWith(`${name}=`)) return false;
      const val = norm.slice(name.length + 1).toLowerCase();
      return val !== "false" && val !== "0" && val !== "f";
    };
    for (let i = goInv.argsStart; i < cmdToks.length; i++) {
      const tok = cmdToks[i];
      if (tok === "--") break;
      const norm = tok.startsWith("--") ? tok.slice(1) : tok;
      if (isGoBoolOn(norm, "-n") || norm === "-help" || norm === "-h") return true;
      if (
        goInv.subcmd === "test" &&
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
  if (tscArgs) return hasNonExecutingTscFlags(tscArgs);

  const eslintArgs = extractEslintArgs(cmdToks);
  if (eslintArgs) {
    for (let i = 0; i < eslintArgs.length; i++) {
      const tok = eslintArgs[i];
      if (tok === "--") break;
      if (
        tok === "--print-config" ||
        tok.startsWith("--print-config=") ||
        tok === "--init" ||
        tok === "--inspect-config" ||
        tok === "--env-info" ||
        tok === "-v" ||
        tok === "--version" ||
        tok === "-h" ||
        tok === "--help"
      ) {
        return true;
      }
    }
    return false;
  }

  if (bin0 === "ruff" && c1 === "check") {
    for (let i = 2; i < cmdToks.length; i++) {
      const tok = cmdToks[i];
      if (tok === "--") break;
      if (tok === "--show-settings" || tok === "--show-files") return true;
    }
    return false;
  }

  if (bin0 === "npm" || bin0 === "bun" || bin0 === "pnpm" || bin0 === "yarn") {
    const flags = new Map<string, boolean>();
    if (bin0 === "npm") {
      for (const [rawKey, rawVal] of Object.entries(process.env)) {
        if (rawVal === undefined) continue;
        const k = rawKey.toLowerCase();
        if (k === "npm_config_if_present") flags.set("if-present", parseBoolVal(rawVal));
        if (k === "npm_config_dry_run") flags.set("dry-run", parseBoolVal(rawVal));
        if (k === "npm_config_usage") flags.set("usage", parseBoolVal(rawVal));
        if (k === "npm_config_versions") flags.set("versions", parseBoolVal(rawVal));
      }
      for (const raw of envToks) {
        const eq = raw.indexOf("=");
        if (eq < 0) continue;
        const k = raw.slice(0, eq).toLowerCase();
        const v = raw.slice(eq + 1);
        if (k === "npm_config_if_present") flags.set("if-present", parseBoolVal(v));
        if (k === "npm_config_dry_run") flags.set("dry-run", parseBoolVal(v));
        if (k === "npm_config_usage") flags.set("usage", parseBoolVal(v));
        if (k === "npm_config_versions") flags.set("versions", parseBoolVal(v));
      }
    }
    const pm = parsePkgManagerInvocation(cmdToks);
    if (pm?.manager !== "npm" && pm?.managerFlags.some(arg => ["-v", "--version", "-h", "--help", "-?", "--versions", "--usage"].includes(arg))) return true;
    const scriptKind = pm && getScriptKind(pm.scriptName);
    const builtinBuild = pm?.manager === "bun" && pm.subcmd === "build" && !pm.bunScript;
    if (pm && !builtinBuild && (requireManifestScript || scriptKind)) {
      const nonExecutingFlags = new Set([
        "-h", "-V", "-?", "--help", "--version", "--versions", "--usage",
        "--dry-run", "--dry", "--list", "--collect-only", "--pass-with-no-tests",
        "--passwithnotests", "--watch", "--ui", "--open", "--showconfig", "--listfilesonly",
        "--nocheck", "--clean", "--init", "--print-config", "--inspect-config", "--env-info",
        "--show-settings", "--show-files", "--merge-reports", "--mergereports", "--clear-cache",
        "--clearcache", "--typecheck-only",
      ]);
      const forwarded = pm.forwarded;
      const verbose = forwarded.includes("-v");
      const builtinTest = pm.manager === "bun" && pm.subcmd === "test" && !pm.bunScript;
      const kind = expectedKind ?? scriptKind;
      if (verbose && (builtinTest || kind !== "test")) return true;
      if (!builtinTest) {
        let manifestScript: unknown;
        const pkgDir = findNearestPackageDir(targetDir, pm.manager === "npm");
        if (pkgDir && pkgDir !== targetDir) {
          const top = getGitTopLevel(targetDir);
          if (top && getGitTopLevel(pkgDir) !== top) return true;
        }
        if (pkgDir) {
          try {
            const scripts = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).scripts;
            manifestScript = scripts?.[pm.scriptName];
            const post = scripts?.[`post${pm.scriptName}`];
            if (typeof post === "string" && post.trim() && !ignoresLifecycleScripts(pm, envToks)) {
              if (hasAmbiguousControlFlow(post) || !safeTrailingSegments(splitShellSegments(post), pkgDir, depth + 1, [], null, envToks)) return true;
            }
          } catch {
            return true;
          }
        }
        const script = typeof manifestScript === "string" ? manifestScript : null;
        if ((requireManifestScript || pm.bunScript) && script === null) return true;
        if (script !== null && (!script.trim() || hasAmbiguousControlFlow(script))) return true;
        const segments = script !== null ? splitShellSegments(script) : null;
        if (segments && pkgDir && (!kind || !hasExecutingScriptSegment(segments, pkgDir, depth, kind, forwarded, outputText, passed, envToks))) return true;
        if (verbose && script === null) return true;
      }
      for (const arg of forwarded) {
        const eq = arg.indexOf("=");
        if (eq >= 0 && /^(false|0|null)$/i.test(arg.slice(eq + 1))) continue;
        const name = eq >= 0 ? arg.slice(0, eq) : arg;
        if (nonExecutingFlags.has(name.startsWith("--") ? name.toLowerCase() : name)) return true;
      }
    }
    const checkKeys =
      pm?.manager === "bun" && pm.subcmd === "test" && !pm.bunScript
        ? ["dry-run", "pass-with-no-tests"]
        : bin0 === "npm"
          ? ["dry-run", "if-present", "no-exit-on-error", "usage", "versions", "version"]
          : ["dry-run", "if-present", "no-exit-on-error"];
    for (const arg of bin0 === "npm" && pm ? pm.managerFlags : cmdToks.slice(1)) {
      if (arg === "--") break;
      // npm 11 expands the positive help shorthands to usage. --no-help does not undo --usage.
      if (bin0 === "npm") {
        if (/^-[A-Za-z?]{2,}$/.test(arg) && !/^-[CLcmw]/.test(arg)) {
          if (arg.includes("v")) flags.set("version", true);
          if (/[hH?]/.test(arg)) flags.set("usage", true);
          continue;
        }
        const tok = arg.replace(/^-v(?==|$)/, "--version")
          .replace(/^(?:--hel(?:p)?|-[hH?])(?==|$)/, "--usage")
          .replace(/^--(?:u|us|usa|usag)(?:=(?!false$).*|$)/, "--usage");
        for (const key of checkKeys) {
          const value = npmCliBoolean(tok, key);
          if (value !== undefined) flags.set(key, value);
        }
        continue;
      }
      const tok = arg;
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
