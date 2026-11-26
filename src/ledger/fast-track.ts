import type { ExactPlan } from "./ship-actions";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { canonicalRepoPath, loadShipPolicy, shipGlob, type ShipPolicy } from "../config";
import { runGit } from "../git";
import { matchesGlob } from "../shared/path";
import { resolveTaskCheckout } from "./checkout";
import type { Ledger } from "./store";
import { appendEventInTx, withImmediateTx } from "./transactions";
import { canonicalJson, nowIso, sha256String } from "./types";

export type Endpoint = ShipPolicy["max_endpoint"];
export interface Envelope {
  envelope_id: string;
  task_id: string;
  status: "PENDING" | "ACTIVE" | "DEGRADED" | "REVOKED" | "REDEEMED" | "EXPIRED";
  target_endpoint: Endpoint;
  allowed_repos_json: string;
  allowed_path_globs_json: string;
  spec_hashes_json: string;
  freeze_seq: number;
  base_shas_json: string;
  policy_hash: string;
  scope_hash: string;
  ttl_minutes: number;
  approved_session_id: string | null;
  approved_at: string | null;
  expires_at: string | null;
  run_token: string | null;
  degraded_reason: string | null;
  redeemed_runbook_id: string | null;
}

export function envelope(ledger: Ledger, id: string) {
  const row = ledger.db
    .query<Envelope, [string]>("SELECT * FROM fast_track_envelopes WHERE envelope_id=?")
    .get(id);
  if (!row) throw Error("Unknown fast-track envelope: " + id);
  return row;
}
interface Binding {
  runbook_id: string;
  actions_hash: string;
  endpoint: string;
}
export function exactBinding(ledger: Ledger, id: string) {
  const binding = ledger.db
    .query<
      Binding,
      [string]
    >("SELECT runbook_id, actions_hash, endpoint FROM exact_ship_envelopes WHERE envelope_id=?")
    .get(id);
  if (!binding)
    throw Error(
      "Missing exact actions for this legacy envelope; create a new runbook and request human approval",
    );
  return binding;
}
export function exactRunbook(ledger: Ledger, e: Envelope) {
  const binding = exactBinding(ledger, e.envelope_id);
  const rb = ledger.getRunbook(binding.runbook_id);
  if (
    !rb ||
    rb.task_id !== e.task_id ||
    rb.actions_hash !== binding.actions_hash ||
    sha256String(rb.actions_json) !== binding.actions_hash
  )
    throw Error("Registered runbook contents or task changed");
  const plan: ExactPlan = JSON.parse(rb.actions_json).exact;
  if (!plan || plan.endpoint !== binding.endpoint || !plan.actions?.length || !plan.ci || !plan.stages)
    throw Error("Runbook missing exact action or endpoint bindings");
  return { rb, plan, binding };
}
export function trackEvent(
  ledger: Ledger,
  e: Pick<Envelope, "task_id" | "envelope_id">,
  type: string,
  data: Record<string, unknown> = {},
  session?: string,
) {
  return appendEventInTx(ledger.db, {
    task_id: e.task_id,
    event_type: type,
    actor: session ? "user" : "tool",
    session_id: session,
    payload: { envelope_id: e.envelope_id, ...data },
  });
}
function scopeHash(
  e: Pick<
    Envelope,
    | "task_id"
    | "target_endpoint"
    | "spec_hashes_json"
    | "freeze_seq"
    | "allowed_repos_json"
    | "allowed_path_globs_json"
    | "policy_hash"
  >,
  binding: Binding,
) {
  return sha256String(
    canonicalJson([
      e.task_id,
      e.target_endpoint,
      JSON.parse(e.spec_hashes_json),
      e.freeze_seq,
      JSON.parse(e.allowed_repos_json),
      JSON.parse(e.allowed_path_globs_json),
      e.policy_hash,
      binding.runbook_id,
      binding.actions_hash,
      binding.endpoint,
    ]),
  );
}
function taskSnapshot(ledger: Ledger, id: string) {
  if (ledger.getTask(id)?.status !== "OPEN" || !ledger.verify(id).ok)
    throw Error("Expected an OPEN task with a valid ledger chain");
  const rows = ledger.getTaskRepos(id);
  if (!rows.length) throw Error("No attached repositories");
  if (rows.some(({ repo }) => repo === ".." || repo.startsWith("../")))
    throw Error("Invalid attached repository");
  const spec = ledger.getSpecState(id);
  if (spec.state !== "FROZEN" || spec.drift_detected || !spec.freeze_seq || !spec.hashes)
    throw Error("A drift-free frozen specification is required");
  const bases = rows
    .map((r) => {
      if (!r.base_sha || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(r.base_sha))
        throw Error("Invalid attached base SHA");
      const { dir } = resolveTaskCheckout(ledger.workbenchRoot, r);
      if (runGit(dir, ["cat-file", "-t", r.base_sha]).stdout.trim() !== "commit")
        throw Error("Missing base commit for " + r.repo);
      const remotes = [false, true].map((push) => {
        const result = runGit(dir, ["remote", "get-url", ...(push ? ["--push"] : []), "--all", "origin"]);
        return result.code ? null : result.stdout.trim();
      });
      return {
        repo: r.repo,
        branch: r.branch,
        base_sha: r.base_sha,
        origin_hash: sha256String(canonicalJson(remotes)),
      };
    })
    .sort((a, b) => a.repo.localeCompare(b.repo) || a.branch.localeCompare(b.branch));
  return {
    spec_hashes_json: canonicalJson(spec.hashes),
    freeze_seq: spec.freeze_seq,
    base_shas_json: canonicalJson(bases),
    repos: [...new Set(bases.map((r) => r.repo))].sort(),
  };
}
function ceiling(policy: ShipPolicy, to: string) {
  const levels = ["fat", "pr", "prod"];
  if (
    !policy.enabled ||
    !levels.includes(to) ||
    levels.indexOf(to) > levels.indexOf(policy.max_endpoint) ||
    (to === "prod" && !policy.allow_prod)
  )
    throw Error("Fast-track disabled or endpoint exceeds policy ceiling");
}
function validateActionCeiling(policy: ShipPolicy, endpoint: Endpoint, plan: ExactPlan) {
  ceiling(policy, endpoint);
  if (endpoint === "fat" && plan.actions.some(a => a.kind !== "fat"))
    throw Error("FAT scope can only update the registered test branch");
  // Instance stages run arbitrary delivery writers with an independent target observer.
  if (endpoint !== "prod" && plan.actions.some(a => ["stage", "tag", "sql"].includes(a.kind)))
    throw Error("Deployment, tag or database writes require a production delivery endpoint");
  if (policy.forbid_db_rw && plan.actions.some(a => a.kind === "sql"))
    throw Error("Policy forbids database writes");
}
export function validateScope(ledger: Ledger, e: Envelope) {
  const { policy, hash } = loadShipPolicy(ledger.workbenchRoot);
  const { binding, plan } = exactRunbook(ledger, e);
  validateActionCeiling(policy, e.target_endpoint, plan);
  const snapshot = taskSnapshot(ledger, e.task_id);
  if (
    hash !== e.policy_hash ||
    scopeHash(e, binding) !== e.scope_hash ||
    e.freeze_seq !== snapshot.freeze_seq ||
    e.spec_hashes_json !== snapshot.spec_hashes_json ||
    e.base_shas_json !== snapshot.base_shas_json
  )
    throw Error("Policy, frozen scope or attachment bases changed");
  const events = ledger.getTaskEvents(e.task_id);
  const prepared = events.find(
    (ev) =>
      ev.event_type === "FAST_TRACK_PREPARED" && JSON.parse(ev.payload_json).envelope_id === e.envelope_id,
  );
  const anchor = prepared && JSON.parse(prepared.payload_json);
  if (
    !prepared ||
    anchor.runbook_id !== binding.runbook_id ||
    anchor.actions_hash !== binding.actions_hash ||
    anchor.endpoint !== binding.endpoint ||
    anchor.scope_hash !== e.scope_hash ||
    anchor.base_shas_json !== e.base_shas_json ||
    anchor.ttl_minutes !== e.ttl_minutes ||
    events.some(
      (ev) => {
        if (ev.seq <= prepared.seq) return false;
        if (ev.event_type === "ENDPOINT_UPDATED") {
          const change = JSON.parse(ev.payload_json);
          return change.prev_endpoint !== change.endpoint;
        }
        return ["TASK_CLOSED", "TASK_CANCELLED", "HANDOFF_RECORDED", "TASK_RESUMED"].includes(ev.event_type);
      },
    )
  )
    throw Error("Prepared scope is no longer current");
  return policy;
}
export function shipReceipts(ledger: Ledger, id: string) {
  return ledger.db
    .query<
      {
        action_index: number;
        action_hash: string;
        status: string;
        owner_pid: number;
        observation: string | null;
        created_at: string;
        confirmed_at: string | null;
      },
      [string]
    >("SELECT * FROM ship_action_receipts WHERE envelope_id=? ORDER BY action_index")
    .all(id);
}
function revoke(ledger: Ledger, e: Envelope, reason: string, session?: string) {
  if (!["PENDING", "ACTIVE"].includes(e.status)) throw Error("Envelope is " + e.status);
  if(e.status==="ACTIVE" && (!session || session!==e.approved_session_id)) throw Error("Active authorization requires revocation from the approving root session");
  ledger.db
    .query(
      "UPDATE fast_track_envelopes SET status='REVOKED',updated_at=?,degraded_reason=? WHERE envelope_id=?",
    )
    .run(nowIso(), reason, e.envelope_id);
  const delivery = shipReceipts(ledger, e.envelope_id);
  const notice = delivery.some((item) => item.status === "claimed")
    ? "An approved item may be in flight. Inspect the target and the recorded receipts."
    : undefined;
  trackEvent(ledger, e, "FAST_TRACK_REVOKED", { reason, delivery, ...(notice && { notice }) }, session);
  return { ...envelope(ledger, e.envelope_id), delivery, notice };
}
export function humanFastTrack(ledger: Ledger, id: string, session: string, approve: boolean) {
  return withImmediateTx(ledger.db, () => {
    const e = envelope(ledger, id);
    if (!session.trim()) throw Error("Missing root session");
    if (!approve) return revoke(ledger, e, "Human revocation", session);
    if (e.status !== "PENDING") throw Error("Envelope is " + e.status);
    validateScope(ledger, e);
    const { rb } = exactRunbook(ledger, e);
    if (
      rb.status !== "PENDING" &&
      !(
        rb.status === "APPROVED" &&
        rb.approved_session_id === session &&
        Date.parse(rb.expires_at!) > Date.now()
      )
    )
      throw Error("Runbook is unavailable or belongs to another approval");
    const now = Date.now(),
      approved = new Date(now).toISOString(),
      expires = new Date(
        Math.min(now + 60000 * e.ttl_minutes, rb.expires_at ? Date.parse(rb.expires_at) : Infinity),
      ).toISOString();
    if (rb.status === "PENDING")
      ledger.db
        .query(
          "UPDATE runbooks SET status='APPROVED',approved_session_id=?,approved_at=?,expires_at=? WHERE runbook_id=? AND status='PENDING'",
        )
        .run(session, approved, expires, rb.runbook_id);
    ledger.db
      .query(
        "UPDATE fast_track_envelopes SET status='ACTIVE',approved_session_id=?,approved_at=?,expires_at=?,updated_at=? WHERE envelope_id=?",
      )
      .run(session, approved, expires, approved, id);
    trackEvent(ledger, e, "FAST_TRACK_APPROVED", { scope_hash: e.scope_hash, expires_at: expires }, session);
    return envelope(ledger, id);
  });
}
export function fastTrackCommand(ledger: Ledger, args: string[]) {
  const [cmd, ...rest] = args;
  if (cmd === "status") {
    const { positionals, values } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { task: { type: "string" } },
    });
    if (positionals.length > 1) throw Error("Expected at most one envelope ID");
    if (
      !ledger.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fast_track_envelopes'").get()
    )
      return [];
    return ledger.db
      .query<Envelope, [string | null, string | null, string | null, string | null]>(
        "SELECT * FROM fast_track_envelopes WHERE (? IS NULL OR envelope_id=?) AND (? IS NULL OR task_id=?) ORDER BY created_at",
      )
      .all(positionals[0] ?? null, positionals[0] ?? null, values.task ?? null, values.task ?? null)
      .map((row) => {
        if (!ledger.db.query("SELECT 1 FROM sqlite_master WHERE name='exact_ship_envelopes'").get()) return row;
        const binding = ledger.db
          .query<
            Binding,
            [string]
          >("SELECT runbook_id, actions_hash, endpoint FROM exact_ship_envelopes WHERE envelope_id=?")
          .get(row.envelope_id);
        return binding ? { ...row, ...binding, receipts: shipReceipts(ledger, row.envelope_id) } : row;
      });
  }
  const [id, ...flags] = rest;
  if (!id) throw Error("Expected task or envelope ID");
  return withImmediateTx(ledger.db, () => {
    if (cmd === "revoke")
      return revoke(
        ledger,
        envelope(ledger, id),
        parseArgs({ args: flags, options: { reason: { type: "string" } } }).values.reason ??
          "Operator revocation",
      );
    if (cmd !== "prepare") throw Error("Expected prepare, status or revoke; approval requires a human prompt");
    const { values: v } = parseArgs({
      args: flags,
      options: {
        to: { type: "string" },
        paths: { type: "string" },
        repos: { type: "string" },
        ttl: { type: "string" },
        runbook: { type: "string" },
      },
    });
    const { policy, hash } = loadShipPolicy(ledger.workbenchRoot);
    const rb = v.runbook && ledger.getRunbook(v.runbook);
    if (
      !rb ||
      rb.task_id !== id ||
      !["APPROVED", "PENDING"].includes(rb.status) ||
      rb.actions_hash !== sha256String(rb.actions_json)
    )
      throw Error("Expected --runbook with exact pending or approved actions for this task");
    const plan: ExactPlan = JSON.parse(rb.actions_json).exact;
    if (!plan?.actions.length || plan.endpoint !== v.to)
      throw Error("Runbook must bind the exact requested endpoint; create a new runbook");
    const target_endpoint: Endpoint = v.to === "pr" || v.to === "fat" ? v.to : "prod";
    validateActionCeiling(policy, target_endpoint, plan);
    const snap = taskSnapshot(ledger, id);
    const repos =
      v.repos === undefined
        ? snap.repos
        : [...new Set(v.repos.split(",").map((r) => canonicalRepoPath(ledger.workbenchRoot, r.trim())))].sort();
    if (repos.some((r) => !snap.repos.includes(r))) throw Error("Unattached repository in scope");
    const paths = [...new Set((v.paths ?? "").split(",").map(shipGlob))].sort();
    for (const path of paths) {
      const probe = path
        .replace(/^\.\//, "")
        .toLowerCase()
        .replace(/\*+|\?/g, "example");
      if (
        !/[a-z0-9_.-]/i.test(path) ||
        policy.forbidden_paths.some(
          (f) => matchesGlob(probe, f.toLowerCase()) || matchesGlob(probe + "/example", f.toLowerCase()),
        )
      )
        throw Error("Forbidden or unrestricted path scope: " + path);
    }
    const ttl = v.ttl === undefined ? policy.default_ttl_minutes : Number(v.ttl);
    if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > policy.default_ttl_minutes)
      throw Error("TTL exceeds policy bounds");
    const e = {
      envelope_id: "ft-" + Date.now() + "-" + randomBytes(6).toString("hex"),
      task_id: id,
      target_endpoint,
      allowed_repos_json: canonicalJson(repos),
      allowed_path_globs_json: canonicalJson(paths),
      spec_hashes_json: snap.spec_hashes_json,
      freeze_seq: snap.freeze_seq,
      policy_hash: hash,
    };
    const scope = scopeHash(e, {
        runbook_id: rb.runbook_id,
        actions_hash: rb.actions_hash,
        endpoint: plan.endpoint,
      }),
      ts = nowIso();
    ledger.db
      .query(
        "INSERT INTO fast_track_envelopes(envelope_id,task_id,status,target_endpoint,allowed_repos_json,allowed_path_globs_json,spec_hashes_json,freeze_seq,base_shas_json,policy_hash,scope_hash,ttl_minutes,created_at,updated_at) VALUES(?,?,'PENDING',?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        e.envelope_id,
        id,
        target_endpoint,
        e.allowed_repos_json,
        e.allowed_path_globs_json,
        e.spec_hashes_json,
        e.freeze_seq,
        snap.base_shas_json,
        hash,
        scope,
        ttl,
        ts,
        ts,
      );
    ledger.db
      .query(
        "INSERT INTO exact_ship_envelopes(envelope_id, runbook_id, actions_hash, endpoint) VALUES (?,?,?,?)",
      )
      .run(e.envelope_id, rb.runbook_id, rb.actions_hash, plan.endpoint);
    trackEvent(ledger, e, "FAST_TRACK_PREPARED", {
      runbook_id: rb.runbook_id,
      actions_hash: rb.actions_hash,
      endpoint: plan.endpoint,
      scope_hash: scope,
      base_shas_json: snap.base_shas_json,
      ttl_minutes: ttl,
    });
    return {
      ...envelope(ledger, e.envelope_id),
      runbook_id: rb.runbook_id,
      actions: plan.actions,
      endpoint: plan.endpoint,
      approval: "快轨批准 " + e.envelope_id,
    };
  });
}
