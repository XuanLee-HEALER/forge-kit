import { canonicalJson, isRolloutEndpoint, sha256String, usesV05, type ReleaseObserver } from "./types";
import { stagePin } from "./ship-actions";
import { observeStage } from "../stage-observation";
import { installedInstance } from "../workflow-config";
import { canonicalRepoPath } from "../config";
import { randomBytes } from "node:crypto";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import {
  currentHandoff,
  deploymentStages,
  availableHandoffs,
  detail,
  aggregate,
  invalidate,
  observe,
  inspect,
  releasePrActions,
  checkedActions,
  productionActions,
  requireActionReceipts,
} from "./release-inspection";
import type { Ledger } from "./store";
import { appendEventInTx, withImmediateTx } from "./transactions";
import { nowIso, type RunbookSqlFileAction, type RunbookTagAction } from "./types";

function create(ledger: Ledger, args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      title: { type: "string" },
      "from-handoffs": { type: "boolean" },
      tasks: { type: "string" },
      prs: { type: "string" },
      order: { type: "string" },
    },
  });
  const title = values.title?.trim();
  if (
    !title ||
    values.tasks === "" ||
    values.prs === "" ||
    [values["from-handoffs"], values.tasks, values.prs].filter(Boolean).length > 1
  )
    throw Error("Expected --title and at most one of --from-handoffs, --tasks, --prs");
  const wanted = new Set(values.prs?.split(","));
  const selected = values.tasks
    ? [...new Set(values.tasks.split(","))].sort()
    : values.prs
      ? ledger.db
          .query<{ task_id: string }, []>(
            "SELECT task_id FROM tasks WHERE status='HANDED_OFF' ORDER BY task_id",
          )
          .all()
          .map((t) => t.task_id)
      : availableHandoffs(ledger);
  const snapshots = selected
    .map((id) => currentHandoff(ledger, id))
    .filter((s) => {
      if (!values.prs) return true;
      const keys = s.items.map((i) => i.repo + "#" + i.pr_number);
      return keys.some((k) => wanted.has(k));
    });
  const items = snapshots.flatMap((s) =>
    s.items.map((i) => ({ ...i, task_id: s.task_id, ledger_tip: s.ledger_tip, hasSql: !!s.sql_files.length })),
  );
  if (!items.length) throw Error("No handoffs selected");
  const reserved = ledger.db.query<{ release_id: string }, [string, string]>(
    "SELECT r.release_id FROM releases r JOIN release_items i USING(release_id) WHERE i.task_id=? AND i.ledger_tip=? AND r.status IN ('DRAFT','VERIFIED','APPROVED') LIMIT 1",
  );
  for (const snapshot of snapshots) {
    const owner = reserved.get(snapshot.task_id, snapshot.ledger_tip);
    if (owner)
      throw Error("Handoff " + snapshot.task_id + " already belongs to active release " + owner.release_id);
  }
  const keys = new Set(items.map((i) => i.repo + "#" + i.pr_number));
  if (keys.size !== items.length || [...wanted].some((k) => !keys.has(k)))
    throw Error("Ambiguous or unknown PR selector");
  const order = values.order?.split(",") ?? [];
  if (order.some((r) => !items.some((i) => i.repo === r)) || new Set(order).size !== order.length)
    throw Error("Invalid repository merge order");
  const rank = (r: string) => (order.includes(r) ? order.indexOf(r) : order.length);
  items.sort(
    (a, b) =>
      rank(a.repo) - rank(b.repo) ||
      (!order.length ? Number(b.hasSql) - Number(a.hasSql) : 0) ||
      a.repo.localeCompare(b.repo) ||
      a.pr_number - b.pr_number,
  );
  const { sql_files, rollback_plan } = aggregate(snapshots);
  const ts = nowIso();
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
  const id =
    "rel-" + ts.slice(5, 10).replace("-", "") + "-" + (slug ? slug + "-" : "") + randomBytes(3).toString("hex");
  ledger.db
    .query(
      "INSERT INTO releases(release_id,title,status,sql_files_json,rollback_plan,created_at,updated_at) VALUES(?,?,'DRAFT',?,?,?,?)",
    )
    .run(id, title, JSON.stringify(sql_files), rollback_plan, ts, ts);
  const insert = ledger.db.query(
    "INSERT INTO release_items(release_id,task_id,repo,branch,base_branch,pr_number,pr_url,expected_head_sha,ledger_tip,status,merge_order) VALUES(?,?,?,?,?,?,?,?,?,'PENDING',?)",
  );
  items.forEach((i, k) =>
    insert.run(
      id,
      i.task_id,
      i.repo,
      i.branch,
      i.base_branch,
      i.pr_number,
      i.pr_url,
      i.verified_head,
      i.ledger_tip,
      k + 1,
    ),
  );
  return detail(ledger, id);
}

