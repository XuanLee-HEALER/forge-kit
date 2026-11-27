import { normalizeReviewRole } from "./types";
import { isOid, runGit } from "../git";
import { resolveTaskCheckout } from "./checkout";
import type { TaskRepoRecord } from "./types";

export function compareReviewTrees(dir: string, base: string, head: string): "changed" | "equal" | "unavailable" {
  function tree(sha: string) {
    const result = runGit(dir, ["--no-replace-objects", "rev-parse", "--verify", "--end-of-options", sha + "^{tree}"]);
    const oid = result.stdout.trim();
    return result.code === 0 && isOid(oid) ? oid : undefined;
  }
  const before = tree(base);
  const after = tree(head);
  if (!before || !after) return "unavailable";
  return before === after ? "equal" : "changed";
}

export function coversReviewBase(
  root: string,
  attachment: Pick<TaskRepoRecord, "repo" | "branch" | "worktree" | "base_sha">,
  base: unknown,
): boolean {
  if (!attachment.base_sha) return false;
  if (typeof base !== "string" || !/^[a-f0-9]{7,64}$/i.test(base)) return false;
  if (base === attachment.base_sha) return true;
  if (!/^[a-f0-9]{7,64}$/i.test(attachment.base_sha)) return false;
  const { dir } = resolveTaskCheckout(root, attachment);
  const resolve = (sha: string) => runGit(dir, ["rev-parse", "--verify", sha + "^{commit}"]);
  const reviewed = resolve(base), recorded = resolve(attachment.base_sha);
  return reviewed.code === 0 && recorded.code === 0 && reviewed.stdout === recorded.stdout;
}

export function reviewMeetsFloor(status: string, meta: { role?: string; started_at?: string; review_floor_seq?: number; review_task_id?: string } | undefined,
  task: string, floor: number, floorTime?: string, source?: string): boolean {
  if (source === "hook" && status === "pass" && normalizeReviewRole(meta?.role) !== "codex-review")
    return meta?.review_task_id === task && meta.review_floor_seq === floor;
  if (meta?.review_task_id !== undefined && meta.review_task_id !== task) return false;
  if (meta?.review_floor_seq !== undefined) return meta.review_floor_seq === floor && (!floor || meta.review_task_id === task);
  if (!floor) return true;
  if (status !== "fail") return false;
  if (meta?.started_at !== undefined) return !!floorTime && Date.parse(meta.started_at) > Date.parse(floorTime);
  return true; // Undated legacy failures still require resolution.
}

export interface ReviewIssue {
  role: string;
  base: string;
  head: string;
  seq: number;
  source: string;
}

function ancestor(dir: string, older: string, newer: string) {
  return older === newer || (/^[a-f0-9]{7,64}$/i.test(older) && /^[a-f0-9]{7,64}$/i.test(newer) &&
    runGit(dir, ["--no-replace-objects", "merge-base", "--is-ancestor", older, newer]).code === 0);
}

const nativeSuccessors = new Map([["business-review", "business"], ["performance", "simplify"]]);

export function resolveReviewedIssues(issues: Map<number, ReviewIssue>, pass: ReviewIssue, summary: string,
  dir: string, deliveryHead: string, coversBaseline: boolean) {
  if (!issues.size || !ancestor(dir, pass.head, deliveryHead)) return;
  if (pass.source === "tool") {
    // Old tools could repeat a range at its HEAD or review the full baseline again after a fix.
    for (const issue of issues.values()) {
      if (issue.source !== "tool" || issue.role !== pass.role) continue;
      const covered = issue.head === pass.head
        ? issue.base === pass.base
        : coversBaseline && ancestor(dir, pass.base, issue.base) && ancestor(dir, issue.head, pass.head);
      if (covered) issues.delete(issue.seq);
    }
    return;
  }

  const references = summary.matchAll(/(?:\bseq\s+|#)([1-9]\d*)\b/gi);
  for (const [, seq] of references) {
    const issue = issues.get(Number(seq));
    if (!issue) continue;
    const role = nativeSuccessors.get(issue.role) ?? issue.role;
    if (role !== pass.role || !ancestor(dir, issue.head, pass.head)) continue;
    if (ancestor(dir, pass.base, issue.base) || ancestor(dir, issue.head, pass.base)) issues.delete(issue.seq);
  }
}
