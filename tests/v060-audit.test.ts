import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, readFileSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { auditEpoch, message, permissions, rollout, row, timestamp, tokenCount, tokens, withAudit } from "./helpers/audit-cli";

function assertNoLeak(output: string, markers: string[]) {
  for (const [index, marker] of markers.entries()) {
    expect(output.includes(marker), "sensitive marker index " + index).toBe(false);
  }
}

test("T01 lifecycle commands use the selected session and preserve the chain", () => withAudit(f => {
  for (const [name, flags, codex, forge, expected] of [
    ["explicit", ["--session-id", "by-argument"], "by-codex", "by-forge", "by-argument"],
    ["codex", [], "by-codex", "by-forge", "by-codex"],
    ["forge", ["--session-id", " "], " ", "by-forge", "by-forge"],
    ["absent", [], undefined, undefined, null],
  ] as const) {
    if (codex === undefined) delete f.s.env.CODEX_THREAD_ID;
    else f.s.env.CODEX_THREAD_ID = codex;
    if (forge === undefined) delete f.s.env.FORGE_SESSION_ID;
    else f.s.env.FORGE_SESSION_ID = forge;

    f.open(name, [...flags]);
    const original = f.status(name).events[0];
    expect(original.session_id).toBe(expected);
    f.json("close", name, "--no-archive", ...flags);
    f.json("reopen", name, ...flags);
    const { task, events } = f.status(name);
    expect(task.status).toBe("OPEN");
    expect(events[0]).toEqual(original);
    for (const type of ["TASK_CLOSED", "TASK_REOPENED"]) {
      expect(events.filter((e: { event_type: string }) => e.event_type === type)).toMatchObject([{ session_id: expected }]);
    }
    expect(f.json("verify", "--task", name, "--json").ok).toBe(true);
    expect(existsSync(f.path(name))).toBe(false);
  }
  f.open("unverified", ["--endpoint", "pr", "--session-id", "known"]);
  const old = f.status("unverified");
  for (const action of ["handoff", "close"]) {
    expect(f.run(action, "unverified", "--session-id", "rejected").code).not.toBe(0);
    expect(f.status("unverified")).toEqual(old);
    expect(existsSync(f.path("unverified"))).toBe(false);
  }
}), 30_000);

test("T02 session directory precedence, fallback and archived sibling", () => withAudit(f => {
  const id = "selected";
  f.open(id, ["--session-id", id]);
  f.put(id, [message(4, "user", "selected directory")]);
  f.put("archived-child", [message(5, "user", "selected archived sibling")], { parent: id, archive: true });
  f.s.env.CODEX_HOME = join(f.s.work, "codex-home");
  rollout(f.s, "codex-home/sessions/rollout-selected.jsonl", id, [message(4, "user", "CODEX_HOME directory")]);
  rollout(f.s, "../home/.codex/sessions/rollout-selected.jsonl", id, [message(4, "user", "default directory")]);
  const refresh = () => {
    f.json("archive", id);
    return f.read(id, "trace.jsonl");
  };

  let trace = refresh();
  expect(trace).toContain("selected directory");
  expect(trace).toContain("selected archived sibling");
  expect(trace).not.toContain("CODEX_HOME directory");
  expect(trace).not.toContain("default directory");

  delete f.s.env.FORGE_CODEX_SESSIONS_DIR;
  trace = refresh();
  expect(trace).toContain("CODEX_HOME directory");
  expect(trace).not.toContain("selected archived sibling");
  expect(trace).not.toContain("default directory");

  delete f.s.env.CODEX_HOME;
  trace = refresh();
  expect(trace).toContain("default directory");
  expect(trace).not.toContain("CODEX_HOME directory");
}), 30_000);

