import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalRepoPath, loadModelsConfig } from "../config";
import { checkoutEnvironment, runGit, runProcess } from "../git";
import { inspectPr, verifiedPr } from "./pr";
import { prRemoteRefs, reachableFromRefs, resolveTaskCheckout } from "./checkout";
import { coversReviewBase } from "./review-range";
import { getSpecState } from "./spec";
import type { Ledger } from "./store";

function attached(ledger: Ledger, task: string, repo: string, branch?: string) {
  const rows = ledger.getTaskRepos(task).filter(r => r.repo === canonicalRepoPath(ledger.workbenchRoot,repo) && (!branch || r.branch === branch));
  if (ledger.getTask(task)?.status !== "OPEN" || rows.length !== 1)
    throw new Error("Expected one open task attachment; specify --branch for multiple branches");
  return rows[0];
}

function commit(dir: string, ref: string) {
  const r = runGit(dir, ["rev-parse", "--verify", "--end-of-options", ref + "^{commit}"]);
  if (r.code) throw new Error("Cannot resolve commit " + ref);
  return r.stdout.trim();
}

export function reviewNative(ledger: Ledger, task: string, repo: string, baseRef: string, branch?: string) {
  const attachment = attached(ledger, task, repo, branch);
  const { dir } = resolveTaskCheckout(ledger.workbenchRoot, attachment);
  function current() {
    if (runGit(dir, ["symbolic-ref", "--quiet", "HEAD"]).stdout.trim() !== "refs/heads/" + attachment.branch)
      throw new Error("Review checkout is not on the attached branch");
    return commit(dir, "HEAD");
  }
  const floor = () => getSpecState(ledger, task, { metadataOnly: true }).evidence_floor_seq.review;
  const head = current();
  const base = commit(dir, baseRef);
  if (!coversReviewBase(ledger.workbenchRoot, attachment, base)) throw new Error("Review base does not cover the attached task base");
  if (runGit(dir, ["merge-base", "--is-ancestor", base, head]).code !== 0)
    throw new Error("Native review requires the attached base to be an ancestor of HEAD; restore the branch history or review the exact tree diff with a role reviewer.");
  const review_floor_seq = floor();
  const started_at = new Date().toISOString();
  const spec = getSpecState(ledger, task, { metadataOnly: true });
  const context = [join(ledger.workbenchRoot, "AGENTS.md"), join(ledger.workbenchRoot, "AGENTS.local.md"),
    join(ledger.workbenchRoot, ".workbench/repos", repo + ".md"), ...(spec.spec_dir ? [join(ledger.workbenchRoot, spec.spec_dir)] : [])]
    .filter(path => existsSync(path));
  const model = loadModelsConfig(ledger.workbenchRoot).tiers.standard;
  const tmp = mkdtempSync(join(tmpdir(), "forge-native-review-"));
  try {
    // Review the captured objects even if the original checkout changes and later returns to this SHA.
    const snapshot = join(tmp, "checkout");
    const clone = runGit(dir, ["clone", "--local", "--shared", "--no-checkout", "--", dir, snapshot]);
    if (clone.code || runGit(snapshot, ["-c", "core.hooksPath=/dev/null", "checkout", "--detach", head]).code)
      throw new Error("Cannot prepare review checkout at " + head);
    const schema = join(tmp, "schema.json"), output = join(tmp, "verdict.json");
    writeFileSync(schema, JSON.stringify({ type: "object", additionalProperties: false, required: ["passed", "report"],
      properties: { passed: { type: "boolean" }, report: { type: "string" } } }));
    const result = Bun.spawnSync(["codex", "-s", "read-only", "exec", "review", "--ephemeral", "--base", base,
      "-m", model.model, "-c", "model_reasoning_effort=" + JSON.stringify(model.effort),
      "-c", "project_doc_max_bytes=0", "-c", "developer_instructions=" + JSON.stringify(
        "Review the pinned diff for task " + JSON.stringify(ledger.getTask(task)?.title) +
        ". Available workbench rules and specification paths: " + JSON.stringify(context) +
        ". Use supplied context where applicable. Return only a JSON object with exactly two fields: passed (boolean, false for blocking findings or incomplete review) and report (nonempty string with findings and limitations)."),
      "--output-schema", schema, "-o", output], { env: checkoutEnvironment(), cwd: snapshot, stdin: "ignore", stdout: "ignore", stderr: "inherit" });
    let passed = false, summary = "Native review did not produce a passing verdict";
    if (result.exitCode === 0) {
      try {
        const report = JSON.parse(readFileSync(output, "utf8"));
        if (typeof report.passed === "boolean" && typeof report.report === "string" && report.report.trim()) {
          passed = report.passed;
          summary = report.report;
        } else if (Array.isArray(report.findings) && typeof report.overall_explanation === "string") {
          passed = report.overall_correctness === "patch is correct" && report.findings.length === 0;
          summary = JSON.stringify(report);
        }
      } catch {
        summary = "Native review returned an unreadable or incomplete verdict";
      }
    }
    return ledger.db.transaction(() => {
    const live = attached(ledger, task, repo, attachment.branch);
      if (resolveTaskCheckout(ledger.workbenchRoot, live).dir !== dir || current() !== head || floor() !== review_floor_seq || live.base_sha !== attachment.base_sha)
        throw new Error("HEAD, attachment or review floor changed during review");
      return ledger.recordEvidence({ task_id: task, repo, branch: attachment.branch, sha: head, kind: "review",
        status: passed ? "pass" : "fail", source: "tool", actor: "tool", summary,
        meta: { role: "codex-review", head, base, started_at, review_floor_seq, review_task_id: task } });
    }).immediate();
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

export function syncPr(ledger: Ledger, task: string, repo: string, pr?: string, branch?: string, beforeRecord?:()=>void) {
  const attachment = attached(ledger, task, repo, branch);
  const { dir } = resolveTaskCheckout(ledger.workbenchRoot, attachment);
  const branchRef = "refs/heads/" + attachment.branch;
  function currentHead(row: typeof attachment) {
    const exists = runGit(dir, ["show-ref", "--verify", "--quiet", branchRef]);
    if (exists.code === 0) return commit(dir, branchRef);
    if (exists.code !== 1 || !pr || !row.head_sha || !reachableFromRefs(dir, row.head_sha, prRemoteRefs(dir, attachment.branch)))
      throw new Error("After branch cleanup, supply --pr and a recorded head reachable from the origin feature or default branch");
    return row.head_sha;
  }
  const head = currentHead(attachment);
  const data = verifiedPr(dir, attachment.branch, head, pr);
  return ledger.db.transaction(() => {
    beforeRecord?.();
    const live = attached(ledger, task, repo, attachment.branch);
    if (resolveTaskCheckout(ledger.workbenchRoot, live).dir !== dir || currentHead(live) !== head) throw new Error("Branch advanced while verifying PR");
    ledger.db.query("UPDATE task_repos SET head_sha = ? WHERE task_id = ? AND canonical_repo(repo) = canonical_repo(?) AND branch = ?")
      .run(head, task, repo, attachment.branch);
    return ledger.recordEvidence({ task_id: task, repo, branch: attachment.branch, sha: head, kind: "pr",
      source: "tool", actor: "tool", status: "pass", summary: data.url, meta: { state: data.state, pr_url: data.url, pr_head_oid: data.headRefOid } });
  }).immediate();
}

export function matchesReleasePr(dir: string, pin: { url:string; head:string; branch:string; base:string; base_oid?:string;merged_oid?:string }) {
  try {
    const pr = inspectPr(dir, pin.branch, pin.url, process.env, 2500, {baseOid:!!pin.base_oid});
    return !pin.merged_oid && pr.state === "OPEN" && pr.headRefOid === pin.head && pr.baseRefName === pin.base && (!pin.base_oid || pr.baseRefOid===pin.base_oid);
  } catch { return false; }
}
