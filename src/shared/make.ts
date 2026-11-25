import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const MAKE_ALL_LONG_OPTS = [
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

export const MAKE_VALUE_LONG = new Set([
  "directory",
  "file",
  "makefile",
  "include-dir",
  "what-if",
  "new-file",
  "assume-new",
  "NeXT-option",
]);

export const MAKE_VALUE_SHORT = new Set(["C", "f", "I", "W", "N"]);

export const MAKE_OPT_VALUE_SHORT = new Set(["j", "l", "O"]);

const MAKE_NON_EXEC_SHORT = new Set(["n", "q", "t", "v", "h", "i", "o"]);

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

export function extractMakeDirs(args: string[], startDir: string, changeDir = resolve): string | null {
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
        dir = changeDir(dir, val);
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
          dir = changeDir(dir, val);
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

export function extractMakeTargets(args: string[]): string[] {
  const targets: string[] = [];
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
    targets.push(tok);
  }
  return targets;
}

export function hasBuildTarget(args: string[], dir: string): boolean {
  const recognized = (goal: string) => /^(?:build|all|compile|dist|release|binary|bin|check|build-[\w.-]+|[\w.-]+-build)$/.test(goal);
  const goals = extractMakeTargets(args);
  if (!goals.every(recognized)) return false;

  // Verify the recipe and its prerequisites in the same makefile used by this invocation.
  if (process.env.MAKEFILES) return false;
  for (let i = 0; i < args.length; i++) {
    if (goals.includes(args[i])) continue;
    if (args[i] === "-j" || args[i] === "--jobs") {
      if (/^\d+$/.test(args[i + 1] ?? "")) i++;
      continue;
    }
    if (/^(?:-j|--jobs=)\d+$/.test(args[i])) continue;
    if (args[i] === "-C" || args[i] === "--directory") { i++; continue; }
    if (args[i].startsWith("-C") || args[i].startsWith("--directory=") || args[i] === "--") continue;
    return false;
  }
  const file = ["GNUmakefile", "makefile", "Makefile"].map(name => join(dir, name)).find(path => existsSync(path));
  if (!file) return false;
  const prerequisites = new Map<string, string[]>();
  const recipes = new Set<string>();
  let first = "", selected = "", current = "";
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (line.startsWith("\t")) {
      if (current && line.trim() && !line.trim().startsWith("#")) recipes.add(current);
      continue;
    }
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    current = "";
    const explicit = /^\s*\.DEFAULT_GOAL\s*:?=\s*([\w.-]+)\s*(?:#.*)?$/.exec(line);
    if (explicit) { selected = explicit[1]; continue; }
    if (/^\.PHONY\s*:/.test(line)) continue;
    if (/^[\w-]+\s*(?::=|\?=|\+=|=)/.test(line)) continue;
    const rule = /^([\w./-]+)\s*:(?![=:])\s*([^#]*)/.exec(line);
    if (!rule) return false;
    current = rule[1];
    if (!first && !current.startsWith(".")) first = current;
    const [deps, ...inline] = rule[2].split(";");
    if (inline.join(";").trim()) recipes.add(current);
    const inputs = deps.trim().split(/\s+/).filter(Boolean);
    prerequisites.set(current, [...(prerequisites.get(current) ?? []), ...inputs]);
  }
  return (goals.length ? goals : [selected || first]).every(goal => {
    if (!recognized(goal)) return false;
    const seen = new Set<string>();
    const pending = [goal];
    let hasRecipe = false;
    while (pending.length) {
      const target = pending.pop()!;
      if (seen.has(target)) continue;
      seen.add(target);
      if (/^(?:clean|distclean|mrproper|fmt|format|help|version)$/.test(target)) return false;
      if (recipes.has(target)) hasRecipe = true;
      pending.push(...(prerequisites.get(target) ?? []));
    }
    return hasRecipe;
  });
}
