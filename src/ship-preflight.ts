import { checkStagePin } from "./stage-observation";
import { diffScope, prospectiveMergeTree, git } from "./ship-diff";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { remoteBranch, checkPushPermission, checkDeliveryDefinition, pinCheckouts, databaseTarget, isOid, type ShipAction, type ExactPlan } from "./ledger/ship-actions";
import { runGit, runProcess, checkoutEnvironment } from "./git";
import type { Ledger } from "./ledger/store";
import { shipReceipts as receipts, preparedScope, exactRunbook, envelope, validateScope, type Envelope } from "./ledger/fast-track";
import { resolveTaskCheckout } from "./ledger/checkout";
import { inspectPr } from "./ledger/pr";
import { canonicalJson, type RunbookRecord } from "./ledger/types";

export function live(e: Envelope) {
  const forge = process.env.FORGE_SESSION_ID,
    codex = process.env.CODEX_SESSION_ID;
  if (forge && codex && forge !== codex) throw Error("Conflicting runtime session identifiers");
  const sid = forge || codex;
  if (!sid || sid !== e.approved_session_id) throw Error("Session does not match human approval");
  if (!e.expires_at || !(Date.parse(e.expires_at) >= Date.now())) throw Error("Envelope expired");
}

export type PrAction = Extract<ShipAction, { kind: "pr" }>;

function requiredChecksPending(dir: string, url: string) {
  const gh = process.env.FORGE_GH_BIN || "gh";
  const ci = runProcess([gh, "pr", "checks", url, "--required", "--json", "name,bucket"], {
    cwd: dir,
    env: checkoutEnvironment(),
  });
  if (ci.code && ci.code !== 8) throw Error("Required CI checks unavailable or failed");
  const checks = JSON.parse(ci.stdout.trim() || "[]");
  if (!Array.isArray(checks) || checks.some(c => !c.name || !["pass","pending"].includes(c.bucket)))
    throw Error("Required CI checks missing or failing");
  const pendingCi = ci.code === 8 || checks.some(c => c.bucket === "pending");
  if (!pendingCi && !checks.length) throw Error("Required CI checks missing");
  return pendingCi;
}

export function checkedPr(dir: string, branch: string, a: PrAction) {
  if (!isOid(a.tree)) throw Error("Runbook lacks the approved merge tree; register and approve a new runbook");
  const gh = process.env.FORGE_GH_BIN || "gh";
  const pr = inspectPr(dir, branch, String(a.number), process.env, undefined, {
    bin: gh,
    baseOid: true,
    mergeability: true,
  });
  if (pr.url !== a.url || pr.headRefOid !== a.head || pr.baseRefName !== a.base)
    throw Error("PR destination or version drifted");
  const pendingCi = requiredChecksPending(dir, a.url);
  const url = new URL(a.url),
    repo = url.pathname.split("/").slice(1, 3).join("/");
  const api = (path: string, jq: string) =>
    runProcess([gh, "api", "--hostname", url.host, "repos/" + repo + "/" + path, "--jq", jq], {
      cwd: dir,
      env: checkoutEnvironment(),
    });
  const target = api("git/ref/heads/" + encodeURIComponent(a.base), ".object.sha");
  if (target.code || !isOid(target.stdout.trim())) throw Error("Cannot verify live PR target ref");
  if (pr.state === "OPEN") {
    if (
      target.stdout.trim() !== a.baseOid ||
      pr.baseRefOid !== a.baseOid ||
      pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY"
    )
      throw Error("PR base drift or mergeability failure");
    if (pendingCi) throw new AwaitingOperator("Required CI pending on " + a.url + "; rerun after the checks complete");
    if (pr.mergeable === "UNKNOWN" || pr.mergeStateStatus === "UNKNOWN")
      throw new AwaitingOperator("Mergeability is still being computed for " + a.url + "; rerun to observe it");
    if (pr.mergeable !== "MERGEABLE" || pr.mergeStateStatus !== "CLEAN") throw Error("PR is blocked by target policy");
    return { merged: false as const };
  }
  const oid = pr.mergeCommit?.oid;
  if (!isOid(oid) || !isOid(pr.baseRefOid)) throw Error("Missing remote merge receipt");
  if (target.stdout.trim() !== oid) {
    const comparison = api("compare/" + oid + "..." + target.stdout.trim(), ".status");
    if (comparison.code || comparison.stdout.trim() !== "ahead") throw Error("Target does not contain the approved merge");
  }
  if (oid === a.head) {
    if (git(dir, ["rev-parse", a.head + "^{tree}"]).trim() !== a.tree) throw Error("Fast-forward tree differs from approved merge tree");
    if (runGit(dir, ["merge-base", "--is-ancestor", a.baseOid, a.head]).code)
      throw Error("Fast-forward did not include approved base");
  } else {
    const commit = api("git/commits/" + oid, '[.tree.sha, .parents[].sha] | join(" ")');
    if (commit.code || commit.stdout.trim() !== [a.tree, a.baseOid, a.head].join(" "))
      throw Error("Remote merge tree or parents differ from approved result");
  }
  if (pendingCi) throw new AwaitingOperator("Awaiting final required checks on merged PR " + a.url);
  return { merged: true as const, oid: String(oid), targetOid: target.stdout.trim() };
}