function releaseObservers(ledger: Ledger, release: ReturnType<typeof detail>): ReleaseObserver[] {
  const observers: ReleaseObserver[] = [];
  for (const item of release.items) {
    const endpoint = ledger.getTask(item.task_id)!.endpoint;
    if (!isRolloutEndpoint(endpoint) || !usesV05(ledger, item.task_id)) continue;
    const cfg = installedInstance(ledger.workbenchRoot);
    const stages = deploymentStages(cfg, endpoint);
    if (endpoint === "prod" && !stages.length) continue;
    if (cfg?.delivery.value.endpoint !== endpoint)
      throw Error("Release endpoint changed for " + item.task_id);
    if (!stages.length) throw Error("Custom release endpoint requires a target observer: " + endpoint);
    const versions = [{repo: item.repo, head: item.expected_head_sha}];
    for (const id of stages) {
      const stage = stagePin(ledger.workbenchRoot, id);
      const action_id = sha256String(canonicalJson([release.release_id, item.task_id, item.branch, item.ledger_tip, versions, endpoint, stage]));
      observers.push({task_id: item.task_id, repo: item.repo, branch: item.branch, action_id, endpoint, stage, versions});
    }
  }
  return observers;
}

function latestReceipt(ledger: Ledger, id: string, item: ReturnType<typeof detail>["items"][number],
  observed: boolean, endpoint: string, runbook: string) {
  return ledger.db
    .query<{ seq: number; status: string; observations: string | null }, [string, string, string, string, string, number, string, string]>(
      `SELECT seq, json_extract(payload_json,'$.status') AS status, json_extract(payload_json,'$.meta.observations') AS observations FROM events WHERE task_id=?
     AND canonical_repo(repo)=canonical_repo(?) AND branch=? AND sha=? AND event_type='EVIDENCE_CAPTURED'
     AND json_extract(payload_json,'$.release_id')=?
     AND (?=0 OR (json_extract(payload_json,'$.source')='tool' AND json_extract(payload_json,'$.meta.delivery_endpoint')=? AND json_extract(payload_json,'$.meta.observed_runbook')=?))
     AND json_extract(payload_json,'$.kind')='prod' AND json_type(payload_json,'$.meta.action_id') IS NULL AND json_extract(payload_json,'$.status') IN ('pass','fail') ORDER BY seq DESC LIMIT 1`,
    )
    .get(item.task_id, item.repo, item.branch, item.expected_head_sha, id, Number(observed), endpoint, runbook);
}

