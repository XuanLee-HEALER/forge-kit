import type { Database } from "bun:sqlite";
import { withImmediateTx } from "./transactions";
import { computeEntryHash, type LedgerReader, type TaskRecord } from "./types";

const SCHEMA_VERSION = 4;

export function ensureInitialized(db: Database): void {
  const versionRow = db.query("PRAGMA user_version;").get() as {
    user_version?: number;
  } | null;
  if (versionRow?.user_version === SCHEMA_VERSION) {
    return;
  }
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    withImmediateTx(db, () => {
      const { user_version } = db.query("PRAGMA user_version").get() as { user_version: number };
      if (user_version === SCHEMA_VERSION) return;
      if (user_version > SCHEMA_VERSION) throw Error("Unsupported newer ledger schema");
      if (db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks'").get()) {
        createTasks(db, "tasks_v4");
        const columns = "task_id,title,status,endpoint,verification_depth,open_blockers,last_verified_sha,tip_hash,created_at,updated_at,closed_at";
        db.exec(`INSERT INTO tasks_v4(rowid,${columns}) SELECT rowid,${columns} FROM tasks;
                 DROP TABLE tasks; ALTER TABLE tasks_v4 RENAME TO tasks`);
      } else createTasks(db, "tasks");
      initSchema(db);
      if (db.query("PRAGMA foreign_key_check").get()) throw Error("Ledger migration failed foreign_key_check");
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  } finally { db.exec("PRAGMA foreign_keys = ON"); }
}

function createTasks(db: Database, name: "tasks" | "tasks_v4") {
  db.exec(`CREATE TABLE ${name} (
        task_id            TEXT PRIMARY KEY,
        title              TEXT NOT NULL,
        status             TEXT NOT NULL CHECK (status IN ('OPEN','HANDED_OFF','CLOSED','CANCELLED')),
        endpoint           TEXT NOT NULL,
        verification_depth TEXT NOT NULL,
        open_blockers      INTEGER NOT NULL DEFAULT 0,
        last_verified_sha  TEXT,
        tip_hash           TEXT NOT NULL,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        closed_at          TEXT
      );`);
}

function initSchema(db: Database): void {
  db.exec(`
      CREATE TABLE IF NOT EXISTS task_handoffs (
        task_id TEXT PRIMARY KEY REFERENCES tasks(task_id) ON DELETE CASCADE,
        handed_off_at TEXT NOT NULL, ledger_tip TEXT NOT NULL, items_json TEXT NOT NULL,
        sql_files_json TEXT NOT NULL, rollback_plan TEXT
      );
      CREATE TABLE IF NOT EXISTS releases (
        release_id TEXT PRIMARY KEY, title TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('DRAFT','VERIFIED','APPROVED','COMPLETED','CANCELLED')),
        runbook_id TEXT, sql_files_json TEXT NOT NULL, rollback_plan TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS release_items (
        release_id TEXT NOT NULL REFERENCES releases(release_id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(task_id), repo TEXT NOT NULL, branch TEXT NOT NULL, base_branch TEXT NOT NULL,
        pr_number INTEGER NOT NULL, pr_url TEXT NOT NULL, expected_head_sha TEXT NOT NULL,
        verified_head_sha TEXT, ledger_tip TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('PENDING','VERIFIED','STALE_PR','MERGED')),
        merge_order INTEGER NOT NULL, PRIMARY KEY(release_id,task_id,repo,pr_number)
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

export function verify(ledger: LedgerReader, task_id?: string): {
  ok: boolean;
  checked_tasks: number;
  checked_events: number;
  errors: string[];
} {
  // Consistent read snapshot prevents false tip mismatch during concurrent writes.
  return ledger.db.transaction(() => {
    if (task_id && !ledger.getTask(task_id)) {
      return {
        ok: false,
        checked_tasks: 0,
        checked_events: 0,
        errors: [`Task not found: ${task_id}`],
      };
    }
    const tasks = task_id
      ? ([ledger.getTask(task_id)!])
      : (ledger.db.query("SELECT * FROM tasks ORDER BY created_at ASC").all() as TaskRecord[]);

    const errors: string[] = [];
    let checkedEvents = 0;

    for (const task of tasks) {
      const events = ledger.getTaskEvents(task.task_id);
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
  }).deferred();
}
