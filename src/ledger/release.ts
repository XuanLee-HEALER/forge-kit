import { canonicalRepoPath } from "../config";
import { randomBytes } from "node:crypto";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import {
  currentHandoff,
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
  const ids = ledger.db
    .query<{ task_id: string }, []>("SELECT task_id FROM tasks WHERE status='HANDED_OFF' ORDER BY task_id")
    .all()
    .map((t) => t.task_id);
  const wanted = new Set(values.prs?.split(","));
  const selected = values.tasks ? [...new Set(values.tasks.split(","))].sort() : ids;
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

export function releaseCommand(ledger: Ledger, argv: string[]) {
  const [cmd, ...rest] = argv;
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
          kubectl_commands: (values.kubectl ?? []) as string[],
          prs: releasePrActions(checked.items),
          sql_files: checked.sql_files,
        },
      });
      const actions = checkedActions({ ...checked, runbook_id: rb.runbook_id }, rb);
      ledger.db
        .query("UPDATE releases SET runbook_id=?,updated_at=? WHERE release_id=?")
        .run(rb.runbook_id, nowIso(), id);
      const merge_commands = checked.items
        .filter((i) => i.status !== "MERGED")
        .map((i) => "gh pr merge " + i.pr_url + " --merge --match-head-commit " + i.expected_head_sha);
      return { ...rb, actions, release_id: id, execution_actions: productionActions(actions), merge_commands };
    }
    const prodItems = checked.items.filter((i) => ledger.getTask(i.task_id)?.endpoint === "prod");
    if ((prodItems.length || checked.sql_files.length) && !release.runbook_id)
      throw Error("Production release requires an approved and COMPLETED runbook");
    if (release.runbook_id) {
      const rb = ledger.getRunbook(release.runbook_id);
      if (rb?.status !== "COMPLETED" || !rb.approved_at)
        throw Error("Linked runbook must be approved and COMPLETED");
      checkedActions(checked, rb);
      requireActionReceipts(ledger, id, rb);
      for (const item of prodItems) {
        const last = ledger.db
          .query<{ status: string }, [string, string, string, string]>(
            `SELECT json_extract(payload_json,'$.status') AS status FROM events WHERE task_id=?
           AND canonical_repo(repo)=canonical_repo(?) AND (branch=? OR branch IS NULL) AND sha=? AND event_type='EVIDENCE_CAPTURED'
           AND json_extract(payload_json,'$.kind')='prod' AND json_type(payload_json,'$.meta.action_id') IS NULL AND json_extract(payload_json,'$.status') IN ('pass','fail') ORDER BY seq DESC LIMIT 1`,
          )
          .get(item.task_id, item.repo, item.branch, item.expected_head_sha);
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
