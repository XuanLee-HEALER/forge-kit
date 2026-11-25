import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { runLangChecks } from "../lang-check";
import { runGit, runProcess, checkoutEnvironment } from "../git";
import { loadWorkbenchConfig } from "../config";
import { resolveTaskCheckout } from "./checkout";
import { cleanCheckout } from "./execution";
import type { Ledger } from "./store";

export function fatMerge(
  ledger: Ledger,
  repo: string,
  feature: string,
  fat: string,
  task?: string,
  cherryPick = false,
  noPush = false,
  verifyCmd?: string,
  beforePush?: (featureSha:string, targetSha:string, newSha:string) => void,
  transportDir?: string,
) {
  if (!repo || /[/\\]/.test(repo) || repo === "." || repo === "..") throw Error("Expected a repository name");
  const root = join(ledger.workbenchRoot, repo);
  if (dirname(realpathSync(root)) !== realpathSync(ledger.workbenchRoot))
    throw Error("Repository must be inside the workbench");
  function git(dir: string, args: string[]) {
    const result = runGit(dir, args, 120000);
    if (result.code) throw Error("git " + args[0] + " failed: " + result.stderr);
    return result.stdout.trim();
  }
  for (const branch of [feature, fat]) {
    if (!branch || branch.startsWith("-") || git(root, ["check-ref-format", "--branch", branch]) !== branch)
      throw Error("Invalid branch");
  }
  const protectedBranches = loadWorkbenchConfig(ledger.workbenchRoot).guard.protected_branches;
  if (feature === fat || ["main", "master", ...protectedBranches].includes(fat))
    throw Error("Invalid FAT destination");
  const tasks = ledger.findOpenTasksByRepoBranch(repo, feature).filter((t) => !task || t.task_id === task);
  if (tasks.length !== 1) throw Error("Expected an OPEN task attached to the feature branch");
  const task_id = tasks[0].task_id;
  const feat_sha = git(root, ["rev-parse", "--verify", "refs/heads/" + feature + "^{commit}"]);
  function ready() {
    const attachment = ledger.getTaskRepos(task_id).find((r) => r.repo === repo && r.branch === feature);
    if (
      !attachment ||
      ledger.getTask(task_id)?.status !== "OPEN" ||
      git(root, ["rev-parse", "--verify", "refs/heads/" + feature]) !== feat_sha
    )
      throw Error("Feature attachment changed");
    const checkout = resolveTaskCheckout(ledger.workbenchRoot, attachment);
    if (checkout.registered) cleanCheckout(checkout.dir);
    const check = ledger.checkPushReadiness({ task_id, repo, branch: feature, head_sha: feat_sha });
    if (!check.ready) throw Error("Feature verification incomplete: " + check.missing.join(", "));
    return attachment.base_sha;
  }
  const base = ready();
  if (
    cherryPick &&
    (!base ||
      !/^[a-f0-9]{40,64}$/i.test(base) ||
      runGit(root, ["merge-base", "--is-ancestor", base, feat_sha]).code)
  )
    throw Error("Cherry-pick requires the attached ancestor base");
  git(transportDir ?? root, ["fetch", "origin", "refs/heads/" + fat + ":refs/remotes/origin/" + fat]);
  const target = git(root, ["rev-parse", "--verify", "refs/remotes/origin/" + fat + "^{commit}"]);
  mkdirSync(root + ".worktrees", { recursive: true });
  const dir = join(root + ".worktrees", "fat-merge-" + Date.now() + "-" + crypto.randomUUID());
  try {
    git(root, ["worktree", "add", "--detach", dir, target]);
    const strategy = cherryPick ? "cherry-pick" : "merge";
    try {
      if (!cherryPick || base !== feat_sha)
        git(dir, cherryPick ? ["cherry-pick", base + ".." + feat_sha] : ["merge", "--no-edit", feat_sha]);
    } catch (e) {
      const conflicts = git(dir, ["diff", "--name-only", "--diff-filter=U"]);
      runGit(dir, [strategy, "--abort"]);
      throw Error(String(e) + (conflicts ? "\nConflicts: " + conflicts : ""));
    }
    const fat_sha = git(dir, ["rev-parse", "HEAD"]);
    if (git(dir, ["rev-parse", fat_sha + "^{tree}"]) !== git(dir, ["rev-parse", feat_sha + "^{tree}"])) {
      if (verifyCmd !== undefined) {
        if (!verifyCmd.trim()) throw Error("Expected a nonempty --verify-cmd");
        const check = runProcess(["sh", "-c", verifyCmd], {cwd: dir, env: checkoutEnvironment(), timeoutMs: 0});
        if (check.code !== 0) throw Error("FAT integration verification failed: " + (check.stderr || check.stdout).slice(-1000));
      } else {
        const report = runLangChecks({ targetDir: dir, mode: "all" });
        if (!report.detected_languages.length) throw Error("No integration checks detected. Pass --verify-cmd to verify the diverged integration.");
        const full = ledger.getTask(task_id)?.verification_depth === "full";
        const missingPhase = full && ["static", "dynamic"].some(phase =>
          !report.checks.some(check => check.phase === phase && check.status === "pass"));
        if (missingPhase || !report.ok) throw Error("FAT integration verification failed: " + JSON.stringify(report.checks));
      }
      cleanCheckout(dir);
      if (git(dir, ["rev-parse", "HEAD"]) !== fat_sha) throw Error("FAT integration HEAD changed during verification");
    }
    if (ready() !== base) throw Error("Feature base changed during integration");
    beforePush?.(feat_sha,target,fat_sha);
    if (!noPush) git(transportDir ?? dir, ["push", "--no-follow-tags", ...(beforePush ? ["--force-with-lease=refs/heads/"+fat+":"+target] : []), "origin", fat_sha + ":refs/heads/" + fat]);
    return {
      ok: true,
      repo,
      task_id,
      feature_branch: feature,
      feat_sha,
      fat_branch: fat,
      fat_sha,
      strategy,
      pushed: !noPush,
    };
  } finally {
    try {
      if (existsSync(join(dir, ".git"))) git(root, ["worktree", "remove", "--force", dir]);
    } finally {
      git(root, ["worktree", "prune"]);
    }
  }
}
