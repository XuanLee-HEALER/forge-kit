import { canonicalRepoPath } from "../config";
import { realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { locateRepo, runGit } from "../git";
import { getCanonicalGitCommonDir } from "../shared/git-cmd";
import { resolveTaskCheckout } from "./checkout";
import { getSpecState } from "./spec";
import type { Ledger } from "./store";

export const targetOptions = {
  task: { type: "string" },
  repo: { type: "string" },
  cwd: { type: "string" },
} as const;
type Target = { task?: string; repo?: string; cwd?: string };

export function cleanCheckout(dir: string) {
  const status = runGit(dir, ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"]);
  if (status.code || status.stdout)
    throw Error(
      "Working tree has uncommitted changes; commit before running the executor so evidence binds to a verified commit SHA",
    );
}

export function executionSnapshot(ledger: Ledger, target: Target) {
  const root = ledger.workbenchRoot;
  if (target.repo) target = {...target, repo:canonicalRepoPath(root,target.repo)};
  let dir = target.cwd ?? process.cwd();
  if (!target.cwd && (target.task || target.repo)) {
    const tasks = target.task ? [target.task] : ledger.listOpenTasks().map((t) => t.task_id);
    const attachments = tasks
      .flatMap((id) => ledger.getTaskRepos(id))
      .filter((r) => !target.repo || r.repo === target.repo);
    if (attachments.length === 1) dir = resolveTaskCheckout(root, attachments[0]).dir;
    else {
      const invoking = locateRepo(root, dir);
      if (target.repo && invoking?.repo !== target.repo) {
        if (basename(target.repo) !== target.repo || [".", ".."].includes(target.repo)) throw Error("Expected a repository name");
        dir = join(root, target.repo);
      } else if (!invoking) throw Error("Specify --cwd to select the attached checkout");
    }
  }
  const loc = locateRepo(root, dir);
  if (
    !loc?.headSha ||
    (target.repo && target.repo !== loc.repo) ||
    realpathSync(join(root, loc.repo)) !== loc.repoRoot
  )
    throw Error("Expected a checkout of the target workbench repository");
  const common = getCanonicalGitCommonDir(loc.repoRoot);
  if (!common || common !== getCanonicalGitCommonDir(loc.checkoutDir))
    throw Error("Checkout belongs to a different repository");
  const { repo, headSha: head, checkoutDir } = loc;
  const tasks = loc.isDetached
    ? ledger.findOpenTasksByRepoCommits(repo, [head])
    : ledger.findOpenTasksByRepoBranch(repo, loc.branch);
  const candidates = tasks.filter((t) => !target.task || t.task_id === target.task);
  if (candidates.length !== 1) throw Error("Expected one matching OPEN task; check --task and --cwd");
  const task_id = candidates[0].task_id;
  const rows = ledger
    .getTaskRepos(task_id)
    .filter((r) => r.repo === repo && (loc.isDetached ? r.head_sha === head : r.branch === loc.branch));
  if (rows.length !== 1) throw Error("Cannot identify a unique task attachment");
  const attachment = rows[0];
  resolveTaskCheckout(root, attachment);
  cleanCheckout(checkoutDir);
  const spec = getSpecState(ledger, task_id, { delivery: { repo, head_sha: head, checkoutDir } });
  if (spec.drift_detected || spec.state === "AMENDED")
    throw Error("Frozen specification or tests changed; restore or refreeze before verification");
  return {
    task_id,
    repo,
    head,
    dir: checkoutDir,
    branch: attachment.branch,
    detached: loc.isDetached,
    base: attachment.base_sha,
    freeze_seq: spec.freeze_seq,
    floors: spec.evidence_floor_seq,
  };
}

export function recheckExecution(ledger: Ledger, snapshot: ReturnType<typeof executionSnapshot>) {
  const current = executionSnapshot(ledger, { task: snapshot.task_id, repo: snapshot.repo, cwd: snapshot.dir });
  if (JSON.stringify(current) !== JSON.stringify(snapshot))
    throw Error("Task, checkout, HEAD or evidence floor changed during execution");
}
