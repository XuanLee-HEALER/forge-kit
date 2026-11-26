import { buildPlan } from "./ship-actions";
import { checkedActions, requireActionReceipts, detail, inspect, observe, type ReleaseLedger } from "./release-inspection";
import { runGit, withinProcessDeadline } from "../git";
import { tagTargetIsCurrent } from "./pr";
import { withImmediateTx } from "./transactions";
import {
  canonicalJson,
  nowIso,
  sha256String,
  type LedgerReader,
  type RunbookActions,
  type RunbookPrAction,
  type RunbookRecord,
  type RunbookSqlFileAction,
  type RunbookStatus,
  type RunbookTagAction,
} from "./types";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { canonicalizeOsPath, sha256File } from "../shared/path";
import { tokenizeSimpleShellCommand } from "../shared/shell";

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

export function createRunbook(ledger: LedgerReader, params: {
  runbook_id?: string;
  task_id?: string | null;
  title: string;
  actions: Partial<RunbookActions>;
  exact_stages?: string[];
    exact_fat?: string[];
}): RunbookRecord {
  const title = params.title.trim();
  if (!title) throw new Error("Runbook title is required");

  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const runbook_id =
    params.runbook_id?.trim().toLowerCase() ||
    `rb-${mm}${dd}-${randomBytes(2).toString("hex")}`;
  if (!/^rb-[a-z0-9-]{1,32}$/.test(runbook_id)) {
    throw new Error(
      `Invalid runbook_id "${runbook_id}" (must match /^rb-[a-z0-9-]{1,32}$/)`,
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
    const repoDir = join(ledger.workbenchRoot, repo);
    if (existsSync(repoDir)) {
      const rev = runGit(repoDir, ["rev-parse", "--verify", `${sha}^{commit}`], 3000);
      if (rev.code === 0 && /^[0-9a-f]{40}$/i.test(rev.stdout.trim())) {
        sha = rev.stdout.trim().toLowerCase();
      }
    }
    tags.push({ repo, tag, sha, ...(raw.remote && {remote:raw.remote}) });
  }

  const prs: RunbookPrAction[] = [];
  for (const raw of params.actions.prs ?? []) {
    const repo = raw.repo.trim();
    const num = Number(raw.number);
    if (!repo || !Number.isInteger(num) || num <= 0) {
      throw new Error(`Invalid PR action (${raw.repo}:${raw.number}); expected <repo>:<positive-int>`);
    }
    if (raw.pin && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(raw.pin.head)) throw Error("Invalid pinned PR head");
    prs.push({ repo, number: num, ...(raw.pin && { pin: raw.pin }) });
  }

  const sql_files: RunbookSqlFileAction[] = [];
  for (const raw of params.actions.sql_files ?? []) {
    const host = raw.host.trim();
    const rawSqlPath = raw.path.trim();
    if (!host) throw new Error("SQL file action requires non-empty host");
    const real = canonicalizeOsPath(ledger.workbenchRoot, rawSqlPath);
    if (!real) {
      throw new Error(`Runbook SQL file does not exist: ${rawSqlPath}`);
    }
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
    !params.exact_fat?.length && !params.exact_stages?.length && kubectl_commands.length === 0
  ) {
    throw new Error(
      "Runbook must include at least one action (--tag, --pr, --sql, or --kubectl)",
    );
  }

  const normalized: RunbookActions = { tags, prs, sql_files, kubectl_commands };
  if (params.actions.release_observers?.length) normalized.release_observers = params.actions.release_observers;
  const exact = params.exact_stages && params.task_id ? buildPlan(ledger,params.task_id,normalized,params.exact_stages,params.exact_fat) : undefined;
  for(const action of exact?.actions ?? []) {
    if(action.kind==="pr") {
      const pr=normalized.prs.find(pr=>pr.repo===action.repo && pr.number===action.number)!;
      pr.pin={url:action.url,head:action.head,branch:exact!.pins.find(p=>p.repo===pr.repo)!.branch,base:action.base,base_oid:action.baseOid};
    }
  }
  const actions_json = canonicalJson(exact ? {...normalized,exact} : normalized);
  const actions_hash = sha256String(actions_json);
  const ts = nowIso();

  return withImmediateTx(ledger.db, () => {
    const existing = ledger.db
      .query("SELECT runbook_id FROM runbooks WHERE runbook_id = ?")
      .get(runbook_id);
    if (existing) {
      throw new Error(`Runbook already exists: ${runbook_id}`);
    }
    ledger.db
      .query(
        `INSERT INTO runbooks (
            runbook_id, task_id, title, status, actions_json, actions_hash,
            created_at, approved_at, approved_session_id, expires_at, completed_at, revoked_at
          ) VALUES (?, ?, ?, 'PENDING', ?, ?, ?, NULL, NULL, NULL, NULL, NULL)`,
      )
      .run(runbook_id, params.task_id ?? null, title, actions_json, actions_hash, ts);
    return ledger.getRunbook(runbook_id)!;
  });
}

export function getRunbook(ledger: LedgerReader, runbook_id: string): RunbookRecord | null {
  return ledger.db
    .query("SELECT * FROM runbooks WHERE runbook_id = ?")
    .get(runbook_id.trim().toLowerCase()) as RunbookRecord | null;
}

export function listRunbooks(ledger: LedgerReader, status?: RunbookStatus): RunbookRecord[] {
  if (status) {
    return ledger.db
      .query("SELECT * FROM runbooks WHERE status = ? ORDER BY created_at DESC LIMIT 50")
      .all(status) as RunbookRecord[];
  }
  return ledger.db
    .query("SELECT * FROM runbooks ORDER BY created_at DESC LIMIT 50")
    .all() as RunbookRecord[];
}

export function approveRunbookFromUserPrompt(ledger: ReleaseLedger, params: {
  runbook_id: string;
  session_id: string;
  ttl_minutes?: number;
}, deadline = Date.now() + 4500): { record: RunbookRecord; actions: RunbookActions } {
  return withinProcessDeadline(deadline, () => {
    const id = params.runbook_id.trim().toLowerCase();
    const sessionId = params.session_id.trim();
    if (!sessionId) throw new Error("Cannot approve runbook without valid session_id");

    const ttlMin = Math.min(120, Math.max(5, params.ttl_minutes ?? 30));

    const linked = () => ledger.db.query<{release_id:string},[string]>(
      "SELECT release_id FROM releases WHERE runbook_id=?").get(id)?.release_id;
    const releaseId = linked();
    const pending = ledger.getRunbook(id);
    if (pending?.status !== "PENDING") throw Error("Runbook is not PENDING: " + id);
    const observations = releaseId ? observe(ledger, detail(ledger,releaseId), deadline) : null;

    return withImmediateTx(ledger.db, () => {
      const rb = ledger.getRunbook(id);
      if (!rb) throw new Error(`Runbook not found: ${id}`);
      if (rb.status !== "PENDING") {
        throw new Error(`Runbook ${id} is ${rb.status} and cannot be approved`);
      }
      if (sha256String(rb.actions_json) !== rb.actions_hash) {
        throw new Error(`Runbook ${id} integrity check failed (actions_hash mismatch)`);
      }
      if (linked() !== releaseId || rb.actions_hash !== pending.actions_hash) throw Error("Runbook binding changed");
      if (releaseId && observations) {
        const release = detail(ledger,releaseId);
        if (release.status !== "VERIFIED" || release.runbook_id !== id) throw Error("Release is not VERIFIED");
        const checked = inspect(ledger,releaseId,observations,deadline);
        if (!checked.ok) throw Error(checked.errors.join("\n"));
        checkedActions(checked,rb);
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
      if (nowMs >= deadline) throw Error("Runbook approval verification timed out");
      const approvedAt = new Date(nowMs).toISOString();
      const expiresAt = new Date(nowMs + ttlMin * 60_000).toISOString();
      ledger.db
        .query(
          `UPDATE runbooks
             SET status = 'APPROVED', approved_at = ?, approved_session_id = ?, expires_at = ?
             WHERE runbook_id = ?`,
        )
        .run(approvedAt, sessionId, expiresAt, id);

      ledger.db.query("UPDATE releases SET status='APPROVED', updated_at=? WHERE runbook_id=? AND status='VERIFIED'").run(approvedAt,id);
      return { record: ledger.getRunbook(id)!, actions };
    });
  });
}

export function listActiveApprovedRunbooks(
  ledger: LedgerReader,
  session_id: string,
): Array<{ record: RunbookRecord; actions: RunbookActions }> {
  const sid = session_id.trim();
  if (!sid) return [];
  const now = nowIso();
  const rows = ledger.db
    .query(
      `SELECT * FROM runbooks
         WHERE status = 'APPROVED' AND approved_session_id = ? AND expires_at > ?
         ORDER BY approved_at DESC`,
    )
    .all(sid, now) as RunbookRecord[];
  const out: Array<{ record: RunbookRecord; actions: RunbookActions }> = [];
  const hasExactBindings=!!ledger.db.query("SELECT 1 FROM sqlite_master WHERE name='exact_ship_envelopes'").get();
  for (const r of rows) {
    if (sha256String(r.actions_json) !== r.actions_hash) continue;
    // The exact executor owns this authorization. It cannot be used as a
    // generic grant by shell hooks or an unrelated database session.
    if (hasExactBindings && ledger.db.query("SELECT 1 FROM exact_ship_envelopes WHERE runbook_id=?").get(r.runbook_id)) continue;
    try {
      const actions = JSON.parse(r.actions_json) as RunbookActions;
      // The push guard reads the authorized remote only after matching the local repository and tag.
      // Use the hashed remote, even when the pushing worktree and the primary checkout have different origins.
      if (actions.tags?.some(tag => tag.remote)) {
        actions.tags = actions.tags.map(tag => {
          const remote = tag.remote;
          if (!remote) return tag;
          const pin = actions.prs.find(pr => pr.repo === tag.repo && pr.pin?.head === tag.sha)?.pin;
          let current: boolean | undefined;
          return { ...tag, get remote() {
            current ??= !!pin?.base_oid && tagTargetIsCurrent(ledger.workbenchRoot, remote, pin.base, pin.base_oid);
            // A stale pin must match no host/owner/repo, including on a second read of this snapshot.
            return current ? remote : "unavailable";
          }};
        });
      }
      out.push({ record: r, actions });
    } catch {
      // Ignore malformed
    }
  }
  return out;
}

export function completeRunbook(ledger: ReleaseLedger, runbook_id: string): RunbookRecord {
  const id = runbook_id.trim().toLowerCase();
  return withImmediateTx(ledger.db, () => {
    const rb = ledger.getRunbook(id);
    if (!rb) throw new Error(`Runbook not found: ${id}`);
    if (rb.status === "COMPLETED") return rb;
    if(ledger.db.query("SELECT 1 FROM exact_ship_envelopes WHERE runbook_id=?").get(id))
      throw Error("Fast-track runbooks complete through verified action receipts. Use forge ship run --envelope <id>.");
    if (rb.status === "REVOKED") {
      throw new Error(`Cannot complete REVOKED runbook: ${id}`);
    }
    const linked = ledger.db.query<{release_id:string},[string]>("SELECT release_id FROM releases WHERE runbook_id=?").get(id);
    if (linked) {
      if (!rb.approved_at) throw Error("Release runbook requires human approval");
      requireActionReceipts(ledger,linked.release_id,rb);
    }
    const ts = nowIso();
    ledger.db
      .query("UPDATE runbooks SET status = 'COMPLETED', completed_at = ? WHERE runbook_id = ?")
      .run(ts, id);
    return ledger.getRunbook(id)!;
  });
}

export function revokeRunbook(ledger: LedgerReader, runbook_id: string, session?:string): RunbookRecord {
  const id = runbook_id.trim().toLowerCase();
  return withImmediateTx(ledger.db, () => {
    const rb = ledger.getRunbook(id);
    if (!rb) throw new Error(`Runbook not found: ${id}`);
    const active=ledger.db.query<{approved_session_id:string},[string]>("SELECT e.approved_session_id FROM fast_track_envelopes e JOIN exact_ship_envelopes b ON e.envelope_id=b.envelope_id WHERE b.runbook_id=? AND e.status='ACTIVE'").get(id);
    if(active && session!==active.approved_session_id) throw Error("Use the approving root session to revoke this active authorization");
    const ts = nowIso();
    ledger.db
      .query("UPDATE runbooks SET status = 'REVOKED', revoked_at = ? WHERE runbook_id = ?")
      .run(ts, id);
    ledger.db.query("UPDATE releases SET status='VERIFIED', updated_at=? WHERE runbook_id=? AND status='APPROVED'").run(ts,id);
    return ledger.getRunbook(id)!;
  });
}
