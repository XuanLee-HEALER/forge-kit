import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalRepoPath, efforts, loadModelsConfig, reviewRoleModel, reviewRoles } from "../config";
import { isOid, runGit } from "../git";
import { resolveTaskCheckout } from "./checkout";
import { compareReviewTrees } from "./review-range";
import { getSpecState } from "./spec";
import type { Ledger } from "./store";
import { appendEventInTx, withImmediateTx } from "./transactions";

interface ReviewOptions {
  repo?: string; branch?: string; role?: string; base?: string; head?: string;
  status?: string; report?: string; summary?: string; "session-id"?: string;
  model?: string; effort?: string;
}

function commit(dir: string, revision: string) {
  const result = runGit(dir, ["--no-replace-objects", "rev-parse", "--verify", "--end-of-options", revision + "^{commit}"]);
  if (result.code || !isOid(result.stdout.trim())) throw Error("Cannot resolve review commit: " + revision);
  return result.stdout.trim();
}

function pinnedCommit(dir: string, sha: string) {
  if (!/^[a-f0-9]{4,64}$/i.test(sha)) throw Error("Expected a pinned commit SHA: " + sha);
  const oid = commit(dir, sha);
  if (!oid.startsWith(sha.toLowerCase())) throw Error("Revision is not a commit SHA: " + sha);
  return oid;
}

function readReport(file: string) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw Error("Review report must be a regular file");
    const bytes = readFileSync(fd);
    const text = bytes.toString("utf8");
    if (!text.trim()) throw Error("Review report is empty");
    return createHash("sha256").update(bytes).digest("hex");
  } finally {
    closeSync(fd);
  }
}

export function recordReview(ledger: Ledger, task: string, options: ReviewOptions) {
  const role = reviewRoles.find(role => role === options.role);
  const { base, head, status, report, summary } = options;
  if (!role || !base || !head || !status || !["pass", "blocked", "incomplete"].includes(status) || !report || !summary?.trim())
    throw Error("Expected --role, --base, --head, --status, --report and a nonempty --summary");
  for (const [name, value] of Object.entries(options)) {
    if (!value.trim()) throw Error("Empty --" + name);
  }
  const root = ledger.workbenchRoot;
  const repo = options.repo && canonicalRepoPath(root, options.repo);
  const reportPath = resolve(report);
  const digest = readReport(reportPath);
  if (options.effort && !efforts.some(effort => effort === options.effort)) throw Error("Unknown --effort");
  const config = loadModelsConfig(root);
  const tier = reviewRoleModel(config, role);
  return withImmediateTx(ledger.db, () => {
    if (ledger.getTask(task)?.status !== "OPEN") throw Error("Review registration requires an OPEN task");
    const spec = getSpecState(ledger, task, { metadataOnly: true });
    if (spec.state !== "FROZEN") throw Error("Review registration requires a FROZEN specification");
    const rows = ledger.getTaskRepos(task).filter(row =>
      (!repo || row.repo === repo) && (!options.branch || row.branch === options.branch));
    if (rows.length !== 1) throw Error("Select one attached repository and branch with --repo and --branch");
    const attachment = rows[0];
    if (!attachment.base_sha) throw Error("Missing review baseline");
    const { dir } = resolveTaskCheckout(root, attachment);
    const start = commit(dir, attachment.base_sha);
    const from = pinnedCommit(dir, base);
    const to = pinnedCommit(dir, head);
    for (const [older, newer] of [[start, from], [from, to]]) {
      if (runGit(dir, ["--no-replace-objects", "merge-base", "--is-ancestor", older, newer]).code)
        throw Error("Review range must lie within the task baseline and attached HEAD");
    }
    const trees = compareReviewTrees(dir, from, to);
    if (trees !== "changed") throw Error(trees === "equal" ? "Review diff is empty" : "Cannot inspect review trees");
    if (commit(dir, "refs/heads/" + attachment.branch) !== to) throw Error("Review HEAD differs from attached branch HEAD");
    const session = options["session-id"] ?? null;
    return appendEventInTx(ledger.db, {
      task_id: task, repo: attachment.repo, branch: attachment.branch, sha: to,
      event_type: "EVIDENCE_CAPTURED", actor: "subagent", session_id: session,
      payload: {
        kind: "review", source: "subagent", status: status === "pass" ? "pass" : "fail", summary,
        meta: {
          role, base: from, head: to, report_status: status, report_path: reportPath, report_sha256: digest,
          session_id: session, model: options.model ?? tier.model, effort: options.effort ?? tier.effort,
          freeze_seq: spec.freeze_seq, review_task_id: task, review_floor_seq: spec.evidence_floor_seq.review,
        },
      },
    });
  });
}
