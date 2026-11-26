import { appendEventInTx } from "../src/ledger/transactions";
import { test, expect } from "bun:test";
import { mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
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

for (const version of ["0.4", "0.5"] as const) test(`v${version} merged prod child requires a completed runbook and production scope pinned to its release`, () => {
  const f = feature("web", 2, version);
  if (version === "0.4") {
    const dir = join(root, ".workbench/specs", f.task);
    mkdirSync(dir, {recursive: true});
    for (const name of ["ssot.md", "tech-spec.md", "test-spec.md"]) writeFileSync(join(dir, name), "legacy release scope");
    ledger.freezeSpec({task_id: f.task});
    // A newer installation's observer policy does not reclassify a historical task.
    writeFileSync(join(root, ".workbench/workbench.yaml"), [
      "repos: [web]", "extensions:", "  actions:",
      '    send: {purpose: deliver, argv: [bun, --version], inputs: []}',
      '    lookup: {purpose: observe, argv: [bun, --help], inputs: []}',
      "  stages: {publish: {action: send, observe: lookup}}",
      "  delivery: {endpoint: prod, stages: [publish]}",
    ].join("\n"));
  }
  const id = train(f);
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
    expect(ledger.getRunbook(book)?.status).toBe("APPROVED");
    expect(credentials).toThrow(/authorized ship executor/);
  } finally {
    if (previous === undefined) delete process.env.FORGE_SESSION_ID;
    else process.env.FORGE_SESSION_ID = previous;
  }
  recordProd(f, runbook);
  cmd("runbook", "complete", book);
  expect(cmd("release", "complete", id).status).toBe("COMPLETED");
}, 30000);

test("release refuses previously handed-off v0.5 PRs pinned to staging", () => {
  const f = feature("api", 1);
  sync(f);
  const handoff = cmd("handoff", f.task);
  // Reproduce the durable snapshot an earlier v0.5 installer accepted.
  const items = handoff.items.map((item: object) => ({ ...item, base_branch: "staging" }));
  const snapshot = {items, sql_files: [], sql_owners: [], rollback_plan: null};
  const event = appendEventInTx(ledger.db, {task_id: f.task, event_type:"HANDOFF_RECORDED", actor:"agent", payload:snapshot});
  ledger.db.query("UPDATE task_handoffs SET ledger_tip=?,items_json=? WHERE task_id=?")
    .run(f.task + "@" + event.entry_hash, JSON.stringify(items), f.task);
  remote(f.n, {baseRefName:"staging", state:"MERGED"});
  git(f.dir, "update-ref", "refs/remotes/origin/staging", f.head);
  const batch = cmd("release", "create", "--tasks", f.task, "--title", "historical staging handoff");
  expect(rejects("release", "verify", batch.release_id)).toContain("targeting main");
  expect(ledger.getTask(f.task)?.status).toBe("HANDED_OFF");
}, 30_000);

