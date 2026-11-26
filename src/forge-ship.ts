import { mergePinnedHead } from "./conditional-merge";
import { diffScope, inspectMerge, deliveryDiff, git } from "./ship-diff";
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import {
  fatRef,
  checkFatProtection,
  checkDeliveryDefinition,
  pinCheckouts,
  stagePin,
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
function checkEvidence(ledger: Ledger, e: Envelope, row: TaskRepoRecord, dir: string, head: string) {
  const check = ledger.checkPushReadiness({
    task_id: e.task_id,
    repo: row.repo,
    branch: row.branch,
    checkoutDir: dir,
    head_sha: head,
  });
  if (!check.ready) throw Error(check.missing.join(", "));
}
type PrAction = Extract<ShipAction, { kind: "pr" }>;
function checkedPr(dir: string, branch: string, a: PrAction) {
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
  if (ci.code) throw Error("Required CI checks unavailable");
  const checks = JSON.parse(ci.stdout);
  if (!Array.isArray(checks) || !checks.length || checks.some((c) => !c.name || c.bucket !== "pass"))
    throw Error("Required CI checks missing or failing");
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
      pr.mergeable !== "MERGEABLE" ||
      ["DIRTY", "BLOCKED", "UNKNOWN"].includes(pr.mergeStateStatus)
    )
      throw Error("PR base drift or mergeability failure");
    return { merged: false, oid: pr.baseRefOid as string };
  }
  const oid = pr.mergeCommit?.oid;
  if (!isOid(oid) || !isOid(pr.baseRefOid)) throw Error("Missing remote merge receipt");
  if (target.stdout.trim() !== oid)
    throw Error("Remote target changed after merge; inspect its ancestry before continuing");
  if (oid === a.head) {
    if (runGit(dir, ["merge-base", "--is-ancestor", a.baseOid, a.head]).code)
      throw Error("Fast-forward did not include approved base");
  } else {
    const parents = api("git/commits/" + oid, '[.parents[].sha] | join(" ")');
    if (parents.code || parents.stdout.trim() !== a.baseOid + " " + a.head)
      throw Error("Merge parents differ from approved base and head");
  }
  return { merged: true, oid: String(oid) };
}
function preflight(ledger: Ledger, e: Envelope) {
  const { rb, plan } = exactRunbook(ledger, e);
  if (e.status !== "ACTIVE") throw Error("Envelope is " + e.status);
  live(e);
  if (
    rb.status !== "APPROVED" ||
    rb.approved_session_id !== e.approved_session_id ||
    !rb.expires_at ||
    Date.parse(rb.expires_at) <= Date.now()
  )
    throw Error("Runbook approval revoked, expired or wrong session");
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
  const policy = validateScope(ledger, e),
    paths: string[] = JSON.parse(e.allowed_path_globs_json),
    repos: string[] = JSON.parse(e.allowed_repos_json);
  checkDeliveryDefinition(ledger.workbenchRoot, plan);
  if (canonicalJson(pinCheckouts(ledger, e.task_id)) !== canonicalJson(plan.pins))
    throw Error("Approved commit or remote changed");
  const files = new Set<string>(),
    dirs = new Map<string, string>(),
    check = deliveryDiff(policy, paths);
  let lines = 0;
  for (const row of ledger.getTaskRepos(e.task_id)) {
    const pin = plan.pins.find((p) => p.repo === row.repo && p.branch === row.branch)!;
    const { dir } = resolveTaskCheckout(ledger.workbenchRoot, row);
    if (
      git(dir, ["status", "--porcelain", "-z", "--untracked-files=all"]) ||
      runGit(dir, ["merge-base", "--is-ancestor", row.base_sha!, pin.head]).code
    )
      throw Error("Expected clean approved version in " + row.repo);
    if (!repos.includes(row.repo)) throw Error("Repository outside approval");
    dirs.set(row.repo, dir);
    checkEvidence(ledger, e, row, dir, pin.head);
    lines += diffScope(dir, row, pin.head, true, paths, policy, files);
    if (lines > policy.max_lines_changed || files.size > policy.max_files_changed)
      throw Error("Diff exceeds policy limits");
    if (plan.endpoint === "fat") {
      checkFatProtection(ledger.workbenchRoot);
      const index = plan.actions.findIndex((a) => a.kind === "fat" && a.repo === row.repo),
        item = plan.actions[index];
      if (
        !item ||
        item.kind !== "fat" ||
        item.head !== pin.head ||
        item.originHash !== pin.originHash ||
        item.ref !== "refs/heads/fat" ||
        item.remote !== "origin" ||
        plan.actions.some((a) => a.kind !== "fat")
      )
        throw Error("Incomplete or out-of-scope FAT binding");
      const live = fatRef(dir),
        claimed = receipts(ledger, e.envelope_id).some((r) => r.action_index === index);
      if (live !== item.baseOid && !(claimed && live === item.targetOid))
        throw Error("Remote FAT target changed");
      if (runGit(dir, ["merge-base", "--is-ancestor", row.base_sha!, item.baseOid]).code)
        throw Error("FAT target is outside the approved base");
      inspectMerge(row.repo, dir, item.baseOid, pin.head, check);
      continue;
    }
    const merges = plan.ci.filter((a) => a.repo === row.repo);
    if (merges.length !== 1)
      throw Error("Expected one exact CI target per attached branch; recreate the runbook");
    const pr = merges[0],
      observation = checkedPr(dir, row.branch, pr);
    if (!observation.merged) inspectMerge(row.repo, dir, pr.baseOid, pin.head, check);
    else if (observation.oid === pin.head) check(row.repo, dir, pr.baseOid, pin.head);
    else inspectMerge(row.repo, dir, pr.baseOid, pin.head, check);
  }
  for (const a of plan.actions) {
    if (a.kind === "stage" && canonicalJson(stagePin(ledger.workbenchRoot, a.stage)) !== canonicalJson(a))
      throw Error("Stage script, target or arguments changed: " + a.stage);
    if (
      a.kind === "sql" &&
      (policy.forbid_db_rw ||
        createHash("sha256").update(readFileSync(a.path)).digest("hex") !== a.sha256 ||
        canonicalJson(databaseTarget(ledger.workbenchRoot, a.target.host)) !== canonicalJson(a.target))
    )
      throw Error("SQL target or content changed, or writes forbidden");
  }
  return { plan, dirs };
}
function observed(ledger: Ledger, e: Envelope, a: ShipAction, dirs: Map<string, string>): string | null {
  if (a.kind === "fat") {
    const live = fatRef(dirs.get(a.repo)!);
    if (live === a.targetOid) return live;
    if (live !== a.baseOid) throw Error("Remote FAT ref drifted");
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
  const current = envelope(ledger, id),
    { rb } = exactRunbook(ledger, current);
  live(current);
  if (
    current.status !== "ACTIVE" ||
    rb.status !== "APPROVED" ||
    rb.approved_session_id !== current.approved_session_id ||
    !rb.expires_at ||
    Date.parse(rb.expires_at) <= Date.now()
  )
    throw Error("Authorization expired, revoked or changed");
  if (ledger.getTaskBlockers(current.task_id).some((blocker) => blocker.status === "OPEN"))
    throw Error("Task has an open blocker");
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
  if (a.kind === "fat") {
    const dir = dirs.get(a.repo)!;
    const diff = deliveryDiff(validateScope(ledger, e), JSON.parse(e.allowed_path_globs_json));
    mergePinnedHead(
      dir,
      "fat",
      a.baseOid,
      a.head,
      (sha, env) => {
        if (sha !== a.targetOid) throw Error("Prospective FAT update changed");
        diff(a.repo, dir, a.baseOid, sha, env);
      },
      () => {
        checkFatProtection(ledger.workbenchRoot);
        checkAuthorization(ledger, e.envelope_id);
      },
      a.originHash,
    );
    const target = fatRef(dir);
    if (target !== a.targetOid) throw Error("Cannot confirm the approved FAT ref");
    return target;
  }
  if (a.kind === "pr" || a.kind === "tag") {
    const dir = dirs.get(a.repo)!;
    if (a.kind === "pr") {
      const diff = deliveryDiff(validateScope(ledger, e), JSON.parse(e.allowed_path_globs_json));
      mergePinnedHead(
        dir,
        a.base,
        a.baseOid,
        a.head,
        (target, env) => diff(a.repo, dir, a.baseOid, target, env),
        () => checkAuthorization(ledger, e.envelope_id),
        plan.pins.find((pin) => pin.repo === a.repo)!.originHash,
      );
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
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    LANG: process.env.LANG,
    FORGE_ACTION_ID: e.envelope_id + "/" + index,
    FORGE_ENDPOINT: plan.endpoint,
    FORGE_APPROVED_HEADS: JSON.stringify(plan.pins.map(({ repo, head }) => ({ repo, head }))),
  };
  if (a.kind === "stage") {
    if (canonicalJson(stagePin(ledger.workbenchRoot, a.stage)) !== canonicalJson(a))
      throw Error("Stage changed");
    checkAuthorization(ledger, e.envelope_id);
    const r = runProcess(a.argv, {
      cwd: a.cwd,
      env: { ...env, FORGE_ACTIVE_STAGE: a.stage },
      timeoutMs: 60_000,
    });
    if (r.code)
      throw Error("Unconfirmed stage " + a.stage + " (exit " + r.code + "); inspect target before retrying");
    return "exit=0 stdout_sha256=" + sha256String(r.stdout);
  }
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
    try {
      exactBinding(ledger, id);
    } catch (err) {
      return state(ledger, id, String(err));
    }
    if (initial.status !== "ACTIVE") return state(ledger, id);
    // A wrong session cannot revoke another session's approved envelope.
    try {
      live(initial);
    } catch (err) {
      if (Date.parse(initial.expires_at!) > Date.now()) return state(ledger, id, String(err));
    }
    try {
      const execute = cmd === "run" && !values["dry-run"];
      if (execute && !acquireRunner(ledger, id)) return state(ledger, id);
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
          observation = observed(ledger, current, action, dirs);
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
        live(current);
        const { rb } = exactRunbook(ledger, current);
        if (rb.status !== "APPROVED" || !rb.expires_at || Date.parse(rb.expires_at) <= Date.now())
          throw Error("Approval expired or revoked");
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
          if (plan.endpoint === "fat") {
            const index = plan.actions.findIndex((a) => a.kind === "fat" && a.repo === pin.repo),
              action = plan.actions[index];
            const receipt = receipts(ledger, id).find((r) => r.action_index === index);
            if (action?.kind !== "fat" || receipt?.observation !== action.targetOid)
              throw Error("Missing verified FAT receipt");
            ledger.recordEvidence({
              task_id: current.task_id,
              repo: pin.repo,
              branch: pin.branch,
              sha: pin.head,
              kind: "fat",
              status: "pass",
              source: "tool",
              actor: "tool",
              summary: "Confirmed exact FAT ref update",
              meta: {
                runbook_id: rb.runbook_id,
                envelope_id: id,
                delivery_endpoint: "fat",
                remote: action.remote,
                ref: action.ref,
                old_sha: action.baseOid,
                new_sha: receipt.observation,
              },
            });
            continue;
          }
          const pr = plan.ci.find((a) => a.repo === pin.repo)!;
          const prIndex = plan.actions.findIndex((a) => a.kind === "pr" && a.repo === pin.repo);
          const receipt = receipts(ledger, id).find((r) => r.action_index === prIndex);
          const meta = {
            runbook_id: rb.runbook_id,
            envelope_id: id,
            delivery_endpoint: plan.endpoint,
            pr_url: pr.url,
            pr_head_oid: pr.head,
            base_branch: pr.base,
            merge_commit: receipt?.observation,
            target_oid: receipt?.observation,
            ...(receipt && { state: "MERGED" }),
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
              meta,
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
        const reason = err instanceof Error ? err.message : String(err);
        const status = Date.parse(initial.expires_at!) <= Date.now() ? "EXPIRED" : "DEGRADED";
        if (
          ledger.db
            .query(
              "UPDATE fast_track_envelopes SET status=?,degraded_reason=?,updated_at=? WHERE envelope_id=? AND status='ACTIVE'",
            )
            .run(status, reason, nowIso(), id).changes
        )
          trackEvent(ledger, initial, "FAST_TRACK_DEGRADED", { reason });
        return state(ledger, id);
      });
    }
  } finally {
    ledger.closeDb();
  }
}
