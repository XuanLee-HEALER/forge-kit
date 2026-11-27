import { beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { executorFixture } from "./helpers/executor";

const f = executorFixture("0.5");

beforeEach(() => {
  f.ledger.attachRepo({task_id: "task", repo: "service", branch: "feature", base_sha: f.head});
  const specs = join(f.root, ".workbench/specs/task");
  mkdirSync(specs, {recursive: true});
  writeFileSync(join(specs, "scope.md"), "Review the committed repair.");
  f.ledger.freezeSpec({task_id: "task"});
});

function change(value: string) {
  writeFileSync(join(f.repo, "code.txt"), value);
  f.git("commit", "-qm", value, "--", "code.txt");
  return f.git("rev-parse", "HEAD");
}

for (const scenario of ["task baseline", "incremental start", "missing full review", "other role",
  "later start", "divergent repair", "wrong freeze", "wrong floor"] as const) {
  test("0.5.x historical quality reassessment with " + scenario, () => {
    const baseline = f.head;
    const incremental = change("incremental start");
    const original = change("quality finding");
    const spec = f.ledger.getSpecState("task");
    const scope = {task_id: "task", repo: "service", branch: "feature", source: "tool" as const, actor: "tool"};
    function review(base: string, head: string, role: string, status: "pass" | "fail",
      freezeSeq = spec.freeze_seq, floor = spec.evidence_floor_seq.review) {
      f.ledger.recordEvidence({...scope, sha: head, kind: "review", status, summary: "Historical " + role + " " + status,
        meta: {base, head, role, report_status: status === "pass" ? "pass" : "blocked", review_task_id: "task",
          review_floor_seq: floor, freeze_seq: freezeSeq, backend: "codex", attempts: [{backend: "codex", status}]}});
    }

    const originalBase = scenario === "task baseline" ? baseline : incremental;
    review(originalBase, original, "quality", "fail");
    if (scenario === "divergent repair") {
      f.git("branch", "-m", "previous-line");
      f.git("switch", "-qc", "feature", incremental);
    }
    const repaired = change("repaired revision");
    review(scenario === "later start" ? original : originalBase, repaired, scenario === "other role" ? "simplify" : "quality",
      "pass", scenario === "wrong freeze" ? 0 : spec.freeze_seq, scenario === "wrong floor" ? 0 : spec.evidence_floor_seq.review);
    if (scenario !== "missing full review") review(baseline, repaired, "business", "pass");
    for (const kind of ["lint", "test"] as const)
      f.ledger.recordEvidence({...scope, sha: repaired, kind, status: "pass", summary: "H2 checks passed"});

    const readiness = f.ledger.checkPushReadiness({...scope, head_sha: repaired, checkEndpoint: true});
    const close = f.cli("ledger", ["close", "task", "--no-archive"]);
    const allowed = scenario === "task baseline" || scenario === "incremental start";
    expect(readiness.ready, readiness.missing.join(" ")).toBe(allowed);
    if (scenario === "missing full review") {
      expect(readiness.missing.join(" ")).toContain("baseline-to-HEAD");
      expect(readiness.missing.join(" ")).not.toContain("quality");
    } else if (!allowed) expect(readiness.missing.join(" ")).toContain("quality");
    expect(close.exitCode === 0, close.stderr.toString()).toBe(allowed);
    expect(f.ledger.getTask("task")?.status).toBe(allowed ? "CLOSED" : "OPEN");
    if (allowed) {
      const history = f.cli("ledger", ["reviews", "task"]);
      expect(history.exitCode).toBe(0);
      expect(JSON.parse(history.stdout.toString()).slice(0, 2)).toMatchObject([
        {role: "quality", status: "blocked", base: originalBase, head: original},
        {role: "quality", status: "pass", base: originalBase, head: repaired},
      ]);
    }
  }, 20_000);
}
