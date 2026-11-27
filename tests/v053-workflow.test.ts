import { expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { executorFixture } from "./helpers/executor";

const f = executorFixture("0.5");

test("run retention keeps active and recent runs and preserves closed task evidence", () => {
  const wb = join(f.root, ".workbench");
  appendFileSync(join(wb, "workbench.yaml"), "\nledger: {retention_days: 10}\n");
  function cli(...args: string[]) {
    const result = f.cli("ledger", args);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString();
  }
  for (const id of ["expired", "recent", "task"]) {
    if (id !== "task") cli("open", "--id", id, "--title", id, "--endpoint", "local", "--depth", "targeted", "--repo", "service", "--branch", id, "--base", f.head, "--head", f.head);
    const specs = join(wb, "specs", id);
    const runs = join(wb, "runs", id);
    mkdirSync(specs, { recursive: true });
    mkdirSync(runs, { recursive: true });
    writeFileSync(join(specs, "scope.md"), "Check task runs\n");
    if (id === "task") {
      const misplaced = join(specs, "stage.log");
      writeFileSync(misplaced, id);
      const blocked = f.cli("ledger", ["freeze", id]);
      expect(blocked.exitCode).not.toBe(0);
      expect(blocked.stderr.toString()).toContain("stage.log");
      renameSync(misplaced, join(runs, "stage.log"));
    } else {
      writeFileSync(join(runs, "stage.log"), id);
    }
    cli("freeze", id);
    if (id !== "task") cli("cancel", id, "--reason", "fixture completed");
    expect(readdirSync(specs)).toEqual(["scope.md"]);
  }
  // Age only the terminal timestamp in this private fixture, preserving the event chain.
  f.ledger.db.query("UPDATE tasks SET closed_at=? WHERE task_id=?").run("2000-01-01T00:00:00.000Z", "expired");
  const events = f.ledger.getTaskEvents("expired");
  cli("prune", "--runs-only");
  expect(existsSync(join(wb, "runs/expired/stage.log"))).toBe(true);
  cli("prune", "--runs-only", "--apply");
  expect(existsSync(join(wb, "runs/expired"))).toBe(false);
  for (const id of ["recent", "task"]) expect(readFileSync(join(wb, "runs", id, "stage.log"), "utf8")).toBe(id);
  expect(readFileSync(join(wb, "specs/expired/scope.md"), "utf8")).toBe("Check task runs\n");
  expect(f.ledger.getTaskEvents("expired")).toEqual(events);
  cli("verify", "--task", "expired");
});
