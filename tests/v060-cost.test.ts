import { expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { digest } from "./helpers/historical-kit";
import { message, row, tokenCount, tokens, withAudit } from "./helpers/audit-cli";

const usageKeys = [
  "input_tokens", "cached_input_tokens", "uncached_input_tokens", "cache_write_input_tokens",
  "output_tokens", "reasoning_output_tokens", "total_tokens",
] as const;
const context = (at: number, model: string) => row(at, "turn_context", { turn_id: "turn", model, effort: "high" });

function assertConservation(report: Record<string, any>) {
  for (const dimension of [report.by_role, report.by_stage]) {
    for (const key of usageKeys) {
      const measurements = Object.values(dimension).map(bucket => (bucket as Record<string, number | null>)[key]);
      expect(measurements.reduce<number>((sum, value) => sum + (value ?? 0), 0)).toBe(report.usage[key]);
    }
  }
}

function usage(input: number, cached: number, cacheWrite: number, output: number, reasoning: number) {
  return { ...tokens(input, cached, cacheWrite, output, reasoning),
    uncached_input_tokens: input - cached, cache_hit_rate: input ? cached / input : null };
}

test("T05, T12, T13 raw usage, read-time per-model pricing and weighted aggregate", () => withAudit(f => {
  f.open("measured-a", ["--session-id", "a"]);
  const totalOne = tokens(100, 40, 10, 30, 8);
  const totalTwo = tokens(150, 60, 15, 50, 12);
  const change = tokens(50, 20, 5, 20, 4);
  const repeated = tokenCount(4, change, totalTwo);
  f.put("a", [context(1, "model-a"), tokenCount(2, tokens(0, 0, 0, 0, 0), tokens(0, 0, 0, 0, 0)),
    tokenCount(3, totalOne, totalOne), repeated, repeated,
    row(4, "token_usage_record", { thread_id: "a", session_id: "a", turn_id: "turn", response_id: "a-last",
      usage: change, thread_token_usage: totalTwo }),
  ]);
  const last = tokens(40, 10, 2, 5, 1);
  const repeatedLast = { ...tokenCount(4, last), ordinal: 2 };
  f.put("a-child", [context(1, "model-b"), repeatedLast, repeatedLast, tokenCount(5, last)],
    { parent: "a", role: "implementer" });
  f.json("archive", "measured-a");
  const first = f.summary("measured-a");
  expect(first.usage).toEqual(usage(230, 80, 19, 60, 14));
  expect(first.by_model).toMatchObject({ "model-a": usage(150, 60, 15, 50, 12), "model-b": usage(80, 20, 4, 10, 2) });
  expect(first.by_role).toMatchObject({ main: usage(150, 60, 15, 50, 12), implementer: usage(80, 20, 4, 10, 2) });
  assertConservation(first);

  const args = ["cost", "measured-a", "--json"];
  const eventState = f.status("measured-a");
  const artefact = f.read("measured-a", "summary.json");
  const trace = f.read("measured-a", "trace.jsonl");
  const cost = () => f.json(...args);
  expect(cost().estimated_cost).toBeNull();
  expect(f.call("cost", "measured-a")).toContain("—");
  const prices = f.s.read(".workbench/models.toml");
  const item = (model: string, input: string, cached: string, output: string) =>
    `\n[pricing."${model}"]\ninput_per_1m = ${input}\ncached_input_per_1m = ${cached}\noutput_per_1m = ${output}\n`;
  const priceA = item("model-a", "2", "1", "4");
  const priceB = item("model-b", "3", "2", "5");
  const price = (sections: string) => f.s.privateFile(".workbench/models.toml", prices + sections);
  price(priceA);
  expect(cost().estimated_cost).toBeNull();
  price(priceA + priceB);
  expect(cost().estimated_cost).toBeCloseTo(0.000710, 12);
  expect(cost().usage).toEqual(first.usage);
  expect(cost().by_stage).toEqual(first.by_stage);
  expect(cost().by_role).toEqual(first.by_role);
  expect(cost().rework).toEqual(first.rework);
  price(priceA.replace("2\n", "2000000\n") + priceB);
  const publicText = f.call("cost", "measured-a");
  expect(publicText).toContain("230");
  expect(publicText).toContain("290");
  expect(publicText).toMatch(/180[.,]00/);
  expect(cost().estimated_cost).toBeCloseTo(180.000530, 10);
  price(item("model-a", "0", "0", "0") + item("model-b", "0", "0", "0"));
  expect(cost().estimated_cost).toBe(0);
  for (const invalid of ["-1", "inf", "nan"]) {
    price(item("model-a", invalid, "1", "4") + priceB);
    expect(cost().estimated_cost).toBeNull();
  }

  expect(f.status("measured-a")).toEqual(eventState);
  expect(f.read("measured-a", "summary.json")).toBe(artefact);
  expect(f.read("measured-a", "trace.jsonl")).toBe(trace);

  f.open("measured-b", ["--session-id", "b"]);
  f.put("b", [context(1, "model-a"), tokenCount(2, tokens(50, 40, 0, 10, 0))]);
  // Time-window distinctions use a fixture-only date. The original target was opened via CLI.
  const older = new Date(Date.now() - 5 * 86_400_000).toISOString();
  f.db(db => db.query("UPDATE tasks SET created_at = ? WHERE task_id = ?").run(older, "measured-a"));
  f.json("archive", "measured-a");
  f.json("archive", "measured-b");
  const both = f.json("cost", "--days", "6", "--json");
  expect(both.coverage).toMatchObject({ matched_tasks: 2, readable_summaries: 2 });
  expect(both.usage).toEqual(usage(280, 120, 19, 70, 14));
  expect(both.average_usage.total_tokens).toBe(175);
  expect(both.role_shares.implementer).toBeCloseTo(90 / 350);
  expect(both.role_shares.main).toBeCloseTo(260 / 350);
  for (const [stage, bucket] of Object.entries(both.by_stage as Record<string, { total_tokens: number }>)) {
    if (bucket.total_tokens) expect(both.stage_shares[stage]).toBeCloseTo(bucket.total_tokens / 350);
  }
  assertConservation(both);
  const recent = f.json("cost", "--days", "1", "--json");
  expect(recent.coverage.matched_tasks).toBe(1);
  expect(recent.usage).toEqual(usage(50, 40, 0, 10, 0));

  f.open("without-summary");
  const missing = f.run("cost", "without-summary");
  expect(missing.out + missing.err).toMatch(/summary|摘要/i);
  f.open("damaged-summary");
  f.s.privateFile(".workbench/audit/damaged-summary/summary.json", "bad JSON");
  f.open("without-rollout");
  f.json("archive", "without-rollout");
  const incomplete = f.json("cost", "--days", "6", "--json");
  expect(incomplete.coverage).toMatchObject({ matched_tasks: 5, missing_summaries: 1, damaged_summaries: 1 });
  expect(incomplete.usage).toEqual(both.usage);
  expect(incomplete.average_usage.total_tokens).toBe(both.average_usage.total_tokens);
  for (const invalid of ["0", "-1", "1.5", "abc"]) expect(f.run("cost", "--days", invalid, "--json").code).not.toBe(0);
}), 30_000);

test("T05-T06 models and roles retain their own increments, incomplete counters do not create usage", () => withAudit(f => {
  const id = "roles";
  const zero = tokens(0, 0, 0, 0, 0);
  f.open(id, ["--session-id", id]);
  f.put(id, [
    context(1, "model-first"), tokenCount(2, tokens(0, 0, 0, 4, 1)),
    context(3, "model-second"), tokenCount(4, tokens(0, 0, 0, 2, 0)),
  ]);
  const roles = ["implementer", "reviewer-business", "reviewer-quality", "reviewer-simplify", "reviewer-comments", "analyst", "scanner", "other"];
  for (const [index, role] of roles.entries()) {
    f.put("child-" + index, [tokenCount(1, tokens(0, 0, 0, index + 1, 0))], { parent: id, role });
  }
  f.put("unknown-role", [tokenCount(1, tokens(0, 0, 0, 9, 0))], { parent: id });
  f.json("archive", id);
  const report = f.summary(id);
  expect(report.usage).toEqual(usage(0, 0, 0, 51, 1));
  expect(report.by_model["model-first"]).toEqual(usage(0, 0, 0, 4, 1));
  expect(report.by_model["model-second"]).toEqual(usage(0, 0, 0, 2, 0));
  for (const [index, role] of roles.entries())
    expect(report.by_role[role].total_tokens).toBe(index + 1 + (role === "other" ? 9 : 0));
  const unknown = report.sessions.find((session: { session_id: string }) => session.session_id === "unknown-role");
  expect(unknown).toBeDefined();
  if (unknown.role !== null) {
    expect(JSON.stringify(report.warnings)).toMatch(/role.{0,200}(?:missing|unknown)|(?:missing|unknown).{0,200}role/i);
  }
  assertConservation(report);

  f.open("reset", ["--session-id", "reset"]);
  const large = tokens(20, 8, 0, 5, 1);
  f.put("reset", [context(1, "main-model"), tokenCount(2, zero, zero), tokenCount(3, large, large),
    tokenCount(4, zero, tokens(18, 9, 0, 4, 1)),
    tokenCount(5, zero, { ...tokens(2, 0, 0, 1, 0), total_tokens: 1_000 }),
  ]);
  f.put("unknown-base", [tokenCount(1, zero, large)], { parent: "reset" });
  f.put("measured-later", [tokenCount(6, tokens(2, 1, 0, 5, 0))], { parent: "reset" });
  f.json("archive", "reset");
  const partial = f.summary("reset");
  expect(partial.usage).toEqual(usage(22, 9, 0, 10, 1));
  expect(partial.warnings.length).toBeGreaterThan(0);
  expect(partial.archive_status).toBe("partial");
}), 30_000);

test("T14-T15 trace retention and destructive prune with rollback and retry", () => withAudit(f => {
  const config = parse(f.s.read(".workbench/workbench.yaml"));
  f.s.privateFile(".workbench/workbench.yaml", stringify({ ...config, ledger: { ...config.ledger, retention_days: 4 } }));
  const old = new Date(Date.now() - 9 * 86_400_000).toISOString();
  for (const [task, state, expired] of [["closed", "CLOSED", true], ["cancelled", "CANCELLED", true],
    ["recent", "CLOSED", false], ["open", "OPEN", true], ["handoff", "HANDED_OFF", true]] as const) {
    f.open(task, ["--session-id", task]);
    f.put(task, [message(1, "user", task), tokenCount(2, tokens(1, 0, 0, 2, 0))]);
    if (state === "CLOSED") f.json("close", task);
    if (state === "CANCELLED") f.json("cancel", task, "--reason", "fixture");
    if (expired) {
      f.db(db => db.query("UPDATE tasks SET status = ?, closed_at = ?, updated_at = ? WHERE task_id = ?")
        .run(state, state === "OPEN" || state === "HANDED_OFF" ? null : old, old, task));
    }
    f.json("archive", task);
  }
  const trace = (task: string) => f.path(task, "trace.jsonl");
  const cost = (task: string) => f.json("cost", task, "--json");
  const original = cost("closed");
  const tracePreview = f.json("prune", "--audit-traces-only");
  expect(tracePreview.candidates.sort()).toEqual(["cancelled", "closed"]);
  expect(tracePreview.deleted).toEqual([]);
  expect(existsSync(trace("closed"))).toBe(true);
  const traceApply = f.json("prune", "--audit-traces-only", "--apply");
  expect(traceApply.deleted.sort()).toEqual(["cancelled", "closed"]);
  for (const id of ["closed", "cancelled"]) {
    expect(existsSync(trace(id))).toBe(false);
    expect(existsSync(f.path(id, "summary.md"))).toBe(true);
  }
  for (const id of ["recent", "open", "handoff"]) expect(existsSync(trace(id))).toBe(true);
  expect(cost("closed")).toEqual(original);
  expect(f.json("prune", "--audit-traces-only", "--apply").deleted).toEqual([]);

  const preview = f.json("prune", "--before", "4");
  expect(preview.candidates.sort()).toEqual(["cancelled", "closed"]);
  expect(preview.deleted).toEqual([]);
  const oldState = f.status("closed");
  const summaryFiles = ["summary.json", "summary.md"].map(file => f.path("closed", file));
  const hashes = summaryFiles.map(digest);
  const scope = join(f.path("closed"), "..");
  chmodSync(scope, 0o500);
  try {
    const fault = f.run("prune", "--before", "4", "--apply");
    expect(fault.code).not.toBe(0);
    expect(f.status("closed")).toEqual(oldState);
    expect(summaryFiles.map(digest)).toEqual(hashes);
  } finally {
    chmodSync(scope, 0o700);
  }
  expect(cost("closed")).toEqual(original);
  f.db(db => db.exec(`CREATE TRIGGER refuse_test_delete BEFORE DELETE ON tasks
    WHEN OLD.task_id = 'closed' BEGIN SELECT RAISE(ABORT, 'test delete failure'); END`));
  const fault = f.run("prune", "--before", "4", "--apply");
  expect(fault.code).not.toBe(0);
  expect(f.status("closed")).toEqual(oldState);
  expect(summaryFiles.map(digest)).toEqual(hashes);
  expect(cost("closed")).toEqual(original);
  f.db(db => db.exec("DROP TRIGGER refuse_test_delete"));
  expect(f.json("prune", "--before", "4", "--apply").deleted.sort()).toEqual(["cancelled", "closed"]);
  expect(existsSync(f.path("closed"))).toBe(false);
  expect(existsSync(f.path("cancelled"))).toBe(false);
  expect(f.json("prune", "--before", "4").candidates).toEqual([]);
}), 30_000);

test("T16 valid summary through a terminal symlink is out of scope for reads and writes", () => withAudit(f => {
  for (const [id, quantity] of [["target", 8765], ["neighbor", 21]] as const) {
    f.open(id, ["--session-id", id]);
    f.put(id, [tokenCount(1, tokens(quantity, 0, 0, 0, 0))]);
    f.json("archive", id);
  }
  const target = f.path("target", "summary.json");
  const neighbor = f.path("neighbor", "summary.json");
  const outside = join(f.s.root, "standalone-valid-summary.json");
  writeFileSync(outside, readFileSync(target), { mode: 0o600 });
  rmSync(target);
  symlinkSync(outside, target);
  const hashes = [outside, neighbor].map(digest);

  const single = f.run("cost", "target", "--json");
  expect(single.out + single.err).not.toContain("8765");
  const aggregate = f.json("cost", "--json");
  expect(aggregate.usage.total_tokens).toBe(21);
  expect(aggregate.coverage).toMatchObject({ matched_tasks: 2, readable_summaries: 1, damaged_summaries: 1 });
  f.run("archive", "target");
  expect([outside, neighbor].map(digest)).toEqual(hashes);
  rmSync(target, { force: true });
  f.json("archive", "target");
  expect(f.summary("target").usage.total_tokens).toBe(8765);
  expect(f.run("archive", "../neighbor").code).not.toBe(0);
  expect(digest(neighbor)).toBe(hashes[1]!);
}), 30_000);

test("T13 rework Top sorts by the promised score, with task ID breaking ties", () => withAudit(f => {
  for (const [id, score] of [["case-z", 3], ["case-a", 3], ["case-first", 4], ["case-empty", 0]] as const) {
    f.open(id, ["--session-id", id]);
    f.put(id, [tokenCount(1, tokens(1, 0, 0, 0, 0))]);
    f.s.privateFile(".workbench/specs/" + id + "/scope.md", "Case scope\n");
    for (let index = 0; index < score; index++) {
      f.json("freeze", id);
      f.json("amend", id, "--scope", "test_spec", "--reason", "Fixture amendment " + index);
    }
    f.json("archive", id);
  }
  const report = f.json("cost", "--json");
  expect(report.rework_top.slice(0, 3).map((entry: { task_id: string; score: number }) => [entry.task_id, entry.score]))
    .toEqual([["case-first", 4], ["case-a", 3], ["case-z", 3]]);
}), 30_000);

test("T16 source, audit root, task and trace links leave out-of-scope data untouched", () => withAudit(f => {
  f.open("victim", ["--session-id", "victim"]);
  const fakeRollout = f.put("victim", [message(1, "user", "outside-source-canary"), tokenCount(2, tokens(7766, 0, 0, 0, 0))]);
  const outsideRollout = join(f.s.root, "outside-rollout.jsonl");
  renameSync(fakeRollout, outsideRollout);
  symlinkSync(outsideRollout, fakeRollout);
  f.json("archive", "victim");
  expect(f.summary("victim").archive_status).toBe("no_rollout");
  if (existsSync(f.path("victim", "trace.jsonl"))) {
    expect(f.read("victim", "trace.jsonl").includes("outside-source-canary")).toBe(false);
  }
  expect(f.summary("victim").usage.total_tokens).not.toBe(7766);
  rmSync(fakeRollout);
  f.put("victim", [message(1, "user", "valid within boundary"), tokenCount(2, tokens(16, 0, 0, 0, 0))]);
  f.json("close", "victim");
  f.open("neighbor", ["--session-id", "neighbor"]);
  f.put("neighbor", [message(1, "user", "neighbor-canary"), tokenCount(2, tokens(21, 0, 0, 0, 0))]);
  f.json("archive", "neighbor");
  const neighbor = f.path("neighbor", "summary.json");
  const neighborTrace = f.path("neighbor", "trace.jsonl");
  const hashes = [outsideRollout, neighbor, neighborTrace].map(digest);
  const audit = join(f.path("victim"), "..");
  const outsideAudit = join(f.s.root, "outside-audit");
  renameSync(audit, outsideAudit);
  symlinkSync(outsideAudit, audit);
  expect(f.run("archive", "victim").code).not.toBe(0);
  expect(f.run("cost", "victim", "--json").out).not.toContain('"total_tokens": 16');
  rmSync(audit);
  renameSync(outsideAudit, audit);

  const moved = join(f.s.root, "intact-victim");
  renameSync(f.path("victim"), moved);
  symlinkSync(f.path("neighbor"), f.path("victim"));
  expect(f.run("archive", "victim").code).not.toBe(0);
  expect(f.run("cost", "victim", "--json").out).not.toContain('"total_tokens": 21');
  rmSync(f.path("victim"));
  renameSync(moved, f.path("victim"));

  const victimTrace = f.path("victim", "trace.jsonl");
  rmSync(victimTrace);
  symlinkSync(neighborTrace, victimTrace);
  const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
  f.db(db => db.query("UPDATE tasks SET closed_at = ?, updated_at = ? WHERE task_id = ?").run(old, old, "victim"));
  f.run("prune", "--audit-traces-only", "--apply");
  expect([outsideRollout, neighbor, neighborTrace].map(digest)).toEqual(hashes);
  rmSync(victimTrace, {force: true});
  f.json("archive", "victim");
  expect(f.summary("victim").usage.total_tokens).toBe(16);
  expect(f.json("prune", "--before", "90", "--apply").deleted).toEqual(["victim"]);
  expect([outsideRollout, neighbor, neighborTrace].map(digest)).toEqual(hashes);
}), 30_000);
