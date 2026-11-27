import { coversReviewBase, reviewMeetsFloor } from "./review-range";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadModelsConfig } from "../config";
import { isOid, checkoutEnvironment, runGit } from "../git";
import { getSpecState } from "./spec";
import { resolveTaskCheckout } from "./checkout";
import { evidenceSource, reviewFactKind } from "./types";
import type { Ledger } from "./store";

function reviewAgentDirectories(root: string) {
  return process.env.FORGE_REVIEW_AGENTS_DIR ? [resolve(process.env.FORGE_REVIEW_AGENTS_DIR)] :
    [join(root,"review-agents"),join(root,".workbench/review-agents")];
}

export function runReviewFallback(ledger: Ledger, task: string, repo: string, role: string, head: string) {
  if (!["quality", "simplify", "comments"].includes(role) || !isOid(head))
    throw new Error("Expected a review role and a full pinned commit SHA");
  if (ledger.getTask(task)?.status !== "OPEN") throw new Error("Expected an open task");
  const spec = () => getSpecState(ledger, task, { metadataOnly: true });
  const launch = spec();
  const initialFloor = launch.evidence_floor_seq.review;
  function latestReview() {
    const events = ledger.getTaskEvents(task);
    const floorTime = events.find(e => e.seq === initialFloor)?.ts;
    for (const event of events.reverse()) {
      if (event.seq < initialFloor) break;
      if (event.event_type !== "EVIDENCE_CAPTURED" || event.repo !== repo || event.sha !== head) continue;
      const p = JSON.parse(event.payload_json);
      if (!reviewMeetsFloor(p.status, p.meta, task, initialFloor, floorTime, evidenceSource(p, event.actor))) continue;
      if (reviewFactKind(p) === "review" && p.meta?.role === role && evidenceSource(p, event.actor) !== "manual") return { event, p };
    }
  }
  const failure = latestReview();
  const meta = failure?.p.meta;
  if (!failure || failure.p.status !== "fail" || meta.exit_code !== 2 || meta.report_status !== "error" ||
      meta.error_code !== "credit_balance_exhausted" || !isOid(meta.base))
    throw new Error("No eligible credit_balance_exhausted failure for this role and revision");
  const attachments = ledger.getTaskRepos(task).filter(r => r.repo === repo && (!failure.event.branch || r.branch === failure.event.branch));
  if (attachments.length !== 1) throw new Error("Cannot identify fallback review attachment");
  const attachment = attachments[0];
  const { dir } = resolveTaskCheckout(ledger.workbenchRoot, attachment);
  if (!coversReviewBase(ledger.workbenchRoot, attachment, meta.base)) throw new Error("Review base does not cover attached task base");
  for (const sha of [meta.base, head]) {
    if (runGit(dir, ["cat-file", "-t", sha]).stdout.trim() !== "commit") throw new Error("Unavailable review commit " + sha);
  }
  const startedAt = new Date().toISOString();
  const model = loadModelsConfig(ledger.workbenchRoot).tiers.standard;
  const agents = reviewAgentDirectories(ledger.workbenchRoot).find(path => existsSync(join(path,"prompts",role+".md")));
  if (!agents) throw Error("Missing review-agent prompt for " + role);
  const report = readOnlyRoleReview(agents, dir, role, meta.base, head, model);
  return ledger.db.transaction(() => {
      const current = spec();
      if (current.freeze_seq !== launch.freeze_seq || current.evidence_floor_seq.review !== initialFloor || latestReview()?.event.seq !== failure.event.seq) throw new Error("Review evidence changed during fallback");
      return ledger.recordEvidence({ task_id: task, repo, branch: attachment.branch, sha: head, actor: "tool", source: "tool", kind: "review",
        status: report.passed ? "fallback" : "fail", summary: report.report, meta: { role, base: meta.base, head,
          original_failure: failure.event.seq, review_task_id: task, review_floor_seq: initialFloor, started_at: startedAt, model: model.model, effort: model.effort } });
    }).immediate();
}

function readOnlyRoleReview(agentsDir: string, dir: string, role: string, base: string, head: string,
  model: {model: string; effort: string}): {passed: boolean; report: string} {
  const instructions = readFileSync(join(agentsDir, "prompts", role + ".md"), "utf8");
  const tmp = mkdtempSync(join(tmpdir(), "forge-review-"));
  try {
    const schema = join(tmp, "schema.json");
    const output = join(tmp, "report.json");
    writeFileSync(schema, JSON.stringify({ type: "object", additionalProperties: false, required: ["passed", "report"],
      properties: { passed: { type: "boolean" }, report: { type: "string" } } }));
    const prompt = instructions + "\nReview the committed diff " + base + ".." + head +
      ". Set passed=false for blocking findings or incomplete review. Include findings and limitations in report.";
    const executable = process.env.FORGE_CODEX_BIN || "codex";
    const child = Bun.spawnSync([executable.includes("/") ? resolve(executable) : executable, "exec", "--ephemeral", "-s", "read-only", "-C", dir, "-m", model.model,
      "-c", "project_doc_max_bytes=0", "-c", "model_reasoning_effort=" + JSON.stringify(model.effort), "--output-schema", schema, "-o", output, prompt],
      { cwd: dir, env: checkoutEnvironment(), stdin: "ignore", stdout: "ignore", stderr: "inherit" });
    if (child.exitCode !== 0) throw new Error("Read-only Codex review failed");
    const report = JSON.parse(readFileSync(output, "utf8"));
    if (typeof report.passed !== "boolean" || typeof report.report !== "string" || !report.report.trim())
      throw new Error("Incomplete read-only review report");
    return report;
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
