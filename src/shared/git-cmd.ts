import { runGit } from "../git";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalizeOsPath } from "./path";

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

/** True for force options and refspecs that explicitly permit overwriting history. */
export function requestsForcedPush(args: string[]): boolean {
  let afterOptions = false;
  let hasDestination = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!afterOptions && arg === "--") {
      afterOptions = true;
      continue;
    }
    if (!afterOptions && arg.startsWith("--")) {
      const option = canonicalPushOption(arg);
      if (["--force", "--force-with-lease", "--force-if-includes", "--mirror"].includes(option)) return true;
      if (option === "--repo") hasDestination = true;
      if (["--repo", "--push-option", "--receive-pack", "--exec"].includes(option) && !arg.includes("=")) i++;
      continue;
    }
    if (!afterOptions && arg.startsWith("-")) {
      for (const [index, flag] of [...arg.slice(1)].entries()) {
        if (flag === "f") return true;
        if (flag === "o") {
          if (index === arg.length - 2) i++;
          break;
        }
      }
      continue;
    }
    if (hasDestination && arg.startsWith("+")) return true;
    hasDestination = true;
  }
  return false;
}

export function getCanonicalGitCommonDir(dir: string): string | null {
  const res = runGit(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"], 3000);
  const path = res.stdout.replace(/\n$/, "");
  if (res.code !== 0 || !path) return null;
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

export function getGitTopLevel(dir: string): string | null {
  const top = runGit(dir, ["rev-parse", "--show-toplevel"], 3000);
  if (top.code !== 0) return null;
  try {
    return realpathSync.native(top.stdout.replace(/\n$/, ""));
  } catch {
    return null;
  }
}