test("v0.4 local branch drift blocks approval, verification and close; deleted merged branch uses pinned non-default base", () => {
  const f = feature("api", 1, "0.4");
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

test("ordinary handoff requires passing executable evidence on each same-SHA branch", () => {
  const a = feature("api", 1),
    b = feature("api", 3);
  writeFileSync(
    join(a.wt, "receipt.test.ts"),
    [
      'import { expect, test } from "bun:test";',
      'test("receipt", () => {',
      '  expect(1 + 1).toBe(3);',
      "});",
    ].join("\n"),
  );
  git(a.wt, "add", ".");
  git(a.wt, "commit", "-m", "shared feature");
  a.head = git(a.wt, "rev-parse", "HEAD");
  git(b.wt, "reset", "--hard", a.head);
  b.head = a.head;
  ledger.cancelTask({ task_id: b.task, reason: "combine attachments" });
  b.task = a.task;
  ledger.attachRepo({
    task_id: a.task,
    repo: b.repo,
    branch: b.branch,
    worktree: b.wt,
    base_sha: b.base,
    head_sha: b.head,
  });
  remote(a.n, { headRefOid: a.head });
  remote(b.n, { headRefOid: b.head });
  sync(a);
  const failed = Bun.spawnSync(
    [
      process.execPath,
      join(import.meta.dir, "../src/bin/cli.ts"),
      "verify",
      "--cwd",
      a.wt,
      "--task",
      a.task,
      "--kind",
      "test",
      "--",
      process.execPath,
      "test",
      "./receipt.test.ts",
    ],
    { cwd: root, env: { ...process.env, FORGE_WORKBENCH_ROOT: root } },
  );
  expect(failed.exitCode).toBe(1);
  sync(b);
  expect(rejects("handoff", a.task)).toContain("latest test failed");
  verifyFeature(a);
  expect(cmd("handoff", a.task).items).toHaveLength(2);
}, 30000);

test("automatic batches and session hints select only unreserved handoffs", () => {
  const a = feature("api", 1),
    b = feature("web", 3);
  const first = train(a);
  sync(b);
  cmd("handoff", b.task);
  const context = () => handleLedgerHook(root, { hook_event_name: "SessionStart", cwd: root }).sessionContext;
  expect(context()).toContain(
    'Handoffs awaiting release: 1 (run forge ledger release create --from-handoffs --title "<title>")',
  );
  expect(rejects("release", "create", "--tasks", a.task, "--title", "dup")).toContain(first);
  expect(rejects("release", "create", "--prs", "api#1", "--title", "dup")).toContain(first);
  const second = cmd("release", "create", "--from-handoffs", "--title", "second");
  expect(second.items.map((i: { task_id: string }) => i.task_id)).toEqual([b.task]);
  expect(context() ?? "").not.toContain("Handoffs awaiting release");
  expect(rejects("release", "create", "--from-handoffs", "--title", "empty")).toContain("No handoffs");
  cmd("release", "cancel", first);
  expect(cmd("release", "create", "--from-handoffs", "--title", "requeued").items[0].task_id).toBe(a.task);
}, 30000);

test("release provides a human merge handoff for the pinned feature worktree origin", () => {
  const f = feature("api", 1);
  git(f.dir, "config", "extensions.worktreeConfig", "true");
  git(f.dir, "config", "--unset-all", "remote.origin.url");
  git(f.dir, "config", "--worktree", "remote.origin.url", "https://github.com/other/api.git");
  git(f.wt, "config", "--worktree", "remote.origin.url", "https://github.com/acme/api.git");
  const id = train(f);
  const gh = join(root, "bin/gh");
  renameSync(gh, gh + "-fixture");
  writeFileSync(gh, '#!/bin/sh\nsleep 3.5\nexec "$0-fixture" "$@"\n', { mode: 0o755 });
  expect(cmd("release", "verify", id).status).toBe("VERIFIED");
  renameSync(gh + "-fixture", gh);
  git(f.wt, "switch", "-c", "next-task");
  const book = cmd("release", "runbook", id);
  const approval = approve(book.runbook_id);
  expect(approval).toContain(book.runbook_id);
  expect(approval).toContain("手动合并");
  expect(approval).toContain("forge ledger release verify " + id);
  expect(approval).not.toContain("自动推进执行");
  expect(book.merge_commands).toBeUndefined();
  expect(book.human_merges).toEqual([{ pr_url: f.url, base_branch: "main", expected_head_sha: f.head }]);
  expect(book.merge_instructions).toContain("托管平台");
  for (const message of [approval, book.merge_instructions]) {
    expect(message).toContain("HEAD 在目标分支上保持可达");
    expect(message).toContain("刷新各仓固定目标分支的 origin 跟踪引用");
  }
  const command = "gh pr merge " + f.url + " --merge --match-head-commit " + f.head;
  const gate = (cwd: string, cmd = command, sid = "fixture") =>
    evaluatePreToolUse(root, {
      hook_event_name: "PreToolUse",
      cwd,
      session_id: sid,
      tool_name: "Bash",
      tool_input: { command: cmd },
    });
  expect(gate(f.wt)).toContain("gh pr merge");
  expect(gate(root)).toContain("gh pr merge");
  expect(gate(f.wt, "gh api -X PUT repos/acme/api/forge/atomic-pr/v1/pulls/1/merge")).toBeTruthy();
  expect(gate(f.wt, "gh api -X GET repos/acme/api/forge/atomic-pr/v1/pulls/1/merge")).toBeNull();
  expect(gate(f.dir)).toBeTruthy();
  expect(gate(f.wt, command, "other")).toBeTruthy();
  expect(gate(f.wt, command.replace(f.head, "a".repeat(40)))).toBeTruthy();
  remote(f.n, { baseRefName: "retargeted" });
  expect(gate(f.wt)).toBeTruthy();
}, 30000);

test("production acceptance from an older handoff or reservation cannot close a new release", () => {
  const f = feature("web", 2),
    old = train(f);
  recordProd(f);
  cmd("resume", f.task);
  expect(cmd("release", "status", old).status).toBe("CANCELLED");
  cmd("handoff", f.task);
  const reserve = () => cmd("release", "create", "--from-handoffs", "--title", "deploy").release_id;
  const cancelled = reserve();
  recordProd(f);
  cmd("release", "cancel", cancelled);
  const next = reserve();
  merge(f);
  cmd("release", "verify", next);
  const book = cmd("release", "runbook", next).runbook_id;
  approve(book);
  cmd("runbook", "complete", book);
  // Candidate builds recorded a SHA but no release identity. Even a later timestamp is ambiguous.
  appendEventInTx(ledger.db, {
    task_id: f.task,
    event_type: "EVIDENCE_CAPTURED",
    actor: "agent",
    repo: f.repo,
    branch: f.branch,
    sha: f.head,
    ts: "2099-01-01T00:00:00.000Z",
    payload: { kind: "prod", status: "pass", source: "manual" },
  });
  expect(rejects("release", "complete", next)).toContain("production delivery evidence");
  recordProd(f);
  expect(cmd("release", "complete", next).status).toBe("COMPLETED");
}, 30000);
