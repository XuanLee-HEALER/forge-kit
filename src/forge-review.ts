import { join } from "node:path";
import { parseArgs } from "node:util";
import { reviewOptions, runReview } from "../review-agents/src/engine";
import { findWorkbenchRoot, loadModelsConfig } from "./config";
import { runGit } from "./git";
import { executionSnapshot, recheckExecution, targetOptions } from "./ledger/execution";
import { Ledger } from "./ledger/store";

export { reviewExitCode } from "../review-agents/src/engine";

function resolveCommit(repo: string, value: string) {
  if (!/^[0-9a-f]{7,64}$/i.test(value)) throw Error("Expected a commit SHA");
  const result = runGit(repo, ["rev-parse", "--verify", "--end-of-options", value + "^{commit}"]);
  if (result.code) throw Error("Unresolvable review commit");
  return result.stdout.trim();
}

export async function reviewCli(args: string[]) {
  const { values } = parseArgs({ args, options: { ...reviewOptions, ...targetOptions } });
  const root = findWorkbenchRoot(values.cwd);
  const ledger = new Ledger(root);
  try {
    const snap = executionSnapshot(ledger, values);
    const head = values.head === undefined ? snap.head : resolveCommit(snap.dir, values.head);
    const base = values.base === undefined ? snap.base : resolveCommit(snap.dir, values.base);
    if (!base || head !== snap.head || !snap.base || runGit(snap.dir, ["merge-base", "--is-ancestor", snap.base, base]).code)
      throw Error("Expected an attached review range ending at the current delivery HEAD");
    const config = loadModelsConfig(root);
    const spec = ledger.getSpecState(snap.task_id);
    const specPath = spec.state === "FROZEN" && (spec.files?.ssot ?? spec.files?.scope);
    const started = new Date().toISOString();
    const execution = crypto.randomUUID();
    const report = await runReview({
      ...values, repo: snap.dir, base, head, spec: specPath ? join(root, specPath) : undefined,
      specSha256: spec.hashes?.ssot ?? spec.hashes?.scope,
      models: { business: config.tiers.deep, quality: config.tiers.deep, simplify: config.tiers.standard, comments: config.tiers.mechanical },
    });
    ledger.db.transaction(() => {
      recheckExecution(ledger, snap);
      for (const result of report.roles) {
        if (!result.attempts.length) continue;
        ledger.recordEvidence({
          task_id: snap.task_id, repo: snap.repo, branch: snap.branch, sha: head, actor: "tool", source: "tool",
          kind: "review", status: result.status === "pass" ? "pass" : "fail", summary: result.summary,
          meta: {
            role: result.role, base, head, execution_id: execution, started_at: started,
            review_task_id: snap.task_id, review_floor_seq: snap.floors.review, freeze_seq: snap.freeze_seq,
            backend: result.backend, attempts: result.attempts, report_status: result.status,
            findings: result.findings, findings_count: result.findings.length, fallback_used: result.attempts.length > 1,
          },
          tool_use_id: "review-execution:" + execution + ":" + result.role,
        });
      }
    }).immediate();
    return { ...report, ok: report.status === "pass", task_id: snap.task_id, repo: snap.repo };
  } finally { ledger.closeDb(); }
}
