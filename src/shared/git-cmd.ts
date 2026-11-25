import { runGit } from "../git";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { parseGitRemoteRepo } from "./gh-remote";
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

export function parseGitPushArgs(args: string[]): {
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

export function isImplicitPushAmbiguous(
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

/**
 * Strict command-position git parser (used for Runbook approval exceptions so
 * non-git commands or git info queries like `git --exec-path tag ...` NEVER count as tag creation).
 * Allowlists ONLY `-C <dir>` (accumulated sequentially) and `-c <key[=val]>`.
 */
export function extractCommandPositionGit(
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

export function parseGitTagCreation(subArgs: string[]): { tagName: string; targetRef: string } | null {
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
export function evaluateFollowTagsSetting(
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

export function isFollowTagsEffective(
  pushSubArgs: string[],
  gitConfigs: string[],
  checkoutDir: string | null,
): boolean {
  const state = evaluateFollowTagsSetting(pushSubArgs, gitConfigs, checkoutDir);
  return state === "cli_true" || state === "inline_true" || state === "repo_true" || state === "unknown";
}

export function effectivePushRepo(dir: string, remote: string, configs: string[]) {
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

export function getGitTopLevel(dir: string): string | null {
  const top = runGit(dir, ["rev-parse", "--show-toplevel"], 3000);
  if (top.code !== 0) return null;
  try {
    return realpathSync.native(top.stdout.replace(/\n$/, ""));
  } catch {
    return null;
  }
}
