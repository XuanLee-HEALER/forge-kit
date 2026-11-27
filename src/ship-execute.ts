import { checkStagePin, observeStage, stageEnvironment } from "./stage-observation";
import { pushFastForward } from "./conditional-merge";
import { git } from "./ship-diff";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { checkPushPermission, databaseTarget, type ShipAction, type ExactPlan } from "./ledger/ship-actions";
import { loadDbEnvironments } from "./config";
import { runProcess, checkoutEnvironment } from "./git";
import type { Ledger } from "./ledger/store";
import { preparedScope, trackEvent, type Envelope } from "./ledger/fast-track";
import { canonicalJson } from "./ledger/types";
import { withImmediateTx } from "./ledger/transactions";
import { checkedPr, AwaitingOperator, checkAuthorization } from "./ship-preflight";

export function observed(ledger: Ledger, e: Envelope, a: ShipAction, dirs: Map<string, string>): string | null {
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

export class WaitingForTarget extends Error {
  constructor(readonly index: number, envelopeId: string) {
    super("Awaiting target confirmation. Retry forge ship run --envelope " + envelopeId + " to observe the same delivery.");
  }
}

export function reconcileStage(
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
    const fact = observeStage(ledger.workbenchRoot, a, actionId, plan.endpoint, versions);
    if (fact.state === "pending") throw new WaitingForTarget(index, e.envelope_id);
    if (fact.state === "failed") throw Error("Target reports failed delivery for " + a.stage);
    if (fact.state !== "completed") return null;
    return canonicalJson(fact);
  }
  const alreadyDone = observe();
  if (alreadyDone) return alreadyDone;
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
  const env = { ...stageEnvironment(actionId, plan.endpoint, versions), FORGE_ACTIVE_STAGE: a.stage };
  const submission = runProcess(a.execute.argv, { cwd: a.execute.cwd, env, timeoutMs: 60_000 });
  const receipt = observe();
  if (receipt) return receipt;
  if (submission.code !== 0)
    throw Error(
      `Stage ${a.stage} submission exited with code ${submission.code}; target reports action ${actionId} absent. Inspect the submitter and target before manual recovery.`,
    );
  throw Error(absentAfterIntent);
}

export function perform(
  ledger: Ledger,
  e: Envelope,
  a: ShipAction,
  dirs: Map<string, string>,
  index: number,
  plan: ExactPlan,
) {
  if (a.kind === "push") {
    return pushFastForward(dirs.get(a.repo)!, a, () => {
      if (!plan.nodeAuthorization) checkPushPermission(ledger.workbenchRoot, a.ref.slice("refs/heads/".length));
      checkAuthorization(ledger, e.envelope_id);
    });
  }
  const state = observed(ledger, e, a, dirs);
  if (state) return state;
  if (a.kind === "pr") {
    if (!plan.nodeAuthorization || !preparedScope(ledger, e).anchor.node_authorization)
      throw new AwaitingOperator("Manual merge required for the pinned PR " + a.url);
    checkAuthorization(ledger, e.envelope_id);
    const result = runProcess([process.env.FORGE_GH_BIN || "gh", "pr", "merge", a.url,
      "--merge", "--match-head-commit", a.head], {cwd: dirs.get(a.repo)!, env: checkoutEnvironment()});
    const confirmed = observed(ledger, e, a, dirs);
    if (!confirmed)
      throw new AwaitingOperator("Manual merge or target confirmation required for " + a.url + " (base " + a.baseOid +
        ", head " + a.head + "). Platform merge exited " + result.code + "; the PR is still open.");
    return confirmed;
  }
  if (a.kind === "tag") {
    checkAuthorization(ledger, e.envelope_id);
    const result = runProcess(["git", "push", "--no-follow-tags", "origin", a.head + ":refs/tags/" + a.tag], {
      cwd: dirs.get(a.repo)!,
      env: checkoutEnvironment(),
    });
    if (result.code) throw Error("Tag action failed; inspect remote state");
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
