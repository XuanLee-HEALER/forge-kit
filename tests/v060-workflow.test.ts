import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { auditFixture, message, row, tokenCount, tokens } from "./helpers/audit-cli";
import { withReviewDelivery } from "./helpers/review-delivery";
import { cmd, feature, ledger, root, useReleaseFixture, verifyFeature } from "./helpers/release";

test("T02 actual Hook, review, runbook and fast-track approvals provide independent archive anchors", () => withReviewDelivery(w => {
  const f = auditFixture(w.s);
  for (const id of ["hook-only", "review-only", "book-only", "track-only"]) {
    f.put(id, [message(2, "user", id), tokenCount(3, tokens(10, 0, 0, 0, 0))]);
  }
  const refresh = () => {
    f.json("archive", w.task);
    return f.summary(w.task).sessions.map((item: { session_id: string }) => item.session_id).sort();
  };
  expect(refresh()).toEqual([]);

  const head = w.change("reviewed revision");
  const hook = w.s.hook("PostToolUse", {
    cwd: join(w.s.work, "app"), session_id: "hook-only", tool_use_id: "fixture-commit",
    tool_name: "Bash", tool_input: { command: "git commit -m ledger-fixture" },
    tool_response: { exit_code: 0, output: "fixture commit" },
  });
  for (const reply of hook) expect(reply.code, reply.text).toBe(0);
  expect(w.status().events).toContainEqual(expect.objectContaining({ session_id: "hook-only", sha: head }));
  expect(refresh()).toEqual(["hook-only"]);

  w.verify();
  w.native(w.base, head, { session: "review-only" });
  expect(refresh()).toEqual(["hook-only", "review-only"]);

  const book = () => w.ledger("runbook", "create", "--task", w.task, "--exact", "--push", "app:main", "--title", "Isolated archive");
  const standalone = book();
  expect(refresh()).toEqual(["hook-only", "review-only"]);
  w.s.hook("UserPromptSubmit", { session_id: "book-only", prompt: "批准 " + standalone.runbook_id });
  expect(w.ledger("runbook", "show", standalone.runbook_id).status).toBe("APPROVED");
  expect(refresh()).toEqual(["book-only", "hook-only", "review-only"]);

  const bound = book();
  const envelope = w.ledger("fast-track", "prepare", w.task, "--runbook", bound.runbook_id, "--paths", "revision.txt");
  expect(refresh()).toEqual(["book-only", "hook-only", "review-only"]);
  w.s.hook("UserPromptSubmit", { session_id: "track-only", prompt: envelope.approval });
  expect(w.ledger("fast-track", "status", envelope.envelope_id)[0].status).toBe("ACTIVE");
  expect(refresh()).toEqual(["book-only", "hook-only", "review-only", "track-only"]);
  expect(f.summary(w.task).usage.total_tokens).toBe(40);
}), 30_000);