export function checkEnvelopeApproval(ledger: Ledger, e: Envelope) {
  if (e.status !== "ACTIVE") throw Error("Envelope is " + e.status);
  live(e);
  const approval = ledger
    .getTaskEvents(e.task_id)
    .findLast(
      (ev) =>
        ev.event_type === "FAST_TRACK_APPROVED" && JSON.parse(ev.payload_json).envelope_id === e.envelope_id,
    );
  if (
    !approval ||
    approval.session_id !== e.approved_session_id ||
    JSON.parse(approval.payload_json).scope_hash !== e.scope_hash ||
    JSON.parse(approval.payload_json).expires_at !== e.expires_at
  )
    throw Error("Invalid ledger approval binding");
  return validateScope(ledger, e);
}

export function approvedCheckouts(ledger: Ledger, e: Envelope, plan?: ExactPlan) {
  const policy = checkEnvelopeApproval(ledger, e);
  const paths: string[] = JSON.parse(e.allowed_path_globs_json);
  const repos: string[] = JSON.parse(e.allowed_repos_json);
  const pins = pinCheckouts(ledger, e.task_id);
  const files = new Set<string>();
  let lines = 0;
  const checkouts = ledger.getTaskRepos(e.task_id).map(row => ({
    row,
    pin: pins.find(p => p.repo === row.repo && p.branch === row.branch)!,
    dir: resolveTaskCheckout(ledger.workbenchRoot, row).dir,
  }));
  // Check every local review gate before observing even the first remote repository.
  for (const {row, pin, dir} of checkouts) {
    const mergeIndex = plan?.actions.findIndex(a => a.kind === "pr" && a.repo === row.repo) ?? -1;
    const hostedCi = plan?.ci.some(a => a.repo === row.repo) &&
      (mergeIndex < 0 || !plan.actions.slice(0, mergeIndex).some(a => a.kind !== "pr"));
    const check = ledger.checkPushReadiness({
      task_id: e.task_id, repo: row.repo, branch: row.branch, checkoutDir: dir, head_sha: pin.head,
      requireDeploymentCi: !!plan && policy.require_ci_green_for_prod && e.target_endpoint === "prod" && !hostedCi,
    });
    if (!check.ready) throw Error(check.missing.join(", "));
  }
  for (const {row, pin, dir} of checkouts) {
    if (
      git(dir, ["status", "--porcelain", "-z", "--untracked-files=all"]) ||
      runGit(dir, ["merge-base", "--is-ancestor", row.base_sha!, pin.head]).code
    )
      throw Error("Expected clean approved version in " + row.repo);
    if (!repos.includes(row.repo)) throw Error("Repository outside approval");
    lines += diffScope(dir, row, pin.head, true, paths, policy, files);
    if (lines > policy.max_lines_changed || files.size > policy.max_files_changed)
      throw Error("Diff exceeds policy limits");
  }
  return {checkouts, pins};
}

export function checkRunbookApproval(rb: RunbookRecord, e: Envelope) {
  if (rb.status !== "APPROVED" || rb.approved_session_id !== e.approved_session_id ||
      !rb.expires_at || Date.parse(rb.expires_at) <= Date.now()) throw Error("Runbook approval expired, revoked or changed");
}

