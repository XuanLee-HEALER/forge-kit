import { appendEventInTx } from "../src/ledger/transactions";
import { test, expect } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluatePreToolUse } from "../src/guard";
import { handleLedgerHook } from "../src/ledger-hook";
import { formatDbCred } from "../src/dbcred";
import {
  useReleaseFixture,
  root,
  ledger,
  cmd,
  rejects,
  feature,
  git,
  remote,
  merge,
  recordProd,
  verifyFeature,
  type Feature,
} from "./helpers/release";
useReleaseFixture();

function sync(f: Feature) {
  verifyFeature(f);
  cmd("pr-sync", f.task, "--repo", f.repo, "--branch", f.branch, "--pr", String(f.n));
}
function train(f: Feature, ...options: string[]) {
  sync(f);
  cmd("handoff", f.task, ...options);
  const id = cmd("release", "create", "--tasks", f.task, "--title", "fixture").release_id;
  cmd("release", "verify", id);
  return id;
}
function approve(book: string) {
  return handleLedgerHook(root, {
    hook_event_name: "UserPromptSubmit",
    session_id: "fixture",
    prompt: "批准 " + book,
  }).userPromptContext;
}

test("merged prod child requires a completed runbook and production scope pinned to its release", () => {
  const f = feature("web", 2),
    id = train(f);
  merge(f);
  expect(rejects("release", "complete", id)).toContain("COMPLETED runbook");
  const book = cmd("release", "runbook", id).runbook_id;
  approve(book);
  cmd("runbook", "complete", book);
  expect(rejects("release", "complete", id)).toContain("production delivery evidence");
  expect(ledger.getTask(f.task)?.status).toBe("HANDED_OFF");
  expect(
    rejects(
      "record",
      f.task,
      "--kind",
      "prod",
      "--status",
      "pass",
      "--summary",
      "wrong revision",
      "--repo",
      f.repo,
      "--branch",
      f.branch,
      "--sha",
      "a".repeat(40),
    ),
  ).toContain("HANDED_OFF");
  cmd(
    "record",
    f.task,
    "--kind",
    "prod",
    "--status",
    "pass",
    "--summary",
    "deployment confirmed",
    "--repo",
    f.repo,
    "--branch",
    f.branch,
    "--sha",
    f.head,
  );
  expect(cmd("release", "complete", id).status).toBe("COMPLETED");
}, 30000);

test("SQL release requires a runbook even for a PR child; stale approval cannot grant dbcred", () => {
  const f = feature("api", 1),
    sql = join(root, "migration.sql");
  writeFileSync(sql, "SELECT 1;");
  const id = train(f, "--sql", "live.db:" + sql);
  merge(f);
  expect(rejects("release", "complete", id)).toContain("COMPLETED runbook");
  const runbook = cmd("release", "runbook", id),
    book = runbook.runbook_id;
  mkdirSync(join(root, ".workbench/env"), { recursive: true });
  writeFileSync(
    join(root, ".workbench/env/environments.json"),
    JSON.stringify({ prod: { host: "live.db", rw: { user: "writer" } } }),
  );
  const credentials = () => formatDbCred(root, "prod", "rw", book, "fixture");
  const previous = process.env.FORGE_SESSION_ID;
  try {
    process.env.FORGE_SESSION_ID = "fixture";
    remote(f.n, { headRefOid: "a".repeat(40) });
    expect(approve(book)).toContain("未生效");
    expect(ledger.getRunbook(book)?.status).toBe("PENDING");
    expect(() => credentials()).toThrow();
    remote(f.n, { headRefOid: f.head });
    approve(book);
    expect(credentials()).toBe("writer:");
  } finally {
    if (previous === undefined) delete process.env.FORGE_SESSION_ID;
    else process.env.FORGE_SESSION_ID = previous;
  }
  recordProd(f, runbook);
  cmd("runbook", "complete", book);
  expect(cmd("release", "complete", id).status).toBe("COMPLETED");
}, 30000);

