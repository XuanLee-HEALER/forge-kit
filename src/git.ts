import { existsSync, readdirSync, realpathSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
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

export function runProcess(
  argv: string[],
  opts?: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number },
): GitRunResult {
  try {
    const proc = Bun.spawnSync(argv, {
      cwd: opts?.cwd,
      env: opts?.env ?? process.env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: opts?.timeoutMs ?? 10_000,
    });
    return {
      code: proc.exitCode ?? 1,
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
    };
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

export function runGit(
  dir: string,
  args: string[],
  timeoutMs = 10_000,
): GitRunResult {
  return runProcess(["git", "-C", dir, ...args], { timeoutMs, env: checkoutEnvironment() });
}

/**
 * Locate git repo identity for any path, INCLUDING detached/external worktrees
 * (such as /tmp/fat-merge created via `git worktree add --detach` for FAT merge)
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

  // Verify the owning main repository belongs to this workbench (not the workbench root itself).
  const relMain = relative(canonicalRoot, mainCheckout);
  if (relMain === "" || relMain.startsWith("..")) {
    return null;
  }

  const repoName = basename(mainCheckout);
  const branch = lines[2];
  const headRes = runGit(top, ["rev-parse", "HEAD"], 3000);
  const headSha = headRes.code === 0 ? headRes.stdout.trim() : null;

  return {
    repo: repoName,
    repoRoot: mainCheckout,
    checkoutDir: top,
    worktree: top !== mainCheckout ? top : null,
    branch,
    headSha,
    isDetached: branch === "HEAD",
  };
}

/**
 * For a detached worktree (e.g. FAT merge commit), return HEAD and its direct parents
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
  excluded = new Set(["review-agents", ".workbench", ".codex", ".agents"]),
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

export function getCommitDiffStats(
  checkoutDir: string,
  commitRef: string,
): { files: string[]; changedLines: number } | null {
  const namesRes = runGit(checkoutDir, [
    "diff-tree",
    "--no-commit-id",
    "--name-only",
    "-r",
    "--root",
    commitRef,
  ]);
  if (namesRes.code !== 0) return null;
  const files = namesRes.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const numstatRes = runGit(checkoutDir, [
    "diff-tree",
    "--no-commit-id",
    "--numstat",
    "-r",
    "--root",
    commitRef,
  ]);
  if (numstatRes.code !== 0) return null;
  let changedLines = 0;
  for (const line of numstatRes.stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const add = Number(parts[0]);
    const del = Number(parts[1]);
    if (Number.isFinite(add)) changedLines += add;
    if (Number.isFinite(del)) changedLines += del;
  }
  return { files, changedLines };
}

/**
 * Compute aggregate diff stats of a branch/commit against the nearest base branch
 * (origin/<base> or <base>), falling back to single-commit diff when no distinct base exists.
 */
export function getBranchDiffStats(
  checkoutDir: string,
  commitRef: string,
  baseBranches: string[] = ["main", "master"],
): { files: string[]; changedLines: number } | null {
  const targetRes = runGit(checkoutDir, ["rev-parse", commitRef]);
  if (targetRes.code !== 0 || !targetRes.stdout.trim()) return null;
  const targetSha = targetRes.stdout.trim();

  const candidates: string[] = [];
  for (const b of baseBranches) {
    candidates.push(`origin/${b}`, b);
  }
  for (const base of candidates) {
    const baseRes = runGit(checkoutDir, ["rev-parse", "--verify", base]);
    if (baseRes.code !== 0 || !baseRes.stdout.trim()) continue;
    const mbRes = runGit(checkoutDir, ["merge-base", base, targetSha]);
    if (mbRes.code !== 0 || !mbRes.stdout.trim()) continue;
    const mergeBase = mbRes.stdout.trim();
    if (mergeBase === targetSha) continue;

    const namesRes = runGit(checkoutDir, ["diff", "--name-only", `${mergeBase}..${targetSha}`]);
    const numstatRes = runGit(checkoutDir, ["diff", "--numstat", `${mergeBase}..${targetSha}`]);
    if (namesRes.code !== 0 || numstatRes.code !== 0) return null;
    const files = namesRes.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    let changedLines = 0;
    for (const line of numstatRes.stdout.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;
      const add = Number(parts[0]);
      const del = Number(parts[1]);
      if (Number.isFinite(add)) changedLines += add;
      if (Number.isFinite(del)) changedLines += del;
    }
    return { files, changedLines };
  }

  // Only fall back to single-commit diff when there is literally 1 commit in the repo (root commit).
  // If multiple commits exist without a resolvable base branch, fail closed (return null) so
  // multi-commit branches cannot smuggle earlier business code commits behind a trailing doc commit.
  const countRes = runGit(checkoutDir, ["rev-list", "--count", targetSha]);
  if (countRes.code === 0 && countRes.stdout.trim() === "1") {
    return getCommitDiffStats(checkoutDir, targetSha);
  }
  return null;
}

export function getStagedDiffStats(checkoutDir: string): {
  files: string[];
  changedLines: number;
} {
  const namesRes = runGit(checkoutDir, ["diff", "--cached", "--name-only"]);
  const files =
    namesRes.code === 0
      ? namesRes.stdout
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  const numstatRes = runGit(checkoutDir, ["diff", "--cached", "--numstat"]);
  let changedLines = 0;
  if (numstatRes.code === 0) {
    for (const line of numstatRes.stdout.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;
      const add = Number(parts[0]);
      const del = Number(parts[1]);
      if (Number.isFinite(add)) changedLines += add;
      if (Number.isFinite(del)) changedLines += del;
    }
  }
  return { files, changedLines };
}
