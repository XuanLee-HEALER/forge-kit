import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluatePreToolUse } from "../src/guard";
import { Ledger } from "../src/ledger";
import { handleLedgerHook } from "../src/ledger-hook";
import { appendEventInTx } from "../src/ledger/transactions";
import { sweepMergedBranches } from "../src/wb-git";

import {
  root,
  ledger,
  recordProd,
  cmd,
  rejects,
  git,
  remote,
  feature,
  verifyFeature,
  merge,
  useReleaseFixture,
} from "./helpers/release";
useReleaseFixture();

test("v3 migration preserves data, FTS rowids, chains and foreign keys", () => {
  const path = join(root, "v3.sqlite"),
    old = new Database(path);
  old.exec(readFileSync(join(import.meta.dir, "fixtures/ledger-v3.sql"), "utf8"));
  for (const state of ["OPEN", "CLOSED", "CANCELLED"]) {
    old
      .query("INSERT INTO tasks VALUES(?,? ,?,'pr','targeted',0,NULL,'GENESIS','t','t',NULL)")
      .run(state, state, state);
    old.query("INSERT INTO task_repos VALUES('api','main',NULL,?,NULL,NULL,'t')").run(state);
    old.query("INSERT INTO task_blockers VALUES(?,'b','CLOSED','fixture','t','t')").run(state);
    appendEventInTx(old, {
      task_id: state,
      event_type: "TASK_OPENED",
      actor: "agent",
      payload: { title: "migrationfixture" },
    });
  }
  old.exec(
    "INSERT INTO exemptions VALUES(7,'api','docs',NULL,'doc','t',NULL); INSERT INTO runbooks(runbook_id,title,status,actions_json,actions_hash,created_at) VALUES('rb-fixture','old','PENDING','{}','sha','t')",
  );
  old.exec("UPDATE tasks SET rowid=27 WHERE task_id='CANCELLED'");
  const tables = ["tasks", "task_repos", "task_blockers", "events", "events_fts", "exemptions", "runbooks"];
  const dump = (db: Database) => tables.map((t) => db.query("SELECT rowid,* FROM " + t + " ORDER BY rowid").all());
  const before = dump(old);
  old.close();
  const migrated = new Ledger(root, { dbPath: path });
  try {
    expect(dump(migrated.db)).toEqual(before);
    expect(migrated.db.query("PRAGMA user_version").get()).toEqual({ user_version: 6 });
    expect(migrated.db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(migrated.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      migrated.db.query("SELECT rowid FROM events_fts WHERE events_fts MATCH 'migrationfixture'").all(),
    ).toHaveLength(3);
    expect(migrated.verify()).toMatchObject({ ok: true, checked_tasks: 3, checked_events: 3 });
  } finally {
    migrated.closeDb();
  }
});

test("handoff, resume and batch release bind evidence, SQL, approvals and sweep eligibility", () => {
  const sql = join(root, "migration.sql");
  writeFileSync(sql, "SELECT 1;");
  const first = feature("api", 1);
  verifyFeature(first);
  expect(rejects("handoff", first.task)).toContain("pr-sync");
  cmd("pr-sync", first.task, "--repo", "api", "--pr", "1");
  writeFileSync(join(root, "probe"), ledger.dbPath);
  const tracked = join(first.wt, "tracked.sql");
  writeFileSync(tracked, "SELECT 2;");
  expect(rejects("handoff", first.task, "--sql", "db:" + tracked)).toContain("verified commit");
  writeFileSync(tracked, "SELECT 1;");
  const original = cmd("handoff", first.task, "--sql", "db:" + tracked);
  expect(original.trailers[0]).toBe(
    ["Forge-Task: " + first.task, "Verified-Head: " + first.head, "Ledger-Tip: " + original.ledger_tip].join("\n"),
  );
  expect(cmd("stats", "--json").tasks.by_status.HANDED_OFF).toBe(1);
  for (const hook_event_name of ["SessionStart", "PostCompact"]) {
    const res = handleLedgerHook(root, { hook_event_name, cwd: root });
    expect(res.sessionContext ?? res.compactMessage).toBe(
      'Handoffs awaiting release: 1 (run forge ledger release create --from-handoffs --title "<title>")',
    );
  }
  expect(() =>
    ledger.openTask({
      task_id: "hijack",
      title: "other",
      repo: "api",
      branch: first.branch,
      endpoint: "local",
      depth: "targeted",
    }),
  ).toThrow("owned");
  const prior = cmd("release", "create", "--from-handoffs", "--title", "before feedback").release_id;
  cmd("release", "verify", prior);
  const priorBook = cmd("release", "runbook", prior).runbook_id;
  handleLedgerHook(root, {
    hook_event_name: "UserPromptSubmit",
    session_id: "review",
    prompt: "批准 " + priorBook,
  });
  expect(cmd("status", "--repo", first.repo, "--branch", first.branch).tasks[0].status).toBe("HANDED_OFF");
  cmd("resume", first.task, "--reason", "review feedback");
  expect(ledger.getRunbook(priorBook)?.status).toBe("REVOKED");
  expect(cmd("release", "status", prior).status).toBe("CANCELLED");
  git(first.wt, "commit", "--allow-empty", "-m", "revised");
  first.head = git(first.wt, "rev-parse", "HEAD");
  remote(1, { headRefOid: first.head });
  verifyFeature(first);
  expect(rejects("handoff", first.task)).toContain("pr-sync");
  cmd("pr-sync", first.task, "--repo", "api", "--pr", "1");
  expect(cmd("handoff", first.task).ledger_tip).not.toBe(original.ledger_tip);

  const second = feature("web", 2),
    third = feature("api", 3);
  for (const f of [second, third]) {
    if (f === second) {
      const dir = join(root, ".workbench", "specs", f.task);
      mkdirSync(dir, { recursive: true });
      for (const file of ["scope.md"]) writeFileSync(join(dir, file), "contract");
      ledger.freezeSpec({ task_id: f.task, locked_test_globs: ["example.test.ts"] });
    }
    verifyFeature(f);
    cmd("pr-sync", f.task, "--repo", f.repo, "--pr", String(f.n));
    cmd(
      "handoff",
      f.task,
      ...(f === second ? ["--sql", "PROD.EXAMPLE.:" + sql, "--rollback", "restore snapshot"] : []),
    );
  }
  const other = feature("api", 4);
  const guard = (cwd: string, command: string) =>
    evaluatePreToolUse(root, { hook_event_name: "PreToolUse", cwd, tool_name: "Bash", tool_input: { command } });
  for (const ref of ["HEAD:refs/heads/" + first.branch, "--delete " + first.branch, ":" + first.branch]) {
    expect(guard(other.wt, "git push origin " + ref)).toContain("resume");
  }
  expect(
    evaluatePreToolUse(root, {
      hook_event_name: "PreToolUse",
      cwd: second.wt,
      tool_name: "Edit",
      tool_input: { file_path: join(second.wt, "example.test.ts") },
    }),
  ).toContain(second.task);
  const selected = cmd(
    "release",
    "create",
    "--tasks",
    first.task + "," + second.task,
    "--order",
    "api,web",
    "--title",
    "ordered",
  );
  expect(selected.items.map((i: { repo: string }) => i.repo)).toEqual(["api", "web"]);
  cmd("resume", first.task, "--reason", "replace batch");
  expect(cmd("release", "status", selected.release_id).status).toBe("CANCELLED");
  cmd("handoff", first.task);
  const replacement = cmd(
    "release",
    "create",
    "--tasks",
    second.task + "," + first.task,
    "--title",
    "replacement",
  );
  expect(replacement.items).toHaveLength(2);
  cmd("release", "cancel", replacement.release_id);
  const subset = cmd("release", "create", "--prs", "api#3", "--title", "third");
  expect(subset.items).toHaveLength(1);
  cmd("release", "cancel", subset.release_id);
  expect(rejects("release", "create", "--prs", "api#77", "--title", "absent")).toContain("handoff");
  const train = cmd("release", "create", "--title", "Deployment", "--from-handoffs"),
    id = train.release_id;
  expect(train.items.map((i: { pr_number: number }) => i.pr_number)).toEqual([2, 1, 3]);
  expect(train.rollback_plan).toBe("restore snapshot");
  remote(1, { baseRefName: "other" });
  expect(rejects("release", "verify", id)).toContain("base branch changed");
  remote(1, { baseRefName: "main" });
  const eventCount = ledger.getTaskEvents(first.task).length;
  remote(1, { headRefOid: "b".repeat(40) });
  expect(rejects("release", "verify", id)).toContain("STALE_PR");
  expect(cmd("release", "status", id).items[1]).toMatchObject({
    verified_head_sha: "b".repeat(40),
    status: "STALE_PR",
  });
  expect(rejects("release", "runbook", id)).toContain("Verify");
  remote(1, { headRefOid: first.head });
  const locked = join(second.wt, "example.test.ts"),
    contents = readFileSync(locked);
  writeFileSync(locked, "changed");
  expect(rejects("release", "verify", id)).toContain("drift");
  writeFileSync(locked, contents);
  writeFileSync(sql, "changed");
  expect(rejects("release", "verify", id)).toContain("SQL drift");
  writeFileSync(sql, "SELECT 1;");
  expect(cmd("release", "verify", id)).toMatchObject({ ok: true, status: "VERIFIED" });
  expect(ledger.getTaskEvents(first.task)).toHaveLength(eventCount);
  expect(rejects("release", "runbook", id, "--kubectl", "kubectl get secret")).toContain("secret");
  const rb = cmd("release", "runbook", id);
  expect(rb.actions.prs).toHaveLength(3);
  expect(rb.actions.sql_files[0]).toMatchObject({
    host: "prod.example",
    path: expect.stringContaining("migration.sql"),
  });
  expect(rejects("release", "complete", id)).toContain("COMPLETED");
  cmd("runbook", "revoke", rb.runbook_id);
  expect(rejects("release", "complete", id)).toContain("COMPLETED");
  const fresh = cmd("release", "runbook", id);
  handleLedgerHook(root, {
    hook_event_name: "UserPromptSubmit",
    session_id: "release-test",
    prompt: "批准 " + fresh.runbook_id,
  });
  expect(cmd("release", "verify", id).status).toBe("APPROVED");
  expect(rejects("release", "cancel", id)).toContain("cancel");
  remote(1, { state: "MERGED" });
  expect(rejects("release", "verify", id)).toContain("reachability");
  expect(cmd("release", "status", id).status).toBe("APPROVED");
  expect(ledger.getRunbook(fresh.runbook_id)?.status).toBe("APPROVED");
  remote(1, { state: "OPEN" });
  const mergeGuard = (args: string) =>
    evaluatePreToolUse(root, {
      hook_event_name: "PreToolUse",
      session_id: "release-test",
      cwd: first.dir,
      tool_name: "Bash",
      tool_input: { command: "gh pr merge " + first.url + " " + args },
    });
  remote(1, { headRefOid: "b".repeat(40) });
  expect(mergeGuard("--merge")).toContain("gh pr merge");
  expect(mergeGuard("--match-head-commit " + "b".repeat(40))).toContain("gh pr merge");
  const pin = "--match-head-commit " + first.head;
  for (const strategy of ["", "--squash", "--rebase"])
    expect(mergeGuard(strategy + " " + pin)).toContain("gh pr merge");
  expect(mergeGuard("--merge " + pin)).toContain("gh pr merge");
  remote(1, { headRefOid: first.head, baseRefName: "other" });
  expect(mergeGuard("--merge " + pin)).toContain("gh pr merge");
  remote(1, { baseRefName: "main" });
  expect(mergeGuard("--merge " + pin)).toBeNull();
  expect(rejects("release", "create", "--tasks", first.task, "--title", "bypass")).toContain(id);
  expect(rejects("runbook", "complete", fresh.runbook_id)).toContain("production execution receipt");
  recordProd(second, fresh);
  cmd("runbook", "complete", fresh.runbook_id);
  expect(rejects("release", "complete", id)).toContain("production delivery evidence");
  recordProd(second);
  expect(rejects("release", "complete", id)).toContain("merged");
  for (const f of [first, second, third]) merge(f);
  const opts = { repo: "web", apply: true, fetch: false };
  expect(sweepMergedBranches(root, opts).skippedOpenTasks).toContain("web:" + second.branch);
  expect(existsSync(second.wt)).toBe(true);
  ledger.db.exec(
    "CREATE TRIGGER fail_close BEFORE UPDATE OF closed_at ON tasks WHEN NEW.task_id='task-3' BEGIN SELECT RAISE(ABORT,'atomic rollback'); END",
  );
  expect(rejects("release", "complete", id)).toContain("atomic rollback");
  for (const f of [first, second, third]) expect(ledger.getTask(f.task)?.status).toBe("HANDED_OFF");
  ledger.db.exec("DROP TRIGGER fail_close");
  expect(cmd("release", "complete", id, "--summary", "accepted").task_ids.sort()).toEqual([
    first.task,
    second.task,
    third.task,
  ]);
  for (const f of [first, second, third]) {
    expect(ledger.getTask(f.task)?.status).toBe("CLOSED");
    expect(JSON.parse(ledger.getTaskEvents(f.task).at(-1)!.payload_json)).toMatchObject({
      release_id: id,
      runbook_id: fresh.runbook_id,
      summary: "accepted",
    });
  }
  expect(cmd("verify").ok).toBe(true);
  sweepMergedBranches(root, opts);
  expect(existsSync(second.wt)).toBe(false);
}, 60000);
