import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { executorFixture } from "./helpers/executor";
const f = executorFixture();
test("stats aggregate by timestamp, source, status and role and report closed durations", () => {
  for (const status of ["pass", "fail"] as const)
    f.ledger.recordEvidence({
      task_id: "task",
      repo: "service",
      sha: f.head,
      kind: "review",
      source: "tool",
      status,
      summary: "review",
      meta: { role: "quality", fallback_used: status === "pass" },
    });
  f.ledger.openTask({ task_id: "other", title: "closed", depth: "targeted", endpoint: "investigation" });
  f.ledger.closeTask({ task_id: "other", archive: false, forceIncomplete: true, forceReason: "fixture" });
  f.ledger.db
    .query(
      "UPDATE tasks SET created_at='2020-01-01T00:00:00Z',closed_at='2020-01-01T00:00:02Z' WHERE task_id='other'",
    )
    .run();
  const stats = (...args: string[]) =>
    JSON.parse(f.cli("ledger", ["stats", "--json", ...args]).stdout.toString());
  expect(stats()).toMatchObject({
    tasks: { by_status: { OPEN: 1, CLOSED: 1 } },
    durations_ms: { average: 2000, median: 2000 },
    reviews: { quality: { pass: 1, fail: 1, fallback: 1 } },
    verifications: { review: { tool: { pass: 1, fail: 1 } } },
  });
  expect(stats("--days", "1").tasks.by_status.CLOSED).toBe(0);
  expect(f.cli("ledger", ["stats"]).stdout.toString()).toContain("Metric\tGroup");
});
test("external tip witnesses distinguish head, prefix, mismatch and corrupted chains", () => {
  const tip = f.cli("ledger", ["tip", "task"]).stdout.toString().trim();
  const witness = "task@" + f.ledger.getTask("task")!.tip_hash;
  expect(tip).toBe("Ledger-Tip: " + witness);
  const verify = (...args: string[]) => f.cli("ledger", ["verify-tip", ...args]);
  expect(JSON.parse(verify(witness).stdout.toString()).match).toBe("head");
  f.ledger.recordEvidence({ task_id: "task", kind: "note", status: "info", summary: "more" });
  const prefix = verify("--task", "task", "--tip", witness.split("@")[1]);
  expect(prefix.exitCode).toBe(0);
  expect(JSON.parse(prefix.stdout.toString()).match).toBe("prefix");
  expect(verify("task@" + "0".repeat(64)).exitCode).toBe(1);
  f.ledger.db.query("UPDATE tasks SET tip_hash='corrupted'").run();
  expect(verify(witness).exitCode).toBe(1);
});

test("read-only stats tolerate missing tables without creating them", () => {
  const stats = () => JSON.parse(f.cli("ledger", ["stats", "--json"]).stdout.toString());
  f.ledger.db.exec("DROP TABLE runbooks");
  expect(stats()).toMatchObject({ tasks: { by_status: { OPEN: 1 } }, runbooks: { APPROVED: 0 } });
  f.ledger.db.exec("PRAGMA foreign_keys=OFF; DROP TABLE tasks; DROP TABLE events");
  expect(stats()).toMatchObject({ tasks: { by_status: { OPEN: 0 } }, verifications: {}, reviews: {} });
  expect(
    f.ledger.db.query("SELECT name FROM sqlite_master WHERE name IN ('tasks','events','runbooks')").all(),
  ).toEqual([]);
});
test("a zero-byte SQLite ledger yields empty statistics", () => {
  const root = join(f.root, "empty-ledger");
  mkdirSync(join(root, ".workbench/ledger"), { recursive: true });
  writeFileSync(join(root, ".workbench/ledger/ledger.sqlite"), "");
  const report = f.cli("ledger", ["stats", "--json"], { FORGE_WORKBENCH_ROOT: root });
  expect(report.exitCode, report.stderr.toString()).toBe(0);
  expect(JSON.parse(report.stdout.toString())).toMatchObject({
    tasks: { by_status: { OPEN: 0 } },
    verifications: {},
    reviews: {},
    runbooks: { APPROVED: 0 },
  });
});
