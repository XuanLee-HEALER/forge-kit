import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { executorFixture } from "./helpers/executor";

const f = executorFixture("0.4");

function legacyFullHistory() {
  const task = "full-legacy";
  f.ledger.cancelTask({task_id: "task", reason: "Use full-depth legacy delivery"});
  f.ledger.openTask({workflow_version: "0.4", task_id: task, title: task, repo: "service", branch: "feature",
    endpoint: "local", depth: "full", base_sha: f.head, head_sha: f.head});
  const specs = join(f.root, ".workbench/specs", task);
  mkdirSync(specs, {recursive: true});
  for (const name of ["ssot", "tech-spec", "test-spec"]) writeFileSync(join(specs, name + ".md"), "Review the revision.");
  const spec = f.ledger.freezeSpec({task_id: task}).spec;
  const scope = {task_id: task, repo: "service", branch: "feature", actor: "tool", source: "tool" as const};
  const binding = {role: "quality", base: f.head, review_task_id: task, review_floor_seq: spec.evidence_floor_seq.review};
  writeFileSync(join(f.repo, "code.txt"), "quality finding\n");
  f.git("commit", "-qm", "introduce the quality finding", "--", "code.txt");
  const previous = f.git("rev-parse", "HEAD");
  f.ledger.recordEvidence({...scope, sha: previous, kind: "review", status: "fail", summary: "Quality finding",
    meta: {...binding, head: previous, report_status: "findings"}});
  writeFileSync(join(f.repo, "code.txt"), "fixed after quality review\n");
  f.git("commit", "-qm", "repair reviewed code", "--", "code.txt");
  const head = f.git("rev-parse", "HEAD");
  for (const kind of ["lint", "test"] as const)
    f.ledger.recordEvidence({...scope, sha: head, kind, status: "pass", summary: "H2 checks passed"});

  const exhausted = f.ledger.recordEvidence({...scope, sha: head, kind: "review", status: "fail",
    summary: "Role execution exhausted its credits", meta: {...binding, head,
      exit_code: 2, report_status: "error", error_code: "credit_balance_exhausted"}});
  // 0.4.1 wrote the fallback's launch floor and original failure, without freeze_seq or report_status.
  const fallback = { ...scope, sha: head, kind: "review" as const, status: "fallback" as const,
    summary: "Rechecked the repaired range", meta: {...binding, head, original_failure: exhausted.seq,
      started_at: new Date().toISOString(), model: "historical-model", effort: "medium"} };
  const readiness = (fastTrack = false) => f.ledger.checkPushReadiness({...scope, head_sha: head,
    checkEndpoint: !fastTrack, requireFrozenToolReview: fastTrack});
  function nativeReview(role: string) {
    const report = join(f.root, role + ".md");
    writeFileSync(report, "Checked the full " + role + " scope.\n");
    const result = f.cli("ledger", ["review-record", task, "--role", role, "--base", f.head,
      "--head", head, "--report", report, "--status", "pass", "--summary", "Full " + role + " review"]);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  }
  return {task, previous, fallback, readiness, nativeReview};
}

for (const status of ["pass", "fallback"] as const) test("a full legacy " + status + " stays valid after a native comments review", () => {
  const {task, fallback, readiness, nativeReview} = legacyFullHistory();
  if (status === "fallback") f.ledger.recordEvidence(fallback);
  else {
    const {original_failure, ...meta} = fallback.meta;
    f.ledger.recordEvidence({...fallback, status, summary: "Quality rerun passed", meta: {...meta, report_status: "pass"}});
  }
  expect(readiness().ready).toBe(true);
  expect(readiness(true).ready).toBe(status === "pass");
  nativeReview("comments");
  expect(readiness().ready).toBe(true);
  expect(readiness(true).ready).toBe(status === "pass");
  const close = f.cli("ledger", ["close", task, "--no-archive"]);
  expect(close.exitCode, close.stderr.toString()).toBe(0);
  expect(f.ledger.getTask(task)?.status).toBe("CLOSED");
}, 20_000);

for (const mismatch of ["source", "role", "range", "floor"] as const) test("legacy fallback retains the quality blocker for a mismatched " + mismatch, () => {
  const {task, previous, fallback, readiness, nativeReview} = legacyFullHistory();
  const meta = {...fallback.meta};
  if (mismatch === "role") meta.role = "comments";
  if (mismatch === "range") meta.base = previous;
  if (mismatch === "floor") meta.review_floor_seq = 0;
  f.ledger.recordEvidence({...fallback, source: mismatch === "source" ? "hook" : "tool", meta});
  nativeReview("business");
  const check = readiness();
  expect(check.ready).toBe(false);
  expect(check.missing.join(" ")).toContain("quality");
  expect(f.cli("ledger", ["close", task, "--no-archive"]).exitCode).not.toBe(0);
  expect(f.ledger.getTask(task)?.status).toBe("OPEN");
}, 20_000);
