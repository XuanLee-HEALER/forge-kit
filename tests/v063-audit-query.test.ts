import { expect, test } from "bun:test";
import { createTrace } from "../src/audit/trace";
import { redactAuditArguments } from "../src/shared/redact";

test("audit messages retain the diagnosis and follow-up around a multiline runtime query", () => {
  const text = [
    "Queue backlog confirmed.",
    "",
    "Here's the command: forge rt query --expr 'first fixture line",
    "second fixture line' " + String.fromCharCode(92),
    "  --param scope=private-fixture",
    "",
    "Owner will verify recovery with $(date).",
  ].join("\n");
  for (const role of ["user", "assistant"]) {
    const { trace } = createTrace([{ type: "response_item", ts: null, ordinal: 1,
      payload: { type: "message", role, phase: "final_answer", content: text } }], "fixture-session", role);
    expect(trace).toHaveLength(1);
    expect(trace[0].text).toBe("Queue backlog confirmed.\n\n[runtime query arguments omitted]\n\nOwner will verify recovery with $(date).");
  }
  expect(redactAuditArguments(["forge", "rt", "query", "--expr", "first fixture line", "--param=scope=private-fixture"]))
    .toEqual(["forge", "rt", "query", "--expr", "***", "--param=***"]);
});

test("query examples retain Markdown handoff paragraphs and suppress opaque nested shell data", () => {
  const begin = "Observed backlog.";
  const end = "Retry owner is assigned.";
  for (const command of [
    "Example: `forge rt query --expr 'SCAN 0' --param scope=opaque-value`.",
    String.raw`forge rt query --expr "SELECT \"status\" FROM jobs"`,
    'forge rt query --expr "$(case x in x) printf foo "first field\nsensitive continuation";; esac)"',
    'forge rt query --expr "$(printf \'%s\' "first field\nsensitive continuation")"',
  ]) {
    const text = [begin, "", command, "", end].join("\n");
    const { trace } = createTrace([{ type: "response_item", ts: null, ordinal: 1,
      payload: { type: "message", role: "assistant", phase: "final_answer", content: text } }], "test", "assistant");
    expect(trace[0].text).toContain(begin);
    expect(trace[0].text).toContain("[runtime query arguments omitted]");
    expect(trace[0].text).not.toMatch(/opaque-value|SCAN 0|SELECT|first field|sensitive continuation/);
    if (!command.includes("$(")) expect(trace[0].text).toContain(end);
  }
});

test("neighboring Markdown spans and simple variable references retain the independent handoff", () => {
  const invocation = 'forge rt query --env "${ENV}" --expr "a private query"';
  for (const line of [invocation, "Inspect `jobs` with ``" + invocation + "``.",
    "Inspect `" + invocation + "` on `jobs`."]) {
    const text = "Diagnosis.\n\n" + line + "\n\nOwner will verify recovery.";
    const { trace } = createTrace([{ type: "response_item", ts: null, ordinal: 1,
      payload: { type: "message", role: "assistant", phase: "final_answer", content: text } }], "test", "assistant");
    expect(trace[0].text).toBe("Diagnosis.\n\n[runtime query arguments omitted]\n\nOwner will verify recovery.");
  }
  for (const operator of ["<(", ">("]) {
    const text = "Diagnosis.\nforge rt query --expr " + operator + "printf x;\nprintf hidden-fixture)";
    const { trace } = createTrace([{ type: "response_item", ts: null, ordinal: 1,
      payload: { type: "message", role: "user", content: text } }], "test", "user");
    expect(trace[0].text).toBe("Diagnosis.\n[runtime query arguments omitted]");
  }
});