test("T07 lifecycle milestones, review rounds and executable failure evidence", () => withReviewDelivery(w => {
  const f = auditFixture(w.s);
  const id = w.task;
  const original = w.status();
  const startedAt = Date.parse(original.task.created_at);
  const freezeAt = Date.parse(original.events.find((e: { event_type: string }) => e.event_type === "SPEC_FROZEN").ts);
  const headA = w.change("first candidate");
  const reviewStart = Date.now();
  w.native(w.base, headA, { session: "reviewer-one", role: "business" });
  w.native(w.base, headA, { session: "reviewer-two", role: "quality", status: "blocked" });
  const headB = w.change("second candidate");
  w.native(headA, headB, { session: "reviewer-three", role: "simplify", status: "incomplete" });
  const headC = w.change("third candidate");
  w.native(headB, headC, { session: "reviewer-four", role: "comments" });

  const app = join(w.s.work, "app");
  const verify = (args: string[]) => w.s.run([w.s.forge, "verify", "--task", id, "--cwd", app, ...args]);
  w.s.privateFile("app/revision.txt", "\n");
  w.git("add", "--", "revision.txt");
  w.git("commit", "-m", "Empty revision triggers the configured check");
  expect(verify(["--mode", "all", "--offline"]).code).not.toBe(0);
  w.change("passing configured check");
  expect(verify(["--mode", "all", "--offline"]).code).toBe(0);
  const lockTest = w.s.privateFile("app/tool.test.ts", `import { expect, test } from "bun:test"; test("assertion", () => expect(1).toBe(2));\n`);
  w.s.privateFile("app/package.json", JSON.stringify({scripts:{lint:"bun ./lint.ts", build:"bun build ./entry.ts"}}));
  w.s.privateFile("app/lint.ts", "process.exit(1);\n");
  w.s.privateFile("app/entry.ts", "export const broken = ;\n");
  w.git("add", "--", "tool.test.ts", "package.json", "lint.ts", "entry.ts");
  w.git("commit", "-m", "Failing native tools");
  const evidence = [
    ["test", "bun", "test", "./tool.test.ts"],
    ["lint", "bun", "run", "lint"],
    ["build", "bun", "run", "build"],
  ];
  for (const [kind, ...command] of evidence) expect(verify(["--kind", kind!, "--", ...command]).code).not.toBe(0);
  w.s.privateFile("app/tool.test.ts", readFileSync(lockTest, "utf8").replace("toBe(2)", "toBe(1)"));
  w.s.privateFile("app/lint.ts", "process.exit(0);\n");
  w.s.privateFile("app/entry.ts", "export const valid = 1;\n");
  w.git("add", "--", "tool.test.ts", "lint.ts", "entry.ts");
  w.git("commit", "-m", "Passing native tools");
  for (const [kind, ...command] of evidence) expect(verify(["--kind", kind!, "--", ...command]).code).toBe(0);

  const book = w.ledger("runbook", "create", "--task", id, "--exact", "--push", "app:main", "--title", "Ship milestone");
  w.s.hook("UserPromptSubmit", { session_id: "fixture-operator", prompt: "批准 " + book.runbook_id });
  const approved = w.ledger("runbook", "show", book.runbook_id);
  expect(approved.status).toBe("APPROVED");
  f.json("amend", id, "--scope", "test_spec", "--reason", "Test fixture rework");

  const record = (absolute: number, data: ReturnType<typeof row>) =>
    ({ ...data, timestamp: new Date(absolute).toISOString() });
  const reviewReceipt = w.status().events.find((e: { payload_json: string }) => JSON.parse(e.payload_json).kind === "review");
  expect(Date.parse(reviewReceipt.ts) - reviewStart).toBeGreaterThan(4);
  const verifyReceipt = w.status().events.find((e: { payload_json: string }) => JSON.parse(e.payload_json).kind === "verify");
  const verifyMeta = JSON.parse(verifyReceipt.payload_json).meta;
  const verifyStart = Date.parse(verifyMeta.started_at);
  expect(verifyMeta.duration_ms).toBeGreaterThan(4);
  const shipAt = Date.parse(approved.approved_at);
  const iso = (ms: number) => new Date(ms).toISOString();
  const completeTurn = (id: string, at: number, quantity: number) => [
    record(at + 1, row(0, "event_msg", { type: "task_started", turn_id: id, started_at: (at + 1) / 1000 })),
    record(at + 2, row(0, "turn_context", { turn_id: id, model: "fixture-stage-model", effort: "high" })),
    record(at + 3, tokenCount(0, tokens(quantity, 0, 0, 0, 0))),
    record(at + 4, row(0, "event_msg", { type: "task_complete", turn_id: id, started_at: (at + 1) / 1000, completed_at: (at + 4) / 1000 })),
  ];
  f.put("fixture-operator", [
    ...completeTurn("grill", startedAt, 11),
    ...completeTurn("impl", freezeAt, 13),
    ...completeTurn("verify", verifyStart, 17),
    ...completeTurn("ship", shipAt, 29),
  ], { startedAt: iso(startedAt) });
  f.put("reviewer-one", completeTurn("review", reviewStart, 19),
    { parent: "fixture-operator", role: "reviewer-business", startedAt: iso(reviewStart) });
  f.put("out-of-period", completeTurn("unclassified", startedAt - 50, 23),
    { parent: "fixture-operator", startedAt: iso(startedAt - 50) });
  f.put("cross-freeze", [
    record(freezeAt - 2, row(0, "turn_context", { model: "fixture-stage-model", effort: "high" })),
    record(freezeAt - 1, tokenCount(0, tokens(0, 0, 0, 0, 0), tokens(0, 0, 0, 0, 0))),
    record(freezeAt + 1, row(0, "event_msg", { type: "token_count", info: { total_token_usage: tokens(31, 0, 0, 0, 0) } })),
  ], { parent: "fixture-operator", role: "implementer", startedAt: iso(freezeAt - 2) });
  f.json("archive", id);
  const report = f.summary(id);
  expect(report.rework).toEqual({
    review_records: 4, review_rounds: 3, review_blocked: 1, review_incomplete: 1,
    verify_failures: 1, test_failures: 1, lint_failures: 1, build_failures: 1, spec_amendments: 1,
  });
  expect(Object.fromEntries(Object.entries(report.by_stage).map(([stage, bucket]) =>
    [stage, (bucket as { total_tokens: number }).total_tokens]))).toEqual({
    grill: 11, impl: 13, review: 19, verify: 17, ship: 29, unclassified: 54,
  });
  expect(report.usage.total_tokens).toBe(143);
  expect(f.json("cost", "--json").rework_top).toContainEqual(expect.objectContaining({ task_id: id, score: 7 }));
}), 60_000);

useReleaseFixture();

