import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeAdapter, type CapturedStream } from "../src/rt/adapter-process";
import { safeAdapterOutput } from "../src/rt/redact";

const limits = { max_bytes: 4096, max_lines: 40 };

function output(stdout: string, stderr = "", secrets: string[] = [], clipped = false) {
  const stream = (text: string, incomplete: boolean): CapturedStream => ({
    bytes: Buffer.from(text), clipped: incomplete, incomplete,
  });
  return safeAdapterOutput({ stdout: stream(stdout, clipped), stderr: stream(stderr, false),
    exit_code: 0, duration_ms: 1, startup_failure: false, timed_out: false }, limits, secrets);
}

test("bracketed application log labels are independent of CLI time window syntax", () => {
  const text = "[2026-11-28 12:00:00] INFO ready\n[worker-2] WARN backlog";
  expect(output(text).output).toBe(text);
  expect(output("[37]\n[48]", "", ["37"]).output).toBe('["***"]\n[48]');
});

test("timestamped logs and complete NDJSON records survive malformed suffixes and are redacted", () => {
  const result = output([
    "[2026-11-28T09:30:00+08:00] first log message",
    '{"event":"queue","Set-Cookie":{"session":"opaque-cookie"},"order_id":9223372036854775807}',
    '{"event":"dispatch","phone":13800138000}',
    '{"password":',
    '  "malformed-private-tail"',
  ].join("\n"));
  expect(result.data).toBeNull();
  expect(result.truncated).toBe(true);
  expect(result.output).toBe([
    "[2026-11-28T09:30:00+08:00] first log message",
    '{"event":"queue","Set-Cookie":"***","order_id":9223372036854775807}',
    '{"event":"dispatch","phone":"***"}',
  ].join("\n"));

  const clipped = output('{"safe":1}\n{"password":"truncated', "", [], true);
  expect(clipped.output).toBe('{"safe":1}');
  expect(clipped.truncated).toBe(true);
});

test("text fields survive prefixed labels, and JSON numbers keep precision after redaction", () => {
  const text = output([
    "upstream: password=opaque-password",
    "header: Set-Cookie: session=opaque-response-cookie; HttpOnly",
    "Cookie: session=opaque-request-cookie",
    "health check continued",
  ].join("\n"));
  expect(text.truncated).toBe(false);
  expect(text.output).toBe([
    "upstream: password=***", "header: Set-Cookie: ***", "Cookie: ***", "health check continued",
  ].join("\n"));

  const json = output('{"contact":13800138000,"echo":9007199254740993,"order_id":9223372036854775807,"ratio":0.125}',
    '{"phone":1234,"decimal":0.10000000000000000001}', ["9007199254740993"]);
  expect(JSON.stringify(json.data)).toBe('{"contact":"***","echo":"***","order_id":9223372036854775807,"ratio":0.125}');
  expect(json.warning).toBe('{"phone":"***","decimal":0.10000000000000000001}');
});

test("adapter cleanup stops detached group members after unsuccessful exit or deadline", async () => {
  const temp = mkdtempSync(join(tmpdir(), "forge-adapter-regression-"));
  const script = '(sleep 0.3; printf late > "$1") </dev/null >/dev/null 2>&1 & exit "$2"';
  const invocation = (witness: string, code: string, timeout_ms: number) => executeAdapter({
    ...limits, argv: ["/bin/sh", "-c", script, "fixture", witness, code], action: "fixture", cwd: temp,
    timeout_ms, read_only_guarantee: "fixed-ro-subcommand",
  }, "status", {});
  const failed = join(temp, "after-failure");
  const late = join(temp, "after-deadline");
  try {
    expect((await invocation(failed, "7", 1000)).exit_code).toBe(7);
    const timeout = invocation(late, "0", 30);
    Bun.sleepSync(70);
    expect((await timeout).timed_out).toBe(true);
    await Bun.sleep(400);
    expect(existsSync(failed)).toBe(false);
    expect(existsSync(late)).toBe(false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
