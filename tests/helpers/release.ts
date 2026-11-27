import { beforeEach, afterEach, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { Ledger } from "../../src/ledger";
import { runGit } from "../../src/git";
import { isolateHome } from "./hermetic";
export let root: string, ledger: Ledger;
let bin: string, savedPath: string;
export function useReleaseFixture() {
  isolateHome();
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "release-train-"));
    bin = join(root, "bin");
    mkdirSync(bin);
    mkdirSync(join(root, ".workbench"));
    writeFileSync(join(root, ".workbench/workbench.yaml"), "name: fixture\nrepos:\n  - api\n  - web\n");
    savedPath = process.env.PATH!;
    process.env.PATH = bin + ":" + savedPath;
    writeFileSync(
      join(bin, "gh"),
      `#!/usr/bin/env bun
import {Database} from "bun:sqlite";
const [group,cmd,key]=process.argv.slice(2);
if(group==="pr" && cmd==="list") console.log("[]");
else if(group==="pr" && cmd==="view"){
  const probe=${JSON.stringify(join(root, "probe"))};
  if(await Bun.file(probe).exists()){
    const db=new Database(await Bun.file(probe).text());
    db.exec("PRAGMA busy_timeout=100; BEGIN IMMEDIATE; COMMIT");
    db.close();
  }
  const n=key.split("/").pop();console.log(await Bun.file(${JSON.stringify(root)}+"/pr-"+n).text());
} else process.exit(1);`,
      { mode: 0o755 },
    );
    const tsc=require.resolve("typescript/bin/tsc");
    writeFileSync(join(bin,"tsc"),"#!/usr/bin/env bun\nimport "+JSON.stringify(tsc)+";\n",{mode:0o755});
    ledger = new Ledger(root);
  });
  afterEach(() => {
    ledger.closeDb();
    process.env.PATH = savedPath;
    rmSync(root, { recursive: true, force: true });
  });
}

