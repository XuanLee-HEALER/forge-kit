import { isOid, runGit } from "../git";

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

export function coversReviewBase(dir: string, recordedBase: string | null, reviewBase: string): boolean {
  if (!recordedBase || !/^[a-f0-9]{7,64}$/i.test(recordedBase)) return false;
  if (recordedBase === reviewBase) return true;
  const resolved = runGit(dir, ["--no-replace-objects", "rev-parse", "--verify", "--end-of-options", recordedBase + "^{commit}"]);
  return resolved.code === 0 && resolved.stdout.trim() === reviewBase;
}

export interface ReviewIssue {
  role: string;
  base: string;
  head: string;
}

function ancestor(dir: string, older: string, newer: string) {
  return older === newer || runGit(dir, ["--no-replace-objects", "merge-base", "--is-ancestor", older, newer]).code === 0;
}

export function resolveReviewedIssues(issues: Map<number, ReviewIssue>, pass: ReviewIssue, summary: string,
  dir: string, deliveryHead: string) {
  if (!issues.size) return;
  const references = summary.matchAll(/(?:\bseq\s+|#)([1-9]\d*)\b/gi);
  let reachesDelivery: boolean | undefined;
  for (const [, seq] of references) {
    const issue = issues.get(Number(seq));
    if (!issue || issue.role !== pass.role) continue;
    reachesDelivery ??= ancestor(dir, pass.head, deliveryHead);
    if (!reachesDelivery) return;
    if (ancestor(dir, issue.head, pass.head) &&
        (ancestor(dir, pass.base, issue.base) || ancestor(dir, issue.head, pass.base))) issues.delete(Number(seq));
  }
}
