import { canonicalRepoPath } from "../config";
import { runGit } from "../git";
import { sha256File } from "../shared/path";
import { reachableFromRefs, resolveTaskCheckout } from "./checkout";
import { inspectPr, PrUnavailable } from "./pr";
import { getSpecState } from "./spec";
import {
  nowIso,
  canonicalJson,
  sha256String,
  type LedgerReader,
  type RunbookRecord,
  type RunbookActions,
  type RunbookSqlFileAction,
  type TaskBlockerRecord,
} from "./types";

export interface ReleaseLedger extends LedgerReader {
  verify(task_id: string): { ok: boolean };
  getTaskBlockers(task_id: string): TaskBlockerRecord[];
  revokeRunbook(id: string): RunbookRecord;
}
export interface HandoffItem {
  repo: string;
  branch: string;
  verified_head: string;
  base_sha: string;
  base_branch: string;
  pr_number: number;
  pr_url: string;
}
export interface Snapshot {
  items: HandoffItem[];
  sql_files: RunbookSqlFileAction[];
  sql_owners?: Array<{ path: string; repo: string; branch: string; verified_head: string }>;
  rollback_plan: string | null;
}

export function currentHandoff(ledger: ReleaseLedger, task: string) {
  const row = ledger.db
    .query<{ ledger_tip: string }, [string]>("SELECT ledger_tip FROM task_handoffs WHERE task_id=?")
    .get(task);
  if (!row || ledger.getTask(task)?.status !== "HANDED_OFF") throw Error("Task is not HANDED_OFF: " + task);
  const event = ledger.getTaskEvents(task).findLast((e) => e.event_type === "HANDOFF_RECORDED");
  if (!event || row.ledger_tip !== task + "@" + event.entry_hash || !ledger.verify(task).ok)
    throw Error("Invalid handoff tip for " + task);
  const snapshot: Snapshot = JSON.parse(event.payload_json);
  return { ...snapshot, task_id: task, ledger_tip: row.ledger_tip };
}

interface Release {
  release_id: string;
  title: string;
  status: string;
  runbook_id: string | null;
  sql_files_json: string;
  rollback_plan: string | null;
}
interface Item {
  task_id: string;
  repo: string;
  branch: string;
  base_branch: string;
  pr_number: number;
  pr_url: string;
  expected_head_sha: string;
  ledger_tip: string;
  merge_order: number;
  status: string;
  verified_head_sha: string | null;
}
export function detail(ledger: ReleaseLedger, id: string) {
  const release = ledger.db.query<Release, [string]>("SELECT * FROM releases WHERE release_id=?").get(id);
  if (!release) throw Error("Unknown release: " + id);
  const items = ledger.db
    .query<Item, [string]>("SELECT * FROM release_items WHERE release_id=? ORDER BY merge_order")
    .all(id);
  const sql_files: RunbookSqlFileAction[] = JSON.parse(release.sql_files_json);
  return { ...release, sql_files, items };
}

export function aggregate(snapshots: Snapshot[]) {
  const files = new Map<string, RunbookSqlFileAction>(),
    digests = new Map<string, string>();
  const notes: string[] = [];
  for (const snapshot of snapshots) {
    if (snapshot.rollback_plan) notes.push(snapshot.rollback_plan);
    for (const file of snapshot.sql_files) {
      if (digests.has(file.path) && digests.get(file.path) !== file.sha256)
        throw Error("Conflicting SQL digests: " + file.path);
      digests.set(file.path, file.sha256);
      files.set(JSON.stringify([file.host, file.path]), file);
    }
  }
  return { sql_files: [...files.values()], rollback_plan: notes.join("\n") || null };
}

export function invalidate(ledger: ReleaseLedger, r: Release, status: "CANCELLED" | "DRAFT") {
  if (r.runbook_id && ["APPROVED", "PENDING"].includes(ledger.getRunbook(r.runbook_id)?.status ?? ""))
    ledger.revokeRunbook(r.runbook_id);
  ledger.db
    .query("UPDATE releases SET status=?,updated_at=? WHERE release_id=?")
    .run(status, nowIso(), r.release_id);
}