export function preflight(ledger: Ledger, e: Envelope, candidate?: ExactPlan) {
  const exact = candidate ? undefined : exactRunbook(ledger, e);
  const plan = candidate ?? exact!.plan;
  const rb = exact?.rb;
  const {checkouts, pins} = approvedCheckouts(ledger, e, plan);
  if (rb) checkRunbookApproval(rb, e);
  if (canonicalJson(pins) !== canonicalJson(plan.pins)) throw Error("Approved commit or remote changed");
  checkDeliveryDefinition(ledger.workbenchRoot, plan);
  for (const a of plan.actions) {
    if (a.kind === "stage") checkStagePin(ledger.workbenchRoot, a);
    if (
      a.kind === "sql" &&
      (validateScope(ledger, e).forbid_db_rw ||
        createHash("sha256").update(readFileSync(a.path)).digest("hex") !== a.sha256 ||
        canonicalJson(databaseTarget(ledger.workbenchRoot, a.target.host)) !== canonicalJson(a.target))
    )
      throw Error("SQL target or content changed, or writes forbidden");
  }
  const dirs = new Map(checkouts.map(({row, dir}) => [row.repo, dir]));
  const verifiedMerges = new Map<string, {oid: string; targetOid: string}>();
  const confirmed = new Set(receipts(ledger, e.envelope_id).filter(r => r.status === "confirmed").map(r => r.action_index));
  let next = plan.actions.findIndex((_, i) => !confirmed.has(i));
  if (next < 0) next = plan.actions.length;
  // Verify previously reached merge nodes and the entire next contiguous PR group before its handoff.
  let limit = next;
  while (plan.actions[limit]?.kind === "pr") limit++;
  const reached = plan.actions.slice(0, limit);
  const waiting: string[] = [];
  const manual: string[] = [];
  for (const {row, pin, dir} of checkouts) {
    if (plan.endpoint === "push") {
      const index = plan.actions.findIndex(a => a.kind === "push" && a.repo === row.repo);
      const action = plan.actions[index];
      if (action?.kind !== "push" || action.head !== pin.head || action.originHash !== pin.originHash ||
          !action.ref.startsWith("refs/heads/") || plan.actions.some(a => a.kind !== "push") ||
          runGit(dir, ["merge-base", "--is-ancestor", action.baseOid, action.head]).code)
        throw Error("Invalid fast-forward binding");
      if (!plan.nodeAuthorization) checkPushPermission(ledger.workbenchRoot, action.ref.slice("refs/heads/".length));
      const target = remoteBranch(dir, action.ref);
      const receipt = receipts(ledger, e.envelope_id).find(r => r.action_index === index);
      if (receipt?.status === "confirmed" && target !== action.head) throw Error("Confirmed remote branch no longer points to the approved head: " + action.ref);
      if (target !== action.baseOid && !(receipt && target === action.head)) throw Error("Remote branch drifted: " + action.ref + " is " + target + ", expected " + action.baseOid);
      continue;
    }
    const pr = plan.actions.find((a): a is PrAction => a.kind === "pr" && a.repo === row.repo);
    if (!pr) {
      // Older exact plans can carry a PR solely as their CI source.
      for (const ci of plan.ci.filter(a => a.repo === row.repo)) {
        const current = inspectPr(dir, row.branch, String(ci.number), process.env, undefined, {bin:process.env.FORGE_GH_BIN});
        if (ci.head !== pin.head || current.url !== ci.url || current.headRefOid !== pin.head || current.baseRefName !== ci.base)
          throw Error("Approved CI target or version drifted");
        if (requiredChecksPending(dir, ci.url)) waiting.push("Required CI pending on " + ci.url);
      }
      continue;
    }
    if (!reached.includes(pr)) continue;
    if (prospectiveMergeTree(dir, pr.baseOid, pin.head) !== pr.tree)
      throw Error("Prospective merge tree differs from the approved tree");
    try {
      const observation = checkedPr(dir, row.branch, pr);
      if (observation.merged) verifiedMerges.set(row.repo, observation);
      else if (!plan.nodeAuthorization || !preparedScope(ledger, e).anchor.node_authorization) manual.push(pr.url + " (base " + pr.baseOid + ", head " + pr.head + ")");
    } catch (err) {
      if (!(err instanceof AwaitingOperator)) throw err;
      waiting.push(err.message);
    }
  }
  if (waiting.length) throw new AwaitingOperator(waiting.join("\n"));
  if (manual.length) {
    const run = "forge ship run --envelope " + e.envelope_id;
    if (candidate)
      throw new AwaitingOperator("Preview only. First run " + run + " to pin the open PRs. " +
        "Wait for that run's 'Manual merge required' handoff before merging " + manual.join(", ") + ".");
    throw new AwaitingOperator("Manual merge required for " + manual.join(", ") +
      ": the host cannot bind the base on merge. After the operator merges, rerun " + run + " to verify the remote receipts.");
  }
  return { plan, dirs, verifiedMerges };
}

export class AwaitingOperator extends Error {}

export function checkAuthorization(ledger: Ledger, id: string) {
  const current = envelope(ledger, id);
  checkEnvelopeApproval(ledger, current);
  const {rb} = exactRunbook(ledger, current);
  checkRunbookApproval(rb, current);
  if (ledger.getTaskBlockers(current.task_id).some((blocker) => blocker.status === "OPEN"))
    throw Error("Task has an open blocker");
}
