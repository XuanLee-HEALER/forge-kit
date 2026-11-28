import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { row, tokenCount, tokens, withAudit } from "./helpers/audit-cli";

function call(at: number, id: string, name: string, args: object, output: string | object) {
  return [
    row(at, "response_item", { type: "function_call", call_id: id, name, arguments: JSON.stringify(args) }),
    row(at + 1, "response_item", { type: "function_call_output", call_id: id, output }),
  ];
}

test("INV-07 close archives capped, redacted diagnostics and filters raw tool data", () => withAudit(f => {
  const id = "diagnostics";
  f.open(id, ["--session-id", id]);
  const secret = "audit-fixture-api-secret";
  const mail = "audit-result@example.invalid";
  f.put(id, [
    ...call(1, "compile", "exec_command", { cmd: "bun run build" },
      "Process exited with code 0\nFinal output:\nBundled 111 modules in 48ms\n"),
    ...call(3, "test", "exec", { code: 'await tools.exec_command({cmd: "bun test"})' },
      "Process exited with code 1\nFinal output:\nFAIL contract test: expected 3, received 4\nError: fixture test mismatch\n    at checkFixture (tests/fixture.test.ts:17:3)\n"),
    ...call(5, "cli", "shell", { command: "forge apply --days -1" },
      "Process exited with code 2\nFinal output:\nforge: --days requires a positive integer\n"),
    ...call(7, "source", "exec_command", { cmd: "cat src/fixture.ts" },
      "export const SOURCE_BODY_MARKER = () => 'fixture source';\n"),
    ...call(9, "patch", "exec_command", { cmd: "git diff" },
      "diff --git a/src/fixture.ts b/src/fixture.ts\n--- a/src/fixture.ts\n+++ b/src/fixture.ts\n@@ -1 +1 @@\n-DIFF_BEFORE_MARKER\n+DIFF_AFTER_MARKER\n"),
    ...call(11, "mixed", "shell", { command: "bun run build --api-key " + secret },
      "Error: workflow diagnostic before\n<file_content>FILE_BODY_MARKER</file_content>\nError: workflow diagnostic after\n" +
      "Authorization: Bearer " + secret + "\nReporter: " + mail + "\n<developer>TEMPLATE_BODY_MARKER</developer>\n"),
    ...call(13, "struct", "fixture_status", { content: "ARGUMENT_BODY_MARKER" }, {
      status: "ok", payload: { nested: "STRUCTURED_BODY_MARKER" },
    }),
    ...call(15, "long", "exec_command", { cmd: "bun run build" }, "Error: Unicode validation " + "界".repeat(1000)),
    row(17, "response_item", { type: "function_call_output", call_id: "unpaired", output: "UNPAIRED_BODY_MARKER" }),
  ]);

  expect(f.json("close", id).task.status).toBe("CLOSED");
  expect(existsSync(f.path(id, "summary.json"))).toBe(true);
  const archive = f.read(id, "trace.jsonl");
  const outputs: { tool: string; output_summary: string }[] = f.trace(id)
    .filter(event => event.kind === "tool_output");
  const diagnostics = outputs.map(output => output.output_summary).join("\n");
  for (const expected of [
    /code 0/, /Bundled 111 modules/, /code 1/, /expected 3, received 4/, /fixture test mismatch/,
    /checkFixture/, /code 2/, /requires a positive integer/,
    /workflow diagnostic before/, /workflow diagnostic after/, /Unicode validation/, /界/,
  ]) expect(diagnostics).toMatch(expected);
  for (const marker of [
    secret, mail, "SOURCE_BODY_MARKER", "DIFF_BEFORE_MARKER", "DIFF_AFTER_MARKER", "FILE_BODY_MARKER",
    "TEMPLATE_BODY_MARKER", "ARGUMENT_BODY_MARKER", "STRUCTURED_BODY_MARKER", "UNPAIRED_BODY_MARKER",
  ]) expect(archive).not.toContain(marker);
  expect(outputs.filter(output => !/unmatched/i.test(output.output_summary))).toHaveLength(8);
  for (const output of outputs) {
    expect(Buffer.byteLength(output.output_summary, "utf8")).toBeLessThanOrEqual(2048);
    expect(output.output_summary).not.toContain("�");
  }
  const long = outputs.find(output => output.output_summary.includes("Unicode validation"))!;
  expect(Buffer.byteLength(long.output_summary, "utf8")).toBeGreaterThan(2000);
}), 30_000);

test("INV-08 close attributes spec and code reviewers to distinct cost buckets", () => withAudit(f => {
  const id = "review-cost";
  f.open(id, ["--session-id", id]);
  const roles = ["reviewer", "reviewer-business", "reviewer-quality", "reviewer-simplify", "reviewer-comments", "unknown-reviewer"];
  const samples = roles.map((role, index) => ({ role, counter: tokens(50 + index * 5, index, 2, 12 + index, 3) }));
  const main = tokens(35, 3, 2, 5, 1);
  f.put(id, [tokenCount(1, main)]);
  for (const { role, counter } of samples) {
    f.put(role, [
      row(1, "turn_context", { turn_id: "review", model: "fixture-" + role }),
      tokenCount(2, counter),
    ], { parent: id, role });
  }

  f.json("close", id);
  const archived = f.summary(id);
  const cost = f.json("cost", id, "--json");
  expect(cost.by_role).toEqual(archived.by_role);
  expect(cost.by_role.main).toMatchObject(main);
  for (const { role, counter } of samples) {
    const bucket = role === "unknown-reviewer" ? "other" : role;
    expect(cost.by_role[bucket]).toMatchObject(counter);
    expect(archived.by_model["fixture-" + role]).toMatchObject(counter);
  }

  for (const key of ["input_tokens", "cached_input_tokens", "cache_write_input_tokens",
    "output_tokens", "reasoning_output_tokens", "total_tokens"] as const) {
    const total = samples.reduce((sum, { counter }) => sum + counter[key], main[key]);
    expect(cost.usage[key]).toBe(total);
    for (const dimension of [cost.by_role, cost.by_stage, archived.by_model]) {
      const buckets = Object.values(dimension) as Record<typeof key, number | null>[];
      expect(buckets.reduce((sum, bucket) => sum + (bucket[key] ?? 0), 0)).toBe(total);
    }
  }
}), 30_000);
