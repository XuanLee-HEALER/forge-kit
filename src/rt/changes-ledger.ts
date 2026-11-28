import { statSync } from "node:fs";
import { isOid } from "../git";
import { Ledger } from "../ledger/store";
import { ledgerDbPath } from "../ledger/types";

type HistoryType = "HANDOFF_RECORDED" | "RELEASE" | "deploy" | "prod" | "TASK_CLOSED";
type HistoryRecord = {
  type: HistoryType; ts: string; repo: string; task_id: string; release_id: string | null;
  sha: string | null; sha_known: boolean; status: string | null;
  item_status?: string | null; expected_head_sha?: string | null; verified_head_sha?: string | null;
};
type HistoryRow = {
  type: HistoryType; ts: unknown; task_id: unknown; release_id: unknown; sha: unknown;
  status: unknown; item_status?: unknown; expected_head_sha?: unknown; verified_head_sha?: unknown;
  time: number | null; record_id: number; item: number;
};
type Coverage = "available" | "partial" | "unavailable";

// Guard JSON functions against corrupt legacy rows and against primitive handoff items.
const payload = `CASE WHEN json_valid(e.payload_json) THEN
  CASE WHEN json_type(e.payload_json) = 'object' THEN e.payload_json END END`;
const handoffItems = `CASE WHEN json_type((${payload}), '$.items') = 'array'
  THEN json_extract((${payload}), '$.items') END`;
const handoffItem = "CASE WHEN item.type = 'object' THEN item.value END";
const releaseId = `json_extract((${payload}), '$.release_id')`;
const repoMatches = (column: string) => `(${column} = ?1 OR canonical_repo(${column}) = ?1)`;
const recent = "ORDER BY time DESC, record_id DESC, item DESC LIMIT ?2";
const closedFields = `'TASK_CLOSED' AS type, e.ts, e.task_id, 'CLOSED' AS status,
  CASE WHEN ${repoMatches("e.repo")} THEN e.sha END AS sha,
  julianday(e.ts) AS time, e.id AS record_id, 0 AS item`;

const historySources = [
  `SELECT 'HANDOFF_RECORDED' AS type, e.ts, e.task_id, NULL AS release_id,
    json_extract((${handoffItem}), '$.verified_head') AS sha, 'HANDED_OFF' AS status,
    julianday(e.ts) AS time, e.id AS record_id, item.key AS item
    FROM events e JOIN json_each(${handoffItems}) item
    WHERE e.event_type = 'HANDOFF_RECORDED' AND ${repoMatches(`json_extract((${handoffItem}), '$.repo')`)}`,
  `SELECT 'RELEASE' AS type, COALESCE(r.completed_at, r.updated_at) AS ts, i.task_id, r.release_id,
    NULL AS sha, r.status, i.status AS item_status, i.expected_head_sha, i.verified_head_sha,
    julianday(COALESCE(r.completed_at, r.updated_at)) AS time, i.rowid AS record_id, 0 AS item
    FROM releases r JOIN release_items i USING (release_id)
    WHERE ${repoMatches("i.repo")}`,
  `SELECT json_extract((${payload}), '$.kind') AS type, e.ts, e.task_id, ${releaseId} AS release_id,
    e.sha, json_extract((${payload}), '$.status') AS status,
    julianday(e.ts) AS time, e.id AS record_id, 0 AS item
    FROM events e WHERE e.event_type = 'EVIDENCE_CAPTURED' AND ${repoMatches("e.repo")}
    AND json_extract((${payload}), '$.kind') IN ('deploy', 'prod')`,
  `SELECT ${closedFields}, ${releaseId} AS release_id
    FROM events e WHERE e.event_type = 'TASK_CLOSED' AND EXISTS (
      SELECT 1 FROM release_items i WHERE i.release_id = ${releaseId}
      AND i.task_id = e.task_id AND ${repoMatches("i.repo")})`,
  // Reopening preserves attachments. Sequence boundaries prevent later changes from altering older closures.
  `SELECT ${closedFields}, NULL AS release_id
    FROM events e WHERE e.event_type = 'TASK_CLOSED' AND (${payload}) IS NOT NULL AND ${releaseId} IS NULL
    AND (
      EXISTS (
        SELECT 1 FROM events a WHERE a.task_id = e.task_id AND a.seq < e.seq
        AND a.event_type IN ('REPO_ATTACHED', 'TASK_OPENED') AND a.branch IS NOT NULL AND ${repoMatches("a.repo")}
        AND NOT EXISTS (
          SELECT 1 FROM events d WHERE d.task_id = e.task_id AND d.seq > a.seq AND d.seq < e.seq
          AND d.event_type = 'REPO_DETACHED' AND d.branch = a.branch AND ${repoMatches("d.repo")}
        )
      ) OR EXISTS (
        SELECT 1 FROM task_repos i WHERE i.task_id = e.task_id AND julianday(i.attached_at) <= julianday(e.ts)
        AND ${repoMatches("i.repo")}
        AND NOT EXISTS (
          SELECT 1 FROM events d WHERE d.task_id = e.task_id AND d.seq < e.seq
          AND julianday(d.ts) >= julianday(i.attached_at) AND d.event_type = 'REPO_DETACHED'
          AND d.branch = i.branch AND ${repoMatches("d.repo")}
        )
        AND NOT EXISTS (
          SELECT 1 FROM events a WHERE a.task_id = e.task_id AND a.seq > e.seq AND a.ts = i.attached_at
          AND a.event_type = 'REPO_ATTACHED' AND a.branch = i.branch AND ${repoMatches("a.repo")}
        )
      )
    )`,
];