function cli(name: string, args: string[], ok = true) {
  const p = Bun.spawnSync([process.execPath, join(import.meta.dir, "../../src/bin/cli.ts"), name, ...args], {
    cwd: root,
    env: { ...process.env, FORGE_WORKBENCH_ROOT: root },
  });
  const output = p.stdout.toString() + p.stderr.toString();
  expect(p.exitCode, output).toBe(ok ? 0 : 1);
  return ok ? JSON.parse(p.stdout.toString()) : output;
}
export const cmd = (...args: string[]) => cli("ledger", args);
export const rejects = (...args: string[]) => cli("ledger", args, false);
export function git(dir: string, ...args: string[]) {
  const r = runGit(dir, args);
  expect(r.code, r.stderr).toBe(0);
  return r.stdout.trim();
}
export function remote(n: number, patch: Record<string, unknown>) {
  const path = join(root, "pr-" + n);
  writeFileSync(
    path,
    JSON.stringify({ ...(existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}), ...patch }),
  );
}
export function feature(repo: string, n: number, workflow_version: "0.4" | "0.5" = "0.5") {
  const dir = join(root, repo),
    bare = join(root, repo + ".git"),
    branch = "feature/" + n,
    task = "task-" + n;
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-b", "main");
    git(dir, "config", "user.name", "Dev");
    git(dir, "config", "user.email", "dev@example.org");
    writeFileSync(
      join(dir, "example.test.ts"),
      'import {test,expect} from "bun:test";test("value",()=>expect(2+2).toBe(4));',
    );
    writeFileSync(join(dir,"value.js"),"export const value = 2 + 2;\n");
    writeFileSync(join(dir, "tracked.sql"), "SELECT 1;");
    git(dir, "add", ".");
    git(dir, "commit", "-m", "base");
    git(dir, "init", "--bare", "-b", "main", bare);
    git(dir, "remote", "add", "origin", "https://github.com/acme/" + basename(repo) + ".git");
    git(dir, "remote", "set-url", "--push", "origin", bare);
    git(dir, "push", "origin", "main");
    git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  }
  const wt = join(root, repo + ".worktrees", String(n));
  git(dir, "worktree", "add", "-b", branch, wt, "main");
  const base = git(wt, "rev-parse", "HEAD");
  const path = `src/feature-${n}.ts`;
  mkdirSync(join(wt, "src"), { recursive: true });
  writeFileSync(join(wt, path), `export const feature = ${n};\n`);
  git(wt, "add", "--", path);
  git(wt, "commit", "-m", "feature", "--", path);
  const head = git(wt, "rev-parse", "HEAD"),
    url = "https://github.com/acme/" + basename(repo) + "/pull/" + n;
  ledger.openTask({
    workflow_version,
    task_id: task,
    title: task,
    repo,
    branch,
    worktree: wt,
    endpoint: n === 2 ? "prod" : "pr",
    depth: "targeted",
    base_sha: base,
    head_sha: head,
  });
  remote(n, {
    url,
    state: "OPEN",
    headRefName: branch,
    baseRefName: "main",
    headRefOid: head,
    isCrossRepository: false,
    headRepository: { name: basename(repo) },
    headRepositoryOwner: { login: "acme" },
  });
  return { repo, n, task, branch, wt, dir, head, base, url };
}
export type Feature = ReturnType<typeof feature>;
export function verifyFeature(f: Feature, { review = true }: { review?: boolean | "historical" } = {}) {
  if (ledger.getSpecState(f.task).state!=="FROZEN") {
    const spec=join(root,".workbench/specs",f.task);
    mkdirSync(spec,{recursive:true});
    writeFileSync(join(spec,"scope.md"),"The local release fixture changes the feature branch. Existing baseline tests cover arithmetic; verify target and review receipt.");
    ledger.freezeSpec({task_id:f.task});
  }
  const target = ["--task", f.task, "--cwd", f.wt];
  cli("verify",[...target,"--kind","lint","--","tsc","--noEmit","--allowJs","--checkJs","--skipLibCheck","value.js"]);
  cli("verify", [...target, "--kind", "test", "--", process.execPath, "test", "./example.test.ts"]);
  if (!review) return;
  if (review === "historical") {
    const spec = ledger.getSpecState(f.task);
    ledger.recordEvidence({task_id: f.task, repo: f.repo, branch: f.branch, sha: f.head,
      kind: "review", status: "pass", source: "tool", summary: "Historical release review",
      meta: {role: "quality", base: f.base, head: f.head, freeze_seq: spec.freeze_seq,
        review_task_id: f.task, review_floor_seq: spec.evidence_floor_seq.review}});
    return;
  }
  const report = join(root, f.task + "-quality.md");
  writeFileSync(report, "Reviewed the fixed release range. No blockers.\n");
  cmd("review-record", f.task, "--repo", f.repo, "--branch", f.branch, "--role", "quality", "--base", f.base, "--head", f.head,
    "--status", "pass", "--summary", "Reviewed release", "--report", report,
    "--session-id", "release-review-fixture", "--model", "fixture-model", "--effort", "medium");
}
export function merge(f: Feature) {
  git(f.dir, "merge", "--no-edit", f.branch);
  git(f.dir, "push", "origin", "main");
  remote(f.n, { state: "MERGED" });
}

export function recordProd(f: Feature, book?: { runbook_id: string; execution_actions: { action_id: string }[] }) {
  const args = [
    "record",
    f.task,
    "--kind",
    "prod",
    "--status",
    "pass",
    "--repo",
    f.repo,
    "--branch",
    f.branch,
    "--sha",
    f.head,
  ];
  if (book)
    for (const { action_id } of book.execution_actions)
      cmd(
        ...args,
        "--summary",
        "action executed",
        "--meta",
        JSON.stringify({ runbook_id: book.runbook_id, action_id }),
      );
  else cmd(...args, "--summary", "deployment confirmed");
}
