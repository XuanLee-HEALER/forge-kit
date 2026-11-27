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
function ready(id = task) {
  return f.ledger.checkPushReadiness({ task_id: id, repo: "service", branch: "feature",
    head_sha: head, checkEndpoint: true });
}
function rejected(argv: string[]) {
  const history = events();
  const before = ready();
  const result = command(...argv);
  expect(result.exitCode, argv.join(" ")).not.toBe(0);
  expect(events()).toEqual(history);
  expect(ready()).toEqual(before);
}
function checks(id = task) {
  for (const kind of ["lint", "test"] as const)
    f.ledger.recordEvidence({ task_id: id, repo: "service", branch: "feature", sha: head,
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
  ok(...args("quality"));
  const oldFailure = ok(...args("comments", "blocked"));
  ok("amend", task, "--scope", "requirement", "--reason", "Update the contract");
  rejected(args());
  ok("freeze", task);
  checks();
  expect(ready().ready).toBe(false);
  expect(ready().missing.join(" ")).not.toContain(`#${oldFailure.seq}`);
  expect(ok("reviews", task)).toHaveLength(2);
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
  checks();
  for (const [repo, branch, selector] of [
    ["mirror", "feature", ["--repo", "mirror"]],
    ["service", "other", ["--branch", "other"]],
  ] as const) {
    ok(...args(), ...selector);
    expect(events().at(-1)).toMatchObject({ repo, branch, sha: head });
    expect(ready().ready).toBe(false);
    const foreignFailure = ok(...args("comments", "blocked"), ...selector);
    expect(ready().missing.join(" ")).not.toContain(`#${foreignFailure.seq}`);
  }
  ok(...args(), "--repo", "service", "--branch", "feature");
  expect(events().at(-1)).toMatchObject({ repo: "service", branch: "feature", sha: head });
  expect(ready().ready).toBe(true);

  const prefix = head;
  head = change("unreviewed suffix on the target branch");
  checks();
  f.git("branch", "-f", "other", head);
  f.git("-C", join(f.root, "mirror"), "pull", "--ff-only", "origin", "feature");
  for (const [repo, branch] of [["mirror", "feature"], ["service", "other"]] as const) {
    ok(...args("quality", "pass", prefix), "--repo", repo, "--branch", branch);
    const readiness = ready();
    expect(readiness.ready).toBe(false);
    expect(readiness.missing.join(" ")).toContain("quality");
    expect(readiness.missing.join(" ")).toContain(head.slice(0, 7));
  }
  ok(...args("quality", "pass", prefix), "--repo", "service", "--branch", "feature");
  expect(ready().ready).toBe(true);
});

test("the same repository, branch and range need a report bound to the current task", () => {
  ok(...args());
  const failure = ok(...args("comments", "blocked"));
  ok("cancel", task, "--reason", "A separate task owns the same change");
  const next = "separate-task";
  ok("open", "--id", next, "--title", next, "--repo", "service", "--branch", "feature",
    "--base", base, "--head", head, "--endpoint", "local", "--depth", "targeted");
  mkdirSync(join(f.root, ".workbench/specs", next));
  writeFileSync(join(f.root, ".workbench/specs", next, "scope.md"), "Review this task's range.\n");
  ok("freeze", next);
  checks(next);
  expect(ready(next).ready).toBe(false);
  expect(ready(next).missing.join(" ")).not.toContain(`#${failure.seq}`);
  expect(ok("reviews", next)).toEqual([]);
  ok("review-record", next, ...args().slice(2));
  expect(ready(next).ready).toBe(true);
});

test("native findings list every unresolved sequence by role until explicitly reassessed", () => {
  const middle = head;
  head = change("complete the change under review");
  const failedHead = head;
  ok(...args("quality", "blocked", base, head, "The parser loses empty values"));
  ok(...args("quality", "blocked", base, head, "The writer truncates values"));
  ok(...args("comments", "incomplete", base, head, "Missing public example"));
  const original = ok("reviews", task);
  expect(original).toHaveLength(3);
  const [parser, writer, example] = original.map((row: {seq: number}) => row.seq);
  const initial = {quality: [parser, writer], comments: [example]};

  function unresolved(expected: Record<string, number[]>) {
    const result = command("close", task, "--no-archive");
    expect(result.exitCode).not.toBe(0);
    expect(f.ledger.getTask(task)?.status).toBe("OPEN");
    const diagnostic = result.stdout.toString() + result.stderr.toString();
    const groups = Array.from(diagnostic.matchAll(/\b(quality|comments)\b([^\n]*?)(?=\b(?:quality|comments)\b|\n|$)/g));
    const byRole = Object.fromEntries(groups.flatMap(([, role, text]) => {
      const sequences = Array.from(text.matchAll(/#(\d+)\b/g), ([, n]) => Number(n)).sort((a, b) => a - b);
      return sequences.length ? [[role, sequences]] : [];
    }));
    expect(byRole, diagnostic).toEqual(expected);
  }
  checks();
  ok(...args("business"));
  unresolved(initial);
  head = change("repair parser, writer and public example");
  checks();
  ok(...args("business"));
  unresolved(initial);
  for (const [role, from, reviewSummary] of [
    ["quality", failedHead, "Checked the incremental changes"],
    ["quality", base, "Checked the entire change"],
    ["quality", failedHead, `Checked revision ${parser}`],
    ["business", base, `Reviewed #${parser}`],
    ["quality", failedHead, `Reviewed #${parser + writer + example + 1000}`],
    ["quality", middle, `Reviewed #${parser}`],
  ]) {
    ok(...args(role, "pass", from, head, reviewSummary));
    unresolved(initial);
  }

  function reassess(role: string, from: string, seq: number, description: string) {
    const reviewSummary = `Verified ${description} #${seq}`;
    report = join(f.root, `recheck-${seq}.md`);
    writeFileSync(report, reviewSummary + " against the original report.\n");
    ok(...args(role, "pass", from, head, reviewSummary));
    expect(ok("reviews", task).at(-1)).toMatchObject({role, status: "pass", base: from, head, summary: reviewSummary});
  }
  reassess("quality", failedHead, parser, "parser repair");
  unresolved({quality: [writer], comments: [example]});
  reassess("comments", base, example, "public example");
  unresolved({quality: [writer]});
  reassess("quality", failedHead, writer, "writer repair");
  expect(ready().ready).toBe(true);
  ok("close", task, "--no-archive");
  expect(f.ledger.getTask(task)?.status).toBe("CLOSED");
  expect(ok("reviews", task).slice(0, original.length)).toEqual(original);
  expect(ok("verify", "--task", task).ok).toBe(true);
}, 30_000);
