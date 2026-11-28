import { evidenceSource, normalizeReviewRole, reviewFactKind, type EventRecord, type LedgerReader } from "../ledger/types";
import { roles as auditRoles } from "./usage";

const lifecycle = new Set(["TASK_OPENED", "TASK_REOPENED", "TASK_RESUMED", "HANDOFF_RECORDED", "TASK_CLOSED"]);
const verification = ["verify", "test", "lint", "build"] as const;
type Approval = { approved_session_id?: string; approved_at?: string; completed_at?: string; revoked_at?: string };
type Payload = { kind?: string; status?: string; source?: string; meta?: Record<string, unknown> };
type Review = { event: EventRecord; session?: string; meta: Record<string, unknown> };
type Receipt = { event: EventRecord; meta: Record<string, unknown> };

export function time(value: unknown) {
  return typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
}

function sessionID(value: unknown) {
  return typeof value === "string" && !/[\u0000-\u001f\u007f]/.test(value.trim())
    ? value.trim() || undefined
    : undefined;
}

function approvals(ledger: LedgerReader, task: string): Approval[] {
  const columns = (table: string) => new Set(ledger.db.query<{ name: string }, []>(
    "SELECT name FROM pragma_table_info('" + table + "')",
  ).all().map(({ name }) => name));
  const books = columns("runbooks");
  const fast = columns("fast_track_envelopes");
  const exact = columns("exact_ship_envelopes");
  const releases = columns("releases");
  const items = columns("release_items");
  const rows: Approval[] = [];
  const links: string[] = [];
  if (books.has("task_id")) links.push("b.task_id = ?1");
  if (releases.has("runbook_id") && releases.has("release_id") && items.has("release_id") && items.has("task_id"))
    links.push("b.runbook_id IN (SELECT r.runbook_id FROM releases r JOIN release_items i USING(release_id) WHERE i.task_id=?1)");
  if (fast.has("task_id") && fast.has("redeemed_runbook_id"))
    links.push("b.runbook_id IN (SELECT redeemed_runbook_id FROM fast_track_envelopes WHERE task_id=?1)");
  if (fast.has("task_id") && fast.has("envelope_id") && exact.has("envelope_id") && exact.has("runbook_id"))
    links.push("b.runbook_id IN (SELECT e.runbook_id FROM exact_ship_envelopes e JOIN fast_track_envelopes f USING(envelope_id) WHERE f.task_id=?1)");
  if (books.has("runbook_id") && links.length) rows.push(...ledger.db.query<Approval, [string]>(
    "SELECT b.* FROM runbooks b WHERE " + links.join(" OR ") + " ORDER BY b.runbook_id",
  ).all(task));
  // Advance authorization is a session anchor. Redemption and the linked runbook
  // supply delivery evidence because the advance approval can precede implementation.
  const envelopes = fast.has("task_id") ? ledger.db.query<Approval & { redeemed_at?: string }, [string]>(
    "SELECT * FROM fast_track_envelopes WHERE task_id=?",
  ).all(task).map(row => ({ approved_session_id: row.approved_session_id, approved_at: row.redeemed_at })) : [];
  return [...rows, ...envelopes];
}

export function captureEvidence(ledger: LedgerReader, taskId: string, explicitSession?: string) {
  return ledger.db.transaction(() => {
    const task = ledger.getTask(taskId);
    if (!task) throw Error("Expected an existing task ID");
    const events = ledger.getTaskEvents(taskId);
    const approvalRows = approvals(ledger, taskId);
    const anchors = new Set<string>();
    const roles: Record<string, string> = Object.create(null);
    const warnings: string[] = [];
    const reviews: Review[] = [];
    const receipts: Receipt[] = [];
    const rounds = new Set<string>();
    let freeze: number | null = null;
    let missingRound = false;
    const rework = {
      review_records: 0, review_rounds: null as number | null, review_blocked: 0, review_incomplete: 0,
      verify_failures: 0, test_failures: 0, lint_failures: 0, build_failures: 0, spec_amendments: 0,
    };
    const anchor = (value: unknown) => {
      const id = sessionID(value);
      if (id) anchors.add(id);
      return id;
    };
    for (const row of approvalRows) anchor(row.approved_session_id);
    anchor(explicitSession);
    for (const event of events) {
      const id = anchor(event.session_id);
      if (id && lifecycle.has(event.event_type)) roles[id] ??= "main";
      if (event.event_type === "SPEC_FROZEN") freeze = event.seq;
      if (event.event_type === "SPEC_AMENDED") {
        rework.spec_amendments++;
        freeze = null;
      }
      if (event.event_type !== "EVIDENCE_CAPTURED") continue;
      let payload: Payload;
      try { payload = JSON.parse(event.payload_json) ?? {}; }
      catch { warnings.push("A ledger evidence payload could not be decoded."); continue; }
      const meta = payload.meta ?? {};
      const source = evidenceSource(payload, event.actor);
      const reviewSession = payload.kind === "review" ? anchor(meta.session_id) ?? id : undefined;
      if (reviewFactKind(payload) === "review") {
        if (meta.reused === true || !meta.backend && Array.isArray(meta.attempts) && !meta.attempts.length) continue;
        if (!(source === "subagent" && typeof meta.report_sha256 === "string" ||
          (source === "tool" || source === "hook") && (meta.backend || Array.isArray(meta.attempts) && meta.attempts.length))) continue;
        if (reviewSession && typeof meta.role === "string") {
          const role = meta.role.startsWith("reviewer-") ? meta.role : "reviewer-" + normalizeReviewRole(meta.role);
          if (auditRoles.some(candidate => candidate === role))
            roles[reviewSession] = role;
        }
        reviews.push({ event, session: reviewSession, meta });
        rework.review_records++;
        if (meta.report_status === "blocked") rework.review_blocked++;
        if (meta.report_status === "incomplete") rework.review_incomplete++;
        const candidate = [
          meta.freeze_seq ?? freeze, event.repo, event.branch, meta.base ?? meta.base_sha, meta.head ?? meta.head_sha ?? event.sha,
        ];
        if (candidate.slice(1).every(value => typeof value === "string" && value.length)) rounds.add(JSON.stringify(candidate));
        else missingRound = true;
      }
      const kind = verification.find(candidate => candidate === payload.kind);
      if (!kind || (source !== "tool" && source !== "hook") || meta.reused === true ||
        meta.reused_from || !["pass", "fail"].includes(payload.status ?? "")) continue;
      receipts.push({ event, meta });
      if (payload.status === "fail") rework[`${kind}_failures`]++;
    }
    rework.review_rounds = missingRound ? null : rounds.size;
    if (missingRound) warnings.push("Some recorded reviews lack a candidate range.");
    return { task, events, approvalRows, anchors: [...anchors].sort(), roles, reviews, receipts, rework, warnings };
  }).deferred();
}

export type Evidence = ReturnType<typeof captureEvidence>;
