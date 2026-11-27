import { beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { executorFixture } from "./helpers/executor";

const f = executorFixture("0.5");
const task = "native";
let base: string, head: string, report: string;
const summary = "核对交付行为";

function command(...args: string[]) {
  return f.cli("ledger", args);
}
function ok(...args: string[]) {
  const result = command(...args);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return JSON.parse(result.stdout.toString());
}
function change(text: string) {
  writeFileSync(join(f.repo, "code.txt"), text);
  f.git("commit", "-qm", text, "--", "code.txt");
  return f.git("rev-parse", "HEAD");
}
function args(role = "quality", status = "pass", from = base, to = head, reviewSummary = summary) {
  return ["review-record", task, "--base", from, "--head", to, "--role", role,
    "--status", status, "--summary", reviewSummary, "--report", report];
}
function events() {
  return f.ledger.getTaskEvents(task);
}
function ready() {
  return f.ledger.checkPushReadiness({ task_id: task, repo: "service", branch: "feature",
    head_sha: head, checkEndpoint: true });
}
function rejected(argv: string[]) {
  const count = events().length;
  const before = ready();
  const result = command(...argv);
  expect(result.exitCode, argv.join(" ")).not.toBe(0);
  expect(events()).toHaveLength(count);
  expect(ready()).toEqual(before);
}
function checks() {
  for (const kind of ["lint", "test"] as const)
    f.ledger.recordEvidence({ task_id: task, repo: "service", branch: "feature", sha: head,
      kind, source: "tool", status: "pass", summary: `Fixture ${kind} passed` });
}
beforeEach(() => {
  // The fixture's first commit is an ancestor outside this task's scope.
  ok("cancel", "task", "--reason", "Use a later task baseline");
  base = change("task baseline");
  head = change("first revision");
  ok("open", "--id", task, "--title", task, "--repo", "service", "--branch", "feature",
    "--base", base, "--head", head, "--endpoint", "local", "--depth", "targeted");
  const specs = join(f.root, ".workbench/specs", task);
  mkdirSync(specs, { recursive: true });
  writeFileSync(join(specs, "scope.md"), "Check the observable change.\n");
  ok("freeze", task);
  const models = join(f.root, ".workbench/models.toml");
  writeFileSync(models, [
    '[tiers.deep]', 'model = "fixture-deep"', 'effort = "high"',
    '[tiers.standard]', 'model = "fixture-standard"', 'effort = "low"',
    '[tiers.mechanical]', 'model = "fixture-mechanical"', 'effort = "medium"',
    '[review.roles]', 'business = "standard"', 'quality = "deep"', 'simplify = "standard"', 'comments = "mechanical"', '',
  ].join("\n"));
  report = join(f.root, "评审.md");
  writeFileSync(report, "# 结论\r\n\n覆盖固定版本。\n");
});

test("review-record persists the actual report bytes, role defaults and explicit native parameters", () => {
  const spec = f.ledger.getSpecState(task);
  const digest = createHash("sha256").update(readFileSync(report)).digest("hex");
  for (const [role, status, model, effort, session] of [
    ["business", "pass", "fixture-standard", "low"],
    ["quality", "blocked", "fixture-deep", "high"],
    ["simplify", "incomplete", "override", "medium", "session-42"],
    ["comments", "pass", "fixture-mechanical", "medium"],
  ]) {
    const count = events().length;
    ok(...args(role, status), ...(session ? ["--session-id", session, "--model", model, "--effort", effort] : []));
    expect(events()).toHaveLength(count + 1);
    const event = events().at(-1)!;
    expect(event).toMatchObject({ event_type: "EVIDENCE_CAPTURED", task_id: task, repo: "service", branch: "feature", sha: head });
    const payload = JSON.parse(event.payload_json);
    expect(payload).toMatchObject({ kind: "review", source: "subagent", status: status === "pass" ? "pass" : "fail", summary,
      meta: { role, base, head, report_status: status, report_sha256: digest, model, effort, review_task_id: task,
        review_floor_seq: spec.evidence_floor_seq.review, freeze_seq: spec.freeze_seq } });
    expect(payload.meta.session_id ?? null).toBe(session ?? null);
    expect(readFileSync(resolve(f.root, payload.meta.report_path))).toEqual(readFileSync(report));
    const row = ok("reviews", task).at(-1);
    expect(row).toMatchObject({ source: "subagent", kind: "review", summary, role, status, base, head,
      repo: "service", branch: "feature", report_sha256: digest, report_path: payload.meta.report_path, model, effort });
    expect(row.session_id ?? null).toBe(session ?? null);
  }
});

test("review-record rejects invalid parameters and Git ranges without changing readiness or history", () => {
  ok(...args());
  checks();
  expect(ready().ready).toBe(true);
  f.git("switch", "-qc", "side", base);
  const side = change("unmerged sibling");
  f.git("switch", "-q", "feature");
  for (const invalid of [args("performance"), args("quality", "unknown"), args("quality", "pass", head),
    args("quality", "pass", f.head), args("quality", "pass", side), args("quality", "pass", "missing"),
    args("quality", "pass", base, "missing"), args("quality", "pass", base, base)]) rejected(invalid);
  for (const flag of ["--role", "--base", "--head", "--report", "--summary", "--status"]) {
    const invalid = args();
    invalid.splice(invalid.indexOf(flag), 2);
    rejected(invalid);
  }
  rejected(["record", task, "--kind", "review", "--status", "pass", "--summary", summary]);
  const original = report;
  report += ".missing";
  rejected(args());
  writeFileSync(report, "");
  rejected(args());
  report = original;
  chmodSync(report, 0);
  try {
    if (process.getuid?.() !== 0) rejected(args());
  } finally { chmodSync(report, 0o600); }
  f.git("commit", "--allow-empty", "-qm", "identical tree");
  const prior = head;
  head = f.git("rev-parse", "HEAD");
  checks();
  expect(ready().ready).toBe(false);
  expect(ok("reviews", task).at(-1)).toMatchObject({base, head: prior});
  rejected(args("quality", "pass", base, prior));
  rejected(args("quality", "pass", prior));
  ok(...args());
}, 30_000);

test("review-record requires an open task with its specification frozen", () => {
  ok(...args());
  ok("amend", task, "--scope", "requirement", "--reason", "Update the contract");
  rejected(args());
  ok("freeze", task);
  checks();
  expect(ready().ready).toBe(false);
  expect(ok("reviews", task)).toHaveLength(1);
  ok(...args());
  expect(ready().ready).toBe(true);
  ok("close", task, "--no-archive");
  expect(f.ledger.getTask(task)?.status).toBe("CLOSED");
  rejected(args());
});

test("attachment selectors must identify exactly one repository and branch", () => {
  f.git("branch", "other", head);
  ok("attach", task, "--repo", "service", "--branch", "other", "--base", base, "--head", head);
  f.git("clone", "--quiet", f.repo, join(f.root, "mirror"));
  ok("attach", task, "--repo", "mirror", "--branch", "feature", "--base", base, "--head", head);
  for (const selector of [[], ["--repo", "service"], ["--branch", "feature"], ["--repo", "missing"],
    ["--branch", "missing"], ["--repo", "mirror", "--branch", "other"]]) rejected([...args(), ...selector]);
  for (const [repo, branch, selector] of [
    ["mirror", "feature", ["--repo", "mirror"]],
    ["service", "other", ["--branch", "other"]],
    ["service", "feature", ["--repo", "service", "--branch", "feature"]],
  ] as const) {
    ok(...args(), ...selector);
    expect(events().at(-1)).toMatchObject({ repo, branch, sha: head });
  }
});

test("fixing one role preserves the other role's unresolved finding through a new HEAD", () => {
  checks();
  ok(...args("business"));
  for (const [role, status] of [["quality", "blocked"], ["comments", "incomplete"]]) {
    ok(...args(role, status));
    expect(ready().missing.join(" ")).toContain(role);
  }
  const reviews = ok("reviews", task);
  const qualitySeq = reviews.find((row: {status: string}) => row.status === "blocked").seq;
  const commentsSeq = reviews.find((row: {status: string}) => row.status === "incomplete").seq;
  const previous = head;
  head = change("repair both findings");
  checks();
  ok(...args("business"));
  expect(ready().missing.join(" ")).toContain("quality");
  expect(ready().missing.join(" ")).toContain("comments");
  report = join(f.root, "quality-recheck.md");
  writeFileSync(report, "Verified the repair against the prior quality finding.\n");
  ok(...args("quality", "pass", previous, head, `Verified fix for #${qualitySeq}`));
  expect(ready().missing.join(" ")).not.toContain("quality");
  expect(ready().missing.join(" ")).toContain("comments");
  report = join(f.root, "comments-recheck.md");
  writeFileSync(report, "Verified the updated comments against the original finding.\n");
  ok(...args("comments", "pass", base, head, `Verified fix for #${commentsSeq}`));
  expect(ready().ready).toBe(true);
  expect(ok("reviews", task)).toContainEqual(expect.objectContaining({role: "quality", status: "blocked", head: previous}));
});

test("a single outstanding finding needs its own role and cited failure sequence", () => {
  ok(...args("quality", "blocked"));
  const original = ok("reviews", task).at(-1);
  const previous = head;
  head = change("repair the quality finding");
  checks();
  ok(...args("business"));
  function stillBlocked() {
    expect(ready().ready).toBe(false);
    expect(ready().missing.join(" ")).toContain("quality");
    expect(command("close", task, "--no-archive").exitCode).not.toBe(0);
    expect(f.ledger.getTask(task)?.status).toBe("OPEN");
  }
  stillBlocked();
  for (const [role, from, reviewSummary] of [
    ["quality", previous, "Checked the incremental changes"],
    ["quality", base, "Checked the entire change"],
    ["quality", previous, `Checked revision ${original.seq}`],
    ["business", base, `Reviewed #${original.seq}`],
    ["quality", previous, `Reviewed #${original.seq + 1000}`],
  ]) {
    ok(...args(role, "pass", from, head, reviewSummary));
    stillBlocked();
  }
  const reviewSummary = `Verified the repair for #${original.seq}`;
  report = join(f.root, "quality-reassessment.md");
  writeFileSync(report, reviewSummary + "\n");
  ok(...args("quality", "pass", previous, head, reviewSummary));
  const history = ok("reviews", task);
  expect(history).toContainEqual(original);
  expect(history.at(-1)).toMatchObject({role: "quality", status: "pass", base: previous, head, summary: reviewSummary});
  expect(ready().ready).toBe(true);
  ok("close", task, "--no-archive");
  expect(f.ledger.getTask(task)?.status).toBe("CLOSED");
  expect(ok("verify", "--task", task).ok).toBe(true);
}, 30_000);

test("native reassessment clears a historical selection and close needs a full final range", () => {
  const previous = head;
  head = change("incremental repair");
  checks();
  const spec = f.ledger.getSpecState(task);
  f.ledger.recordEvidence({task_id: task, repo: "service", branch: "feature", sha: head, source: "tool",
    kind: "review_selection", status: "info", summary: "Prior selection could not start",
    meta: {role: "quality", base: previous, head, report_status: "incomplete", backend: null, attempts: [],
      freeze_seq: spec.freeze_seq, review_task_id: task, review_floor_seq: spec.evidence_floor_seq.review}});
  expect(ready().missing.join(" ")).toContain("quality");
  ok(...args("quality", "pass", previous));
  expect(ok("reviews", task).at(-1)).toMatchObject({base: previous, head});
  expect(ready().missing.join(" ")).not.toContain("quality");
  expect(ready().ready).toBe(false);
  expect(command("close", task, "--no-archive").exitCode).not.toBe(0);
  expect(f.ledger.getTask(task)?.status).toBe("OPEN");
  ok(...args("business"));
  expect(ready().ready).toBe(true);
  ok("close", task, "--no-archive");
  expect(f.ledger.getTask(task)?.status).toBe("CLOSED");
  expect(ok("verify", "--task", task).ok).toBe(true);
});
