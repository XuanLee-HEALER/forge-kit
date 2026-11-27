import type { Database } from "bun:sqlite";
import { canonicalRepoPath } from "../config";
import {
  actionMatchesItem,
  currentHandoff,
  productionActions,
  type ReleaseLedger,
} from "./release-inspection";
import { appendEventInTx, withImmediateTx } from "./transactions";
import {
  isRolloutEndpoint,
  normalizeReviewRole,
  nowIso,
  type EventRecord,
  type EvidenceSource,
  type ExemptionRecord,
  type LedgerReader,
  type TaskBlockerRecord,
} from "./types";

export interface RecordDecisionParams {
  task_id: string;
  key: string;
  summary: string;
  supersedes_seq?: number;
  actor?: string;
  session_id?: string | null;
}

export function recordDecision(ledger: LedgerReader, params: RecordDecisionParams): EventRecord {
  return withImmediateTx(ledger.db, () => {
    const task = ledger.getTask(params.task_id);
    if (!task) throw new Error(`Task not found: ${params.task_id}`);
    if (task.status !== "OPEN") {
      throw new Error(`Cannot record decision on ${task.status} task`);
    }
    const event_type =
      params.supersedes_seq !== undefined
        ? "DECISION_SUPERSEDED"
        : "DECISION_LOCKED";
    return appendEventInTx(ledger.db, {
      task_id: params.task_id,
      event_type,
      actor: params.actor ?? "agent",
      session_id: params.session_id,
      payload: {
        key: params.key,
        summary: params.summary,
        supersedes_seq: params.supersedes_seq ?? null,
      },
    });
  });
}

export interface RecordBlockerParams {
  task_id: string;
  action: "open" | "close";
  blocker_id: string;
  summary: string;
  actor?: string;
  session_id?: string | null;
}

export function recordBlocker(ledger: LedgerReader, params: RecordBlockerParams): EventRecord {
  return withImmediateTx(ledger.db, () => {
    const task = ledger.getTask(params.task_id);
    if (!task) throw new Error(`Task not found: ${params.task_id}`);
    if (task.status !== "OPEN") {
      throw new Error(`Cannot update blocker on ${task.status} task`);
    }

    const ts = nowIso();
    const existing = ledger.db
      .query("SELECT * FROM task_blockers WHERE task_id = ? AND blocker_id = ?")
      .get(params.task_id, params.blocker_id) as TaskBlockerRecord | null;

    if (params.action === "open") {
      if (existing?.status === "OPEN") {
        throw new Error(`Blocker ${params.blocker_id} is already OPEN on ${params.task_id}`);
      }
      ledger.db
        .query(
          `INSERT INTO task_blockers (task_id, blocker_id, status, summary, opened_at, closed_at)
           VALUES (?, ?, 'OPEN', ?, ?, NULL)
           ON CONFLICT(task_id, blocker_id) DO UPDATE SET
             status = 'OPEN', summary = excluded.summary, opened_at = excluded.opened_at, closed_at = NULL`,
        )
        .run(params.task_id, params.blocker_id, params.summary, ts);
    } else {
      if (!existing) {
        throw new Error(`Blocker ${params.blocker_id} not found on ${params.task_id}`);
      }
      if (existing.status === "CLOSED") {
        throw new Error(`Blocker ${params.blocker_id} is already CLOSED on ${params.task_id}`);
      }
      ledger.db
        .query(
          `UPDATE task_blockers SET status = 'CLOSED', summary = ?, closed_at = ?
           WHERE task_id = ? AND blocker_id = ?`,
        )
        .run(params.summary, ts, params.task_id, params.blocker_id);
    }

    const event_type =
      params.action === "open" ? "BLOCKER_OPENED" : "BLOCKER_CLOSED";
    const ev = appendEventInTx(ledger.db, {
      task_id: params.task_id,
      event_type,
      actor: params.actor ?? "agent",
      session_id: params.session_id,
      ts,
      payload: {
        blocker_id: params.blocker_id,
        summary: params.summary,
      },
    });

    ledger.db.query(
      "UPDATE tasks SET open_blockers = (SELECT COUNT(*) FROM task_blockers WHERE task_id = ? AND status = 'OPEN') WHERE task_id = ?",
    ).run(params.task_id, params.task_id);
    return ev;
  });
}

export interface RecordEvidenceParams {
  task_id: string;
  kind:
    | "commit"
    | "build"
    | "test"
    | "lint"
    | "review"
    | "review_selection"
    | "hurl"
    | "pr"
    | "fat"
    | "prod"
    | "note" | "verify" | "deploy" | "smoke" | "manual";
  source?: EvidenceSource;
  status: "pass" | "fail" | "fallback" | "info";
  summary: string;
  repo?: string | null;
  branch?: string | null;
  sha?: string | null;
  meta?: Record<string, unknown>;
  actor?: string;
  session_id?: string | null;
  tool_use_id?: string | null;
}

