import { expect, test } from "bun:test";
import { createTrace } from "../src/audit/trace";
import { redactAuditArguments } from "../src/shared/redact";

test("audit messages retain the diagnosis and follow-up around a multiline runtime query", () => {
  const text = [
    "Queue backlog confirmed.",
    "",
    "forge rt query --expr 'first fixture line",
    "second fixture line' --param scope=private-fixture",
    "",
    "Owner will verify recovery.",
  ].join("\n");
  for (const role of ["user", "assistant"]) {
    const { trace } = createTrace([{ type: "response_item", ts: null, ordinal: 1,
      payload: { type: "message", role, phase: "final_answer", content: text } }], "fixture-session", role);
    expect(trace).toHaveLength(1);
    expect(trace[0].text).toBe("Queue backlog confirmed.\n\n[runtime query arguments omitted]\n\nOwner will verify recovery.");
  }
  expect(redactAuditArguments(["forge", "rt", "query", "--expr", "first fixture line", "--param=scope=private-fixture"]))
    .toEqual(["forge", "rt", "query", "--expr", "***", "--param=***"]);
});
