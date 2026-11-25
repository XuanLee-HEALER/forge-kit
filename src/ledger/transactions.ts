import type { Database } from "bun:sqlite";
import { canonicalJson, computeEntryHash, nowIso, type EventRecord } from "./types";

export function appendEventInTx(db: Database, params: {
  task_id: string;
  event_type: string;
  actor: string;
  session_id?: string | null;
  tool_use_id?: string | null;
  repo?: string | null;
  branch?: string | null;
  sha?: string | null;
  payload: Record<string, unknown>;
  ts?: string;
}): EventRecord {
  // Idempotency by (task_id, tool_use_id) so retried PostToolUse deliveries never double-write.
  if (params.tool_use_id) {
    const existing = db
      .query("SELECT * FROM events WHERE task_id = ? AND tool_use_id = ? LIMIT 1")
      .get(params.task_id, params.tool_use_id) as EventRecord | null;
    if (existing) return existing;
  }

  const ts = params.ts ?? nowIso();
  const last = db
    .query(
      "SELECT seq, entry_hash FROM events WHERE task_id = ? ORDER BY seq DESC LIMIT 1",
    )
    .get(params.task_id) as { seq: number; entry_hash: string } | null;

  const seq = last ? last.seq + 1 : 1;
  const prev_hash = last ? last.entry_hash : "GENESIS";
  const payload_json = canonicalJson(params.payload);
  const repo = params.repo ?? null;
  const branch = params.branch ?? null;
  const sha = params.sha ?? null;
  const session_id = params.session_id ?? null;
  const tool_use_id = params.tool_use_id ?? null;

  const entry_hash = computeEntryHash({
    prev_hash,
    task_id: params.task_id,
    seq,
    ts,
    event_type: params.event_type,
    actor: params.actor,
    session_id,
    tool_use_id,
    repo,
    branch,
    sha,
    payload_json,
  });

  const info = db
    .query(
      `INSERT INTO events (
          task_id, seq, ts, event_type, actor, session_id, tool_use_id,
          repo, branch, sha, payload_json, prev_hash, entry_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      params.task_id,
      seq,
      ts,
      params.event_type,
      params.actor,
      session_id,
      tool_use_id,
      repo,
      branch,
      sha,
      payload_json,
      prev_hash,
      entry_hash,
    );

  db
    .query("UPDATE tasks SET tip_hash = ?, updated_at = ? WHERE task_id = ?")
    .run(entry_hash, ts, params.task_id);

  return {
    id: Number(info.lastInsertRowid),
    task_id: params.task_id,
    seq,
    ts,
    event_type: params.event_type,
    actor: params.actor,
    session_id,
    tool_use_id,
    repo,
    branch,
    sha,
    payload_json,
    prev_hash,
    entry_hash,
  };
}

export function withImmediateTx<T>(db: Database, fn: () => T): T {
  if (db.inTransaction) return db.transaction(fn)();
  db.exec("BEGIN IMMEDIATE;");
  try {
    const result = fn();
    db.exec("COMMIT;");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Ignore rollback error
    }
    throw err;
  }
}