// Collect network observations before taking the ledger writer lock. Local state and
// the checkout associated with each observation are checked again inside the transaction.
export function observe(ledger: ReleaseLedger, release: ReturnType<typeof detail>, deadline = Infinity) {
  const results = new Map<
    string,
    { dir: string; branch: string; base: string; head: string; state: string } | Error
  >();
  for (const item of release.items) {
    if (Date.now() >= deadline) throw new PrUnavailable("Release approval verification timed out");
    try {
      const row = ledger
        .getTaskRepos(item.task_id)
        .find((r) => r.repo === canonicalRepoPath(ledger.workbenchRoot, item.repo) && r.branch === item.branch);
      if (!row) throw Error("Missing task attachment");
      const { dir } = resolveTaskCheckout(ledger.workbenchRoot, row);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new PrUnavailable("Release approval verification timed out");
      const pr = inspectPr(dir, item.branch, item.pr_url, process.env, Math.min(2500, remaining));
      results.set(item.pr_url, {
        dir,
        branch: item.branch,
        base: pr.baseRefName,
        head: pr.headRefOid,
        state: pr.state,
      });
    } catch (error) {
      results.set(item.pr_url, error instanceof Error ? error : Error(String(error)));
    }
  }
  return results;
}

export function inspect(
  ledger: ReleaseLedger,
  id: string,
  observations: ReturnType<typeof observe>,
  deadline = Infinity,
) {
  const release = detail(ledger, id);
  const errors: string[] = [],
    retry: string[] = [];
  const snapshots = new Map<string, ReturnType<typeof currentHandoff>>();
  for (const item of release.items) {
    if (Date.now() >= deadline) throw new PrUnavailable("Release approval verification timed out");
    let status = "PENDING",
      live: string | null = null;
    try {
      const { repo, branch, task_id, expected_head_sha } = item;
      const snapshot = snapshots.get(task_id) ?? currentHandoff(ledger, task_id);
      snapshots.set(task_id, snapshot);
      if (
        snapshot.ledger_tip !== item.ledger_tip ||
        !snapshot.items.some(
          (i) =>
            i.repo === repo &&
            i.branch === branch &&
            i.base_branch === item.base_branch &&
            i.pr_number === item.pr_number &&
            i.pr_url === item.pr_url &&
            i.verified_head === expected_head_sha,
        )
      )
        throw Error("Stale handoff snapshot");
      if (ledger.getTaskBlockers(task_id).some((b) => b.status === "OPEN")) throw Error("Open blockers");
      const row = ledger
        .getTaskRepos(task_id)
        .find((r) => r.repo === canonicalRepoPath(ledger.workbenchRoot, repo) && r.branch === branch);
      if (!row) throw Error("Missing task attachment");
      const checkout = resolveTaskCheckout(ledger.workbenchRoot, row);
      const spec = getSpecState(ledger, task_id, {
        closing: true,
        delivery: {
          repo,
          head_sha: expected_head_sha,
          checkoutDir: checkout.registered ? checkout.dir : undefined,
        },
      });
      if (spec.state === "AMENDED" || spec.drift_detected) throw Error("Frozen specification or tests drifted");
      const pr = observations.get(item.pr_url);
      if (pr instanceof Error) throw pr;
      if (!pr || pr.dir !== checkout.dir || pr.branch !== branch)
        throw Error("Checkout changed during verification");
      live = pr.head;
      if (live !== expected_head_sha) {
        status = "STALE_PR";
        throw Error("Expected " + expected_head_sha + ", live " + live);
      }
      const branchRef = "refs/heads/" + branch;
      const exists = runGit(checkout.dir, ["show-ref", "--verify", "--quiet", branchRef]);
      if (exists.code === 0) {
        const local = runGit(checkout.dir, ["rev-parse", "--verify", branchRef + "^{commit}"]);
        if (local.code || local.stdout.trim() !== expected_head_sha) {
          status = "STALE_PR";
          throw Error("Local branch drift: expected " + expected_head_sha + ", found " + local.stdout.trim());
        }
      } else if (exists.code !== 1 || pr.state !== "MERGED") throw Error("Cannot verify local branch " + branch);
      if (pr.base !== item.base_branch)
        throw Error("PR base branch changed: expected " + item.base_branch + ", live " + pr.base);
      if (pr.state === "MERGED") {
        const ref = "refs/remotes/origin/" + item.base_branch;
        if (!reachableFromRefs(checkout.dir, expected_head_sha, [ref]))
          throw new PrUnavailable("Cannot verify reachability from pinned base " + ref + "; refresh origin refs");
        status = "MERGED";
      } else status = "VERIFIED";
    } catch (e) {
      if (e instanceof PrUnavailable) {
        retry.push(item.pr_url + ": " + String(e));
        continue;
      }
      errors.push(item.pr_url + ": " + String(e));
    }
    ledger.db
      .query(
        "UPDATE release_items SET status=?,verified_head_sha=? WHERE release_id=? AND task_id=? AND repo=? AND pr_number=?",
      )
      .run(status, live, id, item.task_id, item.repo, item.pr_number);
  }
  const ordered = [...snapshots.values()].sort((a, b) =>
    a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0,
  );
  if (!errors.length) {
    const expected = aggregate(ordered);
    if (
      !release.items.length ||
      ordered.reduce((n, s) => n + s.items.length, 0) !== release.items.length ||
      JSON.stringify(expected.sql_files) !== release.sql_files_json ||
      expected.rollback_plan !== release.rollback_plan
    )
      errors.push("Release snapshot mismatch");
  }
  for (const file of release.sql_files)
    if (sha256File(file.path) !== file.sha256) errors.push("SQL drift: " + file.path);
  if (errors.length) invalidate(ledger, release, "DRAFT");
  else if (!retry.length && release.status !== "APPROVED")
    ledger.db.query("UPDATE releases SET status='VERIFIED',updated_at=? WHERE release_id=?").run(nowIso(), id);
  errors.push(...retry);
  return { ...detail(ledger, id), ok: !errors.length, errors };
}

