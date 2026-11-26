import {
  availableHandoffs,
  currentHandoff,
  productionActions,
  actionMatchesItem,
} from "./release-inspection";
import { canonicalRepoPath } from "../config";
import { prRemoteRefs, reachableFromRefs, resolveTaskCheckout } from "./checkout";
import { coversReviewBase, reviewMeetsFloor } from "./review-range";
import { Database } from "bun:sqlite";
import { runGit } from "../git";
import {
  approveRunbookFromUserPrompt,
  completeRunbook,
  createRunbook,
  getRunbook,
  listActiveApprovedRunbooks,
  listRunbooks,
  revokeRunbook,
} from "./runbook";
import { ensureInitialized, verify } from "./schema";
import { amendSpec, freezeSpec, getSpecState, listActiveSpecLocks } from "./spec";
import { appendEventInTx, withImmediateTx } from "./transactions";
import {
  ENDPOINT_RANK,
  EXECUTABLE_EVIDENCE,
  evidenceSource,
  type EvidenceSource,
  ledgerDbPath,
  normalizeReviewRole,
  nowIso,
  VALID_DEPTHS,
  VALID_ENDPOINTS,
  type DeliveryEndpoint,
  type EventRecord,
  type ExemptionRecord,
  type RunbookActions,
  type RunbookRecord,
  type RunbookStatus,
  type SpecAmendScope,
  type TaskBlockerRecord,
  type TaskRecord,
  type TaskRepoRecord,
  type TaskSpecState,
  type VerificationDepth,
} from "./types";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function handedOffBranches(ledger: Ledger, repo: string) {
  return ledger.db.query<{branch:string},[string]>(
    "SELECT tr.branch FROM task_repos tr JOIN tasks t USING(task_id) WHERE canonical_repo(tr.repo) = canonical_repo(?) AND t.status='HANDED_OFF'"
  ).all(repo).map(row => row.branch);
}

export function handedOffOwner(ledger: Ledger, repo: string, branch: string) {
  return ledger.db.query<TaskRecord,[string,string]>(
    "SELECT t.* FROM tasks t JOIN task_repos tr USING(task_id) WHERE canonical_repo(tr.repo) = canonical_repo(?) AND tr.branch=? AND t.status='HANDED_OFF'"
  ).get(repo,branch);
}

export class Ledger {
  readonly db: Database;
  readonly dbPath: string;
  readonly workbenchRoot: string;

