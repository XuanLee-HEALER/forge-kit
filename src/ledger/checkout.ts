import { getCanonicalGitCommonDir, getGitTopLevel } from "../shared/git-cmd";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { runGit } from "../git";
import type { TaskRepoRecord } from "./types";

function verifyRoot(dir: string) {
  if (!existsSync(join(dir, ".git")) || getGitTopLevel(dir) !== realpathSync(dir))
    throw new Error("Cannot verify Git top level: " + dir);
}

function verifyWorktree(primary: string, worktree: string) {
  verifyRoot(worktree);
  if (realpathSync(primary) === realpathSync(worktree)) return;
  const common = getCanonicalGitCommonDir(primary);
  if (!common || common !== getCanonicalGitCommonDir(worktree))
    throw new Error("Worktree belongs to a different repository: " + worktree);
}

export function resolveTaskCheckout(workbenchRoot: string, attachment: Pick<TaskRepoRecord, "repo" | "branch" | "worktree">, allowAbsent = false) {
  const hasWorktree = attachment.worktree && existsSync(attachment.worktree);
  let dir = hasWorktree ? attachment.worktree! : join(workbenchRoot, attachment.repo);
  if (attachment.worktree && !hasWorktree && !existsSync(join(dir, ".git"))) {
    throw new Error("Cannot locate the attached Git repository " + attachment.repo);
  }
  const primary = join(workbenchRoot, attachment.repo);
  if (allowAbsent && !attachment.worktree && !existsSync(primary)) return { dir, registered: false, missingWorktree: false };
  verifyRoot(primary);
  if (hasWorktree) verifyWorktree(primary, dir);
  const registry = primary;
  for (const candidate of new Set([dir, primary])) {
    if (!existsSync(join(candidate, ".git"))) continue;
    const ref = runGit(candidate, ["symbolic-ref", "--quiet", "HEAD"]);
    if (ref.code || ref.stdout.replace(/\n$/, "") !== "refs/heads/" + attachment.branch) continue;
    const top = getGitTopLevel(candidate);
    if (!top) throw new Error("Cannot locate working tree for " + attachment.repo);
    verifyWorktree(primary, top);
    return { dir: top, registered: true, missingWorktree: false };
  }
  let found = false;
  if (existsSync(join(registry, ".git"))) {
    const listing = runGit(registry, ["worktree", "list", "--porcelain", "-z"]);
    if (listing.code) throw new Error("Cannot inspect worktrees for " + attachment.repo);
    for (const record of listing.stdout.split("\0\0")) {
      const fields = record.split("\0");
      if (fields.includes("branch refs/heads/" + attachment.branch) && fields[0].startsWith("worktree ")) {
        dir = fields[0].slice("worktree ".length);
        if (!existsSync(join(dir, ".git"))) throw new Error("Registered worktree is unavailable: " + dir);
        verifyWorktree(primary, dir);
        found = true;
        break;
      }
    }
  }
  return { dir, registered: found, missingWorktree: !found && existsSync(join(registry, ".git")) };
}

export function prRemoteRefs(dir: string, branch: string): string[] {
  const prefix = "refs/remotes/origin/";
  const target = runGit(dir, ["symbolic-ref", "--quiet", prefix + "HEAD"]).stdout.trim();
  return [prefix + branch, ...(target.startsWith(prefix) ? [target] : [prefix + "main", prefix + "master"])];
}

export function reachableFromRefs(dir: string, sha: string, refs: string[]): boolean {
  if (!refs.length || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sha)) return false;
  const result = runGit(dir, ["for-each-ref", "--format=%(refname)", "--contains", sha + "^{commit}", ...refs]);
  return result.code === 0 && result.stdout.split(/\r?\n/).some(ref => refs.includes(ref));
}