for (const [name, flags, codex, forge, expected] of [
  ["explicit", ["--session-id", "handoff-fixture"], "codex-operator", "forge-operator", "handoff-fixture"],
  ["codex", [], "codex-operator", "forge-operator", "codex-operator"],
  ["forge", ["--session-id", " "], " ", "forge-operator", "forge-operator"],
  ["absent", [], undefined, undefined, null],
] as const) {
  test(`T01 and T10 handoff commits the ${name} session and remains refreshable`, () => {
    const f = feature("audit-app", 1);
    verifyFeature(f);
    cmd("pr-sync", f.task, "--repo", f.repo, "--branch", f.branch, "--pr", String(f.n));
    const env = {
      FORGE_CODEX_SESSIONS_DIR: join(root, "sessions"),
      CODEX_THREAD_ID: codex,
      FORGE_SESSION_ID: forge,
    };
    const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    try {
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      const before = cmd("status", "--task", f.task).events;
      const dir = join(root, ".workbench/audit", f.task);
      cmd("handoff", f.task, ...flags);
      const state = cmd("status", "--task", f.task);
      expect(state.task.status).toBe("HANDED_OFF");
      expect(state.events.slice(0, before.length)).toEqual(before);
      expect(state.events.at(-1)).toMatchObject({ event_type: "HANDOFF_RECORDED", session_id: expected });
      expect(JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"))).toMatchObject({ status: "HANDED_OFF", archive_status: "no_rollout" });
      cmd("archive", f.task, "--no-trace");
      expect(existsSync(join(dir, "trace.jsonl"))).toBe(false);
      expect(cmd("status", "--task", f.task)).toEqual(state);
      expect(cmd("verify", "--task", f.task).ok).toBe(true);
      if (name === "explicit") {
        cmd("release", "create", "--tasks", f.task, "--title", "Protect historical audit");
        const old = new Date(Date.now() - 100 * 86_400_000).toISOString();
        // Preserve the actual release reference while preparing a historical closed task.
        ledger.db.query("UPDATE tasks SET status = 'CLOSED', closed_at = ? WHERE task_id = ?").run(old, f.task);
        expect(cmd("prune", "--before", "90").candidates).not.toContain(f.task);
        expect(cmd("prune", "--before", "90", "--apply").deleted).not.toContain(f.task);
        expect(existsSync(join(dir, "summary.json"))).toBe(true);
      }
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 30_000);
}

test("T11 failed automatic handoff archive preserves its durable state and can be retried", () => {
  const f = feature("audit-app", 1);
  verifyFeature(f);
  cmd("pr-sync", f.task, "--repo", f.repo, "--branch", f.branch, "--pr", String(f.n));
  const scope = join(root, ".workbench/audit");
  mkdirSync(scope, { mode: 0o500 });
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/bin/cli.ts"), "ledger",
    "handoff", f.task, "--session-id", "fixture-handoff"], {
      cwd: root, env: { ...process.env, FORGE_WORKBENCH_ROOT: root, FORGE_CODEX_SESSIONS_DIR: join(root, "sessions") },
  });
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toMatch(/archive|归档/i);
  const state = cmd("status", "--task", f.task);
  expect(state.task.status).toBe("HANDED_OFF");
  expect(state.events.at(-1)).toMatchObject({ event_type: "HANDOFF_RECORDED", session_id: "fixture-handoff" });
  chmodSync(scope, 0o700);
  // Pin the retry to an empty source in the fixture, including when the caller has its own Codex sessions.
  const retry = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/bin/cli.ts"), "ledger", "archive", f.task], {
    cwd: root, env: { ...process.env, FORGE_WORKBENCH_ROOT: root, FORGE_CODEX_SESSIONS_DIR: join(root, "sessions") },
  });
  expect(retry.exitCode).toBe(0);
  expect(cmd("status", "--task", f.task)).toEqual(state);
  expect(cmd("verify", "--task", f.task).ok).toBe(true);
}, 30_000);

test("T15 exact fast-track references protect an aged task and its audit directory", () => withReviewDelivery(w => {
  const f = auditFixture(w.s);
  w.s.env.FORGE_SESSION_ID = "fixture-operator";
  f.put("fixture-operator", [message(1, "user", "retained audit body")]);
  const head = w.change("verified isolated candidate");
  w.verify();
  w.native(w.base, head);
  w.deliver(w.authorize());
  const old = new Date(Date.now() - 100 * 86_400_000).toISOString();
  f.db(db => db.query("UPDATE tasks SET closed_at = ?, updated_at = ? WHERE task_id = ?").run(old, old, w.task));
  const audit = f.read(w.task, "summary.json");
  expect(f.json("prune", "--before", "90").candidates).not.toContain(w.task);
  expect(f.json("prune", "--before", "90", "--apply").deleted).not.toContain(w.task);
  expect(f.read(w.task, "summary.json")).toBe(audit);
}), 30_000);