  constructor(workbenchRoot: string, opts?: { dbPath?: string; busyTimeoutMs?: number; readonly?: boolean }) {
    this.workbenchRoot = workbenchRoot;
    this.dbPath = opts?.dbPath ?? ledgerDbPath(workbenchRoot);
    if (!opts?.readonly) mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath, opts?.readonly ? { readonly:true } : { create:true });
    this.db.function("canonical_repo", repo =>
      typeof repo === "string" ? canonicalRepoPath(workbenchRoot,repo) : null);
    // Set busy_timeout FIRST (lower than outer hook timeout to prevent colliding timeouts).
    const busyMs = opts?.busyTimeoutMs ?? 2500;
    this.db.exec(`PRAGMA busy_timeout = ${busyMs};`);
    this.db.exec("PRAGMA foreign_keys = ON;");
    if (!opts?.readonly) ensureInitialized(this.db);
  }

  closeDb(): void {
    this.db.close();
  }

  private assertRepoBranchFreeForOpenTask(
    repo: string,
    branch: string,
    allowedTaskId: string,
  ): void {
    const conflicts = this.db
      .query(
        `SELECT t.task_id, t.status FROM tasks t
         INNER JOIN task_repos tr ON t.task_id = tr.task_id
         WHERE canonical_repo(tr.repo) = canonical_repo(?) AND tr.branch = ? AND t.status IN ('OPEN','HANDED_OFF') AND t.task_id != ?`,
      )
      .all(repo, branch, allowedTaskId) as Array<{ task_id: string; status: string }>;
    if (conflicts[0]?.status === "HANDED_OFF") {
      throw Error("Branch " + repo + ":" + branch + " is owned by a handed-off task; run ledger resume " + conflicts[0].task_id);
    }
    if (conflicts.length > 0) {
      throw new Error(
        `Branch ${repo}:${branch} is already owned by ${conflicts[0].status} task ${conflicts[0].task_id}; close/cancel it or use a separate branch.`,
      );
    }
  }

  private resolveBase(repo?: string, branch?: string, worktree?: string | null, ref?: string | null) {
    if (ref == null) return null;
    if (!repo || !ref.trim()) throw new Error("--base requires an attached repository and a commit reference");
    const dir = branch ? resolveTaskCheckout(this.workbenchRoot, { repo, branch, worktree: worktree ?? null }).dir
      : worktree || join(this.workbenchRoot, repo);
    if (existsSync(join(dir, ".git"))) {
      const result = runGit(dir, ["rev-parse", "--verify", "--end-of-options", ref + "^{commit}"]);
      if (!result.code && /^[a-f0-9]{40}$/.test(result.stdout.trim())) return result.stdout.trim();
    }
    throw new Error("Cannot resolve --base to a commit in " + repo + ": " + ref);
  }

  openTask(params: {
    task_id: string;
    title: string;
    endpoint: DeliveryEndpoint;
    depth: VerificationDepth;
    repo?: string;
    branch?: string;
    worktree?: string | null;
    base_sha?: string | null;
    head_sha?: string | null;
    actor?: string;
    session_id?: string | null;
  }): { task: TaskRecord; event: EventRecord } {
    if (!VALID_ENDPOINTS.has(params.endpoint)) {
      throw new Error(`Invalid endpoint: ${params.endpoint}`);
    }
    if (!VALID_DEPTHS.has(params.depth)) {
      throw new Error(`Invalid verification depth: ${params.depth}`);
    }
    if (params.repo) params = {...params, repo:canonicalRepoPath(this.workbenchRoot,params.repo)};
    if (!/^[a-zA-Z0-9._-]{3,80}$/.test(params.task_id)) {
      throw new Error(
        `Invalid task_id "${params.task_id}" (use 3-80 chars of a-zA-Z0-9._-)`,
      );
    }

    return withImmediateTx(this.db, () => {
      const existing = this.db
        .query("SELECT task_id FROM tasks WHERE task_id = ?")
        .get(params.task_id);
      if (existing) {
        throw new Error(`Task already exists: ${params.task_id}`);
      }
      if (params.repo && params.branch) {
        this.assertRepoBranchFreeForOpenTask(params.repo, params.branch, params.task_id);
      }

      const base = this.resolveBase(params.repo, params.branch, params.worktree, params.base_sha);
      const ts = nowIso();
      this.db
        .query(
          `INSERT INTO tasks (
            task_id, title, status, endpoint, verification_depth,
            open_blockers, last_verified_sha, tip_hash, created_at, updated_at, closed_at
          ) VALUES (?, ?, 'OPEN', ?, ?, 0, '{}', 'PENDING', ?, ?, NULL)`,
        )
        .run(params.task_id, params.title, params.endpoint, params.depth, ts, ts);

      const event = appendEventInTx(this.db, {
        task_id: params.task_id,
        event_type: "TASK_OPENED",
        actor: params.actor ?? "agent",
        session_id: params.session_id,
        repo: params.repo,
        branch: params.branch,
        sha: params.head_sha ?? base,
        ts,
        payload: {
          title: params.title,
          endpoint: params.endpoint,
          verification_depth: params.depth,
          base_sha: base,
        },
      });

      if (params.repo && params.branch) {
        this.attachRepoInTx({
          task_id: params.task_id,
          repo: params.repo,
          branch: params.branch,
          worktree: params.worktree ?? null,
          base_sha: base,
          head_sha: params.head_sha ?? base,
          actor: params.actor ?? "agent",
          session_id: params.session_id,
        });
      }

      const task = this.getTask(params.task_id)!;
      return { task, event };
    });
  }

  private attachRepoInTx(params: {
    task_id: string;
    repo: string;
    branch: string;
    worktree?: string | null;
    base_sha?: string | null;
    head_sha?: string | null;
    actor?: string;
    session_id?: string | null;
  }): EventRecord {
    params = {...params, repo:canonicalRepoPath(this.workbenchRoot,params.repo)};
    const task = this.getTask(params.task_id);
    if (!task) throw new Error(`Task not found: ${params.task_id}`);
    if (task.status !== "OPEN") {
      throw new Error(`Cannot attach repo to ${task.status} task: ${params.task_id}`);
    }
    this.assertRepoBranchFreeForOpenTask(params.repo, params.branch, params.task_id);

    const previous = this.getTaskRepos(params.task_id).find(r=>r.repo===params.repo && r.branch===params.branch);
    // Keep historical hash-chain entries intact. Coalesce legacy attachment aliases on this write.
    this.db.query("DELETE FROM task_repos WHERE task_id=? AND branch=? AND canonical_repo(repo)=? AND repo<>?")
      .run(params.task_id,params.branch,params.repo,params.repo);
    const history = this.db.query(`SELECT json_extract(payload_json, '$.base_sha') AS base_sha,
      json_type(payload_json, '$.base_repair') AS repair FROM events
      WHERE task_id = ? AND canonical_repo(repo) = canonical_repo(?) AND branch = ? AND event_type = 'REPO_ATTACHED' ORDER BY seq`)
      .all(params.task_id, params.repo, params.branch) as Array<{ base_sha: string | null; repair: string | null }>;
    if (params.worktree && !existsSync(join(params.worktree, ".git"))) throw new Error("Cannot verify supplied worktree: " + params.worktree);
    const checkout = resolveTaskCheckout(this.workbenchRoot, { ...params, worktree: params.worktree ?? previous?.worktree ?? null }, true);
    const repairIndex = history.map(row => row.repair).lastIndexOf("object");
    const activeHistory = repairIndex < 0 ? history : history.slice(repairIndex);
    let recovered = false;
    let base = params.base_sha ?? null;
    for (const candidate of new Set([...activeHistory, ...(previous ? [previous] : [])].map(row => row.base_sha))) {
      if (!candidate || !/^[a-f0-9]{7,64}$/i.test(candidate) || !existsSync(join(checkout.dir, ".git"))) continue;
      const commit = runGit(checkout.dir, ["rev-parse", "--verify", "--end-of-options", candidate + "^{commit}"]);
      if (!commit.code) { base = commit.stdout.trim(); recovered = true; break; }
    }
    if (!base && (history.length || previous)) throw new Error("Recover the original attachment start with --base <commit-sha>");
    const worktree = checkout.registered ? realpathSync(checkout.dir) : params.worktree ? realpathSync(params.worktree) : null;
    if (!base && existsSync(join(checkout.dir, ".git"))) {
      const start = runGit(checkout.dir, ["rev-parse", "--verify", "--end-of-options", "refs/heads/" + params.branch + "^{commit}"]);
      if (!start.code) base = start.stdout.trim();
    }
    const ts = nowIso();
    this.db
      .query(
        `INSERT INTO task_repos (repo, branch, worktree, task_id, base_sha, head_sha, attached_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo, branch, task_id) DO UPDATE SET
           worktree = COALESCE(excluded.worktree, task_repos.worktree),
           base_sha = COALESCE(excluded.base_sha, task_repos.base_sha),
           head_sha = COALESCE(excluded.head_sha, task_repos.head_sha)`,
      )
      .run(
        params.repo,
        params.branch,
        worktree ?? previous?.worktree ?? null,
        params.task_id,
        base,
        params.head_sha ?? previous?.head_sha ?? null,
        previous?.attached_at ?? ts,
      );

    return appendEventInTx(this.db, {
      task_id: params.task_id,
      event_type: "REPO_ATTACHED",
      actor: params.actor ?? "agent",
      session_id: params.session_id,
      repo: params.repo,
      branch: params.branch,
      sha: params.head_sha ?? base,
      ts,
      payload: {
        worktree,
        base_sha: base,
        ...(!recovered && params.base_sha && (history.length || previous) ? {
          base_repair: { supersedes: previous?.base_sha ?? activeHistory.at(-1)?.base_sha ?? null },
        } : {}),
        head_sha: params.head_sha ?? null,
      },
    });
  }

  attachRepo(params: {
    task_id: string;
    repo: string;
    branch: string;
    worktree?: string | null;
    base_sha?: string | null;
    head_sha?: string | null;
    actor?: string;
    session_id?: string | null;
  }): EventRecord {
    return withImmediateTx(this.db, () => this.attachRepoInTx({ ...params, base_sha: this.resolveBase(params.repo, params.branch, params.worktree, params.base_sha) }));
  }

  detachRepo(params: {
    task_id: string;
    repo: string;
    branch: string;
    reason?: string;
    actor?: string;
    session_id?: string | null;
  }): EventRecord {
    return withImmediateTx(this.db, () => {
      const task = this.getTask(params.task_id);
      if (!task) throw new Error(`Task not found: ${params.task_id}`);
      if (task.status !== "OPEN") {
        throw new Error(`Cannot detach repo on ${task.status} task: ${params.task_id}`);
      }
      const existing = this.db
        .query(
          "SELECT * FROM task_repos WHERE task_id = ? AND canonical_repo(repo) = canonical_repo(?) AND branch = ?",
        )
        .get(params.task_id, params.repo, params.branch) as TaskRepoRecord | null;
      if (!existing) {
        throw new Error(
          `Branch ${params.repo}:${params.branch} is not attached to task ${params.task_id}`,
        );
      }
      this.db
        .query("DELETE FROM task_repos WHERE task_id = ? AND canonical_repo(repo) = canonical_repo(?) AND branch = ?")
        .run(params.task_id, params.repo, params.branch);
      return appendEventInTx(this.db, {
        task_id: params.task_id,
        event_type: "REPO_DETACHED",
        actor: params.actor ?? "agent",
        session_id: params.session_id,
        repo: params.repo,
        branch: params.branch,
        sha: existing.head_sha ?? existing.base_sha ?? null,
        payload: {
          reason: params.reason ?? "",
          prev_head_sha: existing.head_sha ?? null,
          worktree: existing.worktree ?? null,
        },
      });
    });
  }

  reopenTask(params: {
    task_id: string;
    endpoint?: DeliveryEndpoint;
    depth?: VerificationDepth;
    reason?: string;
    actor?: string;
    session_id?: string | null;
  }): { task: TaskRecord; event: EventRecord } {
    if (params.endpoint !== undefined && !VALID_ENDPOINTS.has(params.endpoint)) {
      throw new Error(`Invalid endpoint: ${params.endpoint}`);
    }
    if (params.depth !== undefined && !VALID_DEPTHS.has(params.depth)) {
      throw new Error(`Invalid verification depth: ${params.depth}`);
    }
    return withImmediateTx(this.db, () => {
      const task = this.getTask(params.task_id);
      if (!task) throw new Error(`Task not found: ${params.task_id}`);
      if (task.status !== "CLOSED") {
        throw new Error(
          `Only CLOSED tasks can be reopened (task ${params.task_id} is ${task.status})`,
        );
      }
      const nextEndpoint = params.endpoint !== undefined ? params.endpoint : task.endpoint;
      const nextDepth = params.depth !== undefined ? params.depth : task.verification_depth;
      const isDowngrade = ENDPOINT_RANK[nextEndpoint] < ENDPOINT_RANK[task.endpoint];
      if (isDowngrade) {
        if (nextEndpoint === "investigation") {
          throw new Error(
            `Cannot downgrade development task ${params.task_id} (${task.endpoint}) to investigation`,
          );
        }
        if (!params.reason?.trim()) {
          throw new Error(
            `Downgrading endpoint (${task.endpoint} -> ${nextEndpoint}) requires a non-empty --reason`,
          );
        }
      }
      const repos = this.getTaskRepos(params.task_id);
      for (const r of repos) {
        this.assertRepoBranchFreeForOpenTask(r.repo, r.branch, params.task_id);
      }
      const ts = nowIso();
      this.db
        .query(
          `UPDATE tasks
           SET status = 'OPEN', closed_at = NULL, endpoint = ?, verification_depth = ?, updated_at = ?
           WHERE task_id = ?`,
        )
        .run(nextEndpoint, nextDepth, ts, params.task_id);
      const event = appendEventInTx(this.db, {
        task_id: params.task_id,
        event_type: "TASK_REOPENED",
        actor: params.actor ?? "agent",
        session_id: params.session_id,
        ts,
        payload: {
          prev_endpoint: task.endpoint,
          endpoint: nextEndpoint,
          prev_depth: task.verification_depth,
          verification_depth: nextDepth,
          reason: params.reason ?? "",
          ...(isDowngrade ? { downgrade: true } : {}),
        },
      });
      return { task: this.getTask(params.task_id)!, event };
    });
  }

  updateEndpoint(params: {
    task_id: string;
    endpoint: DeliveryEndpoint;
    reason?: string;
    actor?: string;
    session_id?: string | null;
  }): { task: TaskRecord; event: EventRecord } {
    if (!VALID_ENDPOINTS.has(params.endpoint)) {
      throw new Error(`Invalid endpoint: ${params.endpoint}`);
    }
    return withImmediateTx(this.db, () => {
      const task = this.getTask(params.task_id);
      if (!task) throw new Error(`Task not found: ${params.task_id}`);
      if (task.status !== "OPEN") {
        throw new Error(`Cannot update endpoint on ${task.status} task: ${params.task_id}`);
      }
      const isDowngrade = ENDPOINT_RANK[params.endpoint] < ENDPOINT_RANK[task.endpoint];
      if (isDowngrade) {
        if (params.endpoint === "investigation") {
          throw new Error(
            `Cannot downgrade development task ${params.task_id} (${task.endpoint}) to investigation; use 'ledger cancel --reason ...' or 'ledger close --force-incomplete --reason ...'`,
          );
        }
        if (!params.reason?.trim()) {
          throw new Error(
            `Downgrading endpoint (${task.endpoint} -> ${params.endpoint}) requires a non-empty --reason`,
          );
        }
      }
      const ts = nowIso();
      this.db
        .query("UPDATE tasks SET endpoint = ?, updated_at = ? WHERE task_id = ?")
        .run(params.endpoint, ts, params.task_id);
      const event = appendEventInTx(this.db, {
        task_id: params.task_id,
        event_type: "ENDPOINT_UPDATED",
        actor: params.actor ?? "agent",
        session_id: params.session_id,
        ts,
        payload: {
          prev_endpoint: task.endpoint,
          endpoint: params.endpoint,
          reason: params.reason ?? "",
          ...(isDowngrade ? { downgrade: true } : {}),
        },
      });
      return { task: this.getTask(params.task_id)!, event };
    });
  }

  recordDecision(params: {
    task_id: string;
    key: string;
    summary: string;
    supersedes_seq?: number;
    actor?: string;
    session_id?: string | null;
  }): EventRecord {
    return withImmediateTx(this.db, () => {
      const task = this.getTask(params.task_id);
      if (!task) throw new Error(`Task not found: ${params.task_id}`);
      if (task.status !== "OPEN") {
        throw new Error(`Cannot record decision on ${task.status} task`);
      }
      const event_type =
        params.supersedes_seq !== undefined
          ? "DECISION_SUPERSEDED"
          : "DECISION_LOCKED";
      return appendEventInTx(this.db, {
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

  recordBlocker(params: {
    task_id: string;
    action: "open" | "close";
    blocker_id: string;
    summary: string;
    actor?: string;
    session_id?: string | null;
  }): EventRecord {
    return withImmediateTx(this.db, () => {
      const task = this.getTask(params.task_id);
      if (!task) throw new Error(`Task not found: ${params.task_id}`);
      if (task.status !== "OPEN") {
        throw new Error(`Cannot update blocker on ${task.status} task`);
      }

      const ts = nowIso();
      const existing = this.db
        .query("SELECT * FROM task_blockers WHERE task_id = ? AND blocker_id = ?")
        .get(params.task_id, params.blocker_id) as TaskBlockerRecord | null;

      if (params.action === "open") {
        if (existing?.status === "OPEN") {
          throw new Error(`Blocker ${params.blocker_id} is already OPEN on ${params.task_id}`);
        }
        this.db
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
        this.db
          .query(
            `UPDATE task_blockers SET status = 'CLOSED', summary = ?, closed_at = ?
             WHERE task_id = ? AND blocker_id = ?`,
          )
          .run(params.summary, ts, params.task_id, params.blocker_id);
      }

      const event_type =
        params.action === "open" ? "BLOCKER_OPENED" : "BLOCKER_CLOSED";
      const ev = appendEventInTx(this.db, {
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

      const countRow = this.db
        .query(
          "SELECT COUNT(*) AS cnt FROM task_blockers WHERE task_id = ? AND status = 'OPEN'",
        )
        .get(params.task_id) as { cnt: number };
      this.db
        .query("UPDATE tasks SET open_blockers = ? WHERE task_id = ?")
        .run(countRow.cnt, params.task_id);
      return ev;
    });
  }

  recordEvidence(params: {
    task_id: string;
    kind:
      | "commit"
      | "build"
      | "test"
      | "lint"
      | "review"
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
  }): EventRecord {
    return withImmediateTx(this.db, () => {
      const task = this.getTask(params.task_id);
      if (!task) throw new Error(`Task not found: ${params.task_id}`);
      // Deployment can happen after PR handoff. Only the pinned production receipt
      // may extend this chain without resuming development.
      let prodReceipt = false;
      let releaseId: string | undefined;
      if (task.status === "HANDED_OFF" && params.kind === "prod" && params.repo && params.branch && params.sha) {
        const repo = canonicalRepoPath(this.workbenchRoot,params.repo);
        const snapshot = currentHandoff(this,task.task_id);
        const item = snapshot.items.find(i =>
          canonicalRepoPath(this.workbenchRoot,i.repo) === repo && i.branch === params.branch && i.verified_head === params.sha);
        const bookId = params.meta?.runbook_id;
        if (bookId !== undefined || params.meta?.action_id !== undefined) {
          const book = typeof bookId === "string" ? this.getRunbook(bookId) : null;
          const linked = book && this.db.query("SELECT 1 FROM releases r JOIN release_items i USING(release_id) WHERE r.runbook_id=? AND r.status='APPROVED' AND i.task_id=? AND i.ledger_tip=?")
            .get(book.runbook_id,task.task_id,snapshot.ledger_tip);
          const action = book && productionActions(JSON.parse(book.actions_json)).find(a=>a.action_id===params.meta?.action_id)?.action;
          if (!item || !linked || book?.status !== "APPROVED" || !action || !actionMatchesItem(snapshot,item,action))
            throw Error("Production receipt must match an approved release action and handoff SHA");
          prodReceipt = true;
        } else if (item && task.endpoint === "prod") {
          prodReceipt = true;
          releaseId = this.db.query<{ release_id: string }, [string, string]>(
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
        params.kind === "review" && params.meta && typeof params.meta.role === "string"
          ? { ...params.meta, role: normalizeReviewRole(params.meta.role) }
          : params.meta;
      const ev = appendEventInTx(this.db, {
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
        this.db
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
        this.db
          .query("UPDATE tasks SET last_verified_sha = ? WHERE task_id = ?")
          .run(JSON.stringify(verifiedMap), params.task_id);
      }

      return ev;
    });
  }

  addExemption(params: {
    repo: string;
    branch: string;
    reason: string;
    head_sha?: string | null;
    ttl_hours?: number;
  }): ExemptionRecord {
    return withImmediateTx(this.db, () => {
      const created = nowIso();
      const ttlHours = params.ttl_hours ?? 24;
      const expires = new Date(Date.now() + ttlHours * 3600_000).toISOString();
      const info = this.db
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

  bindExemptionHeadSha(id: number, head_sha: string): void {
    withImmediateTx(this.db, () => {
      this.db
        .query("UPDATE exemptions SET head_sha = ? WHERE id = ?")
        .run(head_sha, id);
    });
  }

  findActiveExemption(
    repo: string,
    branch: string,
  ): ExemptionRecord | null {
    const now = nowIso();
    const row = this.db
      .query(
        `SELECT * FROM exemptions
         WHERE canonical_repo(repo) = canonical_repo(?) AND branch = ?
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY id DESC LIMIT 1`,
      )
      .get(repo, branch, now) as ExemptionRecord | null;
    return row ?? null;
  }

  findOpenTasksByRepoBranch(repo: string, branch: string): TaskRecord[] {
    return this.db
      .query(
        `SELECT DISTINCT t.* FROM tasks t
         INNER JOIN task_repos tr ON t.task_id = tr.task_id
         WHERE canonical_repo(tr.repo) = canonical_repo(?) AND tr.branch = ? AND t.status = 'OPEN'
         ORDER BY t.updated_at DESC`,
      )
      .all(repo, branch) as TaskRecord[];
  }

  /**
   * Trace a detached worktree commit (e.g. FAT merge commit whose parents include the feature branch HEAD)
   * back to its owning OPEN task.
   */
  findOpenTasksByRepoCommits(repo: string, shas: string[]): TaskRecord[] {
    if (shas.length === 0) return [];
    const placeholders = shas.map(() => "?").join(",");
    return this.db
      .query(
        `SELECT DISTINCT t.* FROM tasks t
         INNER JOIN task_repos tr ON t.task_id = tr.task_id
         WHERE canonical_repo(tr.repo) = canonical_repo(?) AND tr.head_sha IN (${placeholders}) AND t.status = 'OPEN'
         ORDER BY t.updated_at DESC`,
      )
      .all(repo, ...shas) as TaskRecord[];
  }

  getTask(task_id: string): TaskRecord | null {
    return (
      (this.db
        .query("SELECT * FROM tasks WHERE task_id = ?")
        .get(task_id) as TaskRecord | null) ?? null
    );
  }

  getTaskRepos(task_id: string): TaskRepoRecord[] {
    const rows = this.db.query<TaskRepoRecord,[string]>("SELECT * FROM task_repos WHERE task_id=? ORDER BY attached_at,rowid").all(task_id);
    const unique = new Map<string,TaskRepoRecord>();
    for (const row of rows) {
      row.repo = canonicalRepoPath(this.workbenchRoot,row.repo);
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

  getTaskBlockers(task_id: string): TaskBlockerRecord[] {
    return this.db
      .query("SELECT * FROM task_blockers WHERE task_id = ? ORDER BY opened_at ASC")
      .all(task_id) as TaskBlockerRecord[];
  }

  getTaskEvents(task_id: string): EventRecord[] {
    return this.db
      .query("SELECT * FROM events WHERE task_id = ? ORDER BY seq ASC")
      .all(task_id) as EventRecord[];
  }

  listOpenTasks(): TaskRecord[] {
    return this.db
      .query("SELECT * FROM tasks WHERE status = 'OPEN' ORDER BY updated_at DESC")
      .all() as TaskRecord[];
  }

  /**
   * Freeze the 3-document dev cycle spec package (ssot.md, tech-spec.md, test-spec.md)
   * by recording their SHA-256 digests and optional locked test globs in the task hash chain.
   */
  freezeSpec(params: {
    task_id: string;
    spec_dir?: string;
    locked_test_globs?: string[];
    actor?: string;
    session_id?: string | null;
  }): { event: EventRecord; spec: TaskSpecState } {
    return freezeSpec(this, params);
  }

  /**
   * Explicitly amend a frozen spec package (requires prior SPEC_FROZEN and non-empty reason).
   * Unlocks editing for the declared scope and marks downstream stages STALE until re-frozen & re-verified.
   */
  amendSpec(params: {
    task_id: string;
    scope: SpecAmendScope;
    reason: string;
    actor?: string;
    session_id?: string | null;
  }): { event: EventRecord; spec: TaskSpecState } {
    return amendSpec(this, params);
  }

  /**
   * Inspect current spec freeze/amend state, disk SHA-256 drift, and per-stage stale floors.
   */
  getSpecState(task_id: string): TaskSpecState {
    return getSpecState(this, task_id);
  }

  /**
   * Return spec states for all OPEN tasks that currently have a frozen or amended spec package.
   */
  listActiveSpecLocks(): TaskSpecState[] {
    return listActiveSpecLocks(this);
  }

  /**
   * Check readiness for a specific (task, repo, head_sha):
   * - Zero open blockers;
   * - If spec package is frozen: zero silent disk drift and not left in un-refrozen AMENDED state;
   * - Latest post-amend status of each executed verification kind (test/build/lint/hurl) for this exact
   *   (repo, head_sha) must not be `fail`;
   * - For `targeted`: at least one of test/build/lint/hurl must be `pass`;
   * - For `full`: static check (`lint`) MUST be `pass`, at least one of test/build/hurl MUST be `pass`,
   *   and latest review status must be `pass` or `fallback`.
   */
  checkPushReadiness(params: {
    task_id: string;
    repo: string;
    head_sha: string;
    branch?: string;
    checkoutDir?: string;
    checkEndpoint?: boolean;
  }): {
    ready: boolean;
    missing: string[];
    hasExplicitFailure: boolean;
    recordedReviewRoles: string[];
  } {
    return this.checkReadiness(params, false);
  }

  private checkReadiness(params: { task_id: string; repo: string; head_sha: string; branch?: string; checkoutDir?: string; checkEndpoint?: boolean }, closing: boolean) {
    const task = this.getTask(params.task_id);
    if (!task) {
      return {
        ready: false,
        missing: [`Task ${params.task_id} not found`],
        hasExplicitFailure: false,
        recordedReviewRoles: [],
      };
    }

    const missing: string[] = [];
    let hasExplicitFailure = false;
    const openBlockers = this.getTaskBlockers(params.task_id).filter(
      (b) => b.status === "OPEN",
    );
    if (openBlockers.length > 0) {
      missing.push(
        `${openBlockers.length} open blocker(s): ${openBlockers.map((b) => b.blocker_id).join(", ")}`,
      );
    }

    params = {...params, repo:canonicalRepoPath(this.workbenchRoot,params.repo)};
    const specState = getSpecState(this, params.task_id, { delivery: params, closing });
    if (specState.drifted_locked_tests.length) {
      hasExplicitFailure = true;
      missing.push("冻结测试文件发生漂移 (" + specState.drifted_locked_tests.join(", ") + ")，请恢复测试文件或执行 ledger amend --scope test_spec 后重新 freeze");
    }
    if (specState.state === "AMENDED") {
      missing.push(
        `spec is in AMENDED state (scope=${specState.amend_scope ?? "unknown"}); finish revisions and run \`ledger freeze ${params.task_id}\` before delivery`,
      );
    } else if (specState.state === "FROZEN" && specState.drifted_files.length > 0) {
      hasExplicitFailure = true;
      missing.push(
        `frozen spec drifted on disk (${specState.drifted_files.join(", ")}); restore files or run \`ledger amend ${params.task_id} --scope ... --reason "..."\` then re-freeze`,
      );
    }

    const events = this.db
      .query(
        `SELECT seq, actor, branch, event_type, payload_json FROM events
         WHERE task_id = ? AND canonical_repo(repo) = canonical_repo(?)
           AND (event_type IN ('REPO_ATTACHED','REPO_DETACHED') OR (event_type='EVIDENCE_CAPTURED' AND sha=?))
         ORDER BY seq ASC`,
      )
      .all(params.task_id, params.repo, params.head_sha) as Array<{
      seq: number;
      event_type: string;
      branch: string | null;
      actor: string;
      payload_json: string;
    }>;

    const floors = specState.evidence_floor_seq;
    const reviewFloor = this.db.query("SELECT ts FROM events WHERE task_id = ? AND seq = ?")
      .get(params.task_id, floors.review) as { ts: string } | null;
    const repoAttachments = this.getTaskRepos(params.task_id).filter((r) => r.repo === params.repo);
    const attachments = repoAttachments.filter((r) =>
      params.branch
        ? r.branch === params.branch
        : repoAttachments.length === 1 || r.head_sha === params.head_sha,
    );
    const unresolved = !params.branch && repoAttachments.length > 1 && attachments.length !== 1;
    if (unresolved) missing.push("Specify the attached branch to verify delivery evidence");
    if (task.verification_depth === "full" || (task.verification_depth === "targeted" && params.checkEndpoint)) {
      for (const r of attachments) if (!r.base_sha) {
        missing.push(`review baseline missing: ledger attach ${params.task_id} --repo ${r.repo} --branch ${r.branch} --base <original-start-sha>`);
      }
    }
    type BranchEvidence = {
      checks: Map<string, string>;
      reviews: Map<string, string>;
      endpoint?: string;
    };
    const byBranch = new Map<string | null, BranchEvidence>();
    type ReviewAttachment = Pick<TaskRepoRecord, "repo" | "branch" | "worktree" | "base_sha">;
    const attachedAtEvent = new Map<string, ReviewAttachment>();
    for (const ev of events) {
      if (ev.event_type === "REPO_ATTACHED" || ev.event_type === "REPO_DETACHED") {
        if (ev.branch) {
          if (ev.event_type === "REPO_ATTACHED") {
            const { base_sha, worktree } = JSON.parse(ev.payload_json);
            attachedAtEvent.set(ev.branch, { repo: params.repo, branch: ev.branch, base_sha, worktree });
          } else {
            attachedAtEvent.delete(ev.branch);
          }
        }
        continue;
      }
      const branch = ev.branch ?? (attachedAtEvent.size === 1 ? attachedAtEvent.keys().next().value ?? null : null);
      if (params.branch && branch && branch !== params.branch) continue;
      let evidence = byBranch.get(branch);
      if (!evidence) {
        evidence = { checks: new Map(), reviews: new Map() };
        byBranch.set(branch, evidence);
      }
      try {
        const p = JSON.parse(ev.payload_json) as {
          source?: EvidenceSource;
          kind?: string;
          status?: string;
          meta?: {
            pr_head_oid?: string;
            pr_url?: string;
            role?: string;
            started_at?: string;
            review_floor_seq?: number;
            base?: string;
          };
        };
        if (!p.kind || !p.status) continue;
        if (EXECUTABLE_EVIDENCE.has(p.kind) && evidenceSource(p, ev.actor) === "manual") continue;
        if (p.kind === "lint") {
          if (ev.seq >= floors.lint) evidence.checks.set("lint", p.status);
        } else if (p.kind === "test" || p.kind === "build") {
          if (ev.seq >= floors.test) evidence.checks.set(p.kind, p.status);
        } else if (p.kind === "hurl") {
          if (ev.seq >= floors.test) evidence.checks.set("hurl", p.status);
        }
        if (p.kind === "review") {
          if (ev.seq < floors.review || !reviewMeetsFloor(p.status, p.meta, params.task_id, floors.review, reviewFloor?.ts, evidenceSource(p, ev.actor))) continue;
          const historical = branch ? [attachedAtEvent.get(branch)] : [...attachedAtEvent.values()];
          const current = branch ? repoAttachments.filter((r) => r.branch === branch) : [];
          const covered = (row: ReviewAttachment | undefined) =>
            !!row && coversReviewBase(this.workbenchRoot, row, p.meta?.base);
          if (p.status === "fail" || (historical.length > 0 && historical.every(covered) && current.every(covered))) {
            const roleKey = normalizeReviewRole(p.meta?.role);
            evidence.reviews.set(roleKey, p.status);
          }
        }
        if (
          (task.endpoint === "pr" && p.kind === "pr" && attachments.length === 1 && ev.branch === attachments[0].branch) ||
          (task.endpoint === "fat" && (p.kind === "fat" ||
            (p.kind === "hurl" && evidenceSource(p, ev.actor) === "hook"))) ||
          (task.endpoint === "prod" && p.kind === "prod")
        ) {
          if (p.kind === "pr" && p.status === "pass" &&
              (p.meta?.pr_head_oid !== params.head_sha || !p.meta.pr_url)) continue;
          const endpointFloor = task.endpoint === "fat" ? floors.fat : 0;
          if (ev.seq >= endpointFloor && (p.status === "pass" || p.status === "fail")) {
            evidence.endpoint = p.status;
          }
        }
      } catch {
        // Ignore malformed payload
      }
    }

    // A detached merge must honor failures at its own SHA before trying a verified parent.
    // Positive evidence is credited only to the selected attachment or its unambiguous legacy receipts.
    const failedKinds = new Set<string>();
    const failedRoles = new Set<string>();
    const latestByKind = new Map<string, string>();
    const passingRoles = new Set<string>();
    let latestEndpointStatus: string | undefined;
    for (const [branch, evidence] of byBranch) {
      const eligible = attachments.length === 1 && branch === attachments[0].branch;
      for (const [kind, status] of evidence.checks) {
        if (status === "fail") failedKinds.add(kind);
        if (eligible && status === "pass") latestByKind.set(kind, status);
      }
      for (const [role, status] of evidence.reviews) {
        if (status === "fail") failedRoles.add(role);
        if (eligible && (status === "pass" || status === "fallback")) passingRoles.add(role);
      }
      if (evidence.endpoint === "fail" || (eligible && latestEndpointStatus !== "fail" && evidence.endpoint)) {
        latestEndpointStatus = evidence.endpoint;
      }
    }
    const hasPassingVerify = [...latestByKind.values()].some((st) => st === "pass");
    const hasPassingExecVerify =
      latestByKind.get("test") === "pass" ||
      latestByKind.get("build") === "pass" ||
      latestByKind.get("hurl") === "pass";

    if (failedKinds.size > 0) {
      hasExplicitFailure = true;
      missing.push(
        `latest ${[...failedKinds].join("/")} failed for ${params.repo}@${params.head_sha.slice(0, 8)}`,
      );
    } else if (task.verification_depth === "full") {
      if (latestByKind.get("lint") !== "pass") {
        missing.push(
          `full verification requires passing static check (lint) evidence for ${params.repo}@${params.head_sha.slice(0, 8)} (run .workbench/bin/wb-verify --task ${params.task_id} --repo ${params.repo} --mode static)`,
        );
      }
      if (!hasPassingExecVerify) {
        missing.push(
          `no passing build/test/hurl evidence recorded for ${params.repo}@${params.head_sha.slice(0, 8)}`,
        );
      }
    } else if (!hasPassingVerify) {
      missing.push(
        `no passing build/test/lint/hurl evidence recorded for ${params.repo}@${params.head_sha.slice(0, 8)}`,
      );
    }

    if (failedRoles.size > 0) {
      hasExplicitFailure = true;
      missing.push(
        `latest review failed (${[...failedRoles].join(", ")}) for ${params.repo}@${params.head_sha.slice(0, 8)}`,
      );
    } else if (task.verification_depth === "targeted") {
      // Targeted depth requires at least one independent review pass/fallback before delivery/close
      if (params.checkEndpoint && passingRoles.size === 0) {
        missing.push(
          `targeted verification requires independent review evidence for ${params.repo}@${params.head_sha.slice(0, 8)}`,
        );
      }
    } else if (task.verification_depth === "full") {
      const hasQualityOrBusiness = [...passingRoles].some((r) =>
        ["codex-review", "quality", "business-review", "default"].includes(r),
      );
      if (!hasQualityOrBusiness) {
        missing.push(
          `full verification requires business/quality review pass or fallback for ${params.repo}@${params.head_sha.slice(0, 8)}`,
        );
      }
    }

    if (
      params.checkEndpoint &&
      (task.endpoint === "pr" || task.endpoint === "fat" || task.endpoint === "prod")
    ) {
      if (latestEndpointStatus === "fail") {
        hasExplicitFailure = true;
        missing.push(
          `latest ${task.endpoint} delivery verification failed for ${params.repo}@${params.head_sha.slice(0, 8)}`,
        );
      } else if (latestEndpointStatus !== "pass") {
        missing.push(
          `endpoint "${task.endpoint}" requires recorded ${task.endpoint} delivery evidence for ${params.repo}@${params.head_sha.slice(0, 8)}` +
          (task.endpoint === "pr" ? `; run ledger pr-sync ${params.task_id} --repo ${params.repo} to verify the remote PR head` : ""),
        );
      }
    }

    return {
      ready: missing.length === 0,
      missing,
      hasExplicitFailure,
      recordedReviewRoles: [...passingRoles],
    };
  }

  closeTask(params: {
    task_id: string;
    summary?: string;
    archive?: boolean;
    forceIncomplete?: boolean;
    forceReason?: string;
    actor?: string;
    session_id?: string | null;
  }): { task: TaskRecord; archivePath: string | null } {
    const ev = withImmediateTx(this.db, () => {
      const task = this.getTask(params.task_id);
      if (!task) throw new Error(`Task not found: ${params.task_id}`);
      if (task.status !== "OPEN") {
        throw new Error(`Task ${params.task_id} is already ${task.status}`);
      }

      // Enforce readiness across all attached repos unless endpoint is investigation or explicit force-incomplete
      if (task.endpoint !== "investigation" && !params.forceIncomplete) {
        const repos = this.getTaskRepos(params.task_id);
        const allMissing: string[] = [];
        if (repos.length === 0) {
          allMissing.push(
            `development task (${task.endpoint}) has no attached repository; attach a repo or use --force-incomplete --reason "..."`,
          );
        }
        for (const r of repos) {
          // Verify against LIVE git branch HEAD when the repo exists on disk so unrecorded commits
          // cannot let closeTask succeed using stale earlier evidence!
          let effectiveSha = r.head_sha;
          const { dir: candidateDir } = resolveTaskCheckout(this.workbenchRoot, r, true);
          if (existsSync(candidateDir)) {
            const liveRes = runGit(
              candidateDir,
              ["rev-parse", "--verify", `refs/heads/${r.branch}`],
              3000,
            );
            if (liveRes.code === 0 && liveRes.stdout.trim()) {
              effectiveSha = liveRes.stdout.trim();
            } else {
              // Allow closing a post-delivery cleaned-up branch ONLY when:
              // 1) endpoint is a delivered remote target (fat/pr/prod),
              // 2) recorded head_sha resolves to a real commit reachable from `origin`'s exact
              //    delivery destination ref (NEVER a local-only tag, another remote, or an unmerged feature ref for fat), AND
              // 3) that exact SHA already has complete verification + endpoint delivery evidence.
              const remoteRefs = task.endpoint === "fat" ? ["refs/remotes/origin/fat"]
                : task.endpoint === "pr" ? prRemoteRefs(candidateDir, r.branch)
                : task.endpoint === "prod" ? ["refs/remotes/origin/main", "refs/remotes/origin/master"] : [];
              if (r.head_sha && reachableFromRefs(candidateDir, r.head_sha, remoteRefs)) {
                const deliveredCheck = this.checkReadiness({
                  task_id: params.task_id,
                  repo: r.repo,
                  branch: r.branch,
                  head_sha: r.head_sha,
                  checkEndpoint: true,
                }, true);
                if (deliveredCheck.ready) {
                  continue;
                }
                allMissing.push(
                  `${r.repo}:${r.branch} live branch refs/heads/${r.branch} could not be resolved on disk (and recorded ${r.head_sha.slice(0, 8)} lacks full evidence; detach obsolete branch with 'ledger detach' if abandoned)`,
                  ...deliveredCheck.missing,
                );
                continue;
              }
              // Fail closed: repo exists on disk, so an unresolvable/missing branch MUST NOT
              // silently close using unverified/stale stored head_sha!
              allMissing.push(
                `${r.repo}:${r.branch} live branch refs/heads/${r.branch} could not be resolved on disk (if renamed/abandoned, run 'ledger detach ${params.task_id} --repo ${r.repo} --branch ${r.branch}')`,
              );
              continue;
            }
          }
          if (!effectiveSha) {
            allMissing.push(`${r.repo}:${r.branch} has no recorded head_sha`);
            continue;
          }
          const check = this.checkReadiness({
            task_id: params.task_id,
            repo: r.repo,
            branch: r.branch,
            head_sha: effectiveSha,
            checkEndpoint: true,
          }, true);
          if (!check.ready) allMissing.push(...check.missing);
        }
        if (allMissing.length > 0) {
          throw new Error(
            `Cannot close task ${params.task_id}; missing completion evidence:\n- ${allMissing.join("\n- ")}\n(Pass --force-incomplete --reason "..." only if intentionally closing with documented gaps.)`,
          );
        }
      }

      if (params.forceIncomplete && !params.forceReason?.trim()) {
        throw new Error("--force-incomplete requires --reason <text>");
      }

      const ts = nowIso();
      const closedEv = appendEventInTx(this.db, {
        task_id: params.task_id,
        event_type: "TASK_CLOSED",
        actor: params.actor ?? "agent",
        session_id: params.session_id,
        ts,
        payload: {
          summary: params.summary ?? "",
          ...(params.forceIncomplete
            ? { force_incomplete: true, force_reason: params.forceReason }
            : {}),
        },
      });
      this.db
        .query("UPDATE tasks SET status = 'CLOSED', closed_at = ?, updated_at = ? WHERE task_id = ?")
        .run(ts, ts, params.task_id);
      return closedEv;
    });

    const task = this.getTask(params.task_id)!;
    let archivePath: string | null = null;
    if (params.archive !== false) {
      archivePath = this.exportArchive(task.task_id, ev.ts);
    }
    return { task, archivePath };
  }

  exportArchive(task_id: string, closedTs?: string): string {
    const task = this.getTask(task_id);
    if (!task) throw new Error(`Task not found: ${task_id}`);
    const ts = closedTs ?? task.closed_at ?? task.updated_at;
    const month = ts.slice(0, 7);
    const dir = join(dirname(this.dbPath), "archive", month);
    mkdirSync(dir, { recursive: true });
    const outPath = join(dir, `${task.task_id}.md`);
    const repos = this.getTaskRepos(task.task_id);
    const events = this.getTaskEvents(task.task_id);

    const lines: string[] = [
      `# Task Ledger Archive: ${task.task_id}`,
      "",
      `- **Title**: ${task.title}`,
      `- **Status**: ${task.status}`,
      `- **Endpoint / Depth**: ${task.endpoint} / ${task.verification_depth}`,
      `- **Created / Closed**: ${task.created_at} → ${task.closed_at ?? "-"}`,
      `- **Chain Tip Hash**: \`${task.tip_hash}\``,
      "",
      "## Repositories",
      "",
    ];
    if (repos.length === 0) {
      lines.push("- (none)");
    } else {
      for (const r of repos) {
        lines.push(
          `- \`${r.repo}\` (${r.branch}): base=\`${r.base_sha ?? "-"}\`, head=\`${r.head_sha ?? "-"}\``,
        );
      }
    }
    lines.push("", "## Event Chain", "");
    for (const ev of events) {
      lines.push(
        `- \`#${ev.seq}\` [${ev.ts}] **${ev.event_type}** (${ev.actor}${ev.repo ? `, ${ev.repo}` : ""}${ev.sha ? `@${ev.sha.slice(0, 8)}` : ""}) \`${ev.entry_hash}\`: ${ev.payload_json}`,
      );
    }
    writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
    return outPath;
  }

  cancelTask(params: {
    task_id: string;
    reason: string;
    actor?: string;
    session_id?: string | null;
  }): TaskRecord {
    withImmediateTx(this.db, () => {
      const task = this.getTask(params.task_id);
      if (!task) throw new Error(`Task not found: ${params.task_id}`);
      if (task.status !== "OPEN") {
        throw new Error(`Task ${params.task_id} is already ${task.status}`);
      }
      const ts = nowIso();
      appendEventInTx(this.db, {
        task_id: params.task_id,
        event_type: "TASK_CANCELLED",
        actor: params.actor ?? "agent",
        session_id: params.session_id,
        ts,
        payload: { reason: params.reason },
      });
      this.db
        .query("UPDATE tasks SET status = 'CANCELLED', closed_at = ?, updated_at = ? WHERE task_id = ?")
        .run(ts, ts, params.task_id);
    });
    return this.getTask(params.task_id)!;
  }

  verify(task_id?: string): {
    ok: boolean;
    checked_tasks: number;
    checked_events: number;
    errors: string[];
  } {
    return verify(this, task_id);
  }

  query(params: {
    q?: string;
    repo?: string;
    status?: string;
    since?: string;
    limit?: number;
  }): { tasks: TaskRecord[]; events: EventRecord[] } {
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
    const tasks = this.db.query(sql).all(...args, limit) as TaskRecord[];

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
      events = this.db
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

  prune(params: { beforeDays: number; apply: boolean }): {
    cutoff: string;
    candidates: string[];
    deleted: string[];
  } {
    const cutoff = new Date(
      Date.now() - params.beforeDays * 86400_000,
    ).toISOString();
    const eligible = "status IN ('CLOSED', 'CANCELLED') AND COALESCE(closed_at, updated_at) < ? AND NOT EXISTS (SELECT 1 FROM release_items r WHERE r.task_id=tasks.task_id)";
    const selectCandidates = () => {
      const rows = this.db.query(`SELECT task_id FROM tasks WHERE ${eligible} ORDER BY created_at ASC`)
        .all(cutoff) as Array<{ task_id: string }>;
      return rows.map((row) => row.task_id);
    };
    if (!params.apply) return { cutoff, candidates: selectCandidates(), deleted: [] };
    const result = withImmediateTx(this.db, () => {
      const candidates = selectCandidates();
      const remove = this.db.query(`DELETE FROM tasks WHERE task_id = ? AND ${eligible}`);
      const deleted = candidates.filter((id) => remove.run(id, cutoff).changes > 0);
      this.db.query("DELETE FROM exemptions WHERE expires_at IS NOT NULL AND expires_at < ?").run(nowIso());
      return { cutoff, candidates, deleted };
    });
    if (result.deleted.length) this.db.exec("VACUUM;");
    return result;
  }

  formatCompactContext(maxTasks = 8): string {
    const open = this.listOpenTasks().slice(0, maxTasks);
    const count = availableHandoffs(this).length;
    const quiet = count
      ? "Handoffs awaiting release: " +
        count +
        ' (run ledger release create --from-handoffs --title "<title>")'
      : "";
    if (!open.length) return quiet;
    const lines: string[] = ["[Workbench Active Task Ledgers]"];
    for (const t of open) {
      const repos = this.getTaskRepos(t.task_id);
      const repoDesc =
        repos
          .map(
            (r) =>
              `${r.repo}:${r.branch}${r.head_sha ? `@${r.head_sha.slice(0, 7)}` : ""}`,
          )
          .join(", ") || "no-repo";

      const openBlockers = this.getTaskBlockers(t.task_id).filter(
        (b) => b.status === "OPEN",
      );
      const blockerText =
        openBlockers.length > 0
          ? ` | blockers: ${openBlockers.map((b) => `${b.blocker_id}(${b.summary.slice(0, 40)})`).join(", ")}`
          : "";

      // Filter out superseded decisions so only active effective decisions appear
      const decRows = this.db
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

      const specState = this.getSpecState(t.task_id);
      const recentEvidence = this.db.query(
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

  createRunbook(params: {
    runbook_id?: string;
    task_id?: string | null;
    title: string;
    actions: Partial<RunbookActions>;
  }): RunbookRecord {
    return createRunbook(this, params);
  }

  getRunbook(runbook_id: string): RunbookRecord | null {
    return getRunbook(this, runbook_id);
  }

  listRunbooks(status?: RunbookStatus): RunbookRecord[] {
    return listRunbooks(this, status);
  }

  /**
   * Exclusively invoked by `ledger-hook` upon receiving a genuine root-session `UserPromptSubmit`.
   * NEVER exposed via `ledger` CLI so an agent cannot self-approve a runbook.
   */
  approveRunbookFromUserPrompt(params: {
    runbook_id: string;
    session_id: string;
    ttl_minutes?: number;
  }): { record: RunbookRecord; actions: RunbookActions } {
    return approveRunbookFromUserPrompt(this, params);
  }

  listActiveApprovedRunbooks(
    session_id: string,
  ): Array<{ record: RunbookRecord; actions: RunbookActions }> {
    return listActiveApprovedRunbooks(this, session_id);
  }

  completeRunbook(runbook_id: string): RunbookRecord {
    return completeRunbook(this, runbook_id);
  }

  revokeRunbook(runbook_id: string): RunbookRecord {
    return revokeRunbook(this, runbook_id);
  }
}
