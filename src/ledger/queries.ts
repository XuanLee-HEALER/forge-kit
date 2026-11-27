import type { Database } from "bun:sqlite";
import { canonicalRepoPath } from "../config";
import { availableHandoffs } from "./release-inspection";
import {
  evidenceSource,
  type EventRecord,
  type LedgerReader,
  type TaskBlockerRecord,
  type TaskRecord,
  type TaskRepoRecord,
} from "./types";

export interface TaskReader extends LedgerReader {
  getTaskBlockers(task_id: string): TaskBlockerRecord[];
}

export function handedOffOwner(ledger: Pick<LedgerReader, "db">, repo: string, branch: string) {
  return ledger.db.query<TaskRecord,[string,string]>(
    "SELECT t.* FROM tasks t JOIN task_repos tr USING(task_id) WHERE canonical_repo(tr.repo) = canonical_repo(?) AND tr.branch=? AND t.status='HANDED_OFF'"
  ).get(repo,branch);
}

export function findOpenTasksByRepoBranch(db: Database, repo: string, branch: string): TaskRecord[] {
  return db
    .query(
      `SELECT DISTINCT t.* FROM tasks t
       INNER JOIN task_repos tr ON t.task_id = tr.task_id
       WHERE canonical_repo(tr.repo) = canonical_repo(?) AND tr.branch = ? AND t.status = 'OPEN'
       ORDER BY t.updated_at DESC`,
    )
    .all(repo, branch) as TaskRecord[];
}

export function findOpenTasksByRepoCommits(db: Database, repo: string, shas: string[]): TaskRecord[] {
  if (shas.length === 0) return [];
  const placeholders = shas.map(() => "?").join(",");
  return db
    .query(
      `SELECT DISTINCT t.* FROM tasks t
       INNER JOIN task_repos tr ON t.task_id = tr.task_id
       WHERE canonical_repo(tr.repo) = canonical_repo(?) AND tr.head_sha IN (${placeholders}) AND t.status = 'OPEN'
       ORDER BY t.updated_at DESC`,
    )
    .all(repo, ...shas) as TaskRecord[];
}

export function getTask(db: Database, task_id: string): TaskRecord | null {
  return (
    (db
      .query("SELECT * FROM tasks WHERE task_id = ?")
      .get(task_id) as TaskRecord | null) ?? null
  );
}

export function getTaskRepos(ledger: LedgerReader, task_id: string): TaskRepoRecord[] {
  const rows = ledger.db.query<TaskRepoRecord,[string]>("SELECT * FROM task_repos WHERE task_id=? ORDER BY attached_at,rowid").all(task_id);
  const unique = new Map<string,TaskRepoRecord>();
  for (const row of rows) {
    row.repo = canonicalRepoPath(ledger.workbenchRoot,row.repo);
    const key = JSON.stringify([row.repo,row.branch]), prior=unique.get(key);
    if (!prior) unique.set(key,row);
    else {
      if(prior.base_sha && row.base_sha && prior.base_sha!==row.base_sha)
        throw Error("Conflicting legacy attachment baselines for "+row.repo+":"+row.branch);
      prior.base_sha ??= row.base_sha;
      prior.head_sha = row.head_sha ?? prior.head_sha;
      prior.worktree = row.worktree ?? prior.worktree;
    }
  }
  return [...unique.values()];
}

export function getTaskBlockers(db: Database, task_id: string): TaskBlockerRecord[] {
  return db
    .query("SELECT * FROM task_blockers WHERE task_id = ? ORDER BY opened_at ASC")
    .all(task_id) as TaskBlockerRecord[];
}

export function getTaskEvents(db: Database, task_id: string): EventRecord[] {
  return db
    .query("SELECT * FROM events WHERE task_id = ? ORDER BY seq ASC")
    .all(task_id) as EventRecord[];
}

export function listOpenTasks(db: Database): TaskRecord[] {
  return db
    .query("SELECT * FROM tasks WHERE status = 'OPEN' ORDER BY updated_at DESC")
    .all() as TaskRecord[];
}

export interface QueryParams {
  q?: string;
  repo?: string;
  status?: string;
  since?: string;
  limit?: number;
}

