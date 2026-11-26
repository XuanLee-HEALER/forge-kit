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
  ledger.openTask({ workflow_version: "0.4",
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

for (const scenario of ["merge", "full-static-only", "same-tree", "no-checks", "failed-command", "cherry-pick", "conflict", "broken-integration", "go-dry-run", "go-saved-flags", "go-script", "npm-usage", "npmrc-usage", "unverified", "no-push", "no-push-verified"]) {
  test("fat-merge " + scenario + " checks evidence and cleans temporary worktrees", () => {
    const repo = join(wb, "demo"), origin = join(wb, "remote.git");
    function git(...args: string[]) {
      const result = runGit(repo,args);
      expect(result.code,result.stderr).toBe(0);
      return result.stdout.trim();
    }
    git("init","--bare",origin); git("remote","add","origin",origin);
    git("switch","-c","fat");
    if (scenario === "same-tree") git("merge","--ff-only","feat/wip");
    else writeFileSync(join(repo,scenario === "conflict" ? "wip.txt" : "fat.txt"),"integration\n");
    if (scenario === "npmrc-usage") writeFileSync(join(repo,".npmrc"), "usage=true\n");
    if (scenario === "npm-usage" || scenario === "npmrc-usage") writeFileSync(join(repo,"package.json"), JSON.stringify({scripts:{test:"exit 1"}}));
    if (scenario === "full-static-only") writeFileSync(join(repo,"app.py"), "value = 1\n");
    const goEnv = join(wb, "go-env");
    if (scenario === "go-script") {
      mkdirSync(join(repo, "service"));
      writeFileSync(join(repo, "service/go.mod"), "module example\n");
      writeFileSync(join(repo, "package.json"), JSON.stringify({scripts:{test:"cd service && go test ./..."}}));
    }
    if (scenario === "go-saved-flags" || scenario === "go-script") {
      writeFileSync(goEnv, "GOFLAGS='-n'\n");
      writeFileSync(join(wb, "go"), "#!/bin/sh\nif [ \"$1\" = env ]; then sed -n 's/^GOFLAGS=//p' \"$GOENV\"; else case \"${GOFLAGS:--n}\" in *-n*) exit 0;; *) exit 1;; esac; fi\n", {mode: 0o755});
    }
    if (scenario === "go-dry-run" || scenario === "go-saved-flags") writeFileSync(join(repo,"go.mod"), "module example\n\ngo 1.22\n");
    if (scenario === "broken-integration") {
      writeFileSync(join(repo,"package.json"),"{}");writeFileSync(join(repo,"bunfig.toml"),"");
      writeFileSync(join(repo,"fat.test.ts"),'import {test,expect} from "bun:test";test("compatible",()=>expect(Bun.file("wip.txt").size).toBe(0));');
    }
    git("add","."); git("commit","--allow-empty","-m","FAT changes"); git("push","origin","fat");
    const previous = git("rev-parse","fat"), head = git("rev-parse","feat/wip");
    const ledger = new Ledger(wb);
    try {
      ledger.openTask({ workflow_version: "0.4",task_id:"integrate",repo:"demo",branch:"feat/wip",head_sha:head,base_sha:git("rev-parse","main"),title:"integration",endpoint:"fat",depth:scenario === "full-static-only" ? "full" : "targeted"});
      if (scenario !== "unverified") ledger.recordEvidence({task_id:"integrate",repo:"demo",sha:head,kind:"test",source:"tool",status:"pass",summary:"pass"});
      if (scenario === "full-static-only") {
        ledger.recordEvidence({task_id:"integrate",repo:"demo",sha:head,kind:"lint",source:"tool",status:"pass",summary:"feature lint"});
        ledger.recordEvidence({task_id:"integrate",repo:"demo",sha:head,kind:"review",source:"tool",status:"pass",summary:"feature review",meta:{role:"quality",base:git("rev-parse","main")}});
      }
      const args = scenario === "cherry-pick" ? ["--cherry-pick"] : scenario.startsWith("no-push") ? ["--no-push"] : [];
      if (["merge", "cherry-pick", "no-push-verified"].includes(scenario)) args.push("--verify-cmd", "test -f fat.txt && test -f wip.txt");
      if (scenario === "failed-command") args.push("--verify-cmd", "test ! -f wip.txt");
      const cli = Bun.spawnSync([process.execPath,join(import.meta.dir,"../src/bin/cli.ts"),"git","fat-merge","demo","feat/wip",...args],
        {cwd:wb,env:{...process.env,...(scenario === "go-dry-run" && {GOFLAGS:"-n"}),...((scenario === "go-saved-flags" || scenario === "go-script") && {GOENV:goEnv, GOFLAGS:"", PATH:wb+":"+process.env.PATH}),...(scenario === "npm-usage" && {npm_config_usage:"true"}),FORGE_WORKBENCH_ROOT:wb}});
      expect(git("worktree","list","--porcelain")).not.toContain("fat-merge-");
      const remote = git("--git-dir="+origin,"rev-parse","refs/heads/fat");
      if (["no-push","full-static-only","no-checks","failed-command","unverified","conflict","broken-integration","go-dry-run","go-saved-flags","go-script","npm-usage","npmrc-usage"].includes(scenario)) {
        expect(cli.exitCode).toBe(1);
        expect(cli.stderr.toString()).toContain(["no-checks","no-push"].includes(scenario) ? "--verify-cmd" : scenario === "conflict" ? "wip.txt" : scenario !== "unverified" ? "integration verification failed" : "verification incomplete");
        expect(remote).toBe(previous);
      } else {
        expect(cli.exitCode,cli.stderr.toString()).toBe(0);
        const result = JSON.parse(cli.stdout.toString());
        expect(result).toMatchObject({ok:true,feat_sha:head,task_id:"integrate",pushed:!scenario.startsWith("no-push")});
        expect(remote).toBe(scenario.startsWith("no-push") ? previous : result.fat_sha);
        expect(git("show",result.fat_sha+":wip.txt")).toBe("wip");
      }
      expect(ledger.getTaskEvents("integrate").some(e=>JSON.parse(e.payload_json).kind==="fat")).toBe(false);
    } finally {ledger.closeDb();}
  });
}
