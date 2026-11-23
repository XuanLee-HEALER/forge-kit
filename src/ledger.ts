import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { findWorkbenchRoot } from "./config";
import { runGit } from "./git";

export function normalizeReviewRole(role?: string | null): string {
  const raw = (role ?? "").trim().toLowerCase();
  if (!raw) return "default";
  if (raw.startsWith("review-")) return raw.slice("review-".length);
  return raw;
}

export type TaskStatus = "OPEN" | "CLOSED" | "CANCELLED";
export type DeliveryEndpoint = "investigation" | "local" | "fat" | "pr" | "prod";
export type VerificationDepth = "targeted" | "full";
export type SpecAmendScope = "requirement" | "invariant" | "tech_spec" | "test_spec";

export interface SpecFrozenPayload {
  spec_dir: string;
  files: { ssot: string; tech_spec: string; test_spec: string };
  hashes: { ssot: string; tech_spec: string; test_spec: string };
  locked_test_globs: string[];
}

export interface SpecAmendedPayload {
  scope: SpecAmendScope;
  reason: string;
  stale_stages: string[];
}

export interface TaskSpecState {
  task_id: string;
  state: "NONE" | "FROZEN" | "AMENDED";
  freeze_seq: number | null;
  amend_seq: number | null;
  spec_dir: string | null;
  files: { ssot: string; tech_spec: string; test_spec: string } | null;
  hashes: { ssot: string; tech_spec: string; test_spec: string } | null;
  locked_test_globs: string[];
  amend_scope: SpecAmendScope | null;
  amend_scopes: SpecAmendScope[];
  amend_reason: string | null;
  stale_stages: string[];
  drifted_files: string[];
  evidence_floor_seq: { lint: number; test: number; review: number; fat: number };
}

export const SPEC_AMEND_STALE_MAP: Record<SpecAmendScope, string[]> = {
  requirement: ["ssot", "tech_spec", "test_spec", "lint", "test", "review", "fat"],
  invariant: ["tech_spec", "test_spec", "lint", "test", "review", "fat"],
  tech_spec: ["lint", "test", "review", "fat"],
  test_spec: ["test", "fat"],
};

const VALID_SPEC_AMEND_SCOPES = new Set<string>([
  "requirement",
  "invariant",
  "tech_spec",
  "test_spec",
]);

function sha256String(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function tokenizeSimpleShellCommand(raw: string): string[] | null {
  if (/[\n\r\0]/.test(raw)) return null;
  const tokens: string[] = [];
  let cur = "";
  let has = false;
  let quote: "'" | '"' | null = null;
  let escape = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escape) {
      cur += ch;
      has = true;
      escape = false;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
        const next = raw[i + 1];
        if (next === '"' || next === "\\" || next === "$" || next === "`") {
          cur += next;
          i++;
        } else {
          cur += "\\";
        }
      } else if (ch === '"') {
        quote = null;
      } else if (ch === "`" || (ch === "$" && raw[i + 1] === "(")) {
        return null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === "\\") {
      escape = true;
      has = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
      continue;
    }
    if (ch === ";" || ch === "&" || ch === "|" || ch === "`" || ch === "<" || ch === ">" || ch === "(" || ch === ")") {
      return null;
    }
    if (ch === "$" && raw[i + 1] === "(") return null;
    if (ch === " " || ch === "\t") {
      if (has) {
        tokens.push(cur);
        cur = "";
        has = false;
      }
      continue;
    }
    cur += ch;
    has = true;
  }
  if (escape || quote !== null) return null;
  if (has) tokens.push(cur);
  return tokens;
}

export function normalizeKubectlTokens(tokens: string[]): string[] | null {
  if (tokens.length < 2) return null;
  const first = tokens[0];
  if (first !== "kubectl" && !first.endsWith("/kubectl")) return null;
  for (const tok of tokens.slice(1)) {
    for (const part of tok.split(",")) {
      if (/^secrets?(\/|$|\.)/i.test(part.trim())) {
        return null;
      }
    }
  }
  return ["kubectl", ...tokens.slice(1)];
}