test("local branch drift blocks approval, verification and close; deleted merged branch uses pinned non-default base", () => {
  const f = feature("api", 1);
  const file = join(f.wt, "example.test.ts");
  writeFileSync(file, 'import {test,expect} from "bun:test"; test("release contract",()=>expect(1).toBe(1))');
  git(f.wt, "commit", "-am", "release contract");
  f.head = git(f.wt, "rev-parse", "HEAD");
  const spec = join(root, ".workbench/specs", f.task);
  mkdirSync(spec, { recursive: true });
  for (const name of ["ssot.md", "tech-spec.md", "test-spec.md"]) writeFileSync(join(spec, name), "spec");
  const freeze = ledger.freezeSpec({ task_id: f.task, locked_test_globs: ["example.test.ts"] });
  const legacy = JSON.parse(freeze.event.payload_json);
  for (const k of [
    "locked_test_files",
    "locked_test_revisions",
    "locked_test_modes",
    "locked_test_blobs",
    "tracked_locked_tests",
  ])
    legacy[k] = Object.fromEntries(Object.entries(legacy[k]).map(([key, value]) => ["./" + key, value]));
  appendEventInTx(ledger.db, { task_id: f.task, event_type: "SPEC_FROZEN", actor: "agent", payload: legacy });
  expect(ledger.getSpecState(f.task).drift_detected).toBe(false);
  remote(f.n, { baseRefName: "release/1.x", headRefOid: f.head });
  const id = train(f),
    book = cmd("release", "runbook", id).runbook_id;
  const original = readFileSync(file, "utf8");
  writeFileSync(file, "changed");
  expect(approve(book)).toContain("drift");
  writeFileSync(file, original);
  git(f.wt, "commit", "--allow-empty", "-m", "followup");
  expect(approve(book)).toContain("Local branch drift");
  expect(rejects("release", "verify", id)).toContain("STALE_PR");
  git(f.wt, "reset", "--hard", f.head);
  cmd("release", "verify", id);
  const replacement = cmd("release", "runbook", id).runbook_id;
  approve(replacement);
  cmd("runbook", "complete", replacement);
  git(f.dir, "update-ref", "refs/remotes/origin/release/1.x", f.head);
  remote(f.n, { state: "MERGED" });
  git(f.wt, "commit", "--allow-empty", "-m", "undelivered");
  expect(rejects("release", "complete", id)).toContain("Local branch drift");
  expect(ledger.getTask(f.task)?.status).toBe("HANDED_OFF");
  git(f.dir, "worktree", "remove", f.wt);
  git(f.dir, "branch", "-D", f.branch);
  expect(cmd("release", "verify", id).items[0].status).toBe("MERGED");
  expect(cmd("release", "complete", id).status).toBe("COMPLETED");
}, 30000);

test("canonical and legacy repo spellings share one owner across attachment and guard", () => {
  writeFileSync(join(root, ".workbench/workbench.yaml"), "name: fixture\nrepos:\n  - ./services/api/\n");
  const f = feature("services/api", 1);
  symlinkSync(f.dir, join(root, "api-link"));
  ledger.db.query("UPDATE task_repos SET repo='api-link' WHERE task_id=?").run(f.task);
  ledger.db.exec(
    "INSERT INTO task_repos SELECT './services/api/',branch,worktree,task_id,base_sha,head_sha,attached_at FROM task_repos WHERE repo='api-link'",
  );
  expect(ledger.getTaskRepos(f.task).map((r) => r.repo)).toEqual(["services/api"]);
  ledger.db.exec("UPDATE task_repos SET base_sha=head_sha WHERE repo='api-link'");
  expect(() => ledger.attachRepo({ task_id: f.task, repo: "services/api", branch: f.branch })).toThrow(
    "Conflicting legacy attachment baselines",
  );
  ledger.db.query("UPDATE task_repos SET base_sha=? WHERE repo='api-link'").run(f.base);
  ledger.attachRepo({ task_id: f.task, repo: "api-link", branch: f.branch });
  expect(ledger.db.query("SELECT repo FROM task_repos WHERE task_id=?").all(f.task)).toEqual([
    { repo: "services/api" },
  ]);
  ledger.db.query("UPDATE task_repos SET repo='api-link' WHERE task_id=?").run(f.task);
  train(f);
  expect(() =>
    ledger.openTask({
      task_id: "duplicate",
      title: "other",
      repo: "./services/api",
      branch: f.branch,
      endpoint: "pr",
      depth: "targeted",
    }),
  ).toThrow("owned");
  expect(cmd("status", "--repo", "services/api/", "--branch", f.branch).tasks[0].task_id).toBe(f.task);
  expect(
    evaluatePreToolUse(root, {
      hook_event_name: "PreToolUse",
      cwd: f.dir,
      tool_name: "Bash",
      tool_input: { command: "git push origin --delete " + f.branch },
    }),
  ).toContain("resume");
}, 30000);