const historyGaps = `SELECT 1 FROM events e WHERE
  (e.event_type = 'HANDOFF_RECORDED' AND ((${handoffItems}) IS NULL OR EXISTS (
    SELECT 1 FROM json_each(${handoffItems}) item
    WHERE json_type((${handoffItem}), '$.repo') IS NOT 'text'
  )))
  OR (e.event_type = 'TASK_CLOSED' AND ((${payload}) IS NULL OR
    json_type((${payload}), '$.release_id') NOT IN ('text','null') OR ${releaseId} = ''))
  OR (e.event_type = 'EVIDENCE_CAPTURED' AND ${repoMatches("e.repo")} AND (${payload}) IS NULL)
  LIMIT 1`;

function boundedText(column: string, bytes: number) {
  return `CASE WHEN typeof(${column}) = 'text' AND length(CAST(${column} AS BLOB)) <= ${bytes}
    THEN ${column} END AS ${column}`;
}

const commonFields = ["type", "time", "record_id", "item", boundedText("ts", 128), boundedText("status", 32),
  boundedText("task_id", 512), boundedText("release_id", 512), boundedText("sha", 64)];
const releaseFields = [boundedText("item_status", 32), boundedText("expected_head_sha", 64),
  boundedText("verified_head_sha", 64)];

const statuses: ReadonlySet<string> = new Set(["HANDED_OFF", "CLOSED", "DRAFT", "VERIFIED", "APPROVED",
  "COMPLETED", "CANCELLED", "PENDING", "STALE_PR", "MERGED", "pass", "fail", "fallback", "info"]);
const validRow = `COALESCE(time IS NOT NULL AND ts <> '' AND task_id <> '' AND
  status IN (${[...statuses].map(value => "'" + value + "'").join(", ")}), 0)`;
const status = (value: unknown) => typeof value === "string" && statuses.has(value) ? value : null;
const id = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 512 ? value : null;
const oid = (value: unknown) => typeof value === "string" && isOid(value.toLowerCase()) ? value.toLowerCase() : null;

function project(row: HistoryRow, repo: string): HistoryRecord | null {
  const task_id = id(row.task_id);
  const ts = id(row.ts);
  if (!task_id || !ts || row.time === null) return null;
  const release_id = id(row.release_id);
  const expected_head_sha = oid(row.expected_head_sha);
  const verified_head_sha = oid(row.verified_head_sha);
  const sha = row.type === "RELEASE" ? verified_head_sha ?? expected_head_sha : oid(row.sha);
  return { type: row.type, ts, repo, task_id, release_id, sha, sha_known: sha !== null, status: status(row.status),
    ...(row.type === "RELEASE" && { item_status: status(row.item_status), expected_head_sha, verified_head_sha }) };
}

export function readChangesLedger(root: string, repo: string, limit: number) {
  const warnings = ["Ledger history records local evidence and does not establish the deployed version."];
  const records: HistoryRecord[] = [];
  const unavailable = (warning: string) => {
    warnings.push(warning);
    const coverage: Coverage = "unavailable";
    return { ledger: { coverage, records }, warnings };
  };

  const dbPath = ledgerDbPath(root);
  try {
    const file = statSync(dbPath, { throwIfNoEntry: false });
    if (!file) return unavailable("Local ledger database is missing.");
    if (!file.isFile()) return unavailable("Local ledger database is unavailable for read-only history.");
  } catch {
    return unavailable("Local ledger database is unavailable for read-only history.");
  }

  let ledger: Ledger | undefined;
  try {
    ledger = new Ledger(root, { dbPath, readonly: true });
    const { db } = ledger;
    const { rows, completed, gaps } = db.transaction(() => {
      const rows: HistoryRow[] = [];
      let completed = 0;
      let gaps = false;
      for (const [source, sql] of historySources.entries()) {
        try {
          const fields = source === 1 ? [...commonFields, ...releaseFields] : commonFields;
          const projected = `SELECT ${fields.join(", ")} FROM (${sql})`;
          const filtered = `SELECT * FROM (${projected}) WHERE ${validRow} ${recent}`;
          rows.push(...db.query<HistoryRow, [string, number]>(filtered).all(repo, limit));
          completed++;
          if (!gaps) gaps = Boolean(db.query(`SELECT 1 FROM (${projected}) WHERE NOT ${validRow} LIMIT 1`).get(repo));
        } catch { gaps = true; }
      }
      try { if (!gaps) gaps = Boolean(db.query(historyGaps).get(repo)); }
      catch { gaps = true; }
      return { rows, completed, gaps };
    })();
    if (!completed) return unavailable("Local ledger schema is unavailable for read-only history.");

    let partial = gaps;
    rows.sort((a, b) =>
      (b.time ?? -Infinity) - (a.time ?? -Infinity) || b.record_id - a.record_id || b.item - a.item
      || (a.type < b.type ? -1 : Number(a.type !== b.type)));
    for (const row of rows) {
      const record = project(row, repo);
      if (!record || !record.status) {
        partial = true;
        continue;
      }
      records.push(record);
      if (records.length === limit) break;
    }
    if (partial) warnings.push("Some local ledger history could not be read or attributed.");
    if (!records.length) warnings.push("No matching local ledger history was found for this repository.");
    const coverage: Coverage = partial ? "partial" : "available";
    return { ledger: { coverage, records }, warnings };
  } catch {
    return unavailable("Local ledger database is unavailable for read-only history.");
  } finally {
    ledger?.closeDb();
  }
}
