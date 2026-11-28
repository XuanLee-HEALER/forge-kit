import { redactAuditText } from "../shared/redact";
import { time, type Evidence } from "./summary-evidence";
import { stages, type Stage } from "./usage";

type Window = { stage: Stage; start: number; end: number };
type Session = { session_id: string; role: string | null };
const resets = new Set(["TASK_OPENED", "TASK_REOPENED", "TASK_RESUMED", "SPEC_AMENDED"]);
const endings = new Set(["TASK_CLOSED", "TASK_CANCELLED"]);

export function stageClassifier(
  evidence: Evidence,
  sessions: Session[],
  sessionIntervals: Record<string, [number, number][]>,
  captured: number,
) {
  const windows: Window[] = [];
  const add = (stage: Stage, start: number, end: number) => {
    if (Number.isFinite(start) && Number.isFinite(end) && start <= end) windows.push({ stage, start, end });
  };
  const eventBounds = evidence.events.filter(event => resets.has(event.event_type) || endings.has(event.event_type));
  const sessionsById = new Map(sessions.map(session => [session.session_id, session]));
  let wasFrozen = false;
  for (const [index, boundary] of eventBounds.entries()) {
    if (!resets.has(boundary.event_type)) continue;
    const next = eventBounds[index + 1];
    const start = time(boundary.ts);
    const end = next ? time(next.ts) : captured;
    const inCycle = (seq: number) => seq > boundary.seq && (!next || seq < next.seq);
    const cycleEvents = evidence.events.filter(event => inCycle(event.seq));
    const freeze = cycleEvents.find(event => event.event_type === "SPEC_FROZEN");
    if (boundary.event_type === "TASK_OPENED" || boundary.event_type === "SPEC_AMENDED") wasFrozen = false;
    if (freeze) add("grill", start, time(freeze.ts));
    const implementationStart = freeze ? time(freeze.ts) : wasFrozen ? start : NaN;
    wasFrozen ||= Boolean(freeze);
    let implementationEnd = end;
    function downstream(stage: Stage, from: number, to: number, recorded: number) {
      if (Number.isFinite(from) && Number.isFinite(to) && from >= start && to <= recorded && from <= to) {
        implementationEnd = Math.min(implementationEnd, from);
        add(stage, from, Math.min(to, end));
      } else {
        // An unbounded receipt ends the known implementation window. Only a
        // recorded start can place the ambiguity before the receipt itself.
        const ambiguity = Number.isFinite(from) ? Math.max(start, Math.min(from, recorded)) : recorded;
        implementationEnd = Math.min(implementationEnd, ambiguity);
        add("unclassified", ambiguity, Math.min(recorded, end));
      }
    }
    const lastReview = new Map<string, number>();
    for (const { event, meta, session } of evidence.reviews.filter(review => inCycle(review.event.seq))) {
      const recorded = time(event.ts);
      const id = session && redactAuditText(session);
      const observed = id ? sessionsById.get(id) : undefined;
      const from = time(meta.started_at);
      const to = time(meta.ended_at ?? meta.finished_at ?? (meta.execution_id ? event.ts : undefined));
      const turns = id && observed?.role?.startsWith("reviewer-") ? (sessionIntervals[id] ?? []).filter(
        ([begin, finish]) => begin >= Math.max(start, lastReview.get(id) ?? start) && finish <= recorded,
      ) : [];
      if (id) lastReview.set(id, recorded);
      if (!Number.isFinite(from) && turns.length)
        for (const [begin, finish] of turns) downstream("review", begin, finish, recorded);
      else downstream("review", from, to, recorded);
    }
    for (const { event, meta } of evidence.receipts.filter(receipt => inCycle(receipt.event.seq))) {
      const started = time(meta.started_at);
      const finished = time(meta.ended_at ?? meta.finished_at ??
        (typeof meta.duration_ms === "number" ? started + meta.duration_ms : undefined));
      downstream("verify", started, finished, time(event.ts));
    }
    for (const approval of evidence.approvalRows) {
      const approved = time(approval.approved_at);
      if (approved < start || approved > end || !Number.isFinite(approved)) continue;
      const settled = time(approval.completed_at ?? approval.revoked_at);
      implementationEnd = Math.min(implementationEnd, approved);
      add("ship", approved, Number.isFinite(settled) ? Math.min(settled, end) : end);
    }
    for (const handoff of cycleEvents.filter(event => event.event_type === "HANDOFF_RECORDED")) {
      implementationEnd = Math.min(implementationEnd, time(handoff.ts));
      add("ship", time(handoff.ts), end);
    }
    if (next?.event_type === "TASK_CLOSED") add("ship", end, end);
    if (implementationStart < implementationEnd) add("impl", implementationStart, implementationEnd);
  }
  const merged: Window[] = [];
  for (const stage of stages) {
    for (const window of windows.filter(window => window.stage === stage).sort((a, b) => a.start - b.start)) {
      const last = merged.at(-1);
      if (last?.stage === stage && last.end >= window.start) last.end = Math.max(last.end, window.end);
      else merged.push(window);
    }
  }
  return (ts: unknown, fromTs: unknown): Stage => {
    const end = time(ts);
    const start = fromTs == null ? end : time(fromTs);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return "unclassified";
    const overlapping = merged.filter(window => start === end
      ? window.start <= start && window.end >= end
      : window.start < end && window.end > start);
    const stage = overlapping[0]?.stage;
    return stage && overlapping.every(window => window.stage === stage) &&
      overlapping.some(window => window.start <= start && window.end >= end) ? stage : "unclassified";
  };
}
