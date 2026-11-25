import { parseArgs } from "node:util";
import { evidenceSource, type TaskRecord, type EventRecord } from "./types";
import type { Ledger } from "./store";

function tally(counts: Record<string, number>, key: string) {
  counts[key] = (counts[key] ?? 0) + 1;
}
export function ledgerStats(ledger: Ledger, days?: number) {
  if (days !== undefined && (!Number.isSafeInteger(days) || days <= 0))
    throw Error("--days must be a positive integer");
  const since = days === undefined ? "" : new Date(Date.now() - days * 86400000).toISOString();
  return ledger.db
    .transaction(() => {
      const tables = new Set(
        ledger.db
          .query("SELECT name FROM sqlite_master WHERE type='table'")
          .all()
          .map((row) => (row as { name: string }).name),
      );
      const tasks = {
        by_status: { OPEN: 0, HANDED_OFF: 0, CLOSED: 0, CANCELLED: 0 },
        by_endpoint: Object.create(null) as Record<string, number>,
      };
      const durations: number[] = [];
      if (tables.has("tasks"))
        for (const row of ledger.db
          .query("SELECT * FROM tasks WHERE created_at>=?")
          .all(since) as TaskRecord[]) {
          tally(tasks.by_status, row.status);
          tally(tasks.by_endpoint, row.endpoint);
          if (row.status === "CLOSED" && row.closed_at)
            durations.push(Date.parse(row.closed_at) - Date.parse(row.created_at));
        }
      durations.sort((a, b) => a - b);
      const n = durations.length;
      const durations_ms = {
        average: n ? durations.reduce((a, b) => a + b, 0) / n : null,
        median: n ? (durations[Math.floor((n - 1) / 2)] + durations[Math.floor(n / 2)]) / 2 : null,
      };
      type Counts = { pass: number; fail: number };
      const verifications: Record<string, Record<string, Counts>> = Object.create(null);
      const reviews: Record<string, Counts & { fallback: number }> = Object.create(null);
      if (tables.has("events"))
        for (const row of ledger.db
          .query("SELECT actor,payload_json FROM events WHERE ts>=? AND event_type='EVIDENCE_CAPTURED'")
          .all(since) as EventRecord[]) {
          const p = JSON.parse(row.payload_json);
          if (!["pass", "fail", "fallback"].includes(p.status)) continue;
          const status = p.status === "fail" ? "fail" : "pass";
          const sources = (verifications[p.kind] ??= Object.create(null));
          const counts = (sources[evidenceSource(p, row.actor)] ??= { pass: 0, fail: 0 });
          counts[status]++;
          if (p.kind === "review") {
            const role = (reviews[p.meta?.role ?? "default"] ??= { pass: 0, fail: 0, fallback: 0 });
            role[status]++;
            if (p.status === "fallback" || p.meta?.fallback_used || p.meta?.original_failure) role.fallback++;
          }
        }
      const runbooks = { PENDING: 0, APPROVED: 0, COMPLETED: 0, REVOKED: 0 };
      if (tables.has("runbooks"))
        for (const row of ledger.db.query("SELECT status FROM runbooks WHERE created_at>=?").all(since) as {
          status: string;
        }[])
          tally(runbooks, row.status);
      return { tasks, durations_ms, verifications, reviews, runbooks };
    })
    .deferred();
}

export function telemetryCli(ledger: Ledger, cmd: string, args: string[]) {
  if (cmd === "stats") {
    const { values } = parseArgs({ args, options: { days: { type: "string" }, json: { type: "boolean" } } });
    const stats = ledgerStats(ledger, values.days === undefined ? undefined : Number(values.days));
    if (values.json) console.log(JSON.stringify(stats));
    else {
      console.log("Metric\tGroup\tValue");
      function print(group: string, obj: Record<string, unknown>) {
        for (const [key, value] of Object.entries(obj)) {
          if (value && typeof value === "object") print(group + " / " + key, value as Record<string, unknown>);
          else console.log([group, key, value ?? "—"].join("\t"));
        }
      }
      for (const [group, values] of Object.entries(stats)) print(group, values);
    }
    return;
  }
  if (cmd === "tip") {
    const task = args.length === 1 && ledger.getTask(args[0]);
    if (!task) throw Error("Expected an existing task ID");
    console.log("Ledger-Tip: " + task.task_id + "@" + task.tip_hash);
    return;
  }
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { task: { type: "string" }, tip: { type: "string" } },
  });
  const pair =
    positionals.length === 1 && !values.task && !values.tip
      ? positionals[0].split("@")
      : !positionals.length
        ? [values.task, values.tip]
        : [];
  const [id, hash] = pair;
  if (pair.length !== 2 || !id || !hash || !/^[0-9a-f]{64}$/.test(hash))
    throw Error("Expected <task_id>@<tip_hash>");
  const match = ledger.db
    .transaction(() => {
      if (!ledger.verify(id).ok) return "mismatch";
      if (ledger.getTask(id)?.tip_hash === hash) return "head";
      return ledger.db.query("SELECT 1 FROM events WHERE task_id=? AND entry_hash=?").get(id, hash)
        ? "prefix"
        : "mismatch";
    })
    .deferred();
  console.log(JSON.stringify({ task_id: id, match }));
  if (match === "mismatch") process.exitCode = 1;
}
