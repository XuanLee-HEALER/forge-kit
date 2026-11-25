import { isolateHome } from "./helpers/hermetic";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "../src/git";
import { Ledger } from "../src/ledger";
import { collectGitFacts, sweepMergedBranches } from "../src/wb-git";

isolateHome();

let wb: string;

beforeEach(() => {
  wb = mkdtempSync(join(tmpdir(), "forge-wbgit-test-"));
  mkdirSync(join(wb, ".workbench"), { recursive: true });
  writeFileSync(join(wb, ".workbench", "workbench.yaml"), 'name: "git-wb"\nrepos:\n  - demo\n');

  const repo = join(wb, "demo");
  mkdirSync(repo, { recursive: true });
  runGit(repo, ["init", "-b", "main"]);
  runGit(repo, ["config", "user.email", "dev@example.com"]);
  runGit(repo, ["config", "user.name", "Dev"]);
  writeFileSync(join(repo, "f.txt"), "base\n");
  runGit(repo, ["add", "f.txt"]);
  runGit(repo, ["commit", "-m", "chore: base"]);

  mkdirSync(join(wb, "demo.worktrees"), { recursive: true });

  // 1. Merged branch with NO open task -> should be swept
  const wtDone = join(wb, "demo.worktrees", "done-branch");
  runGit(repo, ["worktree", "add", "-b", "feat/done", wtDone, "main"]);

  // 2. Freshly branched clean worktree OWNED BY AN OPEN TASK -> MUST BE PROTECTED!
  const wtActive = join(wb, "demo.worktrees", "active-fresh");
  runGit(repo, ["worktree", "add", "-b", "feat/active-fresh", wtActive, "main"]);
  const ledger = new Ledger(wb);
  ledger.openTask({
    task_id: "20261121-fresh",
    title: "Just claimed task",
    endpoint: "local",
    depth: "targeted",
    repo: "demo",
    branch: "feat/active-fresh",
    worktree: wtActive,
  });
  ledger.closeDb();

  // 3. Unmerged branch with new commit -> kept
  runGit(repo, ["checkout", "-b", "feat/wip"]);
  writeFileSync(join(repo, "wip.txt"), "wip\n");
  runGit(repo, ["add", "wip.txt"]);
  runGit(repo, ["commit", "-m", "feat: wip"]);
  runGit(repo, ["checkout", "main"]);
});

afterEach(() => {
  rmSync(wb, { recursive: true, force: true });
});

describe("wb-git status & sweep", () => {
  test("sweeps completed merged worktree while protecting fresh clean worktree owned by OPEN ledger task", () => {
    const facts = collectGitFacts(wb);
    expect(facts.repos.length).toBe(1);
    expect(facts.repos[0].worktrees.length).toBe(2);

    const applied = sweepMergedBranches(wb, { apply: true, fetch: false });
    expect(applied.deletedLocal.map((d) => d.branch)).toEqual(["feat/done"]);
    expect(applied.skippedOpenTasks).toContain("demo:feat/active-fresh");

    expect(existsSync(join(wb, "demo.worktrees", "done-branch"))).toBe(false);
    expect(existsSync(join(wb, "demo.worktrees", "active-fresh"))).toBe(true);

    const branches = runGit(join(wb, "demo"), ["branch", "--list"]).stdout;
    expect(branches).toContain("feat/wip");
    expect(branches).toContain("feat/active-fresh");
    expect(branches).not.toContain("feat/done");

    const log = readFileSync(join(wb, ".workbench", "sweep-log.jsonl"), "utf8");
    expect(log).toContain("feat/done");
  });

  test("empty repos list in workbench.yaml never auto-sweeps unregistered repos", () => {
    writeFileSync(join(wb, ".workbench", "workbench.yaml"), 'name: "empty-wb"\nrepos: []\n');
    const facts = collectGitFacts(wb);
    expect(facts.repos.length).toBe(0);
    const applied = sweepMergedBranches(wb, { apply: true, fetch: false });
    expect(applied.deletedLocal.length).toBe(0);
    expect(existsSync(join(wb, "demo.worktrees", "done-branch"))).toBe(true);
  });
});
