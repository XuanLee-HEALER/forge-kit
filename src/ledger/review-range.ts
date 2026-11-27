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

export class ReviewGitError extends Error {}

export function reviewBaseline(dir: string, recordedBase: string): string {
  const oid = /^[a-f0-9]{7,64}$/i.test(recordedBase)
    ? runGit(dir, ["--no-replace-objects", "rev-parse", "--verify", "--end-of-options", recordedBase + "^{commit}"])
    : undefined;
  const sha = oid?.stdout.trim();
  if (oid?.code === 0 && sha && isOid(sha) && sha.startsWith(recordedBase.toLowerCase())) return sha;
  throw new ReviewGitError("Cannot resolve review baseline " + recordedBase);
}

export interface ReviewRange {
  base: string;
  head: string;
}

type IsAncestor = (older: string, newer: string) => boolean;

export function reviewAncestry(dir: string): IsAncestor {
  const cache = new Map<string, boolean>();
  return (older, newer) => {
    if (older === newer) return true;
    const pair = older + ".." + newer;
    const previous = cache.get(pair);
    if (previous !== undefined) return previous;
    const result = runGit(dir, ["--no-replace-objects", "merge-base", "--is-ancestor", older, newer]);
    if (result.code !== 0 && (result.code !== 1 || result.termination || result.stderr.trim())) {
      throw new ReviewGitError("Cannot verify review ancestry for " + pair);
    }
    const ancestor = result.code === 0;
    cache.set(pair, ancestor);
    return ancestor;
  };
}

export function reviewCoverageGap(ranges: ReviewRange[], base: string, head: string, ancestor: IsAncestor): string | undefined {
  // The Set iterator also visits new endpoints. In a merge, reachable endpoints can be incomparable.
  const reached = new Set([base]);
  for (const covered of reached) {
    for (const range of ranges) {
      if (reached.has(range.head) || !ancestor(range.base, covered) || !ancestor(covered, range.head)) continue;
      if (range.head === head) return undefined;
      reached.add(range.head);
    }
  }

  let nextBase: string | undefined;
  const endpoints = [...reached];
  for (const range of ranges) {
    if (endpoints.some(covered => ancestor(range.base, covered))) continue;
    if (!nextBase || ancestor(range.base, nextBase)) nextBase = range.base;
  }
  const next = nextBase ?? head;
  let covered = base;
  for (const candidate of reached) {
    if (ancestor(covered, candidate) && ancestor(candidate, next)) covered = candidate;
  }
  const gap = `${covered.slice(0, 8)}..${next.slice(0, 8)}`;
  return nextBase ? `coverage gap ${gap}` : `has not covered delivery HEAD (${gap})`;
}
