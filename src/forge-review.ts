import { checkMigration } from "./managed-assets";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { reviewOptions, runReview } from "../review-agents/src/engine";
import { canonicalRepoPath, findWorkbenchRoot, loadModelsConfig } from "./config";
import { runGit } from "./git";
import { executionSnapshot, recheckExecution, targetOptions } from "./ledger/execution";
import { evidenceSource, usesV05 } from "./ledger/types";
import { reviewMeetsFloor } from "./ledger/review-range";
import { Ledger } from "./ledger/store";

export { reviewExitCode } from "../review-agents/src/engine";

function resolveCommit(repo: string, value: string) {
  if (!/^[0-9a-f]{7,64}$/i.test(value)) throw Error("Expected a commit SHA");
  const result = runGit(repo, ["rev-parse", "--verify", "--end-of-options", value + "^{commit}"]);
  if (result.code) throw Error("Unresolvable review commit");
  return result.stdout.trim();
}

// v0.4 tracked performance separately. A retry is bound to the latest unresolved
// receipt for this role, attachment, range and review cycle.
function performanceFailure(ledger: Ledger, snap: ReturnType<typeof executionSnapshot>, base: string) {
  if (usesV05(ledger, snap.task_id) || base !== snap.base)
    throw Error("A performance retry requires a v0.4 task and its original attached review range");
  const rows = ledger.getTaskEvents(snap.task_id);
  const floor = snap.floors.review;
  const floorTime = rows.find(row => row.seq === floor)?.ts;
  const attachments = ledger.getTaskRepos(snap.task_id).filter(row => row.repo === snap.repo);
  for (const row of rows.reverse()) {
    if (row.seq < floor) break;
    if (row.event_type !== "EVIDENCE_CAPTURED" || row.sha !== snap.head || !row.repo ||
        canonicalRepoPath(ledger.workbenchRoot, row.repo) !== snap.repo ||
        (row.branch ? row.branch !== snap.branch : attachments.length !== 1)) continue;
    const evidence = JSON.parse(row.payload_json);
    const source = evidenceSource(evidence, row.actor);
    if (evidence.kind !== "review" || evidence.meta?.role !== "performance" || source === "manual" ||
        !reviewMeetsFloor(evidence.status, evidence.meta, snap.task_id, floor, floorTime, source)) continue;
    if (evidence.status === "fail" && evidence.meta.base === base) return row.seq;
    break;
  }
  throw Error("No unresolved v0.4 performance failure for this task, branch, range and review cycle");
}

export async function reviewCli(args: string[]) {
  const { values } = parseArgs({ args, options: { ...reviewOptions, ...targetOptions } });
  const root = findWorkbenchRoot(values.cwd);
  checkMigration(root);
  const ledger = new Ledger(root);
  try {
    const snap = executionSnapshot(ledger, values);
    const head = values.head === undefined ? snap.head : resolveCommit(snap.dir, values.head);
    const base = values.base === undefined ? snap.base : resolveCommit(snap.dir, values.base);
    if (!base || head !== snap.head || !snap.base || runGit(snap.dir, ["merge-base", "--is-ancestor", snap.base, base]).code)
      throw Error("Expected an attached review range ending at the current delivery HEAD");
    const priorFailure = values.roles === "performance" ? performanceFailure(ledger, snap, base) : undefined;
    const config = loadModelsConfig(root);
    const spec = ledger.getSpecState(snap.task_id);
    const specPath = spec.state === "FROZEN" && (spec.files?.ssot ?? spec.files?.scope);
    const started = new Date().toISOString();
    const execution = crypto.randomUUID();
    const report = await runReview({
      ...values, repo: snap.dir, base, head, spec: specPath ? join(root, specPath) : undefined,
      specSha256: spec.hashes?.ssot ?? spec.hashes?.scope,
      legacyPerformanceRetry: priorFailure !== undefined,
      models: { performance: config.tiers.deep, business: config.tiers.deep, quality: config.tiers.deep, simplify: config.tiers.standard, comments: config.tiers.mechanical },
    });
    ledger.db.transaction(() => {
      recheckExecution(ledger, snap);
      if (priorFailure !== undefined && performanceFailure(ledger, snap, base) !== priorFailure)
        throw Error("Performance review evidence changed during the retry");
      for (const result of report.roles) {
        ledger.recordEvidence({
          task_id: snap.task_id, repo: snap.repo, branch: snap.branch, sha: head, actor: "tool", source: "tool",
          kind: "review", status: result.status === "pass" ? "pass" : "fail", summary: result.summary,
          meta: {
            ...(priorFailure !== undefined && { retry_of: priorFailure }),
            role: result.role, base, head, execution_id: execution, started_at: started,
            review_task_id: snap.task_id, review_floor_seq: snap.floors.review, freeze_seq: snap.freeze_seq,
            ...(result.missing_materials ? { missing_materials: result.missing_materials } : {}),
            backend: result.backend, attempts: result.attempts, report_status: result.status,
            limitations: result.limitations, findings: result.findings, findings_count: result.findings.length, fallback_used: result.attempts.length > 1,
          },
          tool_use_id: "review-execution:" + execution + ":" + result.role,
        });
      }
    }).immediate();
    return { ...report, ok: report.status === "pass", task_id: snap.task_id, repo: snap.repo };
  } finally { ledger.closeDb(); }
}