test("T03 manual anchors discover whole deduplicated trees and preserve good records around damage", () => withAudit(f => {
  const id = "tree";
  const call = (n: number) => [tokenCount(1, tokens(n, 0, 0, 0, 0))];
  f.open(id, ["--session-id", "grandchild"]);
  const rootFile = f.put("root", [message(1, "user", "tree transient lookup"), ...call(10)]);
  f.put("first", call(20), { parent: "root" });
  f.put("grandchild", call(30), { parent: "first" });
  f.put("sibling", call(40), { parent: "root", archive: true });
  f.put("standalone", [message(1, "user", "unassociated marker"), ...call(900)]);
  f.json("archive", id);
  const initial = f.summary(id);
  expect(initial.sessions.map((s: { session_id: string }) => s.session_id).sort()).toEqual(["first", "grandchild", "root", "sibling"]);
  expect(initial.usage.total_tokens).toBe(100);
  const trace = f.read(id, "trace.jsonl");
  expect(trace).toContain("tree transient lookup");
  expect(trace).not.toContain("unassociated marker");

  copyFileSync(rootFile, f.s.privateFile(".codex-fixture/archived_sessions/rollout-duplicate-root.jsonl", ""));
  f.json("archive", id, "--session", "root");
  expect(f.summary(id).usage.total_tokens).toBe(100);
  expect(f.read(id, "trace.jsonl")).toBe(trace);
  expect(JSON.stringify(f.summary(id).warnings)).toMatch(/duplic/i);

  f.put("other-root", call(50));
  f.json("archive", id, "--session", "other-root");
  expect(f.summary(id).usage.total_tokens).toBe(150);
  expect(JSON.stringify(f.summary(id).warnings)).toMatch(/root/i);

  f.put("orphan", [message(1, "user", "before malformed"), "malformed", message(3, "user", "after malformed"), ...call(60)],
    { parent: "missing-parent" });
  f.json("archive", id, "--session", "orphan");
  expect(f.summary(id).usage.total_tokens).toBe(160);
  expect(f.read(id, "trace.jsonl")).toContain("before malformed");
  expect(f.read(id, "trace.jsonl")).toContain("after malformed");
  expect(JSON.stringify(f.summary(id).warnings)).toMatch(/parent/i);
}), 30_000);

function turn(seconds: number, id: string, kind: "task_started" | "task_complete") {
  return row(seconds, "event_msg", { type: kind, turn_id: id, [kind === "task_started" ? "started_at" : "completed_at"]: Date.parse(timestamp(seconds)) / 1000 });
}

test("T04 summary reports elapsed and unioned activity with missing evidence", () => withAudit(f => {
  const id = "times";
  f.open(id, ["--session-id", "root"]);
  f.put("root", [
    turn(1, "r1", "task_started"), row(2, "turn_context", { turn_id: "r1", model: "model-a", effort: "high" }),
    row(2, "response_item", { type: "function_call", call_id: "once", name: "shell", arguments: "{}" }),
    row(3, "response_item", { type: "function_call_output", call_id: "once", output: "ok" }),
    turn(5, "r1", "task_complete"), turn(10, "r2", "task_started"), turn(12, "r2", "task_complete"),
    turn(14, "open-ended", "task_started"),
  ]);
  f.put("child", [turn(3, "c1", "task_started"), turn(8, "c1", "task_complete")], { parent: "root", role: "implementer" });
  f.json("archive", id);
  const open = f.summary(id);
  expect(open).toMatchObject({
    task_id: id, status: "OPEN", endpoint: "investigation", closed_at: null, active_ms: 9000,
  });
  expect(open.wall_clock_ms).toBe(Date.parse(open.captured_at) - Date.parse(open.created_at));
  expect(open.sessions).toContainEqual(expect.objectContaining({
    session_id: "root", role: "main", model: "model-a", effort: "high", tool_calls: 1, started_at: auditEpoch,
  }));
  expect(open.sessions).toContainEqual(expect.objectContaining({ session_id: "child", role: "implementer", model: null, effort: null }));
  expect(open.warnings.length).toBeGreaterThan(0);
  const closed = f.json("close", id);
  const summary = f.summary(id);
  expect(summary).toMatchObject({ status: "CLOSED", closed_at: closed.task.closed_at, created_at: open.created_at, active_ms: 9000 });
  expect(summary.wall_clock_ms).toBe(Date.parse(summary.closed_at) - Date.parse(summary.created_at));
  const md = f.read(id, "summary.md");
  for (const value of [id, summary.status, summary.endpoint, summary.created_at, summary.closed_at, summary.archive_status])
    expect(md).toContain(value);
}), 30_000);