function sha256File(absPath: string): string | null {
  if (!existsSync(absPath)) return null;
  try {
    const st = statSync(absPath);
    if (!st.isFile()) return null;
    const buf = readFileSync(absPath);
    return createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}

export interface TaskRecord {
  task_id: string;
  title: string;
  status: TaskStatus;
  endpoint: DeliveryEndpoint;
  verification_depth: VerificationDepth;
  open_blockers: number;
  last_verified_sha: string | null;
  tip_hash: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface TaskRepoRecord {
  repo: string;
  branch: string;
  worktree: string | null;
  task_id: string;
  base_sha: string | null;
  head_sha: string | null;
  attached_at: string;
}

export interface TaskBlockerRecord {
  task_id: string;
  blocker_id: string;
  status: "OPEN" | "CLOSED";
  summary: string;
  opened_at: string;
  closed_at: string | null;
}

export interface EventRecord {
  id: number;
  task_id: string;
  seq: number;
  ts: string;
  event_type: string;
  actor: string;
  session_id: string | null;
  tool_use_id: string | null;
  repo: string | null;
  branch: string | null;
  sha: string | null;
  payload_json: string;
  prev_hash: string;
  entry_hash: string;
}

export interface ExemptionRecord {
  id: number;
  repo: string;
  branch: string;
  head_sha: string | null;
  reason: string;
  created_at: string;
  expires_at: string | null;
}

export type RunbookStatus = "PENDING" | "APPROVED" | "COMPLETED" | "REVOKED";

export interface RunbookTagAction {
  repo: string;
  tag: string;
  sha: string;
}

export interface RunbookPrAction {
  repo: string;
  number: number;
}

export interface RunbookSqlFileAction {
  host: string;
  path: string;
  sha256: string;
}

export interface RunbookActions {
  tags: RunbookTagAction[];
  prs: RunbookPrAction[];
  sql_files: RunbookSqlFileAction[];
  kubectl_commands: string[];
}

export interface RunbookRecord {
  runbook_id: string;
  task_id: string | null;
  title: string;
  status: RunbookStatus;
  actions_json: string;
  actions_hash: string;
  created_at: string;
  approved_at: string | null;
  approved_session_id: string | null;
  expires_at: string | null;
  completed_at: string | null;
  revoked_at: string | null;
}

const SCHEMA_VERSION = 3;
const VALID_ENDPOINTS = new Set<string>([
  "investigation",
  "local",
  "fat",
  "pr",
  "prod",
]);
const VALID_DEPTHS = new Set<string>(["targeted", "full"]);

export function nowIso(): string {
  return new Date().toISOString();
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

export function computeEntryHash(fields: {
  prev_hash: string;
  task_id: string;
  seq: number;
  ts: string;
  event_type: string;
  actor: string;
  session_id: string | null;
  tool_use_id: string | null;
  repo: string | null;
  branch: string | null;
  sha: string | null;
  payload_json: string;
}): string {
  // Length-prefixed canonical framing prevents field-delimiter collision attacks.
  const preimage = JSON.stringify([
    fields.prev_hash,
    fields.task_id,
    fields.seq,
    fields.ts,
    fields.event_type,
    fields.actor,
    fields.session_id ?? null,
    fields.tool_use_id ?? null,
    fields.repo ?? null,
    fields.branch ?? null,
    fields.sha ?? null,
    fields.payload_json,
  ]);
  return createHash("sha256").update(preimage).digest("hex");
}

export function ledgerDbPath(workbenchRoot: string): string {
  return join(workbenchRoot, ".workbench", "ledger", "ledger.sqlite");
}

export class Ledger {
  readonly db: Database;
  readonly dbPath: string;
  readonly workbenchRoot: string;

  constructor(workbenchRoot: string, opts?: { dbPath?: string; busyTimeoutMs?: number }) {
    this.workbenchRoot = workbenchRoot;
    this.dbPath = opts?.dbPath ?? ledgerDbPath(workbenchRoot);
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath, { create: true });
    // Set busy_timeout FIRST (lower than outer hook timeout to prevent colliding timeouts).
    const busyMs = opts?.busyTimeoutMs ?? 2500;
    this.db.exec(`PRAGMA busy_timeout = ${busyMs};`);
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.ensureInitialized();
  }

  closeDb(): void {
    this.db.close();
  }

  private ensureInitialized(): void {
    const versionRow = this.db.query("PRAGMA user_version;").get() as {
      user_version?: number;
    } | null;
    if (versionRow?.user_version === SCHEMA_VERSION) {
      return;
    }
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.withImmediateTx(() => {
      const inner = this.db.query("PRAGMA user_version;").get() as {
        user_version?: number;
      } | null;
      if (inner?.user_version === SCHEMA_VERSION) return;
      this.initSchema();
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    });
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        task_id            TEXT PRIMARY KEY,
        title              TEXT NOT NULL,
        status             TEXT NOT NULL CHECK (status IN ('OPEN','CLOSED','CANCELLED')),
        endpoint           TEXT NOT NULL,
        verification_depth TEXT NOT NULL,
        open_blockers      INTEGER NOT NULL DEFAULT 0,
        last_verified_sha  TEXT,
        tip_hash           TEXT NOT NULL,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        closed_at          TEXT
      );

      CREATE TABLE IF NOT EXISTS task_repos (
        repo        TEXT NOT NULL,
        branch      TEXT NOT NULL,
        worktree    TEXT,
        task_id     TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
        base_sha    TEXT,
        head_sha    TEXT,
        attached_at TEXT NOT NULL,
        PRIMARY KEY (repo, branch, task_id)
      );
      CREATE INDEX IF NOT EXISTS idx_task_repos_lookup ON task_repos(repo, branch);
      CREATE INDEX IF NOT EXISTS idx_task_repos_head ON task_repos(repo, head_sha);

      CREATE TABLE IF NOT EXISTS task_blockers (
        task_id    TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
        blocker_id TEXT NOT NULL,
        status     TEXT NOT NULL CHECK (status IN ('OPEN','CLOSED')),
        summary    TEXT NOT NULL,
        opened_at  TEXT NOT NULL,
        closed_at  TEXT,
        PRIMARY KEY (task_id, blocker_id)
      );

      CREATE TABLE IF NOT EXISTS events (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id      TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
        seq          INTEGER NOT NULL,
        ts           TEXT NOT NULL,
        event_type   TEXT NOT NULL,
        actor        TEXT NOT NULL,
        session_id   TEXT,
        tool_use_id  TEXT,
        repo         TEXT,
        branch       TEXT,
        sha          TEXT,
        payload_json TEXT NOT NULL,
        prev_hash    TEXT NOT NULL,
        entry_hash   TEXT NOT NULL,
        UNIQUE(task_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_events_task_seq ON events(task_id, seq);
      CREATE INDEX IF NOT EXISTS idx_events_type_sha ON events(task_id, event_type, sha);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_tool_use_idemp
        ON events(task_id, tool_use_id) WHERE tool_use_id IS NOT NULL;

      CREATE TRIGGER IF NOT EXISTS trg_events_no_update
      BEFORE UPDATE ON events
      BEGIN
        SELECT RAISE(ABORT, 'ledger events are immutable');
      END;

      CREATE TABLE IF NOT EXISTS exemptions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        repo       TEXT NOT NULL,
        branch     TEXT NOT NULL,
        head_sha   TEXT,
        reason     TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_exemptions_lookup ON exemptions(repo, branch);

      CREATE TABLE IF NOT EXISTS runbooks (
        runbook_id          TEXT PRIMARY KEY,
        task_id             TEXT,
        title               TEXT NOT NULL,
        status              TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','COMPLETED','REVOKED')),
        actions_json        TEXT NOT NULL,
        actions_hash        TEXT NOT NULL,
        created_at          TEXT NOT NULL,
        approved_at         TEXT,
        approved_session_id TEXT,
        expires_at          TEXT,
        completed_at        TEXT,
        revoked_at          TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_runbooks_status_session
        ON runbooks(status, approved_session_id);

      CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
        task_id,
        event_type,
        payload_json,
        content='events',
        content_rowid='id'
      );

      CREATE TRIGGER IF NOT EXISTS trg_events_ai AFTER INSERT ON events BEGIN
        INSERT INTO events_fts(rowid, task_id, event_type, payload_json)
        VALUES (new.id, new.task_id, new.event_type, new.payload_json);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_events_ad AFTER DELETE ON events BEGIN
        INSERT INTO events_fts(events_fts, rowid, task_id, event_type, payload_json)
        VALUES ('delete', old.id, old.task_id, old.event_type, old.payload_json);
      END;
    `);
  }

  private appendEventInTx(params: {
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
      const existing = this.db
        .query("SELECT * FROM events WHERE task_id = ? AND tool_use_id = ? LIMIT 1")
        .get(params.task_id, params.tool_use_id) as EventRecord | null;
      if (existing) return existing;
    }

    const ts = params.ts ?? nowIso();
    const last = this.db
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

    const info = this.db
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

    this.db
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

  private withImmediateTx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = fn();
      this.db.exec("COMMIT;");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        // Ignore rollback error
      }
      throw err;
    }
  }

  private assertRepoBranchFreeForOpenTask(
    repo: string,
    branch: string,
    allowedTaskId: string,
  ): void {
    const conflicts = this.db
      .query(
        `SELECT t.task_id FROM tasks t
         INNER JOIN task_repos tr ON t.task_id = tr.task_id
         WHERE tr.repo = ? AND tr.branch = ? AND t.status = 'OPEN' AND t.task_id != ?`,
      )
      .all(repo, branch, allowedTaskId) as Array<{ task_id: string }>;
    if (conflicts.length > 0) {
      throw new Error(
        `Branch ${repo}:${branch} is already owned by OPEN task ${conflicts[0].task_id}; close/cancel it or use a separate branch.`,
      );
    }
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
    if (!/^[a-zA-Z0-9._-]{3,80}$/.test(params.task_id)) {
      throw new Error(
        `Invalid task_id "${params.task_id}" (use 3-80 chars of a-zA-Z0-9._-)`,
      );
    }

    return this.withImmediateTx(() => {
      const existing = this.db
        .query("SELECT task_id FROM tasks WHERE task_id = ?")
        .get(params.task_id);
      if (existing) {
        throw new Error(`Task already exists: ${params.task_id}`);
      }
      if (params.repo && params.branch) {
        this.assertRepoBranchFreeForOpenTask(params.repo, params.branch, params.task_id);
      }

      const ts = nowIso();
      this.db
        .query(
          `INSERT INTO tasks (
            task_id, title, status, endpoint, verification_depth,
            open_blockers, last_verified_sha, tip_hash, created_at, updated_at, closed_at
          ) VALUES (?, ?, 'OPEN', ?, ?, 0, '{}', 'PENDING', ?, ?, NULL)`,
        )
        .run(params.task_id, params.title, params.endpoint, params.depth, ts, ts);

      const event = this.appendEventInTx({
        task_id: params.task_id,
        event_type: "TASK_OPENED",
        actor: params.actor ?? "agent",
        session_id: params.session_id,
        repo: params.repo,
        branch: params.branch,
        sha: params.head_sha ?? params.base_sha,
        ts,
        payload: {
          title: params.title,
          endpoint: params.endpoint,
          verification_depth: params.depth,
          base_sha: params.base_sha ?? null,
        },
      });

      if (params.repo && params.branch) {
        this.attachRepoInTx({
          task_id: params.task_id,
          repo: params.repo,
          branch: params.branch,
          worktree: params.worktree ?? null,
          base_sha: params.base_sha ?? null,
          head_sha: params.head_sha ?? params.base_sha ?? null,
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
    const task = this.getTask(params.task_id);
    if (!task) throw new Error(`Task not found: ${params.task_id}`);
    if (task.status !== "OPEN") {
      throw new Error(`Cannot attach repo to ${task.status} task: ${params.task_id}`);
    }
    this.assertRepoBranchFreeForOpenTask(params.repo, params.branch, params.task_id);

    const ts = nowIso();
    this.db
      .query(
        `INSERT INTO task_repos (repo, branch, worktree, task_id, base_sha, head_sha, attached_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo, branch, task_id) DO UPDATE SET
           worktree = COALESCE(excluded.worktree, task_repos.worktree),
           base_sha = COALESCE(task_repos.base_sha, excluded.base_sha),
           head_sha = COALESCE(excluded.head_sha, task_repos.head_sha)`,
      )
      .run(
        params.repo,
        params.branch,
        params.worktree ?? null,
        params.task_id,
        params.base_sha ?? null,
        params.head_sha ?? null,
        ts,
      );

    return this.appendEventInTx({
      task_id: params.task_id,
      event_type: "REPO_ATTACHED",
      actor: params.actor ?? "agent",
      session_id: params.session_id,
      repo: params.repo,
      branch: params.branch,
      sha: params.head_sha ?? params.base_sha ?? null,
      ts,
      payload: {
        worktree: params.worktree ?? null,
        base_sha: params.base_sha ?? null,
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
    return this.withImmediateTx(() => this.attachRepoInTx(params));
  }

  recordDecision(params: {
    task_id: string;
    key: string;
    summary: string;
    supersedes_seq?: number;
    actor?: string;
    session_id?: string | null;
  }): EventRecord {
    return this.withImmediateTx(() => {
      const task = this.getTask(params.task_id);
      if (!task) throw new Error(`Task not found: ${params.task_id}`);
      if (task.status !== "OPEN") {
        throw new Error(`Cannot record decision on ${task.status} task`);
      }
      const event_type =
        params.supersedes_seq !== undefined
          ? "DECISION_SUPERSEDED"
          : "DECISION_LOCKED";
      return this.appendEventInTx({
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
    return this.withImmediateTx(() => {
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
      const ev = this.appendEventInTx({
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
      | "note";
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
    return this.withImmediateTx(() => {
      const task = this.getTask(params.task_id);
      if (!task) throw new Error(`Task not found: ${params.task_id}`);
      if (task.status !== "OPEN") {
        throw new Error(`Cannot record evidence on ${task.status} task`);
      }
      const event_type =
        params.kind === "commit" ? "COMMIT_RECORDED" : "EVIDENCE_CAPTURED";
      const normalizedMeta =
        params.kind === "review" && params.meta && typeof params.meta.role === "string"
          ? { ...params.meta, role: normalizeReviewRole(params.meta.role) }
          : params.meta;
      const ev = this.appendEventInTx({
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
          summary: params.summary,
          ...(normalizedMeta ? { meta: normalizedMeta } : {}),
        },
      });

      if (params.repo && params.branch && params.sha && params.kind === "commit") {
        this.db
          .query(
            `UPDATE task_repos SET head_sha = ? WHERE task_id = ? AND repo = ? AND branch = ?`,
          )
          .run(params.sha, params.task_id, params.repo, params.branch);
      }

      if (
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
    return this.withImmediateTx(() => {
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
    this.withImmediateTx(() => {
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
         WHERE repo = ? AND branch = ?
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY id DESC LIMIT 1`,
      )
      .get(repo, branch, now) as ExemptionRecord | null;
    return row ?? null;
  }

  findOpenTasksByRepoBranch(repo: string, branch: string): TaskRecord[] {
    return this.db
      .query(
        `SELECT t.* FROM tasks t
         INNER JOIN task_repos tr ON t.task_id = tr.task_id
         WHERE tr.repo = ? AND tr.branch = ? AND t.status = 'OPEN'
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
         WHERE tr.repo = ? AND tr.head_sha IN (${placeholders}) AND t.status = 'OPEN'
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
    return this.db
      .query("SELECT * FROM task_repos WHERE task_id = ? ORDER BY attached_at ASC")
      .all(task_id) as TaskRepoRecord[];
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
    const ev = this.withImmediateTx(() => {
      const task = this.getTask(params.task_id);
      if (!task) throw new Error(`Task not found: ${params.task_id}`);
      if (task.status !== "OPEN") {
        throw new Error(`Cannot freeze spec on ${task.status} task ${params.task_id}`);
      }

      const wbReal = realpathSync(this.workbenchRoot);
      const rawDir = params.spec_dir?.trim() || join(".workbench", "specs", params.task_id);
      const absDir = resolve(wbReal, rawDir);
      if (!existsSync(absDir)) {
        throw new Error(`Spec directory does not exist: ${rawDir}`);
      }
      const realDir = realpathSync(absDir);
      if (!statSync(realDir).isDirectory()) {
        throw new Error(`Spec path is not a directory: ${rawDir}`);
      }
      const relDir = relative(wbReal, realDir).replace(/\\/g, "/");
      if (!relDir || relDir.startsWith("..") || isAbsolute(relDir)) {
        throw new Error(`Spec directory must reside inside workbench root: ${rawDir}`);
      }

      const fileNames = {
        ssot: "ssot.md",
        tech_spec: "tech-spec.md",
        test_spec: "test-spec.md",
      } as const;
      const files = {
        ssot: `${relDir}/${fileNames.ssot}`,
        tech_spec: `${relDir}/${fileNames.tech_spec}`,
        test_spec: `${relDir}/${fileNames.test_spec}`,
      };
      const hashes = { ssot: "", tech_spec: "", test_spec: "" };

      for (const [key, fname] of Object.entries(fileNames) as Array<
        [keyof typeof fileNames, string]
      >) {
        const absFile = join(realDir, fname);
        if (!existsSync(absFile)) {
          throw new Error(`Missing required spec document: ${files[key]}`);
        }
        const realFile = realpathSync(absFile);
        if (!statSync(realFile).isFile()) {
          throw new Error(`Spec document is not a regular file: ${files[key]}`);
        }
        const relToSpecDir = relative(realDir, realFile).replace(/\\/g, "/");
        if (!relToSpecDir || relToSpecDir.startsWith("..") || isAbsolute(relToSpecDir)) {
          throw new Error(
            `Spec document resolves outside selected spec directory (${relDir}): ${files[key]}`,
          );
        }
        const rawText = readFileSync(realFile, "utf8");
        if (!rawText.trim()) {
          throw new Error(`Spec document is empty: ${files[key]}`);
        }
        const digest = sha256File(realFile);
        if (!digest) {
          throw new Error(`Failed to hash spec document: ${files[key]}`);
        }
        hashes[key] = digest;
      }

      const prevSpec = this.getSpecState(params.task_id);
      const lockedGlobs =
        params.locked_test_globs !== undefined
          ? [...new Set(params.locked_test_globs.map((g) => g.trim()).filter(Boolean))]
          : prevSpec.locked_test_globs;

      if (prevSpec.state === "FROZEN") {
        if (prevSpec.spec_dir && relDir !== prevSpec.spec_dir) {
          throw new Error(
            `Cannot change spec_dir from ${prevSpec.spec_dir} to ${relDir} while spec is FROZEN; run \`ledger amend ${params.task_id} --scope requirement --reason "..."\` first`,
          );
        }
        const changedDocs: string[] = [];
        for (const key of ["ssot", "tech_spec", "test_spec"] as const) {
          if (prevSpec.hashes && hashes[key] !== prevSpec.hashes[key]) {
            changedDocs.push(files[key]);
          }
        }
        if (changedDocs.length > 0) {
          throw new Error(
            `Cannot re-freeze drifted spec document(s) (${changedDocs.join(", ")}) without an explicit amendment; restore files or run \`ledger amend ${params.task_id} --scope ... --reason "..."\` first`,
          );
        }
        if (params.locked_test_globs !== undefined) {
          const dropped = prevSpec.locked_test_globs.filter((g) => !lockedGlobs.includes(g));
          if (dropped.length > 0) {
            throw new Error(
              `Cannot remove locked test glob(s) (${dropped.join(", ")}) while spec is FROZEN; run \`ledger amend ${params.task_id} --scope test_spec --reason "..."\` first`,
            );
          }
        }
      } else if (prevSpec.state === "AMENDED") {
        const scopes = new Set<SpecAmendScope>(prevSpec.amend_scopes);
        const allowSsot = scopes.has("requirement") || scopes.has("invariant");
        const allowTech = allowSsot || scopes.has("tech_spec");
        const allowTest = allowSsot || scopes.has("test_spec");
        if (!allowSsot && prevSpec.spec_dir && relDir !== prevSpec.spec_dir) {
          throw new Error(
            `Cannot change spec_dir from ${prevSpec.spec_dir} to ${relDir} outside requirement/invariant amend scope`,
          );
        }
        const unauthorizedDocs: string[] = [];
        if (!allowSsot && prevSpec.hashes && hashes.ssot !== prevSpec.hashes.ssot) {
          unauthorizedDocs.push(files.ssot);
        }
        if (!allowTech && prevSpec.hashes && hashes.tech_spec !== prevSpec.hashes.tech_spec) {
          unauthorizedDocs.push(files.tech_spec);
        }
        if (!allowTest && prevSpec.hashes && hashes.test_spec !== prevSpec.hashes.test_spec) {
          unauthorizedDocs.push(files.test_spec);
        }
        if (unauthorizedDocs.length > 0) {
          throw new Error(
            `Cannot re-freeze: out-of-scope spec document(s) changed (${unauthorizedDocs.join(", ")}) outside amend scope(s) [${[...scopes].join(", ")}]; restore them or add an authorizing \`ledger amend\``,
          );
        }
        if (!allowTest && params.locked_test_globs !== undefined) {
          const dropped = prevSpec.locked_test_globs.filter((g) => !lockedGlobs.includes(g));
          if (dropped.length > 0) {
            throw new Error(
              `Cannot remove locked test glob(s) (${dropped.join(", ")}) outside test_spec/invariant/requirement amend scope`,
            );
          }
        }
      }

      const payload: SpecFrozenPayload = {
        spec_dir: relDir,
        files,
        hashes,
        locked_test_globs: lockedGlobs,
      };
      return this.appendEventInTx({
        task_id: params.task_id,
        event_type: "SPEC_FROZEN",
        actor: params.actor ?? "agent",
        session_id: params.session_id,
        payload: payload as unknown as Record<string, unknown>,
      });
    });

    return { event: ev, spec: this.getSpecState(params.task_id) };
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
    if (!VALID_SPEC_AMEND_SCOPES.has(params.scope)) {
      throw new Error(
        `Invalid amend scope: ${params.scope}. Must be one of: requirement, invariant, tech_spec, test_spec`,
      );
    }
    if (!params.reason?.trim()) {
      throw new Error("ledger amend requires a non-empty --reason");
    }

    const ev = this.withImmediateTx(() => {
      const task = this.getTask(params.task_id);
      if (!task) throw new Error(`Task not found: ${params.task_id}`);
      if (task.status !== "OPEN") {
        throw new Error(`Cannot amend spec on ${task.status} task ${params.task_id}`);
      }
      const cur = this.getSpecState(params.task_id);
      if (cur.state === "NONE") {
        throw new Error(`Task ${params.task_id} has no frozen spec yet; run ledger freeze first`);
      }

      const payload: SpecAmendedPayload = {
        scope: params.scope,
        reason: params.reason.trim(),
        stale_stages: [...SPEC_AMEND_STALE_MAP[params.scope]],
      };
      return this.appendEventInTx({
        task_id: params.task_id,
        event_type: "SPEC_AMENDED",
        actor: params.actor ?? "agent",
        session_id: params.session_id,
        payload: payload as unknown as Record<string, unknown>,
      });
    });

    return { event: ev, spec: this.getSpecState(params.task_id) };
  }

  /**
   * Inspect current spec freeze/amend state, disk SHA-256 drift, and per-stage stale floors.
   */
  getSpecState(task_id: string): TaskSpecState {
    const rows = this.db
      .query(
        `SELECT seq, event_type, payload_json FROM events
         WHERE task_id = ? AND event_type IN ('SPEC_FROZEN', 'SPEC_AMENDED')
         ORDER BY seq ASC`,
      )
      .all(task_id) as Array<{ seq: number; event_type: string; payload_json: string }>;

    let freezeSeq: number | null = null;
    let amendSeq: number | null = null;
    let specDir: string | null = null;
    let files: { ssot: string; tech_spec: string; test_spec: string } | null = null;
    let hashes: { ssot: string; tech_spec: string; test_spec: string } | null = null;
    let lockedTestGlobs: string[] = [];
    let amendScope: SpecAmendScope | null = null;
    let amendReason: string | null = null;
    let firstFreezeSeen = false;
    let pendingAmendScopes = new Set<SpecAmendScope>();
    let pendingStaleStages = new Set<string>();
    const floors = { lint: 0, test: 0, review: 0, fat: 0 };

    for (const row of rows) {
      try {
        if (row.event_type === "SPEC_FROZEN") {
          const p = JSON.parse(row.payload_json) as Partial<SpecFrozenPayload>;
          freezeSeq = row.seq;
          specDir = p.spec_dir ?? specDir;
          if (p.files) files = p.files;
          if (p.hashes) hashes = p.hashes;
          if (Array.isArray(p.locked_test_globs)) {
            lockedTestGlobs = p.locked_test_globs.map(String);
          }
          if (!firstFreezeSeen) {
            firstFreezeSeen = true;
            floors.lint = Math.max(floors.lint, row.seq);
            floors.test = Math.max(floors.test, row.seq);
            floors.review = Math.max(floors.review, row.seq);
            floors.fat = Math.max(floors.fat, row.seq);
          } else {
            if (pendingStaleStages.has("lint")) floors.lint = Math.max(floors.lint, row.seq);
            if (pendingStaleStages.has("test")) floors.test = Math.max(floors.test, row.seq);
            if (pendingStaleStages.has("review")) floors.review = Math.max(floors.review, row.seq);
            if (pendingStaleStages.has("fat")) floors.fat = Math.max(floors.fat, row.seq);
          }
          pendingStaleStages = new Set<string>();
          pendingAmendScopes = new Set<SpecAmendScope>();
        } else if (row.event_type === "SPEC_AMENDED") {
          const p = JSON.parse(row.payload_json) as Partial<SpecAmendedPayload>;
          amendSeq = row.seq;
          if (p.scope && VALID_SPEC_AMEND_SCOPES.has(p.scope)) {
            amendScope = p.scope;
            pendingAmendScopes.add(p.scope);
          }
          amendReason = p.reason ?? null;
          for (const st of p.stale_stages ?? []) {
            pendingStaleStages.add(String(st));
          }
        }
      } catch {
        // Ignore malformed payload
      }
    }

    if (freezeSeq === null) {
      return {
        task_id,
        state: "NONE",
        freeze_seq: null,
        amend_seq: null,
        spec_dir: null,
        files: null,
        hashes: null,
        locked_test_globs: [],
        amend_scope: null,
        amend_scopes: [],
        amend_reason: null,
        stale_stages: [],
        drifted_files: [],
        evidence_floor_seq: floors,
      };
    }

    const isAmended = amendSeq !== null && amendSeq > freezeSeq;
    const driftedFiles: string[] = [];
    if (!isAmended && files && hashes) {
      const wbReal = existsSync(this.workbenchRoot)
        ? realpathSync(this.workbenchRoot)
        : resolve(this.workbenchRoot);
      let realSpecDir: string | null = null;
      if (specDir) {
        const specDirAbs = resolve(wbReal, specDir);
        if (existsSync(specDirAbs)) {
          try {
            const candidateReal = realpathSync(specDirAbs);
            const relRealDir = relative(wbReal, candidateReal).replace(/\\/g, "/");
            if (
              statSync(candidateReal).isDirectory() &&
              relRealDir &&
              !relRealDir.startsWith("..") &&
              !isAbsolute(relRealDir) &&
              relRealDir === specDir
            ) {
              realSpecDir = candidateReal;
            }
          } catch {
            realSpecDir = null;
          }
        }
      }
      for (const key of ["ssot", "tech_spec", "test_spec"] as const) {
        const relPath = files[key];
        const expectedHash = hashes[key];
        const absFile = resolve(wbReal, relPath);
        if (!existsSync(absFile) || !realSpecDir) {
          driftedFiles.push(relPath);
          continue;
        }
        let realFile: string;
        try {
          realFile = realpathSync(absFile);
        } catch {
          driftedFiles.push(relPath);
          continue;
        }
        const relToDir = relative(realSpecDir, realFile).replace(/\\/g, "/");
        if (!relToDir || relToDir.startsWith("..") || isAbsolute(relToDir)) {
          driftedFiles.push(relPath);
          continue;
        }
        const actualHash = sha256File(realFile);
        if (!actualHash || actualHash !== expectedHash) {
          driftedFiles.push(relPath);
        }
      }
    }

    return {
      task_id,
      state: isAmended ? "AMENDED" : "FROZEN",
      freeze_seq: freezeSeq,
      amend_seq: amendSeq,
      spec_dir: specDir,
      files,
      hashes,
      locked_test_globs: lockedTestGlobs,
      amend_scope: isAmended ? amendScope : null,
      amend_scopes: isAmended ? [...pendingAmendScopes] : [],
      amend_reason: isAmended ? amendReason : null,
      stale_stages: isAmended ? [...pendingStaleStages] : [],
      drifted_files: driftedFiles,
      evidence_floor_seq: floors,
    };
  }

  /**
   * Return spec states for all OPEN tasks that currently have a frozen or amended spec package.
   */
  listActiveSpecLocks(): TaskSpecState[] {
    const open = this.listOpenTasks();
    const out: TaskSpecState[] = [];
    for (const t of open) {
      const st = this.getSpecState(t.task_id);
      if (st.state !== "NONE") out.push(st);
    }
    return out;
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
    checkEndpoint?: boolean;
  }): {
    ready: boolean;
    missing: string[];
    hasExplicitFailure: boolean;
    recordedReviewRoles: string[];
  } {
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

    const specState = this.getSpecState(params.task_id);
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
        `SELECT seq, payload_json FROM events
         WHERE task_id = ? AND event_type = 'EVIDENCE_CAPTURED'
           AND repo = ? AND sha = ?
         ORDER BY seq ASC`,
      )
      .all(params.task_id, params.repo, params.head_sha) as Array<{
      seq: number;
      payload_json: string;
    }>;

    const floors = specState.evidence_floor_seq;
    const latestByKind = new Map<string, string>();
    const latestReviewByRole = new Map<string, string>();
    let latestEndpointStatus: string | null = null;

    for (const ev of events) {
      try {
        const p = JSON.parse(ev.payload_json) as {
          kind?: string;
          status?: string;
          meta?: { role?: string };
        };
        if (!p.kind || !p.status) continue;
        if (p.kind === "lint") {
          if (ev.seq >= floors.lint) latestByKind.set("lint", p.status);
        } else if (p.kind === "test" || p.kind === "build") {
          if (ev.seq >= floors.test) latestByKind.set(p.kind, p.status);
        } else if (p.kind === "hurl") {
          if (ev.seq >= floors.test) latestByKind.set("hurl", p.status);
        }
        if (p.kind === "review") {
          if (ev.seq >= floors.review) {
            const roleKey = normalizeReviewRole(p.meta?.role);
            latestReviewByRole.set(roleKey, p.status);
          }
        }
        if (
          (task.endpoint === "pr" && p.kind === "pr") ||
          (task.endpoint === "fat" && (p.kind === "fat" || p.kind === "hurl")) ||
          (task.endpoint === "prod" && p.kind === "prod")
        ) {
          const endpointFloor = task.endpoint === "fat" ? floors.fat : 0;
          if (ev.seq >= endpointFloor && (p.status === "pass" || p.status === "fail")) {
            latestEndpointStatus = p.status;
          }
        }
      } catch {
        // Ignore malformed payload
      }
    }

    const failedKinds = [...latestByKind.entries()]
      .filter(([, st]) => st === "fail")
      .map(([k]) => k);
    const hasPassingVerify = [...latestByKind.values()].some((st) => st === "pass");
    const hasPassingExecVerify =
      latestByKind.get("test") === "pass" ||
      latestByKind.get("build") === "pass" ||
      latestByKind.get("hurl") === "pass";

    if (failedKinds.length > 0) {
      hasExplicitFailure = true;
      missing.push(
        `latest ${failedKinds.join("/")} failed for ${params.repo}@${params.head_sha.slice(0, 8)}`,
      );
    } else if (task.verification_depth === "full") {
      if (latestByKind.get("lint") !== "pass") {
        missing.push(
          `full verification requires passing static check (lint) evidence for ${params.repo}@${params.head_sha.slice(0, 8)} (run repo lint/typecheck or .workbench/bin/lang-check --mode static)`,
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

    const failedRoles = [...latestReviewByRole.entries()]
      .filter(([, st]) => st === "fail")
      .map(([r]) => r);
    const passingRoles = [...latestReviewByRole.entries()]
      .filter(([, st]) => st === "pass" || st === "fallback")
      .map(([r]) => r);

    if (failedRoles.length > 0) {
      hasExplicitFailure = true;
      missing.push(
        `latest review failed (${failedRoles.join(", ")}) for ${params.repo}@${params.head_sha.slice(0, 8)}`,
      );
    } else if (task.verification_depth === "targeted") {
      // Targeted depth requires at least one independent review pass/fallback before delivery/close
      if (params.checkEndpoint && passingRoles.length === 0) {
        missing.push(
          `targeted verification requires independent review evidence for ${params.repo}@${params.head_sha.slice(0, 8)}`,
        );
      }
    } else if (task.verification_depth === "full") {
      const hasQualityOrBusiness = passingRoles.some((r) =>
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
          `endpoint "${task.endpoint}" requires recorded ${task.endpoint} delivery evidence for ${params.repo}@${params.head_sha.slice(0, 8)}`,
        );
      }
    }

    return {
      ready: missing.length === 0,
      missing,
      hasExplicitFailure,
      recordedReviewRoles: passingRoles,
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
    const ev = this.withImmediateTx(() => {
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
          const candidateDir =
            r.worktree && existsSync(r.worktree)
              ? r.worktree
              : join(this.workbenchRoot, r.repo);
          if (existsSync(candidateDir)) {
            const liveRes = runGit(
              candidateDir,
              ["rev-parse", "--verify", `refs/heads/${r.branch}`],
              3000,
            );
            if (liveRes.code === 0 && liveRes.stdout.trim()) {
              effectiveSha = liveRes.stdout.trim();
            } else {
              // Fail closed: repo exists on disk, so an unresolvable/missing branch MUST NOT
              // silently close using stale stored head_sha!
              allMissing.push(
                `${r.repo}:${r.branch} live branch refs/heads/${r.branch} could not be resolved on disk`,
              );
              continue;
            }
          }
          if (!effectiveSha) {
            allMissing.push(`${r.repo}:${r.branch} has no recorded head_sha`);
            continue;
          }
          const check = this.checkPushReadiness({
            task_id: params.task_id,
            repo: r.repo,
            head_sha: effectiveSha,
            checkEndpoint: true,
          });
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
      const closedEv = this.appendEventInTx({
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
    this.withImmediateTx(() => {
      const task = this.getTask(params.task_id);
      if (!task) throw new Error(`Task not found: ${params.task_id}`);
      if (task.status !== "OPEN") {
        throw new Error(`Task ${params.task_id} is already ${task.status}`);
      }
      const ts = nowIso();
      this.appendEventInTx({
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
    // Consistent read snapshot prevents false tip mismatch during concurrent writes.
    this.db.exec("BEGIN DEFERRED;");
    try {
      if (task_id && !this.getTask(task_id)) {
        return {
          ok: false,
          checked_tasks: 0,
          checked_events: 0,
          errors: [`Task not found: ${task_id}`],
        };
      }
      const tasks = task_id
        ? ([this.getTask(task_id)!])
        : (this.db.query("SELECT * FROM tasks ORDER BY created_at ASC").all() as TaskRecord[]);

      const errors: string[] = [];
      let checkedEvents = 0;

      for (const task of tasks) {
        const events = this.getTaskEvents(task.task_id);
        if (events.length === 0) {
          errors.push(`Task ${task.task_id} has zero events`);
          continue;
        }
        let expectedPrev = "GENESIS";
        let expectedSeq = 1;
        for (const ev of events) {
          checkedEvents++;
          if (ev.seq !== expectedSeq) {
            errors.push(
              `Task ${task.task_id} seq gap: expected ${expectedSeq}, got ${ev.seq}`,
            );
          }
          if (ev.prev_hash !== expectedPrev) {
            errors.push(`Task ${task.task_id} seq ${ev.seq} prev_hash mismatch`);
          }
          const recomputed = computeEntryHash({
            prev_hash: ev.prev_hash,
            task_id: ev.task_id,
            seq: ev.seq,
            ts: ev.ts,
            event_type: ev.event_type,
            actor: ev.actor,
            session_id: ev.session_id,
            tool_use_id: ev.tool_use_id,
            repo: ev.repo,
            branch: ev.branch,
            sha: ev.sha,
            payload_json: ev.payload_json,
          });
          if (recomputed !== ev.entry_hash) {
            errors.push(
              `Task ${task.task_id} seq ${ev.seq} entry_hash tampered (expected ${recomputed.slice(0, 12)}, stored ${ev.entry_hash.slice(0, 12)})`,
            );
          }
          expectedPrev = ev.entry_hash;
          expectedSeq++;
        }
        if (task.tip_hash !== expectedPrev) {
          errors.push(`Task ${task.task_id} tip_hash does not match latest event`);
        }
      }

      return {
        ok: errors.length === 0,
        checked_tasks: tasks.length,
        checked_events: checkedEvents,
        errors,
      };
    } finally {
      try {
        this.db.exec("COMMIT;");
      } catch {
        // Ignore
      }
    }
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
        "EXISTS (SELECT 1 FROM task_repos tr WHERE tr.task_id = t.task_id AND tr.repo = ?)",
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
          "(e.repo = ? OR EXISTS (SELECT 1 FROM task_repos tr WHERE tr.task_id = e.task_id AND tr.repo = ?))",
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
    const rows = this.db
      .query(
        `SELECT task_id FROM tasks
         WHERE status IN ('CLOSED', 'CANCELLED')
           AND COALESCE(closed_at, updated_at) < ?
         ORDER BY created_at ASC`,
      )
      .all(cutoff) as Array<{ task_id: string }>;
    const candidates = rows.map((r) => r.task_id);
    if (!params.apply || candidates.length === 0) {
      return { cutoff, candidates, deleted: [] };
    }

    this.withImmediateTx(() => {
      for (const id of candidates) {
        this.db.query("DELETE FROM tasks WHERE task_id = ?").run(id);
      }
      this.db
        .query("DELETE FROM exemptions WHERE expires_at IS NOT NULL AND expires_at < ?")
        .run(nowIso());
    });
    this.db.exec("VACUUM;");
    return { cutoff, candidates, deleted: candidates };
  }

  formatCompactContext(maxTasks = 8): string {
    const open = this.listOpenTasks().slice(0, maxTasks);
    if (open.length === 0) return "";
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
      const specBadge =
        specState.state === "FROZEN"
          ? ` | spec:FROZEN${specState.drifted_files.length ? `(DRIFT:${specState.drifted_files.length})` : ""}`
          : specState.state === "AMENDED"
            ? ` | spec:AMENDED(${specState.amend_scope ?? "?"})`
            : "";

      lines.push(
        `- ${t.task_id} (${t.endpoint}/${t.verification_depth}): ${t.title} [${repoDesc}]${specBadge}${blockerText}${activeDecs ? ` | decisions: ${activeDecs}` : ""}`,
      );
    }
    return lines.join("\n");
  }

  createRunbook(params: {
    runbook_id?: string;
    task_id?: string | null;
    title: string;
    actions: Partial<RunbookActions>;
  }): RunbookRecord {
    const title = params.title.trim();
    if (!title) throw new Error("Runbook title is required");

    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const runbook_id =
      params.runbook_id?.trim().toLowerCase() ||
      `rb-${mm}${dd}-${randomBytes(2).toString("hex")}`;
    if (!/^rb-[a-z0-9-]{4,32}$/.test(runbook_id)) {
      throw new Error(
        `Invalid runbook_id "${runbook_id}" (must match /^rb-[a-z0-9-]{4,32}$/)`,
      );
    }

    const tags: RunbookTagAction[] = [];
    for (const raw of params.actions.tags ?? []) {
      const repo = raw.repo.trim();
      const tag = raw.tag.trim().replace(/^refs\/tags\//, "");
      let sha = raw.sha.trim().toLowerCase();
      if (!repo || !tag || !/^[0-9a-f]{7,40}$/.test(sha)) {
        throw new Error(
          `Invalid tag action (${raw.repo}:${raw.tag}:${raw.sha}); expected <repo>:<tag>:<hex-sha>`,
        );
      }
      const repoDir = join(this.workbenchRoot, repo);
      if (existsSync(repoDir)) {
        const rev = runGit(repoDir, ["rev-parse", "--verify", `${sha}^{commit}`], 3000);
        if (rev.code === 0 && /^[0-9a-f]{40}$/i.test(rev.stdout.trim())) {
          sha = rev.stdout.trim().toLowerCase();
        }
      }
      tags.push({ repo, tag, sha });
    }

    const prs: RunbookPrAction[] = [];
    for (const raw of params.actions.prs ?? []) {
      const repo = raw.repo.trim();
      const num = Number(raw.number);
      if (!repo || !Number.isInteger(num) || num <= 0) {
        throw new Error(`Invalid PR action (${raw.repo}:${raw.number}); expected <repo>:<positive-int>`);
      }
      prs.push({ repo, number: num });
    }

    const sql_files: RunbookSqlFileAction[] = [];
    for (const raw of params.actions.sql_files ?? []) {
      const host = raw.host.trim();
      const absPath = resolve(this.workbenchRoot, raw.path.trim());
      if (!host) throw new Error("SQL file action requires non-empty host");
      if (!existsSync(absPath)) {
        throw new Error(`Runbook SQL file does not exist: ${absPath}`);
      }
      const real = realpathSync(absPath);
      const hash = sha256File(real);
      if (!hash) {
        throw new Error(`Runbook SQL file is unreadable or not a regular file: ${real}`);
      }
      sql_files.push({ host, path: real, sha256: hash });
    }

    const kubectl_commands: string[] = [];
    for (const rawCmd of params.actions.kubectl_commands ?? []) {
      const toks = tokenizeSimpleShellCommand(rawCmd.trim());
      if (!toks) {
        throw new Error(
          `Invalid kubectl command in runbook (shell chaining/metacharacters forbidden): ${rawCmd}`,
        );
      }
      const norm = normalizeKubectlTokens(toks);
      if (!norm) {
        throw new Error(
          `Rejected kubectl command in runbook (must start with kubectl and never access secrets): ${rawCmd}`,
        );
      }
      kubectl_commands.push(rawCmd.trim());
    }

    if (
      tags.length === 0 &&
      prs.length === 0 &&
      sql_files.length === 0 &&
      kubectl_commands.length === 0
    ) {
      throw new Error(
        "Runbook must include at least one action (--tag, --pr, --sql, or --kubectl)",
      );
    }

    const normalized: RunbookActions = { tags, prs, sql_files, kubectl_commands };
    const actions_json = canonicalJson(normalized);
    const actions_hash = sha256String(actions_json);
    const ts = nowIso();

    return this.withImmediateTx(() => {
      const existing = this.db
        .query("SELECT runbook_id FROM runbooks WHERE runbook_id = ?")
        .get(runbook_id);
      if (existing) {
        throw new Error(`Runbook already exists: ${runbook_id}`);
      }
      this.db
        .query(
          `INSERT INTO runbooks (
            runbook_id, task_id, title, status, actions_json, actions_hash,
            created_at, approved_at, approved_session_id, expires_at, completed_at, revoked_at
          ) VALUES (?, ?, ?, 'PENDING', ?, ?, ?, NULL, NULL, NULL, NULL, NULL)`,
        )
        .run(runbook_id, params.task_id ?? null, title, actions_json, actions_hash, ts);
      return this.getRunbook(runbook_id)!;
    });
  }

  getRunbook(runbook_id: string): RunbookRecord | null {
    return this.db
      .query("SELECT * FROM runbooks WHERE runbook_id = ?")
      .get(runbook_id.trim().toLowerCase()) as RunbookRecord | null;
  }

  listRunbooks(status?: RunbookStatus): RunbookRecord[] {
    if (status) {
      return this.db
        .query("SELECT * FROM runbooks WHERE status = ? ORDER BY created_at DESC LIMIT 50")
        .all(status) as RunbookRecord[];
    }
    return this.db
      .query("SELECT * FROM runbooks ORDER BY created_at DESC LIMIT 50")
      .all() as RunbookRecord[];
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
    const id = params.runbook_id.trim().toLowerCase();
    const sessionId = params.session_id.trim();
    if (!sessionId) throw new Error("Cannot approve runbook without valid session_id");

    const ttlMin = Math.min(120, Math.max(5, params.ttl_minutes ?? 30));

    return this.withImmediateTx(() => {
      const rb = this.getRunbook(id);
      if (!rb) throw new Error(`Runbook not found: ${id}`);
      if (rb.status === "COMPLETED" || rb.status === "REVOKED") {
        throw new Error(`Runbook ${id} is ${rb.status} and cannot be approved`);
      }
      if (sha256String(rb.actions_json) !== rb.actions_hash) {
        throw new Error(`Runbook ${id} integrity check failed (actions_hash mismatch)`);
      }
      const actions = JSON.parse(rb.actions_json) as RunbookActions;
      for (const sf of actions.sql_files ?? []) {
        const diskHash = sha256File(sf.path);
        if (!diskHash || diskHash !== sf.sha256) {
          throw new Error(
            `Runbook ${id} SQL file changed on disk since creation (${sf.path}); recreate runbook before approving`,
          );
        }
      }

      const nowMs = Date.now();
      const approvedAt = new Date(nowMs).toISOString();
      const expiresAt = new Date(nowMs + ttlMin * 60_000).toISOString();
      this.db
        .query(
          `UPDATE runbooks
           SET status = 'APPROVED', approved_at = ?, approved_session_id = ?, expires_at = ?
           WHERE runbook_id = ?`,
        )
        .run(approvedAt, sessionId, expiresAt, id);

      return { record: this.getRunbook(id)!, actions };
    });
  }

  listActiveApprovedRunbooks(
    session_id: string,
  ): Array<{ record: RunbookRecord; actions: RunbookActions }> {
    const sid = session_id.trim();
    if (!sid) return [];
    const now = nowIso();
    const rows = this.db
      .query(
        `SELECT * FROM runbooks
         WHERE status = 'APPROVED' AND approved_session_id = ? AND expires_at > ?
         ORDER BY approved_at DESC`,
      )
      .all(sid, now) as RunbookRecord[];
    const out: Array<{ record: RunbookRecord; actions: RunbookActions }> = [];
    for (const r of rows) {
      if (sha256String(r.actions_json) !== r.actions_hash) continue;
      try {
        const actions = JSON.parse(r.actions_json) as RunbookActions;
        out.push({ record: r, actions });
      } catch {
        // Ignore malformed
      }
    }
    return out;
  }

  completeRunbook(runbook_id: string): RunbookRecord {
    const id = runbook_id.trim().toLowerCase();
    return this.withImmediateTx(() => {
      const rb = this.getRunbook(id);
      if (!rb) throw new Error(`Runbook not found: ${id}`);
      if (rb.status === "REVOKED") {
        throw new Error(`Cannot complete REVOKED runbook: ${id}`);
      }
      const ts = nowIso();
      this.db
        .query("UPDATE runbooks SET status = 'COMPLETED', completed_at = ? WHERE runbook_id = ?")
        .run(ts, id);
      return this.getRunbook(id)!;
    });
  }

  revokeRunbook(runbook_id: string): RunbookRecord {
    const id = runbook_id.trim().toLowerCase();
    return this.withImmediateTx(() => {
      const rb = this.getRunbook(id);
      if (!rb) throw new Error(`Runbook not found: ${id}`);
      const ts = nowIso();
      this.db
        .query("UPDATE runbooks SET status = 'REVOKED', revoked_at = ? WHERE runbook_id = ?")
        .run(ts, id);
      return this.getRunbook(id)!;
    });
  }
}

export async function runLedgerCli(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const USAGE = `Usage: ledger <command> [options]
Commands:
  open        --id <id> --title <title> --endpoint <investigation|local|fat|pr|prod> --depth <targeted|full> [--repo <r> --branch <b> --base <sha> --head <sha> --worktree <p>]
  attach      <task_id> --repo <r> --branch <b> [--base <sha> --head <sha> --worktree <p>]
  freeze      <task_id> [--spec-dir <dir>] [--lock-tests <glob>]...
  amend       <task_id> --scope <requirement|invariant|tech_spec|test_spec> --reason <text>
  spec-status <task_id>
  decide      <task_id> --key <k> --summary <text> [--supersedes <seq>]
  blocker   <task_id> <open|close> --id <bid> --summary <text>
  record    <task_id> --kind <commit|build|test|lint|review|hurl|pr|fat|prod|note> --status <pass|fail|fallback|info> --summary <text> [--role <role> --repo <r> --branch <b> --sha <sha> --meta <json>]
  exempt    --repo <r> --branch <b> --reason <text> [--sha <sha> --ttl-hours <n>]
  status    [--task <id>] [--repo <r> --branch <b>] [--json]
  query     [--q <fts>] [--repo <r>] [--status <OPEN|CLOSED|CANCELLED>] [--since <iso>] [--json]
  verify    [--task <id>] [--json]
  close     <task_id> [--summary <text>] [--no-archive] [--force-incomplete --reason <text>]
  archive   <task_id>
  cancel    <task_id> --reason <text>
  prune     --before <days> [--apply]
  runbook   <create|show|list|complete|revoke> [options]`;

  if (!cmd || cmd === "--help" || cmd === "-h" || rest.includes("--help") || rest.includes("-h")) {
    console.log(USAGE);
    return;
  }

  const root = findWorkbenchRoot();
  const ledger = new Ledger(root);
  try {
    if (cmd === "open") {
      const { values } = parseArgs({
        args: rest,
        options: {
          id: { type: "string" },
          title: { type: "string" },
          endpoint: { type: "string", default: "local" },
          depth: { type: "string", default: "targeted" },
          repo: { type: "string" },
          branch: { type: "string" },
          worktree: { type: "string" },
          base: { type: "string" },
          head: { type: "string" },
          actor: { type: "string", default: "agent" },
        },
      });
      if (!values.id || !values.title) {
        throw new Error("--id and --title are required");
      }
      const res = ledger.openTask({
        task_id: values.id,
        title: values.title,
        endpoint: values.endpoint as DeliveryEndpoint,
        depth: values.depth as VerificationDepth,
        repo: values.repo,
        branch: values.branch,
        worktree: values.worktree,
        base_sha: values.base,
        head_sha: values.head,
        actor: values.actor,
      });
      console.log(JSON.stringify(res.task, null, 2));
    } else if (cmd === "attach") {
      const task_id = rest[0];
      const { values } = parseArgs({
        args: rest.slice(1),
        options: {
          repo: { type: "string" },
          branch: { type: "string" },
          worktree: { type: "string" },
          base: { type: "string" },
          head: { type: "string" },
          actor: { type: "string", default: "agent" },
        },
      });
      if (!task_id || !values.repo || !values.branch) {
        throw new Error("Usage: ledger attach <task_id> --repo <r> --branch <b>");
      }
      const ev = ledger.attachRepo({
        task_id,
        repo: values.repo,
        branch: values.branch,
        worktree: values.worktree,
        base_sha: values.base,
        head_sha: values.head,
        actor: values.actor,
      });
      console.log(JSON.stringify(ev, null, 2));
    } else if (cmd === "freeze") {
      const task_id = rest[0];
      const { values } = parseArgs({
        args: rest.slice(1),
        options: {
          "spec-dir": { type: "string" },
          "lock-tests": { type: "string", multiple: true },
          actor: { type: "string", default: "agent" },
        },
      });
      if (!task_id) {
        throw new Error(
          "Usage: ledger freeze <task_id> [--spec-dir <dir>] [--lock-tests <glob>]...",
        );
      }
      const res = ledger.freezeSpec({
        task_id,
        spec_dir: values["spec-dir"],
        locked_test_globs: values["lock-tests"] as string[] | undefined,
        actor: values.actor,
      });
      console.log(JSON.stringify(res, null, 2));
    } else if (cmd === "amend") {
      const task_id = rest[0];
      const { values } = parseArgs({
        args: rest.slice(1),
        options: {
          scope: { type: "string" },
          reason: { type: "string" },
          actor: { type: "string", default: "agent" },
        },
      });
      if (!task_id || !values.scope || !values.reason) {
        throw new Error(
          "Usage: ledger amend <task_id> --scope <requirement|invariant|tech_spec|test_spec> --reason <text>",
        );
      }
      const res = ledger.amendSpec({
        task_id,
        scope: values.scope as SpecAmendScope,
        reason: values.reason,
        actor: values.actor,
      });
      console.log(JSON.stringify(res, null, 2));
    } else if (cmd === "spec-status") {
      const task_id = rest[0];
      if (!task_id) throw new Error("Usage: ledger spec-status <task_id>");
      const task = ledger.getTask(task_id);
      if (!task) throw new Error(`Task not found: ${task_id}`);
      console.log(JSON.stringify(ledger.getSpecState(task_id), null, 2));
    } else if (cmd === "decide") {
      const task_id = rest[0];
      const { values } = parseArgs({
        args: rest.slice(1),
        options: {
          key: { type: "string" },
          summary: { type: "string" },
          supersedes: { type: "string" },
          actor: { type: "string", default: "agent" },
        },
      });
      if (!task_id || !values.key || !values.summary) {
        throw new Error("Usage: ledger decide <task_id> --key <k> --summary <text>");
      }
      const ev = ledger.recordDecision({
        task_id,
        key: values.key,
        summary: values.summary,
        supersedes_seq: values.supersedes ? Number(values.supersedes) : undefined,
        actor: values.actor,
      });
      console.log(JSON.stringify(ev, null, 2));
    } else if (cmd === "blocker") {
      const task_id = rest[0];
      const action = rest[1] as "open" | "close";
      const { values } = parseArgs({
        args: rest.slice(2),
        options: {
          id: { type: "string" },
          summary: { type: "string" },
          actor: { type: "string", default: "agent" },
        },
      });
      if (!task_id || (action !== "open" && action !== "close") || !values.id || !values.summary) {
        throw new Error("Usage: ledger blocker <task_id> <open|close> --id <bid> --summary <text>");
      }
      const ev = ledger.recordBlocker({
        task_id,
        action,
        blocker_id: values.id,
        summary: values.summary,
        actor: values.actor,
      });
      console.log(JSON.stringify(ev, null, 2));
    } else if (cmd === "record") {
      const task_id = rest[0];
      const { values } = parseArgs({
        args: rest.slice(1),
        options: {
          kind: { type: "string" },
          status: { type: "string", default: "info" },
          summary: { type: "string" },
          role: { type: "string" },
          repo: { type: "string" },
          branch: { type: "string" },
          sha: { type: "string" },
          meta: { type: "string" },
          actor: { type: "string", default: "agent" },
        },
      });
      if (!task_id || !values.kind || !values.summary) {
        throw new Error("Usage: ledger record <task_id> --kind <k> --status <s> --summary <text>");
      }
      const parsedMeta = values.meta
        ? (JSON.parse(values.meta) as Record<string, unknown>)
        : {};
      if (values.role) {
        if (values.kind === "review") {
          parsedMeta.role = normalizeReviewRole(values.role);
        } else {
          console.error(
            `Warning: --role only applies to --kind review; ignored for --kind ${values.kind}`,
          );
        }
      }
      const ev = ledger.recordEvidence({
        task_id,
        kind: values.kind as
          | "commit"
          | "build"
          | "test"
          | "lint"
          | "review"
          | "hurl"
          | "pr"
          | "fat"
          | "prod"
          | "note",
        status: values.status as "pass" | "fail" | "fallback" | "info",
        summary: values.summary,
        repo: values.repo,
        branch: values.branch,
        sha: values.sha,
        meta: Object.keys(parsedMeta).length > 0 ? parsedMeta : undefined,
        actor: values.actor,
      });
      console.log(JSON.stringify(ev, null, 2));
    } else if (cmd === "exempt") {
      const { values } = parseArgs({
        args: rest,
        options: {
          repo: { type: "string" },
          branch: { type: "string" },
          reason: { type: "string" },
          sha: { type: "string" },
          "ttl-hours": { type: "string", default: "24" },
        },
      });
      if (!values.repo || !values.branch || !values.reason) {
        throw new Error("Usage: ledger exempt --repo <r> --branch <b> --reason <text>");
      }
      const rec = ledger.addExemption({
        repo: values.repo,
        branch: values.branch,
        reason: values.reason,
        head_sha: values.sha,
        ttl_hours: Number(values["ttl-hours"]),
      });
      console.log(JSON.stringify(rec, null, 2));
    } else if (cmd === "status") {
      const { values } = parseArgs({
        args: rest,
        options: {
          task: { type: "string" },
          repo: { type: "string" },
          branch: { type: "string" },
          json: { type: "boolean", default: false },
        },
      });
      if (values.task) {
        const task = ledger.getTask(values.task);
        if (!task) throw new Error(`Task not found: ${values.task}`);
        const data = {
          task,
          spec: ledger.getSpecState(values.task),
          repos: ledger.getTaskRepos(values.task),
          blockers: ledger.getTaskBlockers(values.task),
          events: ledger.getTaskEvents(values.task),
        };
        console.log(JSON.stringify(data, null, 2));
      } else if (values.repo && values.branch) {
        const tasks = ledger.findOpenTasksByRepoBranch(values.repo, values.branch);
        const exemption = ledger.findActiveExemption(values.repo, values.branch);
        console.log(JSON.stringify({ tasks, exemption }, null, 2));
      } else {
        const open = ledger.listOpenTasks();
        if (values.json) {
          console.log(
            JSON.stringify(
              open.map((t) => ({
                ...t,
                repos: ledger.getTaskRepos(t.task_id),
                blockers: ledger.getTaskBlockers(t.task_id),
              })),
              null,
              2,
            ),
          );
        } else if (open.length === 0) {
          console.log("No OPEN task ledgers.");
        } else {
          console.log(ledger.formatCompactContext(50));
        }
      }
    } else if (cmd === "query") {
      const { values } = parseArgs({
        args: rest,
        options: {
          q: { type: "string" },
          repo: { type: "string" },
          status: { type: "string" },
          since: { type: "string" },
          limit: { type: "string", default: "50" },
          json: { type: "boolean", default: false },
        },
      });
      const res = ledger.query({
        q: values.q,
        repo: values.repo,
        status: values.status,
        since: values.since,
        limit: Number(values.limit),
      });
      console.log(JSON.stringify(res, null, 2));
    } else if (cmd === "verify") {
      const { values } = parseArgs({
        args: rest,
        options: {
          task: { type: "string" },
          json: { type: "boolean", default: false },
        },
      });
      const res = ledger.verify(values.task);
      console.log(JSON.stringify(res, null, 2));
      if (!res.ok) process.exitCode = 1;
    } else if (cmd === "close") {
      const task_id = rest[0];
      const { values } = parseArgs({
        args: rest.slice(1),
        options: {
          summary: { type: "string" },
          "no-archive": { type: "boolean", default: false },
          "force-incomplete": { type: "boolean", default: false },
          reason: { type: "string" },
          actor: { type: "string", default: "agent" },
        },
      });
      if (!task_id) throw new Error("Usage: ledger close <task_id>");
      const res = ledger.closeTask({
        task_id,
        summary: values.summary,
        archive: !values["no-archive"],
        forceIncomplete: Boolean(values["force-incomplete"]),
        forceReason: values.reason,
        actor: values.actor,
      });
      console.log(JSON.stringify(res, null, 2));
    } else if (cmd === "archive") {
      const task_id = rest[0];
      if (!task_id) throw new Error("Usage: ledger archive <task_id>");
      const archivePath = ledger.exportArchive(task_id);
      console.log(JSON.stringify({ task_id, archivePath }, null, 2));
    } else if (cmd === "cancel") {
      const task_id = rest[0];
      const { values } = parseArgs({
        args: rest.slice(1),
        options: {
          reason: { type: "string" },
          actor: { type: "string", default: "agent" },
        },
      });
      if (!task_id || !values.reason) {
        throw new Error("Usage: ledger cancel <task_id> --reason <text>");
      }
      const res = ledger.cancelTask({
        task_id,
        reason: values.reason,
        actor: values.actor,
      });
      console.log(JSON.stringify(res, null, 2));
    } else if (cmd === "prune") {
      const { values } = parseArgs({
        args: rest,
        options: {
          before: { type: "string" },
          apply: { type: "boolean", default: false },
        },
      });
      if (!values.before) {
        throw new Error("Usage: ledger prune --before <days> [--apply]");
      }
      const days = Number(values.before.replace(/d$/i, ""));
      if (!Number.isFinite(days) || days < 0) {
        throw new Error(`Invalid --before days: ${values.before}`);
      }
      const res = ledger.prune({ beforeDays: days, apply: Boolean(values.apply) });
      console.log(JSON.stringify(res, null, 2));
    } else if (cmd === "runbook") {
      const sub = rest[0];
      if (!sub || sub === "--help" || sub === "-h") {
        console.log(`Usage: ledger runbook <create|show|list|complete|revoke>
  create   --title <text> [--id rb-xxxx] [--task <task_id>] [--tag <repo>:<tag>:<sha>]... [--pr <repo>:<num>]... [--sql <host>:<path>]... [--kubectl "<cmd>"]...
  show     <runbook_id>
  list     [--status <PENDING|APPROVED|COMPLETED|REVOKED>]
  complete <runbook_id>
  revoke   <runbook_id>
Note: Approval is NEVER a CLI action; the user confirms in chat with "批准 <runbook_id>" (handled by UserPromptSubmit hook).`);
        return;
      }
      if (sub === "create") {
        const { values } = parseArgs({
          args: rest.slice(1),
          options: {
            id: { type: "string" },
            task: { type: "string" },
            title: { type: "string" },
            tag: { type: "string", multiple: true },
            pr: { type: "string", multiple: true },
            sql: { type: "string", multiple: true },
            kubectl: { type: "string", multiple: true },
          },
        });
        if (!values.title) throw new Error("Usage: ledger runbook create --title <text> ...");
        const tags: RunbookTagAction[] = (values.tag ?? []).map((spec) => {
          const parts = spec.split(":");
          if (parts.length !== 3) {
            throw new Error(`Invalid --tag "${spec}" (expected <repo>:<tag>:<sha>)`);
          }
          return { repo: parts[0], tag: parts[1], sha: parts[2] };
        });
        const prs: RunbookPrAction[] = (values.pr ?? []).map((spec) => {
          const idx = spec.lastIndexOf(":");
          if (idx <= 0) {
            throw new Error(`Invalid --pr "${spec}" (expected <repo>:<number>)`);
          }
          return { repo: spec.slice(0, idx), number: Number(spec.slice(idx + 1).replace(/^#/, "")) };
        });
        const sql_files: RunbookSqlFileAction[] = (values.sql ?? []).map((spec) => {
          const idx = spec.indexOf(":");
          if (idx <= 0) {
            throw new Error(`Invalid --sql "${spec}" (expected <host>:<path>)`);
          }
          return { host: spec.slice(0, idx), path: spec.slice(idx + 1), sha256: "" };
        });
        const rec = ledger.createRunbook({
          runbook_id: values.id,
          task_id: values.task,
          title: values.title,
          actions: {
            tags,
            prs,
            sql_files,
            kubectl_commands: values.kubectl ?? [],
          },
        });
        console.log(
          JSON.stringify(
            {
              ...rec,
              actions: JSON.parse(rec.actions_json),
              approval_prompt_hint: `请用户确认后回复：批准 ${rec.runbook_id}`,
            },
            null,
            2,
          ),
        );
      } else if (sub === "show") {
        const id = rest[1];
        if (!id) throw new Error("Usage: ledger runbook show <runbook_id>");
        const rec = ledger.getRunbook(id);
        if (!rec) throw new Error(`Runbook not found: ${id}`);
        console.log(JSON.stringify({ ...rec, actions: JSON.parse(rec.actions_json) }, null, 2));
      } else if (sub === "list") {
        const { values } = parseArgs({
          args: rest.slice(1),
          options: { status: { type: "string" } },
        });
        const list = ledger.listRunbooks(values.status as RunbookStatus | undefined);
        console.log(
          JSON.stringify(
            list.map((r) => ({ ...r, actions: JSON.parse(r.actions_json) })),
            null,
            2,
          ),
        );
      } else if (sub === "complete") {
        const id = rest[1];
        if (!id) throw new Error("Usage: ledger runbook complete <runbook_id>");
        console.log(JSON.stringify(ledger.completeRunbook(id), null, 2));
      } else if (sub === "revoke") {
        const id = rest[1];
        if (!id) throw new Error("Usage: ledger runbook revoke <runbook_id>");
        console.log(JSON.stringify(ledger.revokeRunbook(id), null, 2));
      } else {
        throw new Error(`Unknown ledger runbook subcommand: ${sub}`);
      }
    } else {
      throw new Error(`Unknown ledger command: ${cmd}`);
    }
  } finally {
    ledger.closeDb();
  }
}