export function recordEvidence(ledger: ReleaseLedger, params: RecordEvidenceParams): EventRecord {
  return withImmediateTx(ledger.db, () => {
    const task = ledger.getTask(params.task_id);
    if (!task) throw new Error(`Task not found: ${params.task_id}`);
    // Deployment can happen after PR handoff. Only the pinned production receipt
    // may extend this chain without resuming development.
    let prodReceipt = false;
    let releaseId: string | undefined;
    if (task.status === "HANDED_OFF" && params.kind === "prod" && params.repo && params.branch && params.sha) {
      const repo = canonicalRepoPath(ledger.workbenchRoot,params.repo);
      const snapshot = currentHandoff(ledger,task.task_id);
      const item = snapshot.items.find(i =>
        canonicalRepoPath(ledger.workbenchRoot,i.repo) === repo && i.branch === params.branch && i.verified_head === params.sha);
      const bookId = params.meta?.runbook_id;
      if (bookId !== undefined || params.meta?.action_id !== undefined) {
        const book = typeof bookId === "string" ? ledger.getRunbook(bookId) : null;
        const linked = book && ledger.db.query("SELECT 1 FROM releases r JOIN release_items i USING(release_id) WHERE r.runbook_id=? AND r.status='APPROVED' AND i.task_id=? AND i.ledger_tip=?")
          .get(book.runbook_id,task.task_id,snapshot.ledger_tip);
        const action = book && productionActions(JSON.parse(book.actions_json)).find(a=>a.action_id===params.meta?.action_id)?.action;
        if (!item || !linked || book?.status !== "APPROVED" || !action || !actionMatchesItem(snapshot,item,action))
          throw Error("Production receipt must match an approved release action and handoff SHA");
        prodReceipt = true;
      } else if (item && isRolloutEndpoint(task.endpoint)) {
        prodReceipt = true;
        releaseId = ledger.db.query<{ release_id: string }, [string, string]>(
          `SELECT r.release_id FROM releases r JOIN release_items i USING(release_id)
           WHERE i.task_id=? AND i.ledger_tip=? AND r.status IN ('DRAFT','VERIFIED','APPROVED')
           LIMIT 1`,
        ).get(task.task_id, snapshot.ledger_tip)?.release_id;
      }
    }
    if (task.status !== "OPEN" && !prodReceipt) {
      throw new Error(`Cannot record evidence on ${task.status} task`);
    }
    const event_type =
      params.kind === "commit" ? "COMMIT_RECORDED" : "EVIDENCE_CAPTURED";
    const normalizedMeta =
      (params.kind === "review" || params.kind === "review_selection") && params.meta && typeof params.meta.role === "string"
        ? { ...params.meta, role: normalizeReviewRole(params.meta.role) }
        : params.meta;
    const ev = appendEventInTx(ledger.db, {
      task_id: params.task_id,
      event_type,
      actor: params.actor ?? "agent",
      session_id: params.session_id,
      tool_use_id: params.tool_use_id,
      repo: params.repo ?? null,
      branch: params.branch ?? null,
      sha: params.sha ?? null,
      payload: {
        kind: params.kind,
        status: params.status,
        source: params.source ?? "manual",
        summary: params.summary,
        ...(releaseId && { release_id: releaseId }),
        ...(normalizedMeta ? { meta: normalizedMeta } : {}),
      },
    });

    if (params.repo && params.branch && params.sha && params.kind === "commit") {
      ledger.db
        .query(
          `UPDATE task_repos SET head_sha = ? WHERE task_id = ? AND canonical_repo(repo) = canonical_repo(?) AND branch = ?`,
        )
        .run(params.sha, params.task_id, params.repo, params.branch);
    }

    if (
      (params.source === "tool" || params.source === "hook") &&
      params.repo &&
      params.sha &&
      (params.kind === "test" || params.kind === "build" || params.kind === "lint") &&
      params.status === "pass"
    ) {
      let verifiedMap: Record<string, string> = {};
      try {
        verifiedMap = JSON.parse(task.last_verified_sha || "{}");
      } catch {
        verifiedMap = {};
      }
      verifiedMap[params.repo] = params.sha;
      ledger.db
        .query("UPDATE tasks SET last_verified_sha = ? WHERE task_id = ?")
        .run(JSON.stringify(verifiedMap), params.task_id);
    }

    return ev;
  });
}

export interface AddExemptionParams {
  repo: string;
  branch: string;
  reason: string;
  head_sha?: string | null;
  ttl_hours?: number;
}

export function addExemption(db: Database, params: AddExemptionParams): ExemptionRecord {
  return withImmediateTx(db, () => {
    const created = nowIso();
    const ttlHours = params.ttl_hours ?? 24;
    const expires = new Date(Date.now() + ttlHours * 3600_000).toISOString();
    const info = db
      .query(
        `INSERT INTO exemptions (repo, branch, head_sha, reason, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.repo,
        params.branch,
        params.head_sha ?? null,
        params.reason,
        created,
        expires,
      );
    return {
      id: Number(info.lastInsertRowid),
      repo: params.repo,
      branch: params.branch,
      head_sha: params.head_sha ?? null,
      reason: params.reason,
      created_at: created,
      expires_at: expires,
    };
  });
}

export function bindExemptionHeadSha(db: Database, id: number, head_sha: string): void {
  withImmediateTx(db, () => {
    db
      .query("UPDATE exemptions SET head_sha = ? WHERE id = ?")
      .run(head_sha, id);
  });
}

export function findActiveExemption(db: Database, repo: string, branch: string): ExemptionRecord | null {
  const now = nowIso();
  const row = db
    .query(
      `SELECT * FROM exemptions
       WHERE canonical_repo(repo) = canonical_repo(?) AND branch = ?
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY id DESC LIMIT 1`,
    )
    .get(repo, branch, now) as ExemptionRecord | null;
  return row ?? null;
}