test("SQL on one of two verified branches is bound to its owning checkout", () => {
  const a = feature("api", 2),
    b = feature("api", 3);
  ledger.cancelTask({ task_id: b.task, reason: "combine branches" });
  ledger.attachRepo({
    task_id: a.task,
    repo: b.repo,
    branch: b.branch,
    worktree: b.wt,
    base_sha: b.base,
    head_sha: b.head,
  });
  const sql = join(a.wt, "only-a.sql");
  writeFileSync(sql, "SELECT 2;");
  git(a.wt, "add", "only-a.sql");
  git(a.wt, "commit", "-m", "migration");
  a.head = git(a.wt, "rev-parse", "HEAD");
  remote(a.n, { headRefOid: a.head });
  sync(a);
  sync({ ...b, task: a.task });
  const sibling = feature("web", 5);
  expect(rejects("handoff", a.task, "--sql", "live.db:" + join(sibling.wt, "tracked.sql"))).toContain(
    "unattached checkout",
  );
  writeFileSync(sql, "SELECT 3;");
  expect(rejects("handoff", a.task, "--sql", "live.db:" + sql)).toContain("differs from verified commit");
  writeFileSync(sql, "SELECT 2;");
  expect(cmd("handoff", a.task, "--sql", "live.db:" + sql).items).toHaveLength(2);
  const id = cmd("release", "create", "--tasks", a.task, "--title", "two branches").release_id;
  cmd("release", "verify", id);
  for (const tag of [a.repo + ":v1:" + a.base, "web:v1:" + a.head])
    expect(rejects("release", "runbook", id, "--tag", tag)).toContain("actions do not match");
  const book = cmd("release", "runbook", id, "--tag", a.repo + ":v1:" + a.head);
  approve(book.runbook_id);
  for (const { action_id } of book.execution_actions) {
    expect(
      rejects(
        "record",
        a.task,
        "--kind",
        "prod",
        "--status",
        "pass",
        "--summary",
        "wrong branch",
        "--repo",
        b.repo,
        "--branch",
        b.branch,
        "--sha",
        b.head,
        "--meta",
        JSON.stringify({ runbook_id: book.runbook_id, action_id }),
      ),
    ).toContain("match an approved");
  }
  expect(rejects("runbook", "complete", book.runbook_id)).toContain("execution receipt");
  recordProd(a, book);
  recordProd(a);
  cmd("runbook", "complete", book.runbook_id);
  merge(a);
  merge(b);
  expect(rejects("release", "complete", id)).toContain(b.head);
  recordProd({ ...b, task: a.task });
  expect(cmd("release", "complete", id).status).toBe("COMPLETED");
}, 30000);

test("slow local Git fails approval within the hook budget", () => {
  const f = feature("api", 1),
    id = train(f);
  const book = cmd("release", "runbook", id).runbook_id;
  writeFileSync(join(root, "bin/git"), "#!/bin/sh\nexec sleep 15\n", { mode: 0o755 });
  const start = Date.now();
  expect(approve(book)).toContain("未生效");
  expect(Date.now() - start).toBeLessThan(6500);
  expect(ledger.getRunbook(book)?.status).toBe("PENDING");
}, 30000);