function observeRelease(ledger: Ledger, id: string) {
  function approved() {
    const release = detail(ledger, id);
    const rb = release.runbook_id && ledger.getRunbook(release.runbook_id);
    if (release.status !== "APPROVED" || !rb || !rb.approved_at || !["APPROVED", "COMPLETED"].includes(rb.status))
      throw Error("Release observation needs its approved runbook");
    const pins = checkedActions(release, rb).release_observers ?? [];
    if (!pins.length || canonicalJson(pins) !== canonicalJson(releaseObservers(ledger, release)))
      throw Error("Missing or changed release observer bindings");
    return {pins, items: release.items, runbook_id: rb.runbook_id};
  }
  const {pins, items, runbook_id} = approved();
  const reports = items.flatMap(item => {
    const targets = pins.filter(p => p.task_id === item.task_id && p.repo === item.repo && p.branch === item.branch);
    if (!targets.length) return [];
    const latest = () => latestReceipt(ledger, id, item, true, targets[0].endpoint, runbook_id);
    const before = latest();
    const states = targets.map(pin => {
      try {
        const fact = observeStage(ledger.workbenchRoot, pin.stage, pin.action_id, pin.endpoint, pin.versions);
        return {action_id:pin.action_id, state:fact.state};
      } catch (error) {
        return {action_id:pin.action_id, state:"unconfirmed", error:String(error)};
      }
    });
    const status: "pass" | "fail" = states.every(row => row.state === "completed") ? "pass" : "fail";
    return [{item, targets, latest, before, states, status}];
  });
  withImmediateTx(ledger.db, () => {
    if (approved().runbook_id !== runbook_id) throw Error("Release runbook changed during observation");
    for (const {item, targets, latest, before, states, status} of reports) {
      const prior = latest();
      const observations = states.map(({action_id, state}) => ({action_id, state}));
      if (prior?.status === status && (status === "pass" || prior.observations === canonicalJson(observations))) continue;
      if (prior?.seq !== before?.seq) throw Error("Another observation was recorded; observe again");
      ledger.recordEvidence({
        task_id: item.task_id,
        repo: item.repo,
        branch: item.branch,
        sha: item.expected_head_sha,
        kind: "prod",
        source: "tool",
        actor: "tool",
        status,
        summary: status === "pass" ? "Target confirmed release delivery" : "Target did not confirm release delivery",
        meta: {
          delivery_endpoint: targets[0].endpoint,
          observed_runbook: runbook_id,
          observation_ids: targets.map(p => p.action_id),
          observations,
        },
      });
    }
  });
  const states = reports.flatMap(report => report.states);
  const unconfirmed = states.find(row => row.error) ?? states.find(row => row.state !== "completed");
  if (unconfirmed) throw Error(unconfirmed.error ?? ("Target has not confirmed delivery for " + unconfirmed.action_id));
  return {ok:true, release_id:id, runbook_id, observations:pins.length};
}

