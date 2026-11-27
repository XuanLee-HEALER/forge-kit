import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ledger } from "../../src/ledger";
import { recordReview } from "../../src/ledger/review-record";

// Background evidence for tests that exercise other ledger behavior.
export function nativeReview(ledger: Ledger, task: string, options: {
  repo: string; branch: string; base: string; head: string; role?: string;
}) {
  const report = join(ledger.workbenchRoot, "fixture-review.md");
  writeFileSync(report, "Reviewed the fixture change. No blockers.\n");
  return recordReview(ledger, task, {
    role: "quality", ...options, status: "pass", report, summary: "Fixture review passed",
    "session-id": "fixture-review-session",
  });
}
