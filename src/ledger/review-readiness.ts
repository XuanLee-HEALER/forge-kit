import { join } from "node:path";
import { reviewRoles } from "../config";
import { isOid } from "../git";
import { compareReviewTrees, reviewAncestry, reviewBaseline, reviewCoverageGap, ReviewGitError, type ReviewRange } from "./review-range";
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

interface AttachedReview extends ReviewRange {
  role: string;
  attachedBase: string | null;
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
  const issues = new Map<number, AttachedReview & { status: "blocked" | "incomplete" }>();
  const passes: (AttachedReview & { seq: number; summary: string })[] = [];
  const byRole = new Map<string, ReviewRange[]>();
  let attachedBase: string | null | undefined;
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
    const range = { role: m.role, base: m.base, head: ev.sha, attachedBase };
    if (p.status === "fail" && (m.report_status === "blocked" || m.report_status === "incomplete")) {
      issues.set(ev.seq, { ...range, status: m.report_status });
    } else if (p.status === "pass" && m.report_status === "pass") {
      passes.push({ ...range, seq: ev.seq, summary: typeof p.summary === "string" ? p.summary : "" });
    } else {
      continue;
    }
    if (!byRole.has(range.role)) byRole.set(range.role, []);
  }

  let coverageMissing: string | undefined;
  try {
    const ancestor = reviewAncestry(dir);
    const base = reviewBaseline(dir, base_sha);
    const baselines = new Map([[base_sha, base]]);
    function applies(range: AttachedReview) {
      if (!range.attachedBase || range.base === range.head || !ancestor(range.head, head) ||
          !ancestor(base, range.base) || !ancestor(range.base, range.head)) return false;
      const original = baselines.get(range.attachedBase) ?? reviewBaseline(dir, range.attachedBase);
      baselines.set(range.attachedBase, original);
      return ancestor(original, range.base);
    }

    for (const pass of passes) {
      if (!applies(pass)) continue;
      if (pass.head === head) roles.add(pass.role);
      const ranges = byRole.get(pass.role)!;
      ranges.push(pass);
      for (const [, reference] of pass.summary.matchAll(/(?:\bseq\s+|#)([1-9]\d*)\b/gi)) {
        const seq = Number(reference);
        const issue = issues.get(seq);
        if (!issue || seq >= pass.seq || issue.role !== pass.role || !ancestor(issue.head, pass.head)) continue;
        if (!ancestor(pass.base, issue.base) && !(issue.status === "blocked" && ancestor(issue.head, pass.base))) continue;
        if (issue.status === "blocked" && applies(issue)) ranges.push(issue);
        issues.delete(seq);
      }
    }

    if (!ancestor(base, head)) {
      coverageMissing = required + ". The task baseline is not an ancestor of delivery HEAD";
    } else {
      const trees = compareReviewTrees(dir, base, head);
      if (trees === "unavailable") throw new ReviewGitError("Cannot inspect task baseline or delivery HEAD tree");
      if (trees === "equal") {
        coverageMissing = required + ". The task baseline and delivery HEAD trees are identical";
      } else {
        const gaps: string[] = [];
        // A complete role needs a passing receipt at HEAD, even if its final segment was a repaired failure.
        const orderedRoles = [...byRole].sort(([a], [b]) => Number(roles.has(b)) - Number(roles.has(a)));
        for (const [role, ranges] of orderedRoles) {
          const gap = reviewCoverageGap(ranges, base, head, ancestor);
          if (!gap) {
            gaps.length = 0;
            break;
          }
          gaps.push(`${role} ${gap}`);
        }
        if (!byRole.size || gaps.length) coverageMissing = [required, ...gaps].join(". ");
      }
    }
  } catch (error) {
    if (!(error instanceof ReviewGitError)) throw error;
    coverageMissing = `${required}. Git evidence unavailable. ${error.message}`;
  }

  if (issues.size) {
    const issuesByRole = new Map<string, string[]>();
    for (const [seq, { role }] of issues) {
      const refs = issuesByRole.get(role) ?? [];
      refs.push(`#${seq}`);
      issuesByRole.set(role, refs);
    }
    const details = [...issuesByRole].map(([role, refs]) => `${role} (${refs.join(", ")})`).join(", ");
    const failure = `latest review failed (${details}) for ${target}`;
    return { roles: [...roles], failed: true, missing: coverageMissing ? failure + "\n" + coverageMissing : failure };
  }
  return { roles: [...roles], failed: false, missing: coverageMissing };
}
