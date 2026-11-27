import type { Database } from "bun:sqlite";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { canonicalRepoPath } from "../config";
import { runGit } from "../git";
import { installedInstance } from "../workflow-config";
import { resolveTaskCheckout } from "./checkout";
import { appendEventInTx, withImmediateTx } from "./transactions";
import {
  ENDPOINT_RANK,
  nowIso,
  VALID_DEPTHS,
  VALID_ENDPOINTS,
  type DeliveryEndpoint,
  type EventRecord,
  type LedgerReader,
  type TaskRecord,
  type TaskRepoRecord,
  type VerificationDepth,
} from "./types";

function assertRepoBranchFreeForOpenTask(db: Database, repo: string, branch: string, allowedTaskId: string): void {
  const conflicts = db
    .query(
      `SELECT t.task_id, t.status FROM tasks t
       INNER JOIN task_repos tr ON t.task_id = tr.task_id
       WHERE canonical_repo(tr.repo) = canonical_repo(?) AND tr.branch = ? AND t.status IN ('OPEN','HANDED_OFF') AND t.task_id != ?`,
    )
    .all(repo, branch, allowedTaskId) as Array<{ task_id: string; status: string }>;
  if (conflicts[0]?.status === "HANDED_OFF") {
    throw Error("Branch " + repo + ":" + branch + " is owned by a handed-off task; run forge ledger resume " + conflicts[0].task_id);
  }
  if (conflicts.length > 0) {
    throw new Error(
      `Branch ${repo}:${branch} is already owned by ${conflicts[0].status} task ${conflicts[0].task_id}; close/cancel it or use a separate branch.`,
    );
  }
}

function resolveBase(root: string, repo?: string, branch?: string, worktree?: string | null, ref?: string | null) {
  if (ref == null) return null;
  if (!repo || !ref.trim()) throw new Error("--base requires an attached repository and a commit reference");
  const dir = branch ? resolveTaskCheckout(root, { repo, branch, worktree: worktree ?? null }).dir
    : worktree || join(root, repo);
  if (existsSync(join(dir, ".git"))) {
    const result = runGit(dir, ["rev-parse", "--verify", "--end-of-options", ref + "^{commit}"]);
    if (!result.code && /^[a-f0-9]{40}$/.test(result.stdout.trim())) return result.stdout.trim();
  }
  throw new Error("Cannot resolve --base to a commit in " + repo + ": " + ref);
}

function validEndpoint(root: string, endpoint: string) {
  if (VALID_ENDPOINTS.has(endpoint)) return true;
  const instance = installedInstance(root);
  // Standalone historical ledgers may retain this metadata without an installed executor.
  return instance ? instance.delivery.value.endpoint === endpoint : endpoint === "fat";
}

export interface OpenTaskParams {
  workflow_version?: "0.4" | "0.5";
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
}

