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
PRAGMA user_version = 3;
