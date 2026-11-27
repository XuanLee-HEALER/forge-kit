import { redactSecrets } from "./cmdfmt";
import { parseArgs } from "node:util";
import { findWorkbenchRoot } from "./config";
import { Ledger } from "./ledger/store";
import { shipReceipts as receipts, findExactBinding, exactRunbook, envelope, trackEvent } from "./ledger/fast-track";
import { sha256String, canonicalJson, nowIso } from "./ledger/types";
import { withImmediateTx } from "./ledger/transactions";
import { live, type PrAction, approvedCheckouts, checkRunbookApproval, preflight, AwaitingOperator } from "./ship-preflight";
import { resolveFrontPlan } from "./ship-plan";
import { observed, WaitingForTarget, reconcileStage, perform } from "./ship-execute";

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
    let binding: ReturnType<typeof findExactBinding>;
    try {
      binding = findExactBinding(ledger, id);
    } catch (error) {
      return state(ledger, id, error instanceof Error ? error.message : String(error));
    }
    if (!binding) {
      const prepared = ledger.db.query("SELECT 1 FROM events WHERE task_id=? AND event_type='FAST_TRACK_PREPARED' AND json_extract(payload_json,'$.envelope_id')=? AND json_extract(payload_json,'$.mode')='frozen-scope-v1'")
        .get(initial.task_id,id);
      if (!prepared) return {ok:false,status:initial.status,reason:{message:"Legacy envelope has no exact binding. Register a new plan and request human approval."},receipts:receipts(ledger,id)};
    }
    if (initial.status !== "ACTIVE") return state(ledger, id);
    // A wrong session cannot revoke another session's approved envelope.
    try {
      live(initial);
    } catch (err) {
      if (Date.parse(initial.expires_at!) > Date.now()) return state(ledger, id, String(err));
    }
    const execute = cmd === "run" && !values["dry-run"];
    let expectedToken: string | null = null;
    try {
      if (execute) {
        if (!acquireRunner(ledger, id)) return state(ledger, id);
        expectedToken = String(process.pid);
      }
      const candidate = resolveFrontPlan(ledger, envelope(ledger, id), execute);
      const { plan } = preflight(ledger, envelope(ledger, id), candidate);
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
          if (action.kind === "push")
            throw Error("Uncertain fast-forward outcome for a claimed push; inspect the remote and recover manually");
          observation =
            action.kind === "stage"
              ? reconcileStage(ledger, current, action, plan, index)
              : observed(ledger, current, action, dirs);
          if (!observation && action.kind === "pr")
            throw new AwaitingOperator("Manual merge or target confirmation required for " + action.url +
              " (base " + action.baseOid + ", head " + action.head + "). The PR remains open after the original submission.");
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
      const {verifiedMerges} = preflight(ledger, envelope(ledger, id));
      return withImmediateTx(ledger.db, () => {
        const current = envelope(ledger, id);
        if (current.status !== "ACTIVE") return state(ledger, id);
        if (current.run_token !== expectedToken) throw Error("Delivery runner changed before confirmation");
        const {pins} = approvedCheckouts(ledger, current, plan);
        const exact = exactRunbook(ledger, current);
        checkRunbookApproval(exact.rb, current);
        if (canonicalJson(pins) !== canonicalJson(plan.pins)) throw Error("Approved checkout changed before confirmation");
        if (canonicalJson(exact.plan) !== canonicalJson(plan)) throw Error("Approved plan changed before confirmation");
        const rb = exact.rb;
        const allReceipts = receipts(ledger, id);
        if (allReceipts.length !== plan.actions.length || plan.actions.some((action, index) => {
          const receipt = allReceipts[index];
          return receipt?.action_index !== index || receipt.status !== "confirmed" ||
            receipt.action_hash !== sha256String(canonicalJson(action));
        })) throw Error("Missing or changed delivery receipts");
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
          const meta: Record<string, unknown> = {
            runbook_id: rb.runbook_id, envelope_id: id, delivery_endpoint: plan.endpoint,
          };
          const pr = plan.actions.find((a): a is PrAction => a.kind === "pr" && a.repo === pin.repo);
          if (pr) {
            const merge = verifiedMerges.get(pin.repo);
            if (!merge) throw Error("Missing independent remote PR merge receipt");
            Object.assign(meta, {pr_url: pr.url, pr_head_oid: pr.head, base_branch: pr.base,
              merge_commit: merge.oid, target_oid: merge.targetOid, state: "MERGED"});
            ledger.recordEvidence({
              task_id: current.task_id, repo: pin.repo, branch: pin.branch, sha: pin.head,
              kind: "pr", status: "pass", source: "tool", actor: "tool", summary: "Verified remote PR merge",
              meta,
            });
          }
          if (current.target_endpoint === "prod") {
            ledger.db.query("UPDATE task_repos SET head_sha=? WHERE task_id=? AND canonical_repo(repo)=canonical_repo(?) AND branch=?")
              .run(pin.head, current.task_id, pin.repo, pin.branch);
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
        }
        trackEvent(ledger, current, "FAST_TRACK_REDEEMED", {
          runbook_id: rb.runbook_id,
          endpoint: plan.endpoint,
          versions: plan.pins,
        });
        return state(ledger, id);
      });
    } catch (err) {
      if (!execute && !binding) return state(ledger, id, err instanceof Error ? err.message : String(err));
      return withImmediateTx(ledger.db, () => {
        const current = envelope(ledger, id);
        const reason = redactSecrets(err instanceof Error ? err.message : String(err));
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
