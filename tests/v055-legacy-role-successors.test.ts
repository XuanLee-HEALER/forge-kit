import { beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { executorFixture } from "./helpers/executor";

const f = executorFixture("0.4");
let head: string;

beforeEach(() => {
  f.ledger.attachRepo({task_id: "task", repo: "service", branch: "feature", base_sha: f.head});
  writeFileSync(join(f.repo, "code.txt"), "review target\n");
  f.git("commit", "-qm", "reviewable revision", "--", "code.txt");
  head = f.git("rev-parse", "HEAD");
  const specs = join(f.root, ".workbench/specs/task");
  mkdirSync(specs, {recursive: true});
  for (const name of ["ssot", "tech-spec", "test-spec"]) writeFileSync(join(specs, name + ".md"), "Review the change.");
  f.ledger.freezeSpec({task_id: "task"});
  f.ledger.recordEvidence({task_id: "task", repo: "service", branch: "feature", sha: head, kind: "test",
    source: "tool", status: "pass", summary: "Fixture checks passed"});
});

function failure(role: string) {
  const state = f.ledger.getSpecState("task");
  return f.ledger.recordEvidence({task_id: "task", repo: "service", branch: "feature", sha: head,
    kind: "review", source: "tool", actor: "tool", status: "fail", summary: "Legacy finding",
    meta: {role, base: f.head, head, review_task_id: "task", review_floor_seq: state.evidence_floor_seq.review,
      report_status: "findings"}}).seq;
}

function review(role: string, summary: string, task = "task") {
  const report = join(f.root, role + "-" + summary + ".md");
  writeFileSync(report, summary + "\n");
  const result = f.cli("ledger", ["review-record", task, "--base", f.head, "--head", head,
    "--role", role, "--status", "pass", "--summary", summary, "--report", report]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
}

function expectBlocked(role: string) {
  const check = f.ledger.checkPushReadiness({task_id: "task", repo: "service", branch: "feature",
    head_sha: head, checkEndpoint: true});
  expect(check.ready).toBe(false);
  expect(check.missing.join(" ")).toContain(role);
  expect(f.cli("ledger", ["close", "task", "--no-archive"]).exitCode).not.toBe(0);
  expect(f.ledger.getTask("task")?.status).toBe("OPEN");
}

test("only simplify can reassess a cited performance failure", () => {
  const seq = failure("performance");
  for (const [role, summary] of [
    ["quality", "Reviewed finding #" + seq], ["simplify", "Reviewed the historical range"],
    ["simplify", "Reviewed finding #" + (seq + 100)],
  ]) {
    review(role, summary);
    expectBlocked("performance");
  }
  review("simplify", "Verified the performance fix #" + seq);
  const closed = f.cli("ledger", ["close", "task", "--no-archive"]);
  expect(closed.exitCode, closed.stderr.toString()).toBe(0);
  expect(f.ledger.getTask("task")?.status).toBe("CLOSED");
  const history = f.cli("ledger", ["reviews", "task"]);
  expect(JSON.parse(history.stdout.toString())[0]).toMatchObject({seq, role: "performance", source: "tool", head, base: f.head});
}, 20_000);

test("codex-review has no native successor even when its failure is cited", () => {
  const seq = failure("codex-review");
  for (const role of ["business", "quality", "simplify", "comments"]) {
    review(role, "Reviewed finding #" + seq);
    expectBlocked("codex-review");
  }
}, 20_000);

for (const version of ["0.4", "0.5"] as const) test("an unrelated native report preserves a historical tool repair under " + version, () => {
  const task = "handover";
  f.ledger.cancelTask({task_id: "task", reason: "Use the requested workflow version"});
  f.ledger.openTask({workflow_version: version, task_id: task, title: task, repo: "service", branch: "feature",
    endpoint: "local", depth: "targeted", base_sha: f.head, head_sha: head});
  const specs = join(f.root, ".workbench/specs", task);
  mkdirSync(specs, {recursive: true});
  for (const name of version === "0.4" ? ["ssot", "tech-spec", "test-spec"] : ["scope"])
    writeFileSync(join(specs, name + ".md"), "Legacy tool history.");
  const state = f.ledger.freezeSpec({task_id: task}).spec;
  const scope = {task_id: task, repo: "service", branch: "feature", actor: "tool", source: "tool" as const};
  function historicalQuality(status: "pass" | "fail") {
    f.ledger.recordEvidence({...scope, sha: head, kind: "review", status, summary: "Historical quality " + status,
      meta: {role: "quality", base: f.head, head, review_task_id: task, freeze_seq: state.freeze_seq,
        review_floor_seq: state.evidence_floor_seq.review, report_status: status === "pass" ? "pass" : "findings"}});
  }
  historicalQuality("fail");
  writeFileSync(join(f.repo, "code.txt"), "reviewed repair\n");
  f.git("commit", "-qm", "repair the quality finding", "--", "code.txt");
  head = f.git("rev-parse", "HEAD");
  historicalQuality("pass");
  for (const kind of ["lint", "test"] as const)
    f.ledger.recordEvidence({...scope, sha: head, kind, status: "pass", summary: "Fixture checks passed"});
  const readiness = () => f.ledger.checkPushReadiness({...scope, head_sha: head, checkEndpoint: true});
  expect(readiness().ready, readiness().missing.join(" ")).toBe(true);
  review("comments", "Verified the updated comments", task);
  expect(readiness().ready, readiness().missing.join(" ")).toBe(true);
  const closed = f.cli("ledger", ["close", task, "--no-archive"]);
  expect(closed.exitCode, closed.stderr.toString()).toBe(0);
  expect(f.ledger.getTask(task)?.status).toBe("CLOSED");
}, 20_000);
