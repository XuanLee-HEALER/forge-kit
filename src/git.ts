import { parseYamlFile } from "./config";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export const isOid = (value: string) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);

export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Supervisor-generated termination status, safe to report without child output. */
  termination?: string;
}

export interface RepoLocation {
  repo: string;
  repoRoot: string;
  checkoutDir: string;
  worktree: string | null;
  branch: string;
  headSha: string | null;
  isDetached: boolean;
}

const verificationDeadline = new AsyncLocalStorage<number>();
export function withinProcessDeadline<T>(deadline:number, operation:()=>T):T {
  return verificationDeadline.run(deadline,operation);
}

export function runProcess(
  argv: string[],
  opts?: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
    onOutput?: (stdout: Uint8Array, stderr: Uint8Array) => void;
  },
): GitRunResult {
  try {
    const remaining = (verificationDeadline.getStore() ?? Infinity) - Date.now();
    if (remaining <= 0) throw Error("Verification timed out");
    const requested = opts?.timeoutMs ?? 10000;
    const timeout = Number.isFinite(remaining) ? Math.min(requested || remaining, remaining) : requested;
    const proc = Bun.spawnSync(argv, {
      cwd: opts?.cwd,
      env: opts?.env ?? process.env,
      stdout: "pipe",
      stderr: "pipe",
      timeout,
    });
    opts?.onOutput?.(proc.stdout, proc.stderr);
    const stderr = proc.stderr.toString();
    if (proc.exitedDueToTimeout || proc.signalCode) {
      const cause = proc.exitedDueToTimeout
        ? "Process timed out after " + timeout + " ms"
        : "Process terminated by " + proc.signalCode;
      return {
        code: proc.exitCode || 1,
        termination: cause,
        stdout: proc.stdout.toString(),
        stderr: stderr ? cause + ": " + stderr : cause,
      };
    }
    return { code: proc.exitCode ?? 1, stdout: proc.stdout.toString(), stderr };
  } catch (err) {
    return {
      code: 1,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
}

// Internal commands select a checkout explicitly. Git's inherited repository selectors override -C.
export function checkoutEnvironment(source = process.env) {
  const env = { ...source };
  for (const name of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_PREFIX",
    "GIT_SHALLOW_FILE", "GIT_GRAFT_FILE", "GIT_REPLACE_REF_BASE"]) delete env[name];
  return env;
}

export function offlineGitInvocation(dir: string, args: string[]) {
  const env = checkoutEnvironment();
  for (const key of Object.keys(env)) {
    if (/^GIT_(?:CONFIG(?:_|$)|TRACE|REDIRECT_|TEST_)/.test(key) ||
        ["GIT_EXTERNAL_DIFF", "GIT_ALLOW_PROTOCOL"].includes(key)) delete env[key];
  }
  Object.assign(env, {
    GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "", GIT_ATTR_NOSYSTEM: "1", LC_ALL: "C",
  });
  const argv: [string, ...string[]] = ["git", "-C", dir, "--no-pager", "--literal-pathspecs",
    "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never", ...args];
  return { argv, env };
}

export function runGit(
  dir: string,
  args: string[],
  timeoutMs = 10_000,
): GitRunResult {
  return runProcess(["git", "-C", dir, ...args], { timeoutMs, env: checkoutEnvironment() });
}

/**
 * Locate git repo identity for any path, INCLUDING detached/external worktrees
 * (such as a temporary checkout created via `git worktree add --detach`)
 * as long as the canonical main repo checkout lives inside workbenchRoot.
 */
export function locateRepo(
  workbenchRoot: string,
  targetPath: string,
): RepoLocation | null {
  if (!targetPath || !existsSync(targetPath)) return null;
  let canonicalRoot: string;
  let canonicalTarget: string;
  try {
    canonicalRoot = realpathSync(workbenchRoot);
    canonicalTarget = realpathSync(targetPath);
  } catch {
    return null;
  }

  const info = runGit(
    canonicalTarget,
    ["rev-parse", "--show-toplevel", "--git-common-dir", "--abbrev-ref", "HEAD"],
    3000,
  );
  if (info.code !== 0) return null;
  // Strip ONLY line endings (never `.trim()`, which would truncate valid trailing NBSP in branch/dir names!)
  const lines = info.stdout.replace(/\n$/, "").split("\n");
  if (lines.length !== 3) return null;

  let top: string;
  let common: string;
  try {
    top = realpathSync(lines[0]);
    const commonRaw = lines[1];
    common = realpathSync(
      commonRaw.startsWith("/") ? commonRaw : resolve(canonicalTarget, commonRaw),
    );
  } catch {
    return null;
  }

  const mainCheckout = resolve(common, "..");

  // A host checkout also owns its linked worktrees, but is a business repository only by explicit opt-in.
  const relMain = relative(canonicalRoot, mainCheckout);
  if (relMain.startsWith("..")) return null;
  if (!relMain) {
    const config = parseYamlFile<{ repos?: unknown }>(join(canonicalRoot, ".workbench/workbench.yaml"));
    if (common !== join(canonicalRoot, ".git") || !Array.isArray(config?.repos) ||
        !config.repos.some(repo => repo === "." || repo === "./")) return null;
  }

  const branch = lines[2];
  const headRes = runGit(top, ["rev-parse", "HEAD"], 3000);
  const headSha = headRes.code === 0 ? headRes.stdout.trim() : null;

  return {
    repo: relMain || ".",
    repoRoot: mainCheckout,
    checkoutDir: top,
    worktree: top !== mainCheckout ? top : null,
    branch,
    headSha,
    isDetached: branch === "HEAD",
  };
}

/**
 * For a detached worktree (e.g. an integration merge commit), return HEAD and its direct parents
 * so we can trace back to the feature branch commit bound to an OPEN ledger task.
 */
export function getHeadAndParents(checkoutDir: string): string[] {
  const res = runGit(checkoutDir, ["rev-list", "--parents", "-n", "1", "HEAD"], 3000);
  if (res.code !== 0) return [];
  return res.stdout
    .trim()
    .split(/\s+/)
    .filter((s) => /^[0-9a-f]{7,40}$/i.test(s));
}

export function listWorkbenchRepos(
  workbenchRoot: string,
  excluded = new Set<string>(),
): string[] {
  if (!existsSync(workbenchRoot)) return [];
  const entries = readdirSync(workbenchRoot, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || excluded.has(entry.name)) continue;
    if (entry.name.endsWith(".worktrees")) continue;
    const full = join(workbenchRoot, entry.name);
    if (existsSync(join(full, ".git"))) {
      found.push(entry.name);
    }
  }
  return found.sort();
}