test("T08-T09 trace keeps ordinary messages, minimizes tools and redacts sensitive data", () => withAudit(f => {
  const id = "privacy";
  const source = "ordinary path /Users/build/project.ts and sha e5558bb3d0195b87d2f9d5fe7ab3b41207293b04";
  const notice = source + "\n\nTask owner reviews a rollout after freeze. UUID 018ed16e-2864-7f1e-9c2f-c86144f91da8; " + timestamp(2);
  const examples = [
    ["postgres://operator:AuditUriPassword@localhost/db", "AuditUriPassword"],
    ["Authorization: Bearer access-secret-abcdef", "access-secret-abcdef"],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhdWRpdCJ9.abcdefghijk", "eyJzdWIiOiJhdWRpdCJ9"],
    ["FORGE_API_KEY=fixture-environment-secret", "fixture-environment-secret"],
    ["--api-key fixture-flag-secret", "fixture-flag-secret"],
    ["sk-auditFixtureOnly1234567890abcdefghijkl", "auditFixtureOnly1234567890abcdefghijkl"],
    ["ghp_0123456789abcdefghijklmnopqrstuvwxyz", "0123456789abcdefghijklmnopqrstuvwxyz"],
    ["AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE"],
    ["-----BEGIN PRIVATE KEY-----\nSYNTHETIC_PEM_LINE\n-----END PRIVATE KEY-----", "SYNTHETIC_PEM_LINE"],
    ["synthetic.audit@example.invalid", "synthetic.audit@example.invalid"],
    ["+1 (415) 555-0139", "555-0139"],
  ];
  const sensitive = examples.map(([shape]) => shape).join("\n");
  const params = JSON.stringify({
    command: "inspect file --api-key fixture-tool-secret",
    instructions: "<developer>PARAM_TEMPLATE_MARKER</developer>", content: "PARAM_FILE_BODY",
  });
  const toolOutput = "<developer>OUTPUT_TEMPLATE_MARKER</developer>\n" +
    "<file_content>OUTPUT_FILE_BODY</file_content>\n" +
    "Authorization: Bearer fixture-output-secret\n" + "界".repeat(1000);
  f.put(id, [
    message(9, "assistant", notice),
    message(2, "user", notice), message(3, "user", "ordinary free-form label\n" + sensitive),
    row(4, "response_item", { type: "custom_tool_call", name: "apply_patch", call_id: "custom", input: params }),
    row(5, "response_item", { type: "custom_tool_call_output", call_id: "custom", output: toolOutput }),
    row(6, "response_item", { type: "function_call", name: "shell", call_id: "function", arguments: params }),
    row(7, "response_item", { type: "function_call_output", call_id: "function", output: toolOutput }),
    row(7, "response_item", { type: "function_call", name: "weather", call_id: "long", arguments: '{"city":"Fixture"}' }),
    row(7, "response_item", {
      type: "function_call_output", call_id: "long",
      output: "Authorization: Bearer fixture-output-secret\n" + "界".repeat(1000),
    }),
    row(8, "response_item", { type: "reasoning", encrypted_content: "ENCRYPTED_CONTENT_MARKER" }),
    tokenCount(9, tokens(20, 1, 0, 5, 1)),
  ]);
  const inaccessible = f.put("inaccessible", [message(1, "user", "INACCESSIBLE_MARKER")], { parent: id });
  f.open(id, ["--session-id", id]);
  let run = (args: string[]) => f.s.run(args);
  if (process.getuid?.() === 0) {
    const uid = Number(f.s.ok(["id", "-u", "nobody"]).trim());
    const gid = Number(f.s.ok(["id", "-g", "nobody"]).trim());
    const bun = join(f.s.bin, "bun");
    unlinkSync(bun);
    copyFileSync(process.execPath, bun);
    f.s.ok(["chown", "-RP", uid + ":" + gid, f.s.root]);
    run = args => {
      const result = spawnSync(args[0]!, args.slice(1), {
        cwd: f.s.work, env: f.s.env, uid, gid, encoding: "utf8",
      });
      if (result.error || result.status === null) throw result.error ?? new Error("Unprivileged audit probe failed to launch");
      return { code: result.status, out: result.stdout, err: result.stderr };
    };
  }
  chmodSync(inaccessible, 0);
  try {
    const probe = run(["/bin/cat", inaccessible]);
    expect(probe.code).not.toBe(0);
    expect(probe.err).toMatch(/permission denied/i);
    const close = run([f.s.forge, "ledger", "close", id, "--summary", "legacy summary anchor --api-key fixture-legacy-secret"]);
    expect(close.code).toBe(0);
    const legacy = JSON.parse(close.out).archivePath;
    const archive = run([f.s.forge, "ledger", "archive", id]);
    expect(archive.code).toBe(0);
    const md = f.read(id, "summary.md");
    const traceText = f.read(id, "trace.jsonl");
    const trace = f.trace(id);
    expect(trace.map((event: { ts: string }) => event.ts)).toEqual(trace.map((event: { ts: string }) => event.ts).sort());
    for (const [at, kind] of [[2, "user_message"], [9, "assistant_final"]] as const) {
      const event = trace.find((candidate: { kind: string; ts: string }) => candidate.kind === kind && candidate.ts === timestamp(at));
      expect(event).toMatchObject({ role: "main", session_id: id, text: notice });
    }
    expect(traceText).toContain("ordinary free-form label");
    expect(traceText).toContain("inspect file");
    for (const name of ["apply_patch", "shell"]) expect(traceText).toContain(name);
    const outputs = trace.filter((event: { kind: string }) => /_output$/.test(event.kind));
    expect(outputs).toHaveLength(3);
    for (const output of outputs) {
      expect(Buffer.byteLength(output.output_summary, "utf8")).toBeLessThanOrEqual(2048);
      expect(output.output_summary).not.toContain("�");
    }
    const long = outputs.find((event: { tool: string }) => event.tool === "weather").output_summary;
    expect(long).toContain("界");
    expect(Buffer.byteLength(long, "utf8")).toBeGreaterThan(2000);
    expect(md.includes(notice)).toBe(false);
    expect(f.summary(id).archive_status).toBe("partial");
    expect(JSON.stringify(f.summary(id).warnings)).toMatch(/encrypt/i);
    expect(JSON.stringify(f.summary(id).warnings)).toMatch(/read|permission/i);
    const allOutput = [readFileSync(legacy, "utf8"), md, f.read(id, "summary.json"), traceText,
      archive.out, archive.err, close.out, close.err].join("\n");
    expect(readFileSync(legacy, "utf8")).toContain("legacy summary anchor");
    assertNoLeak(allOutput, [
      ...examples.map(([, marker]) => marker), "fixture-tool-secret", "fixture-output-secret", "fixture-legacy-secret",
      "PARAM_TEMPLATE_MARKER", "PARAM_FILE_BODY", "OUTPUT_TEMPLATE_MARKER", "OUTPUT_FILE_BODY",
      "ENCRYPTED_CONTENT_MARKER", "INACCESSIBLE_MARKER",
    ]);
    expect(permissions(f.path(id))).toBe(0o700);
    for (const file of ["summary.json", "summary.md", "trace.jsonl"]) expect(permissions(f.path(id, file))).toBe(0o600);
  } finally {
    chmodSync(inaccessible, 0o600);
  }
}), 30_000);

