import { runProcess } from "./git";
import { stagePin, type ShipAction } from "./ledger/ship-actions";
import { canonicalJson } from "./ledger/types";

type Stage = Extract<ShipAction, { kind: "stage" }>;
type Revision = { repo: string; head: string };
export interface TargetObservation {
  state: "absent" | "pending" | "failed" | "completed";
  action_id: string;
  endpoint: string;
  versions: Revision[];
}

export function stageEnvironment(actionId: string, endpoint: string, versions: Revision[]) {
  return {
    PATH: process.env.PATH,
    LANG: process.env.LANG,
    FORGE_ACTION_ID: actionId,
    FORGE_ENDPOINT: endpoint,
    FORGE_APPROVED_HEADS: JSON.stringify(versions),
  };
}
export function checkStagePin(root: string, stage: Stage) {
  const current = stagePin(root, stage.stage);
  if (canonicalJson(current) !== canonicalJson(stage) &&
      canonicalJson(stagePin(root, stage.stage, true)) !== canonicalJson(stage))
    throw Error("Stage target, action or observer changed: " + stage.stage);
}

/** Read one observation from the instance's independently configured target adapter. */
export function observeStage(
  root: string,
  stage: Stage,
  actionId: string,
  endpoint: string,
  versions: Revision[],
): TargetObservation {
  checkStagePin(root, stage);
  const env = { ...stageEnvironment(actionId, endpoint, versions), FORGE_ACTIVE_STAGE: stage.stage };
  const r = runProcess(stage.observe.argv, { cwd: stage.observe.cwd, env, timeoutMs: 60_000 });
  if (r.code !== 0) {
    const failure = r.termination ?? ("exit code " + r.code);
    throw Error("Target observer for stage " + stage.stage + " failed (" + failure + "). Inspect action " +
      actionId + " on the target and repair the observer before manual recovery.");
  }
  let fact;
  try {
    fact = JSON.parse(r.stdout);
  } catch {
    throw Error("Invalid target observation for " + stage.stage);
  }
  if (
    !fact ||
    !["absent", "pending", "failed", "completed"].includes(fact.state) ||
    fact.action_id !== actionId ||
    fact.endpoint !== endpoint ||
    canonicalJson(fact.versions) !== canonicalJson(versions)
  )
    throw Error("Target observation does not match approved action, endpoint and revisions: " + stage.stage);
  return { state: fact.state, action_id: actionId, endpoint, versions };
}
