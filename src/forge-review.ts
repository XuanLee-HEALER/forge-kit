import { roles, type Role } from "../review-agents/src/roles";
import { modelPair, type Model } from "../review-agents/src/models";
import { installedInstance } from "./workflow-config";
import { checkMigration } from "./managed-assets";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { reviewOptions, reviewSelection, runReview, type PreviousReview } from "../review-agents/src/engine";
import { findWorkbenchRoot, loadModelsConfig } from "./config";
import { runGit } from "./git";
import { executionSnapshot, recheckExecution, targetOptions } from "./ledger/execution";
import { evidenceSource, reviewFactKind, usesV05 } from "./ledger/types";
import { Ledger } from "./ledger/store";

export { reviewExitCode } from "../review-agents/src/engine";

function resolveCommit(repo: string, value: string) {
  if (!/^[0-9a-f]{7,64}$/i.test(value)) throw Error("Expected a commit SHA");
  const result = runGit(repo, ["rev-parse", "--verify", "--end-of-options", value + "^{commit}"]);
  if (result.code) throw Error("Unresolvable review commit");
  return result.stdout.trim();
}

// Only the most recent applicable execution may supply proof. A newer
// incomplete or blocked run supersedes earlier coverage for this role.
function reviewHistory(ledger: Ledger, snap: ReturnType<typeof executionSnapshot>, base: string, roles: Role[]) {
  const history: Partial<Record<Role, PreviousReview>> = {};
  const pending = new Set(roles);
  for (const event of ledger.getTaskEvents(snap.task_id).reverse()) {
    if (!pending.size || event.seq < snap.floors.review) break;
    if (event.event_type !== "EVIDENCE_CAPTURED" || event.repo !== snap.repo || event.branch !== snap.branch || !event.sha) continue;
    const evidence = JSON.parse(event.payload_json);
    const meta = evidence.meta;
    if (!pending.has(meta?.role) || meta.base !== base || !reviewFactKind(evidence)) continue;
    if (runGit(snap.dir, ["merge-base","--is-ancestor",event.sha,snap.head]).code) continue;
    pending.delete(meta.role);
    if (evidenceSource(evidence,event.actor) === "tool" && meta.head === event.sha &&
        meta.freeze_seq === snap.freeze_seq && meta.review_task_id === snap.task_id && meta.review_floor_seq === snap.floors.review &&
        typeof meta.proof?.rules === "string" && typeof meta.proof.uncertain === "string" &&
        Array.isArray(meta.proof.passed) && meta.proof.passed.every((id: unknown)=>typeof id === "string")) {
      history[meta.role as Role] = {head:event.sha, proof:meta.proof};
    }
  }
  return history;
}

export async function reviewCli(args: string[]) {
  const { values } = parseArgs({ args, options: { ...reviewOptions, ...targetOptions, tier: {type:"string"} } });
  const root = findWorkbenchRoot(values.cwd);
  checkMigration(root);
  const config = loadModelsConfig(root);
  const {sequence} = reviewSelection(values, roles);
  const explicit = values.model !== undefined || values.effort !== undefined;
  if (explicit && values.tier !== undefined) throw Error("Use either --model with --effort or --tier");
  if (values.tier !== undefined && !Object.hasOwn(config.tiers, values.tier)) throw Error("Unknown --tier");
  const override = explicit ? modelPair(values.model, values.effort) : undefined;
  const models: Partial<Record<Role, Model>> = {};
  for (const role of sequence) {
    const tier = config.tiers[values.tier ?? config.review.roles[role]];
    models[role] = override ?? modelPair(tier.model, tier.effort);
  }
  const ledger = new Ledger(root);
  try {
    const snap = executionSnapshot(ledger, values);
    const head = values.head === undefined ? snap.head : resolveCommit(snap.dir, values.head);
    const base = values.base === undefined ? snap.base : resolveCommit(snap.dir, values.base);
    if (!base || head !== snap.head || !snap.base || runGit(snap.dir, ["merge-base", "--is-ancestor", snap.base, base]).code)
      throw Error("Expected an attached review range ending at the current delivery HEAD");
    const spec = ledger.getSpecState(snap.task_id);
    const specPath = spec.state === "FROZEN" && (spec.files?.ssot ?? spec.files?.scope);
    const started = new Date().toISOString();
    const execution = crypto.randomUUID();
    const modern = usesV05(ledger, snap.task_id);
    const reviewSkill = modern ? installedInstance(root)?.skills.get("review")?.value : undefined;
    const report = await runReview({
      ...values, repo: snap.dir, base, head, spec: specPath ? join(root, specPath) : undefined,
      specSha256: spec.hashes?.ssot ?? spec.hashes?.scope,
      ruleContext: reviewSkill && [reviewSkill.description, reviewSkill.body],
      taskHistory: values.full ? {} : reviewHistory(ledger,snap,base,sequence),
      models, model:undefined,
    });
    ledger.db.transaction(() => {
      recheckExecution(ledger, snap);
      for (const result of report.roles) {
        const selectedOnly = result.backend === null && result.attempts.length === 0 && !result.coverage.reused;
        ledger.recordEvidence({
          task_id: snap.task_id, repo: snap.repo, branch: snap.branch, sha: head, actor: "tool", source: "tool",
          kind: selectedOnly ? "review_selection" : "review", status: selectedOnly ? "info" : result.status === "pass" ? "pass" : "fail", summary: result.summary,
          meta: {
            role: result.role, base, head, ...(selectedOnly ? { selection_id: execution } : { execution_id: execution, started_at: started }),
            review_task_id: snap.task_id, review_floor_seq: snap.floors.review, freeze_seq: snap.freeze_seq,
            ...(result.missing_materials ? { missing_materials: result.missing_materials } : {}),
            ...(result.proof && { proof: result.proof }),
            ...(result.scheduling && { scheduling: result.scheduling }),
            backend: result.backend, attempts: result.attempts, report_status: result.status,
            limitations: result.limitations, findings: result.findings, findings_count: result.findings.length, coverage: result.coverage, model: models[result.role],
          },
          tool_use_id: (selectedOnly ? "review-selection:" : "review-execution:") + execution + ":" + result.role,
        });
      }
    }).immediate();
    return { ...report, ok: report.status === "pass", task_id: snap.task_id, repo: snap.repo };
  } finally { ledger.closeDb(); }
}
