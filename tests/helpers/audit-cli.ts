import { Database } from "bun:sqlite";
import { expect } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { sandbox, type Sandbox } from "../v05-sandbox";

export const auditEpoch = "2026-06-01T12:00:00.000Z";
export const timestamp = (seconds: number) => new Date(Date.parse(auditEpoch) + seconds * 1_000).toISOString();

type RolloutRow = { timestamp: string; ordinal?: number; type: string; payload: Record<string, unknown> };
export const row = (seconds: number, type: string, payload: RolloutRow["payload"]): RolloutRow =>
  ({ timestamp: timestamp(seconds), type, payload });

export const message = (seconds: number, role: "user" | "assistant", text: string) => row(seconds, "response_item", {
  type: "message", role, phase: role === "assistant" ? "final_answer" : undefined,
  content: [{ type: role === "user" ? "input_text" : "output_text", text }],
});

export function rollout(s: Sandbox, relative: string, id: string, records: (RolloutRow | string)[], parent?: string, role?: string, startedAt = auditEpoch) {
  const meta = { timestamp: startedAt, type: "session_meta", payload: {
    id, session_id: id, timestamp: startedAt, parent_thread_id: parent, agent_role: role,
    source: parent ? { subagent: { thread_spawn: { parent_thread_id: parent, agent_role: role, depth: 1 } } } : "cli",
  } };
  const lines = [meta, ...records].map((record, ordinal) =>
    typeof record === "string" ? record : JSON.stringify({ ordinal, ...record }));
  return s.privateFile(relative, lines.join("\n") + "\n");
}

export function tokens(input: number, cached: number, cacheWrite: number, output: number, reasoning: number) {
  return {
    input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: cacheWrite,
    output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output,
  };
}

export function tokenCount(seconds: number, last: ReturnType<typeof tokens>, total?: ReturnType<typeof tokens>) {
  return row(seconds, "event_msg", {
    type: "token_count", info: { last_token_usage: last, total_token_usage: total, last_usage_includes_reasoning: true },
  });
}

export function auditFixture(s: Sandbox) {
  const source = ".codex-fixture/sessions";
  s.env.FORGE_CODEX_SESSIONS_DIR = join(s.work, source);
  const run = (...args: string[]) => s.run([s.forge, "ledger", ...args]);
  const call = (...args: string[]) => s.ok([s.forge, "ledger", ...args]);
  const json = (...args: string[]) => JSON.parse(call(...args));
  const status = (id: string) => json("status", "--task", id, "--json");
  const open = (id: string, extra: string[] = [], title = id) =>
    json("open", "--id", id, "--title", title, "--endpoint", "investigation", "--depth", "targeted", ...extra);
  const path = (id: string, name = "") => join(s.work, ".workbench/audit", id, name);
  const read = (id: string, name: string) => readFileSync(path(id, name), "utf8");
  const summary = (id: string) => JSON.parse(read(id, "summary.json"));
  const trace = (id: string) => read(id, "trace.jsonl").split("\n").filter(Boolean).map(line => JSON.parse(line));
  const put = (id: string, records: (RolloutRow | string)[], options?: { parent?: string; role?: string; archive?: boolean; startedAt?: string }) =>
    rollout(s, `${options?.archive ? ".codex-fixture/archived_sessions" : source}/rollout-${id}.jsonl`, id,
      records, options?.parent, options?.role, options?.startedAt);
  const db = <T>(use: (db: Database) => T) => {
    const database = new Database(join(s.work, ".workbench/ledger/ledger.sqlite"));
    try { return use(database); } finally { database.close(); }
  };
  return { s, run, call, json, status, open, path, read, summary, trace, put, db };
}

export function withAudit(run: (fixture: ReturnType<typeof auditFixture>) => void) {
  const s = sandbox();
  try {
    s.fresh();
    run(auditFixture(s));
  } finally {
    s.cleanup();
    expect(existsSync(s.root)).toBe(false);
  }
}

export const permissions = (file: string) => statSync(file).mode & 0o777;
