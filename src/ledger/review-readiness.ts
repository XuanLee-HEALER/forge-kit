import { join } from "node:path";
import { reviewRoles } from "../config";
import { isOid } from "../git";
import { compareReviewTrees, coversReviewBase, resolveReviewedIssues, type ReviewIssue } from "./review-range";
import type { LedgerReader, TaskRepoRecord, TaskSpecState } from "./types";

interface ReviewReceipt {
  status?: string;
  summary?: string;
  meta?: {
    role?: string;
    base?: string;
    head?: string;
    report_status?: string;
    report_path?: string;
    report_sha256?: string;
    freeze_seq?: number;
    review_task_id?: string;
    review_floor_seq?: number;
  };
}

export function checkReviewReadiness(ledger: LedgerReader, attachment: TaskRepoRecord,
  head: string, spec: TaskSpecState, dir = join(ledger.workbenchRoot, attachment.repo)) {
  const { task_id, repo, branch, base_sha } = attachment;
  const roles = new Set<string>();
  const floor = spec.evidence_floor_seq.review;
  const target = `${repo}:${branch}@${head.slice(0, 8)}`;
  const required = `Independent review evidence required for the nonempty task baseline-to-HEAD diff at the current freeze for ${target}`;
  if (spec.state !== "FROZEN" || spec.freeze_seq === null || !isOid(head))
    return { roles: [], failed: false, missing: required };
  if (!base_sha) return { roles: [], failed: false,
    missing: `review baseline missing: forge ledger attach ${task_id} --repo ${repo} --branch ${branch} --base <original-start-sha>` };

  const events = ledger.db.query<{
    seq: number; sha: string | null; event_type: string; payload_json: string;
  }, [string, string, string, number]>(
    `SELECT seq, sha, event_type, payload_json FROM events
     WHERE task_id = ? AND canonical_repo(repo) = canonical_repo(?) AND branch = ?
       AND (event_type IN ('REPO_ATTACHED','REPO_DETACHED') OR (event_type = 'EVIDENCE_CAPTURED' AND seq >= ?
         AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.kind') = 'review'
           AND json_extract(payload_json, '$.source') = 'subagent' END))
     ORDER BY seq`,
  ).all(task_id, repo, branch, Math.max(floor, spec.freeze_seq + 1));
  const issues = new Map<number, ReviewIssue>();
  let attachedBase: string | null | undefined;
  let coversBaseline = false;
  for (const ev of events) {
    if (ev.event_type === "REPO_DETACHED") {
      attachedBase = undefined;
      continue;
    }
    if (ev.event_type === "REPO_ATTACHED") {
      attachedBase = (JSON.parse(ev.payload_json) as { base_sha?: string }).base_sha ?? null;
      continue;
    }
    if (attachedBase === undefined || !ev.sha || !isOid(ev.sha)) continue;
    const p = JSON.parse(ev.payload_json) as ReviewReceipt;
    const m = p.meta;
    if (!m || m.freeze_seq !== spec.freeze_seq || m.review_floor_seq !== floor || m.review_task_id !== task_id ||
        m.head !== ev.sha || typeof m.base !== "string" || !isOid(m.base) ||
        !m.role || !reviewRoles.some(role => role === m.role) ||
        typeof m.report_path !== "string" || !m.report_path ||
        typeof m.report_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(m.report_sha256)) continue;
    const range = { role: m.role, base: m.base, head: ev.sha };
    if (p.status === "fail" && (m.report_status === "blocked" || m.report_status === "incomplete")) {
      issues.set(ev.seq, range);
    } else if (p.status === "pass" && m.report_status === "pass") {
      resolveReviewedIssues(issues, range, typeof p.summary === "string" ? p.summary : "", dir, head);
      if (range.head !== head) continue;
      roles.add(range.role);
      coversBaseline ||= coversReviewBase(dir, attachedBase, range.base) &&
        (attachedBase === base_sha || coversReviewBase(dir, base_sha, range.base));
    }
  }

  if (issues.size) {
    const byRole = new Map<string, string[]>();
    for (const [seq, { role }] of issues) {
      const refs = byRole.get(role) ?? [];
      refs.push(`#${seq}`);
      byRole.set(role, refs);
    }
    const details = [...byRole].map(([role, refs]) => `${role} (${refs.join(", ")})`).join(", ");
    return { roles: [...roles], failed: true, missing: `latest review failed (${details}) for ${target}` };
  }
  const complete = coversBaseline && compareReviewTrees(dir, base_sha, head) === "changed";
  return { roles: [...roles], failed: false, missing: complete ? undefined : required };
}