export function releaseCommand(ledger: Ledger, argv: string[]) {
  const [cmd, ...rest] = argv;
  if (cmd === "observe") {
    if (rest.length !== 1) throw Error("Expected one release ID");
    return observeRelease(ledger, rest[0]);
  }
  if (cmd === "status") {
    if (rest.length > 1) throw Error("Expected at most one release ID");
    if (!ledger.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='releases'").get()) {
      if (rest.length) throw Error("Unknown release: " + rest[0]);
      return [];
    }
    return ledger.db
      .transaction(() =>
        rest.length
          ? detail(ledger, rest[0])
          : ledger.db.query("SELECT * FROM releases ORDER BY created_at,release_id").all(),
      )
      .deferred();
  }
  const observations =
    ["verify", "runbook", "complete"].includes(cmd) && rest[0]
      ? observe(ledger, detail(ledger, rest[0]))
      : new Map();
  return withImmediateTx(ledger.db, () => {
    if (cmd === "create") return create(ledger, rest);
    const [id, ...args] = rest;
    if (!id || !["verify", "runbook", "complete", "cancel"].includes(cmd))
      throw Error("Expected release command and ID");
    const release = detail(ledger, id);
    if (["COMPLETED", "CANCELLED"].includes(release.status)) throw Error("Release is " + release.status);
    if (cmd === "cancel") {
      if (args.length || release.status === "APPROVED")
        throw Error("Expected a DRAFT or VERIFIED release to cancel");
      invalidate(ledger, release, "CANCELLED");
      return detail(ledger, id);
    }
    if (cmd !== "verify" && !["VERIFIED", "APPROVED"].includes(release.status))
      throw Error("Verify the release first");
    const options: ParseArgsOptionsConfig =
      cmd === "runbook"
        ? ({ tag: { type: "string", multiple: true }, kubectl: { type: "string", multiple: true } } as const)
        : cmd === "complete"
          ? ({ summary: { type: "string" } } as const)
          : {};
    const { values } = parseArgs({ args, options });
    const checked = inspect(ledger, id, observations);
    if (!checked.ok || cmd === "verify") return checked;
    if (cmd === "runbook") {
      if (release.runbook_id && ledger.getRunbook(release.runbook_id)?.status !== "REVOKED")
        throw Error("Release already linked to runbook " + release.runbook_id);
      const tags: RunbookTagAction[] = ((values.tag ?? []) as string[]).map((spec) => {
        const [repo, tag, sha, ...extra] = spec.split(":");
        if (!sha || extra.length) throw Error("Expected repo:tag:sha");
        return { repo: canonicalRepoPath(ledger.workbenchRoot, repo), tag, sha };
      });
      const rb = ledger.createRunbook({
        title: release.title,
        actions: {
          tags,
          release_observers: releaseObservers(ledger, checked),
          kubectl_commands: (values.kubectl ?? []) as string[],
          prs: releasePrActions(checked.items),
          sql_files: checked.sql_files,
        },
      });
      const actions = checkedActions({ ...checked, runbook_id: rb.runbook_id }, rb);
      ledger.db
        .query("UPDATE releases SET runbook_id=?,updated_at=? WHERE release_id=?")
        .run(rb.runbook_id, nowIso(), id);
      const human_merges = checked.items.filter(i => i.status !== "MERGED").map(i => ({
        pr_url: i.pr_url,
        base_branch: i.base_branch,
        expected_head_sha: i.expected_head_sha,
      }));
      return { ...rb, actions, release_id: id, execution_actions: productionActions(actions), human_merges,
        ...(human_merges.length && { merge_instructions:
          "审批后按所列 PR 核对目标分支、HEAD 及必需检查，通过托管平台合并，使获批 HEAD 在目标分支上保持可达（例如创建合并提交）。发布线程随后刷新各仓固定目标分支的 origin 跟踪引用，再运行 forge ledger release verify " + id + " 核验远端结果。" }) };
    }
    const prodItems = checked.items.filter((i) => isRolloutEndpoint(ledger.getTask(i.task_id)!.endpoint));
    if ((prodItems.length || checked.sql_files.length) && !release.runbook_id)
      throw Error("Production release requires an approved and COMPLETED runbook");
    if (release.runbook_id) {
      const rb = ledger.getRunbook(release.runbook_id);
      if (rb?.status !== "COMPLETED" || !rb.approved_at)
        throw Error("Linked runbook must be approved and COMPLETED");
      const approvedObservers = checkedActions(checked, rb).release_observers ?? [];
      if (canonicalJson(approvedObservers) !== canonicalJson(releaseObservers(ledger, checked)))
        throw Error("Release observer bindings changed; resume the handoff and approve the current deployment configuration");
      requireActionReceipts(ledger, id, rb);
      for (const item of prodItems) {
        const endpoint = ledger.getTask(item.task_id)!.endpoint;
        const observed = approvedObservers.some(pin => pin.task_id === item.task_id && pin.repo === item.repo && pin.branch === item.branch);
        const last = latestReceipt(ledger, id, item, observed, endpoint, rb.runbook_id);
        if (last?.status !== "pass")
          throw Error(
            "Missing SHA-bound production delivery evidence for " + item.repo + "@" + item.expected_head_sha,
          );
      }
    }
    if (checked.items.some((i) => i.status !== "MERGED")) throw Error("All release PRs must be merged");
    const task_ids = [...new Set(checked.items.map((i) => i.task_id))];
    const ts = nowIso();
    for (const task_id of task_ids) {
      appendEventInTx(ledger.db, {
        task_id,
        ts,
        event_type: "TASK_CLOSED",
        actor: "agent",
        payload: { release_id: id, runbook_id: release.runbook_id, summary: values.summary ?? null },
      });
      ledger.db.query("UPDATE tasks SET status='CLOSED',closed_at=? WHERE task_id=?").run(ts, task_id);
    }
    ledger.db
      .query("UPDATE releases SET status='COMPLETED',completed_at=?,updated_at=? WHERE release_id=?")
      .run(ts, ts, id);
    return {
      ok: true,
      release_id: id,
      status: "COMPLETED",
      task_ids,
      sweepable: checked.items.map(({ repo, branch }) => ({ repo, branch })),
    };
  });
}