export function query(db: Database, params: QueryParams): { tasks: TaskRecord[]; events: EventRecord[] } {
  const limit = params.limit ?? 50;
  const where: string[] = [];
  const args: (string | number)[] = [];

  if (params.status) {
    where.push("t.status = ?");
    args.push(params.status);
  }
  if (params.since) {
    where.push("t.updated_at >= ?");
    args.push(params.since);
  }
  if (params.repo) {
    where.push(
      "EXISTS (SELECT 1 FROM task_repos tr WHERE tr.task_id = t.task_id AND canonical_repo(tr.repo) = canonical_repo(?))",
    );
    args.push(params.repo);
  }

  const sql = `SELECT t.* FROM tasks t ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY t.updated_at DESC LIMIT ?`;
  const tasks = db.query(sql).all(...args, limit) as TaskRecord[];

  let events: EventRecord[] = [];
  if (params.q && params.q.trim()) {
    const evWhere: string[] = ["events_fts MATCH ?"];
    const evArgs: (string | number)[] = [params.q.trim()];
    if (params.status) {
      evWhere.push("t.status = ?");
      evArgs.push(params.status);
    }
    if (params.since) {
      evWhere.push("e.ts >= ?");
      evArgs.push(params.since);
    }
    if (params.repo) {
      evWhere.push(
        "(canonical_repo(e.repo) = canonical_repo(?) OR EXISTS (SELECT 1 FROM task_repos tr WHERE tr.task_id = e.task_id AND canonical_repo(tr.repo) = canonical_repo(?)))",
      );
      evArgs.push(params.repo, params.repo);
    }
    events = db
      .query(
        `SELECT e.* FROM events e
         INNER JOIN events_fts f ON f.rowid = e.id
         INNER JOIN tasks t ON t.task_id = e.task_id
         WHERE ${evWhere.join(" AND ")}
         ORDER BY e.ts DESC LIMIT ?`,
      )
      .all(...evArgs, limit) as EventRecord[];
  }
  return { tasks, events };
}

export function formatCompactContext(ledger: TaskReader, maxTasks = 8): string {
  const open = ledger.listOpenTasks().slice(0, maxTasks);
  const count = availableHandoffs(ledger).length;
  const quiet = count
    ? "Handoffs awaiting release: " +
      count +
      ' (run forge ledger release create --from-handoffs --title "<title>")'
    : "";
  if (!open.length) return quiet;
  const lines: string[] = ["[Workbench Active Task Ledgers]"];
  for (const t of open) {
    const repos = ledger.getTaskRepos(t.task_id);
    const repoDesc =
      repos
        .map(
          (r) =>
            `${r.repo}:${r.branch}${r.head_sha ? `@${r.head_sha.slice(0, 7)}` : ""}`,
        )
        .join(", ") || "no-repo";

    const openBlockers = ledger.getTaskBlockers(t.task_id).filter(
      (b) => b.status === "OPEN",
    );
    const blockerText =
      openBlockers.length > 0
        ? ` | blockers: ${openBlockers.map((b) => `${b.blocker_id}(${b.summary.slice(0, 40)})`).join(", ")}`
        : "";

    // Filter out superseded decisions so only active effective decisions appear
    const decRows = ledger.db
      .query(
        `SELECT seq, payload_json FROM events
         WHERE task_id = ? AND event_type IN ('DECISION_LOCKED','DECISION_SUPERSEDED')
         ORDER BY seq ASC`,
      )
      .all(t.task_id) as Array<{ seq: number; payload_json: string }>;
    const supersededSeqs = new Set<number>();
    const parsedDecs: Array<{ seq: number; key: string; summary: string }> = [];
    for (const row of decRows) {
      try {
        const p = JSON.parse(row.payload_json) as {
          key?: string;
          summary?: string;
          supersedes_seq?: number | null;
        };
        if (typeof p.supersedes_seq === "number") {
          supersededSeqs.add(p.supersedes_seq);
        }
        if (p.key && p.summary) {
          parsedDecs.push({ seq: row.seq, key: p.key, summary: p.summary });
        }
      } catch {
        // Ignore
      }
    }
    const activeDecs = parsedDecs
      .filter((d) => !supersededSeqs.has(d.seq))
      .slice(-2)
      .map((d) => `${d.key}=${d.summary}`)
      .join("; ");

    const specState = ledger.getSpecState(t.task_id);
    const recentEvidence = ledger.db.query(
      "SELECT actor, payload_json FROM events WHERE task_id = ? AND event_type = 'EVIDENCE_CAPTURED' ORDER BY seq DESC LIMIT 4",
    ).all(t.task_id) as Pick<EventRecord, "actor" | "payload_json">[];
    const evidence = recentEvidence.map(row => {
      const payload = JSON.parse(row.payload_json);
      return `[${evidenceSource(payload, row.actor)}] ${payload.kind}/${payload.status}`;
    }).join(", ");
    const driftCount = specState.drifted_files.length + specState.drifted_locked_tests.length;
    const specBadge =
      specState.state === "FROZEN"
        ? ` | spec:FROZEN${driftCount ? `(DRIFT:${driftCount})` : ""}`
        : specState.state === "AMENDED"
          ? ` | spec:AMENDED(${specState.amend_scope ?? "?"})`
          : "";

    lines.push(
      `- ${t.task_id} (${t.endpoint}/${t.verification_depth}): ${t.title} [${repoDesc}]${specBadge}${evidence ? " | " + evidence : ""}${blockerText}${activeDecs ? ` | decisions: ${activeDecs}` : ""}`,
    );
  }
  if (quiet) lines.push(quiet);
  return lines.join("\n");
}