test("T10-T11 manual refresh is idempotent and output failures preserve state", () => withAudit(f => {
  const id = "refresh";
  const root = f.put(id, [
    turn(1, "turn", "task_started"), row(1, "turn_context", { turn_id: "turn", model: "model-a", effort: "high" }),
    message(2, "user", "first"), message(3, "assistant", "final"), tokenCount(3, tokens(2, 1, 0, 1, 0)),
    turn(4, "turn", "task_complete"),
  ]);
  f.open(id, ["--session-id", id]);
  f.json("archive", id);
  expect(f.summary(id).archive_status).toBe("complete");
  const trace = f.read(id, "trace.jsonl");
  const opened = f.status(id);
  f.json("archive", id);
  expect(f.read(id, "trace.jsonl")).toBe(trace);
  expect(f.status(id)).toEqual(opened);
  f.json("archive", id, "--no-trace");
  expect(readdirSync(f.path(id)).sort()).toEqual(["summary.json", "summary.md"]);

  f.open("skip");
  f.json("close", "skip", "--no-archive");
  expect(existsSync(f.path("skip"))).toBe(false);
  f.json("archive", "skip");
  expect(f.summary("skip")).toMatchObject({ status: "CLOSED", archive_status: "no_rollout" });
  f.open("cancelled");
  f.json("cancel", "cancelled", "--reason", "cancel fixture");
  f.json("archive", "cancelled");
  expect(f.summary("cancelled")).toMatchObject({ status: "CANCELLED", archive_status: "no_rollout" });

  renameSync(join(root, ".."), join(root, "..", "../moved"));
  f.json("archive", "skip");
  expect(f.summary("skip").archive_status).toBe("no_rollout");
  expect(f.summary("skip").warnings.length).toBeGreaterThan(0);
  expect(existsSync(f.path("skip", "summary.md"))).toBe(true);

  const before = f.read(id, "summary.json");
  chmodSync(f.path(id), 0o500);
  chmodSync(join(f.path(id), ".."), 0o500);
  try {
    expect(f.run("archive", id).code).not.toBe(0);
    expect(f.read(id, "summary.json")).toBe(before);
    expect(readdirSync(f.path(id)).sort()).toEqual(["summary.json", "summary.md"]);
    expect(f.status(id)).toEqual(opened);

    f.open("close-failure");
    const close = f.run("close", "close-failure");
    expect(close.code).toBe(0);
    expect(close.err).toMatch(/archive|归档/i);
    expect(f.status("close-failure").task.status).toBe("CLOSED");
    expect(f.json("verify", "--task", "close-failure").ok).toBe(true);
  } finally {
    chmodSync(join(f.path(id), ".."), 0o700);
    chmodSync(f.path(id), 0o700);
  }
  f.json("archive", "close-failure");
  expect(f.summary("close-failure").status).toBe("CLOSED");
  expect(f.status("close-failure").events.map((e: { event_type: string }) => e.event_type)).toEqual(["TASK_OPENED", "TASK_CLOSED"]);
}), 30_000);
