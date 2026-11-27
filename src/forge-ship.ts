import { checkStagePin, observeStage, stageEnvironment } from "./stage-observation";
import { pushFastForward } from "./conditional-merge";
import { diffScope, prospectiveMergeTree, git } from "./ship-diff";
import { repoOrigin } from "./shared/gh-remote";
import { resolveInstance } from "./instance";
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import {
  remoteBranch,
  checkPushPermission,
  checkDeliveryDefinition,
  pinCheckouts,
  databaseTarget,
  isOid,
  type ShipAction,
  type ExactPlan,
} from "./ledger/ship-actions";
import { loadDbEnvironments, findWorkbenchRoot } from "./config";
import { runGit, runProcess, checkoutEnvironment } from "./git";
import { Ledger } from "./ledger/store";
import {
  shipReceipts as receipts,
  preparedScope,
  exactBinding,
  exactRunbook,
  envelope,
  validateScope,
  trackEvent,
  type Envelope,
} from "./ledger/fast-track";
import { resolveTaskCheckout } from "./ledger/checkout";
import { inspectPr } from "./ledger/pr";

import { sha256String, canonicalJson, nowIso, type TaskRepoRecord } from "./ledger/types";
import { withImmediateTx } from "./ledger/transactions";

function live(e: Envelope) {
  const forge = process.env.FORGE_SESSION_ID,
    codex = process.env.CODEX_SESSION_ID;
  if (forge && codex && forge !== codex) throw Error("Conflicting runtime session identifiers");
  const sid = forge || codex;
  if (!sid || sid !== e.approved_session_id) throw Error("Session does not match human approval");
  if (!e.expires_at || !(Date.parse(e.expires_at) >= Date.now())) throw Error("Envelope expired");
}
function checkEvidence(ledger: Ledger, e: Envelope, row: TaskRepoRecord, dir: string, head: string, requireFrozenToolReview: boolean) {
  const check = ledger.checkPushReadiness({
    task_id: e.task_id,
    repo: row.repo,
    branch: row.branch,
    checkoutDir: dir,
    head_sha: head,
    requireFrozenToolReview,
  });
  if (!check.ready) throw Error(check.missing.join(", "));
}
type PrAction = Extract<ShipAction, { kind: "pr" }>;
function checkedPr(dir: string, branch: string, a: PrAction) {
  if (!isOid(a.tree)) throw Error("Runbook lacks the approved merge tree; register and approve a new runbook");
  const gh = process.env.FORGE_GH_BIN || "gh";
  const pr = inspectPr(dir, branch, String(a.number), process.env, undefined, {
    bin: gh,
    baseOid: true,
    mergeability: true,
  });
  if (pr.url !== a.url || pr.headRefOid !== a.head || pr.baseRefName !== a.base)
    throw Error("PR destination or version drifted");
  const ci = runProcess([gh, "pr", "checks", a.url, "--required", "--json", "name,bucket"], {
    cwd: dir,
    env: checkoutEnvironment(),
  });
  if (ci.code && ci.code !== 8) throw Error("Required CI checks unavailable or failed");
  const checks = JSON.parse(ci.stdout.trim() || "[]");
  if (!Array.isArray(checks) || checks.some(c => !c.name || !["pass","pending"].includes(c.bucket)))
    throw Error("Required CI checks missing or failing");
  const pendingCi = ci.code === 8 || checks.some(c => c.bucket === "pending");
  if (!pendingCi && !checks.length) throw Error("Required CI checks missing");
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
    return { merged: false, oid: pr.baseRefOid as string };
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
  return { merged: true, oid: String(oid) };
}
function checkEnvelopeApproval(ledger: Ledger, e: Envelope) {
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
function approvedCheckouts(ledger: Ledger, e: Envelope) {
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
  const reviewRequired = policy.require_independent_review || e.target_endpoint === "pr" ||
    ledger.getTask(e.task_id)?.verification_depth === "full";
  // Check every local review gate before observing even the first remote repository.
  for (const {row, pin, dir} of checkouts) {
    checkEvidence(ledger, e, row, dir, pin.head, reviewRequired);
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
function preflight(ledger: Ledger, e: Envelope) {
  const {rb, plan} = exactRunbook(ledger, e);
  const {checkouts, pins} = approvedCheckouts(ledger, e);
  if (rb.status !== "APPROVED" || rb.approved_session_id !== e.approved_session_id ||
      !rb.expires_at || Date.parse(rb.expires_at) <= Date.now()) throw Error("Runbook approval expired, revoked or changed");
  if (canonicalJson(pins) !== canonicalJson(plan.pins)) throw Error("Approved commit or remote changed");
  checkDeliveryDefinition(ledger.workbenchRoot, plan);
  const dirs = new Map(checkouts.map(({row, dir}) => [row.repo, dir]));
  for (const {row, pin, dir} of checkouts) {
    if (plan.endpoint === "push") {
      const index = plan.actions.findIndex(a => a.kind === "push" && a.repo === row.repo);
      const action = plan.actions[index];
      if (action?.kind !== "push" || action.head !== pin.head || action.originHash !== pin.originHash ||
          !action.ref.startsWith("refs/heads/") || plan.actions.some(a => a.kind !== "push") ||
          runGit(dir, ["merge-base", "--is-ancestor", action.baseOid, action.head]).code)
        throw Error("Invalid fast-forward binding");
      checkPushPermission(ledger.workbenchRoot, action.ref.slice("refs/heads/".length));
      const target = remoteBranch(dir, action.ref);
      const claimed = receipts(ledger, e.envelope_id).some(r => r.action_index === index);
      if (target !== action.baseOid && !(claimed && target === action.head)) throw Error("Remote branch drifted");
      continue;
    }
    const merges = plan.ci.filter((a) => a.repo === row.repo);
    if (merges.length !== 1)
      throw Error("Expected one exact CI target per attached branch; recreate the runbook");
    const pr = merges[0];
    const observation = checkedPr(dir, row.branch, pr);
    if (prospectiveMergeTree(dir, pr.baseOid, pin.head) !== pr.tree)
      throw Error("Prospective merge tree differs from the approved tree");
    const hasMergeAction = plan.actions.some(a => (a.kind === "pr" && a.repo === row.repo) ||
      (a.kind === "stage" && a.stage === "ship"));
    if (!observation.merged && hasMergeAction)
      throw new AwaitingOperator("Manual merge required for " + pr.url +
        ": the host cannot bind base " + pr.baseOid + " when merging head " + pr.head +
        ". After the operator merges, rerun forge ship run to verify the remote receipt.");
  }
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
  return { plan, dirs };
}
class AwaitingOperator extends Error {}
function resolveFrontPlan(ledger: Ledger, e: Envelope) {
  const {anchor} = preparedScope(ledger, e);
  if (anchor.mode !== "frozen-scope-v1") return;
  const bound = ledger.db.query("SELECT runbook_id FROM exact_ship_envelopes WHERE envelope_id=?").get(e.envelope_id);
  if (bound) return;
  const {checkouts, pins} = approvedCheckouts(ledger, e);
  const cfg = resolveInstance(ledger.workbenchRoot);
  const stages = cfg.delivery.value.stages.filter(id => cfg.stages.get(id)?.source !== "core");
  const prs: {repo: string; number: number}[] = [];
  const targetBases = new Map<string,string>();
  if (cfg.delivery.value.stages.includes("ship") || cfg.delivery.value.endpoint === "pr") {
    for (const {dir, row, pin} of checkouts) {
      const origin = repoOrigin(dir);
      if (!origin || row.branch === "main" || row.branch.startsWith("-")) throw Error("Expected a feature branch in the approved repository");
      const slug = [origin.host, origin.owner, origin.repo].join("/");
      const gh = (args: string[]) => {
        const r = runProcess([process.env.FORGE_GH_BIN || "gh", ...args], {cwd: dir, env: checkoutEnvironment()});
        if (r.code) throw Error("Cannot confirm PR " + args[1] + " outcome: " + r.stderr.trim());
        return r.stdout;
      };
      const list = JSON.parse(gh(["pr","list","--repo",slug,"--state","open","--head",row.branch,"--limit","2","--json","number,baseRefName"]));
      if (!Array.isArray(list) || list.length > 1 || list.some(p => p.baseRefName !== "main" || !Number.isSafeInteger(p.number) || p.number < 1))
        throw Error("Ambiguous or unexpected task PR");
      const ref = "refs/heads/" + row.branch;
      const remote = git(dir, ["ls-remote","--refs","origin",ref]).trim();
      const base = gh(["api","--hostname",origin.host,"repos/" + origin.owner + "/" + origin.repo + "/git/ref/heads/main","--jq",".object.sha"]).trim();
      if (!isOid(base)) throw Error("Cannot identify the target main OID before PR registration");
      targetBases.set(row.repo,base);
      const selector = list.length ? String(list[0].number) : undefined;
      if (remote !== pin.head + "\t" + ref || !selector) {
        const destination = slug + " " + row.branch + "@" + pin.head + " -> main@" + base;
        throw new AwaitingOperator("Manual PR handoff before publication: " + destination +
          ". A CLI head match or configured program cannot establish a merge-time base condition. Publish the branch and create the PR in the ordinary delivery flow, then rerun to pin the open PR before merging.");
      }
      const pr = inspectPr(dir,row.branch,selector,process.env,undefined,{bin:process.env.FORGE_GH_BIN,baseOid:true});
      if (pr.state !== "OPEN" || pr.headRefOid !== pin.head || pr.baseRefName !== "main" || pr.baseRefOid !== base)
        throw Error("Task PR differs from the authorized version or target");
      prs.push({repo:row.repo, number:Number(pr.url.split("/").pop())});
    }
  }
  withImmediateTx(ledger.db, () => {
    checkEnvelopeApproval(ledger, envelope(ledger, e.envelope_id));
    if (ledger.db.query("SELECT 1 FROM exact_ship_envelopes WHERE envelope_id=?").get(e.envelope_id)) return;
    const rb = ledger.createRunbook({task_id:e.task_id, title:"Realize frozen scope " + e.envelope_id, exact_stages:stages, actions:{prs}});
    const plan: ExactPlan = JSON.parse(rb.actions_json).exact;
    if (canonicalJson(plan.pins) !== canonicalJson(pins) || plan.ci.some(pr => targetBases.has(pr.repo) && targetBases.get(pr.repo) !== pr.baseOid))
      throw Error("Task or target version changed during plan registration");
    ledger.db.query("UPDATE runbooks SET status='APPROVED',approved_session_id=?,approved_at=?,expires_at=? WHERE runbook_id=?")
      .run(e.approved_session_id,e.approved_at,e.expires_at,rb.runbook_id);
    ledger.db.query("INSERT INTO exact_ship_envelopes(envelope_id,runbook_id,actions_hash,endpoint) VALUES(?,?,?,?)")
      .run(e.envelope_id,rb.runbook_id,rb.actions_hash,plan.endpoint);
    trackEvent(ledger,e,"SHIP_PLAN_BOUND",{runbook_id:rb.runbook_id,actions_hash:rb.actions_hash,endpoint:plan.endpoint});
  });
}
function observed(ledger: Ledger, e: Envelope, a: ShipAction, dirs: Map<string, string>): string | null {
  if (a.kind === "push") {
    const target = remoteBranch(dirs.get(a.repo)!, a.ref);
    if (target === a.head) return target;
    if (target !== a.baseOid) throw Error("Remote branch drifted");
    return null;
  }
  if (a.kind === "pr") {
    const row = ledger.getTaskRepos(e.task_id).find((r) => r.repo === a.repo)!;
    const pr = checkedPr(dirs.get(a.repo)!, row.branch, a);
    return pr.merged ? pr.oid : null;
  }
  if (a.kind === "tag") {
    const dir = dirs.get(a.repo)!;
    const out = git(dir, ["ls-remote", "--refs", "origin", "refs/tags/" + a.tag]).trim();
    if (!out) return null;
    if (out !== a.head + "\trefs/tags/" + a.tag) throw Error("Tag destination changed");
    return a.head;
  }
  return null;
}
function checkAuthorization(ledger: Ledger, id: string) {
  const current = envelope(ledger, id);
  checkEnvelopeApproval(ledger, current);
  const {rb} = exactRunbook(ledger, current);
  if (rb.status !== "APPROVED" || rb.approved_session_id !== current.approved_session_id ||
      !rb.expires_at || Date.parse(rb.expires_at) <= Date.now()) throw Error("Runbook approval changed");
  if (ledger.getTaskBlockers(current.task_id).some((blocker) => blocker.status === "OPEN"))
    throw Error("Task has an open blocker");
}
class WaitingForTarget extends Error {
  constructor(readonly index: number, envelopeId: string) {
    super("Awaiting target confirmation. Retry forge ship run --envelope " + envelopeId + " to observe the same delivery.");
  }
}
function reconcileStage(
  ledger: Ledger,
  e: Envelope,
  a: Extract<ShipAction, { kind: "stage" }>,
  plan: ExactPlan,
  index: number,
): string {
  const versions = plan.pins.map(({ repo, head }) => ({ repo, head }));
  const actionId = e.envelope_id + "/" + index;
  const absentAfterIntent = "Target reports action " + actionId + " absent after submission intent. Inspect the submitter and target before manual recovery.";
  function observe() {
    const fact = observeStage(ledger.workbenchRoot, a, actionId, plan.endpoint, versions, plan.ci);
    if (fact.state === "pending") throw new WaitingForTarget(index, e.envelope_id);
    if (fact.state === "failed") throw Error("Target reports failed delivery for " + a.stage);
    if (fact.state !== "completed") return null;
    if (a.stage === "ship") {
      for (const pr of plan.ci.filter(pr => plan.actions.some(action => action.kind === "pr" && action.repo === pr.repo))) {
        const row = ledger.getTaskRepos(e.task_id).find(item => item.repo === pr.repo)!;
        const {dir} = resolveTaskCheckout(ledger.workbenchRoot,row);
        if (!checkedPr(dir, row.branch, pr).merged)
          throw Error("Merge-stage observer reported completion but the pinned PR is still open: " + pr.url);
      }
    }
    return canonicalJson(fact);
  }
  const alreadyDone = observe();
  if (alreadyDone) return alreadyDone;
  if (a.stage === "ship") throw new AwaitingOperator("PR merge handed off; waiting for the registered target observer to confirm " + actionId +
    ". The submit program has no verified merge-time base condition.");
  checkStagePin(ledger.workbenchRoot, a);
  // Persist intent before invoking the writer, so a crash or asynchronous submission cannot replay it.
  withImmediateTx(ledger.db, () => {
    checkAuthorization(ledger, e.envelope_id);
    const submitted = ledger.db
      .query(
        "SELECT 1 FROM events WHERE task_id=? AND event_type='SHIP_STAGE_SUBMISSION_INTENT' AND json_extract(payload_json,'$.envelope_id')=? AND json_extract(payload_json,'$.index')=? LIMIT 1",
      )
      .get(e.task_id, e.envelope_id, index);
    if (submitted) throw Error(absentAfterIntent);
    trackEvent(ledger, e, "SHIP_STAGE_SUBMISSION_INTENT", { index, action_id: actionId });
  });
  const env = { ...stageEnvironment(actionId, plan.endpoint, versions, plan.ci), FORGE_ACTIVE_STAGE: a.stage };
  const submission = runProcess(a.execute.argv, { cwd: a.execute.cwd, env, timeoutMs: 60_000 });
  const receipt = observe();
  if (receipt) return receipt;
  if (submission.code !== 0)
    throw Error(
      `Stage ${a.stage} submission exited with code ${submission.code}; target reports action ${actionId} absent. Inspect the submitter and target before manual recovery.`,
    );
  throw Error(absentAfterIntent);
}
function perform(
  ledger: Ledger,
  e: Envelope,
  a: ShipAction,
  dirs: Map<string, string>,
  index: number,
  plan: ExactPlan,
) {
  const state = observed(ledger, e, a, dirs);
  if (state) return state;
  if (a.kind === "push") {
    return pushFastForward(dirs.get(a.repo)!, a, () => {
      checkPushPermission(ledger.workbenchRoot, a.ref.slice("refs/heads/".length));
      checkAuthorization(ledger, e.envelope_id);
    });
  }
  if (a.kind === "pr" || a.kind === "tag") {
    const dir = dirs.get(a.repo)!;
    if (a.kind === "pr") {
      throw Error("Manual merge required before any merge write: this host cannot condition a PR merge on the approved base OID");
    } else {
      checkAuthorization(ledger, e.envelope_id);
      const result = runProcess(["git", "push", "--no-follow-tags", "origin", a.head + ":refs/tags/" + a.tag], {
        cwd: dir,
        env: checkoutEnvironment(),
      });
      if (result.code) throw Error("Tag action failed; inspect remote state");
    }
    const confirmed = observed(ledger, e, a, dirs);
    if (!confirmed) throw Error("Uncertain remote outcome; inspect remote before retrying");
    return confirmed;
  }
  const env = stageEnvironment(
    e.envelope_id + "/" + index,
    plan.endpoint,
    plan.pins.map(({ repo, head }) => ({ repo, head })),
  );
  if (a.kind === "stage") return reconcileStage(ledger, e, a, plan, index);
  const sql = readFileSync(a.path);
  if (
    createHash("sha256").update(sql).digest("hex") !== a.sha256 ||
    canonicalJson(databaseTarget(ledger.workbenchRoot, a.target.host)) !== canonicalJson(a.target)
  )
    throw Error("SQL changed");
  checkAuthorization(ledger, e.envelope_id);
  const db = loadDbEnvironments(ledger.workbenchRoot, { strict: true })[a.target.env];
  const r = Bun.spawnSync(
    [a.target.client, "-X", "-w", "--single-transaction", "--set=ON_ERROR_STOP=1", "--file=-"],
    {
      stdin: sql,
      stdout: "ignore",
      stderr: "ignore",
      timeout: 60_000,
      env: {
        ...env,
        PGHOST: a.target.host,
        PGPORT: String(a.target.port),
        PGDATABASE: a.target.database,
        PGUSER: a.target.user,
        PGPASSWORD: db.rw!.password,
        PGSSLMODE: a.target.sslmode,
      },
    },
  );
  if (r.exitCode !== 0 || r.signalCode) throw Error("Unconfirmed SQL action; inspect database before retrying");
  return "transaction committed " + a.sha256;
}
function state(ledger: Ledger, id: string, reason?: string) {
  const e = envelope(ledger, id),
    records = receipts(ledger, id);
  if (e.status === "REDEEMED") return { ok: true, status: e.status, receipts: records };
  return {
    ok: false,
    status: e.status,
    reason: { message: reason ?? e.degraded_reason ?? "Await human approval" },
    receipts: records,
  };
}
function validOwner(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function acquireRunner(ledger: Ledger, id: string) {
  const deadline = Date.now() + 120_000,
    token = String(process.pid);
  while (Date.now() < deadline) {
    const e = envelope(ledger, id);
    if (e.status !== "ACTIVE") return false;
    if (!e.run_token || !validOwner(Number(e.run_token))) {
      const result = ledger.db
        .query(
          "UPDATE fast_track_envelopes SET run_token=? WHERE envelope_id=? AND status='ACTIVE' AND run_token IS ?",
        )
        .run(token, id, e.run_token);
      if (result.changes) return true;
    }
    Bun.sleepSync(100);
  }
  return false;
}
export function shipCli(argv: string[]) {
  const [cmd, ...rest] = argv;
  if (!["run", "evaluate"].includes(cmd)) throw Error("Expected forge ship evaluate|run --envelope <id>");
  const { values } = parseArgs({
    args: rest,
    options: { envelope: { type: "string" }, json: { type: "boolean" }, "dry-run": { type: "boolean" } },
  });
  if (!values.envelope) throw Error("Missing --envelope");
  const id = values.envelope,
    ledger = new Ledger(findWorkbenchRoot());
  try {
    const initial = envelope(ledger, id);
    // Pre-scope envelopes without a registered exact plan never acquire new authority.
    let front = false;
    try { front = preparedScope(ledger, initial).anchor.mode === "frozen-scope-v1"; } catch { /* Older envelope without a preparation receipt. */ }
    if (!front) {
      try { exactBinding(ledger, id); }
      catch { return {ok:false,status:initial.status,reason:{message:"Legacy envelope has no exact binding. Register a new plan and request human approval."},receipts:receipts(ledger,id)}; }
    }
    if (initial.status !== "ACTIVE") return state(ledger, id);
    // A wrong session cannot revoke another session's approved envelope.
    try {
      live(initial);
    } catch (err) {
      if (Date.parse(initial.expires_at!) > Date.now()) return state(ledger, id, String(err));
    }
    let expectedToken: string | null = null;
    try {
      const execute = cmd === "run" && !values["dry-run"];
      if (execute) {
        if (!acquireRunner(ledger, id)) return state(ledger, id);
        expectedToken = String(process.pid);
      }
      resolveFrontPlan(ledger, envelope(ledger, id));
      const { plan } = preflight(ledger, envelope(ledger, id));
      if (cmd === "evaluate" || values["dry-run"]) return { ok: true, status: "ELIGIBLE", plan };
      for (const [index, action] of plan.actions.entries()) {
        const current = envelope(ledger, id);
        if (current.status !== "ACTIVE") return state(ledger, id);
        const { dirs } = preflight(ledger, current);
        const hash = sha256String(canonicalJson(action));
        const claim = withImmediateTx(ledger.db, () => {
          const old = receipts(ledger, id).find((r) => r.action_index === index);
          if (old) return old;
          if (envelope(ledger, id).status !== "ACTIVE") throw Error("Authorization is no longer active");
          ledger.db
            .query(
              "INSERT INTO ship_action_receipts(envelope_id,action_index,action_hash,status,owner_pid,created_at) VALUES (?,?,?,'claimed',?,?)",
            )
            .run(id, index, hash, process.pid, nowIso());
          trackEvent(ledger, current, "SHIP_ACTION_CLAIMED", { index, hash });
          return null;
        });
        if (claim?.action_hash && claim.action_hash !== hash) throw Error("Receipt action hash mismatch");
        if (claim?.status === "confirmed") continue;
        let observation: string | null;
        if (claim) {
          if (validOwner(claim.owner_pid)) {
            const deadline = Date.now() + 60_000;
            while (
              Date.now() < deadline &&
              validOwner(claim.owner_pid) &&
              envelope(ledger, id).status === "ACTIVE" &&
              receipts(ledger, id).find((r) => r.action_index === index)?.status === "claimed"
            )
              Bun.sleepSync(100);
            if (receipts(ledger, id).find((r) => r.action_index === index)?.status === "confirmed") continue;
            if (validOwner(claim.owner_pid) || envelope(ledger, id).status !== "ACTIVE")
              return state(ledger, id, "Action claimed; inspect receipts");
          }
          observation =
            action.kind === "stage"
              ? reconcileStage(ledger, current, action, plan, index)
              : observed(ledger, current, action, dirs);
          if (!observation)
            throw Error(
              "Uncertain outcome for a claimed item; inspect target and receipts before manual recovery",
            );
        } else {
          preflight(ledger, envelope(ledger, id));
          observation = perform(ledger, current, action, dirs, index, plan);
        }
        withImmediateTx(ledger.db, () => {
          if (
            ledger.db
              .query(
                "UPDATE ship_action_receipts SET status='confirmed',confirmed_at=?,observation=? WHERE envelope_id=? AND action_index=? AND status='claimed'",
              )
              .run(nowIso(), observation, id, index).changes
          )
            trackEvent(ledger, current, "SHIP_ACTION_CONFIRMED", {
              index,
              hash,
              observation,
              endpoint: plan.endpoint,
              versions: plan.pins,
            });
        });
      }
      return withImmediateTx(ledger.db, () => {
        const current = envelope(ledger, id);
        if (current.status !== "ACTIVE") return state(ledger, id);
        preflight(ledger, current);
        const { rb } = exactRunbook(ledger, current);
        if (rb.status !== "APPROVED" || !rb.expires_at || Date.parse(rb.expires_at) <= Date.now())
          throw Error("Approval expired or revoked");
        const allReceipts = receipts(ledger, id);
        const versions = plan.pins.map(({ repo, head }) => ({ repo, head }));
        const stageReceipts = plan.actions.flatMap((action, index) => {
          if (action.kind !== "stage") return [];
          const fact = { state: "completed", action_id: id + "/" + index, endpoint: plan.endpoint, versions };
          const receipt = allReceipts.find((row) => row.action_index === index && row.status === "confirmed");
          if (receipt?.observation !== canonicalJson(fact))
            throw Error("Missing completed target receipt for " + action.stage);
          return [{ stage: action.stage, ...fact }];
        });
        const now = nowIso();
        ledger.db
          .query(
            "UPDATE fast_track_envelopes SET status='REDEEMED',redeemed_at=?,updated_at=?,redeemed_runbook_id=? WHERE envelope_id=?",
          )
          .run(now, now, rb.runbook_id, id);
        ledger.db
          .query("UPDATE runbooks SET status='COMPLETED',completed_at=? WHERE runbook_id=?")
          .run(now, rb.runbook_id);
        for (const pin of plan.pins) {
          if (plan.endpoint === "push") {
            const index = plan.actions.findIndex(a => a.kind === "push" && a.repo === pin.repo);
            const action = plan.actions[index];
            const receipt = allReceipts.find(r => r.action_index === index);
            if (action?.kind !== "push" || receipt?.observation !== action.head) throw Error("Missing fast-forward receipt");
            ledger.recordEvidence({task_id: current.task_id, repo: pin.repo, branch: pin.branch, sha: pin.head,
              kind: "prod", status: "pass", source: "tool", actor: "tool", summary: "Verified remote fast-forward",
              meta: {runbook_id: rb.runbook_id, envelope_id: id, delivery_endpoint: plan.endpoint,
                remote: action.remote, ref: action.ref, old_sha: action.baseOid, new_sha: receipt.observation}});
            continue;
          }
          const pr = plan.ci.find((a) => a.repo === pin.repo)!;
          const prIndex = plan.actions.findIndex((a) => a.kind === "pr" && a.repo === pin.repo);
          const receipt = receipts(ledger, id).find((r) => r.action_index === prIndex);
          const meta = {
            runbook_id: rb.runbook_id,
            envelope_id: id,
            delivery_endpoint: plan.endpoint,
            ...(receipt && {
              pr_url: pr.url,
              pr_head_oid: pr.head,
              base_branch: pr.base,
              merge_commit: receipt.observation,
              target_oid: receipt.observation,
              state: "MERGED",
            }),
          };
          if (receipt)
            ledger.recordEvidence({
              task_id: current.task_id,
              repo: pin.repo,
              branch: pin.branch,
              sha: pin.head,
              kind: "pr",
              status: "pass",
              source: "tool",
              actor: "tool",
              summary: "Verified remote PR merge",
              meta,
            });
          if (current.target_endpoint === "prod")
            ledger.recordEvidence({
              task_id: current.task_id,
              repo: pin.repo,
              branch: pin.branch,
              sha: pin.head,
              kind: "prod",
              status: "pass",
              source: "tool",
              actor: "tool",
              summary: "Confirmed exact delivery steps",
              meta: { ...meta, stage_receipts: stageReceipts },
            });
        }
        trackEvent(ledger, current, "FAST_TRACK_REDEEMED", {
          runbook_id: rb.runbook_id,
          endpoint: plan.endpoint,
          versions: plan.pins,
        });
        return state(ledger, id);
      });
    } catch (err) {
      return withImmediateTx(ledger.db, () => {
        const current = envelope(ledger, id);
        const reason = err instanceof Error ? err.message : String(err);
        if (current.status !== "ACTIVE") return state(ledger, id);
        // Evaluation may fail after an executor has claimed its first external action.
        if (current.run_token !== expectedToken) return state(ledger, id, reason);
        if (err instanceof AwaitingOperator) {
          if (expectedToken) ledger.db.query("UPDATE ship_action_receipts SET owner_pid=0 WHERE envelope_id=? AND owner_pid=? AND status='claimed'")
            .run(id,Number(expectedToken));
          ledger.db.query("UPDATE fast_track_envelopes SET run_token=NULL WHERE envelope_id=? AND run_token IS ?").run(id,expectedToken);
          return state(ledger,id,err.message);
        }
        if (err instanceof WaitingForTarget) {
          ledger.db
            .query(
              "UPDATE ship_action_receipts SET owner_pid=0 WHERE envelope_id=? AND action_index=? AND status='claimed'",
            )
            .run(id, err.index);
          ledger.db
            .query(
              "UPDATE fast_track_envelopes SET run_token=NULL WHERE envelope_id=? AND status='ACTIVE' AND run_token=?",
            )
            .run(id, String(process.pid));
          return state(ledger, id, err.message);
        }
        const status = Date.parse(current.expires_at!) <= Date.now() ? "EXPIRED" : "DEGRADED";
        if (
          ledger.db
            .query(
              "UPDATE fast_track_envelopes SET status=?,degraded_reason=?,updated_at=? WHERE envelope_id=? AND status='ACTIVE' AND run_token IS ?",
            )
            .run(status, reason, nowIso(), id, expectedToken).changes
        )
          trackEvent(ledger, initial, "FAST_TRACK_DEGRADED", { reason });
        return state(ledger, id);
      });
    }
  } finally {
    ledger.closeDb();
  }
}