export function releasePrActions(items: Item[]) {
  return items.map((i) => ({
    repo: i.repo,
    number: i.pr_number,
    pin: { url: i.pr_url, head: i.expected_head_sha, branch: i.branch, base: i.base_branch },
  }));
}

export function checkedActions(release: ReturnType<typeof detail>, rb: RunbookRecord): RunbookActions {
  const actions: RunbookActions = JSON.parse(rb.actions_json);
  if (
    release.runbook_id !== rb.runbook_id ||
    sha256String(rb.actions_json) !== rb.actions_hash ||
    actions.tags.some(
      (tag) => !release.items.some((i) => i.repo === tag.repo && i.expected_head_sha === tag.sha),
    ) ||
    canonicalJson(actions.prs) !== canonicalJson(releasePrActions(release.items)) ||
    canonicalJson(actions.sql_files) !== canonicalJson(release.sql_files)
  )
    throw Error("Runbook actions do not match the release");
  return actions;
}

export function productionActions(actions: RunbookActions) {
  return [...actions.sql_files, ...actions.tags, ...actions.kubectl_commands].map((action) => ({
    action,
    action_id: sha256String(canonicalJson(action)),
  }));
}

export function actionMatchesItem(
  snapshot: Snapshot,
  item: HandoffItem,
  action: ReturnType<typeof productionActions>[number]["action"],
) {
  if (typeof action === "string") return true;
  if ("tag" in action) return action.repo === item.repo && action.sha === item.verified_head;
  if (!snapshot.sql_files.some((file) => canonicalJson(file) === canonicalJson(action))) return false;
  const owner = snapshot.sql_owners?.find((o) => o.path === action.path);
  if (owner)
    return owner.repo === item.repo && owner.branch === item.branch && owner.verified_head === item.verified_head;
  // Old multi-item handoffs have no trustworthy workspace/checkout attribution. Re-handoff them.
  return snapshot.sql_owners !== undefined || snapshot.items.length === 1;
}

// The action ID binds the complete approved action, including a SQL file's host, path and digest.
export function requireActionReceipts(ledger: ReleaseLedger, releaseId: string, rb: RunbookRecord) {
  const required = productionActions(JSON.parse(rb.actions_json));
  if (!required.length) return;
  const receipts = ledger.db
    .query<
      { task_id: string; repo: string; branch: string; expected_head_sha: string; payload_json: string },
      [string, string]
    >(
      `SELECT i.task_id,i.repo,i.branch,i.expected_head_sha,e.payload_json FROM events e JOIN release_items i ON i.task_id=e.task_id
       AND canonical_repo(i.repo)=canonical_repo(e.repo) AND i.branch=e.branch AND i.expected_head_sha=e.sha
     WHERE i.release_id=? AND e.event_type='EVIDENCE_CAPTURED' AND json_extract(e.payload_json,'$.kind')='prod'
       AND json_extract(e.payload_json,'$.meta.runbook_id')=? ORDER BY e.id`,
    )
    .all(releaseId, rb.runbook_id);
  const latest = new Map<string, string>();
  const snapshots = new Map<string, Snapshot>();
  for (const row of receipts) {
    const p = JSON.parse(row.payload_json);
    const snapshot = snapshots.get(row.task_id) ?? currentHandoff(ledger, row.task_id);
    snapshots.set(row.task_id, snapshot);
    const item = snapshot.items.find(
      (i) => i.repo === row.repo && i.branch === row.branch && i.verified_head === row.expected_head_sha,
    );
    const action = required.find((a) => a.action_id === p.meta.action_id)?.action;
    if (item && action && actionMatchesItem(snapshot, item, action)) latest.set(p.meta.action_id, p.status);
  }
  for (const { action_id } of required)
    if (latest.get(action_id) !== "pass")
      throw Error(
        "Missing passing production execution receipt for " +
          rb.runbook_id +
          " action " +
          action_id +
          "; record the result with ledger record --kind prod --meta containing runbook_id and action_id",
      );
}