export function openTask(ledger: LedgerReader, params: OpenTaskParams): { task: TaskRecord; event: EventRecord } {
  if (!(params.workflow_version === "0.4" && params.endpoint === "fat") && !validEndpoint(ledger.workbenchRoot, params.endpoint)) {
    throw new Error(`Invalid endpoint: ${params.endpoint}`);
  }
  if (!VALID_DEPTHS.has(params.depth)) {
    throw new Error(`Invalid verification depth: ${params.depth}`);
  }
  if (params.repo) params = {...params, repo:canonicalRepoPath(ledger.workbenchRoot,params.repo)};
  if (!/^[a-zA-Z0-9._-]{3,80}$/.test(params.task_id)) {
    throw new Error(
      `Invalid task_id "${params.task_id}" (use 3-80 chars of a-zA-Z0-9._-)`,
    );
  }

  return withImmediateTx(ledger.db, () => {
    const existing = ledger.db
      .query("SELECT task_id FROM tasks WHERE task_id = ?")
      .get(params.task_id);
    if (existing) {
      throw new Error(`Task already exists: ${params.task_id}`);
    }
    if (params.repo && params.branch) {
      assertRepoBranchFreeForOpenTask(ledger.db, params.repo, params.branch, params.task_id);
    }

    const base = resolveBase(ledger.workbenchRoot, params.repo, params.branch, params.worktree, params.base_sha);
    const ts = nowIso();
    ledger.db
      .query(
        `INSERT INTO tasks (
          task_id, title, status, endpoint, verification_depth,
          open_blockers, last_verified_sha, tip_hash, created_at, updated_at, closed_at
        ) VALUES (?, ?, 'OPEN', ?, ?, 0, '{}', 'PENDING', ?, ?, NULL)`,
      )
      .run(params.task_id, params.title, params.endpoint, params.depth, ts, ts);

    const event = appendEventInTx(ledger.db, {
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
        ...(params.workflow_version !== "0.4" && { workflow_version: "0.5", specs_only: true }),
        verification_depth: params.depth,
        base_sha: base,
      },
    });

    if (params.repo && params.branch) {
      attachRepoInTx(ledger, {
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

    const task = ledger.getTask(params.task_id)!;
    return { task, event };
  });
}

function attachRepoInTx(ledger: LedgerReader, params: AttachRepoParams): EventRecord {
  params = {...params, repo:canonicalRepoPath(ledger.workbenchRoot,params.repo)};
  const task = ledger.getTask(params.task_id);
  if (!task) throw new Error(`Task not found: ${params.task_id}`);
  if (task.status !== "OPEN") {
    throw new Error(`Cannot attach repo to ${task.status} task: ${params.task_id}`);
  }
  assertRepoBranchFreeForOpenTask(ledger.db, params.repo, params.branch, params.task_id);

  const previous = ledger.getTaskRepos(params.task_id).find(r=>r.repo===params.repo && r.branch===params.branch);
  // Keep historical hash-chain entries intact. Coalesce legacy attachment aliases on this write.
  ledger.db.query("DELETE FROM task_repos WHERE task_id=? AND branch=? AND canonical_repo(repo)=? AND repo<>?")
    .run(params.task_id,params.branch,params.repo,params.repo);
  const history = ledger.db.query(`SELECT json_extract(payload_json, '$.base_sha') AS base_sha,
    json_type(payload_json, '$.base_repair') AS repair FROM events
    WHERE task_id = ? AND canonical_repo(repo) = canonical_repo(?) AND branch = ? AND event_type = 'REPO_ATTACHED' ORDER BY seq`)
    .all(params.task_id, params.repo, params.branch) as Array<{ base_sha: string | null; repair: string | null }>;
  if (params.worktree && !existsSync(join(params.worktree, ".git"))) throw new Error("Cannot verify supplied worktree: " + params.worktree);
  const checkout = resolveTaskCheckout(ledger.workbenchRoot, { ...params, worktree: params.worktree ?? previous?.worktree ?? null }, true);
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
  ledger.db
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

  return appendEventInTx(ledger.db, {
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

export interface AttachRepoParams {
  task_id: string;
  repo: string;
  branch: string;
  worktree?: string | null;
  base_sha?: string | null;
  head_sha?: string | null;
  actor?: string;
  session_id?: string | null;
}

export function attachRepo(ledger: LedgerReader, params: AttachRepoParams): EventRecord {
  return withImmediateTx(ledger.db, () => attachRepoInTx(ledger, { ...params, base_sha: resolveBase(ledger.workbenchRoot, params.repo, params.branch, params.worktree, params.base_sha) }));
}

export interface DetachRepoParams {
  task_id: string;
  repo: string;
  branch: string;
  reason?: string;
  actor?: string;
  session_id?: string | null;
}

export function detachRepo(ledger: LedgerReader, params: DetachRepoParams): EventRecord {
  return withImmediateTx(ledger.db, () => {
    const task = ledger.getTask(params.task_id);
    if (!task) throw new Error(`Task not found: ${params.task_id}`);
    if (task.status !== "OPEN") {
      throw new Error(`Cannot detach repo on ${task.status} task: ${params.task_id}`);
    }
    const existing = ledger.db
      .query(
        "SELECT * FROM task_repos WHERE task_id = ? AND canonical_repo(repo) = canonical_repo(?) AND branch = ?",
      )
      .get(params.task_id, params.repo, params.branch) as TaskRepoRecord | null;
    if (!existing) {
      throw new Error(
        `Branch ${params.repo}:${params.branch} is not attached to task ${params.task_id}`,
      );
    }
    ledger.db
      .query("DELETE FROM task_repos WHERE task_id = ? AND canonical_repo(repo) = canonical_repo(?) AND branch = ?")
      .run(params.task_id, params.repo, params.branch);
    return appendEventInTx(ledger.db, {
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

export interface ReopenTaskParams {
  task_id: string;
  endpoint?: DeliveryEndpoint;
  depth?: VerificationDepth;
  reason?: string;
  actor?: string;
  session_id?: string | null;
}

export function reopenTask(ledger: LedgerReader, params: ReopenTaskParams): { task: TaskRecord; event: EventRecord } {
  if (params.endpoint !== undefined && !validEndpoint(ledger.workbenchRoot, params.endpoint)) {
    throw new Error(`Invalid endpoint: ${params.endpoint}`);
  }
  if (params.depth !== undefined && !VALID_DEPTHS.has(params.depth)) {
    throw new Error(`Invalid verification depth: ${params.depth}`);
  }
  return withImmediateTx(ledger.db, () => {
    const task = ledger.getTask(params.task_id);
    if (!task) throw new Error(`Task not found: ${params.task_id}`);
    if (task.status !== "CLOSED") {
      throw new Error(
        `Only CLOSED tasks can be reopened (task ${params.task_id} is ${task.status})`,
      );
    }
    const nextEndpoint = params.endpoint !== undefined ? params.endpoint : task.endpoint;
    const nextDepth = params.depth !== undefined ? params.depth : task.verification_depth;
    const isDowngrade = (ENDPOINT_RANK[nextEndpoint] ?? ENDPOINT_RANK.prod) < (ENDPOINT_RANK[task.endpoint] ?? ENDPOINT_RANK.prod);
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
    const repos = ledger.getTaskRepos(params.task_id);
    for (const r of repos) {
      assertRepoBranchFreeForOpenTask(ledger.db, r.repo, r.branch, params.task_id);
    }
    const ts = nowIso();
    ledger.db
      .query(
        `UPDATE tasks
         SET status = 'OPEN', closed_at = NULL, endpoint = ?, verification_depth = ?, updated_at = ?
         WHERE task_id = ?`,
      )
      .run(nextEndpoint, nextDepth, ts, params.task_id);
    const event = appendEventInTx(ledger.db, {
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
    return { task: ledger.getTask(params.task_id)!, event };
  });
}

export interface UpdateEndpointParams {
  task_id: string;
  endpoint: DeliveryEndpoint;
  reason?: string;
  actor?: string;
  session_id?: string | null;
}

export function updateEndpoint(ledger: LedgerReader, params: UpdateEndpointParams): { task: TaskRecord; event: EventRecord } {
  if (!validEndpoint(ledger.workbenchRoot, params.endpoint)) {
    throw new Error(`Invalid endpoint: ${params.endpoint}`);
  }
  return withImmediateTx(ledger.db, () => {
    const task = ledger.getTask(params.task_id);
    if (!task) throw new Error(`Task not found: ${params.task_id}`);
    if (task.status !== "OPEN") {
      throw new Error(`Cannot update endpoint on ${task.status} task: ${params.task_id}`);
    }
    const isDowngrade = (ENDPOINT_RANK[params.endpoint] ?? ENDPOINT_RANK.prod) < (ENDPOINT_RANK[task.endpoint] ?? ENDPOINT_RANK.prod);
    if (isDowngrade) {
      if (params.endpoint === "investigation") {
        throw new Error(
          `Cannot downgrade development task ${params.task_id} (${task.endpoint}) to investigation; use 'forge ledger cancel ${params.task_id} --reason ...' or 'forge ledger close ${params.task_id} --force-incomplete --reason ...'`,
        );
      }
      if (!params.reason?.trim()) {
        throw new Error(
          `Downgrading endpoint (${task.endpoint} -> ${params.endpoint}) requires a non-empty --reason`,
        );
      }
    }
    const ts = nowIso();
    ledger.db
      .query("UPDATE tasks SET endpoint = ?, updated_at = ? WHERE task_id = ?")
      .run(params.endpoint, ts, params.task_id);
    const event = appendEventInTx(ledger.db, {
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
    return { task: ledger.getTask(params.task_id)!, event };
  });
}
