import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, relative } from "node:path";
import { canonicalRepoPath, normalizeDbHost } from "../config";
import { runGit } from "../git";
import { canonicalizeOsPath } from "../shared/path";
import { resolveTaskCheckout } from "./checkout";
import { verifiedPr } from "./pr";
import { requireReleaseBase, type HandoffItem, type Snapshot } from "./release-inspection";
import type { Ledger } from "./store";
import { appendEventInTx, withImmediateTx } from "./transactions";
import { evidenceSource, isRolloutEndpoint, nowIso, type RunbookSqlFileAction } from "./types";

export function handoff(ledger: Ledger, task_id: string, sql: string[], rollback?: string, callbacks?:{verifyTarget:(repo:string,branch:string,oid:string,state:string)=>void; beforeRecord:(items:HandoffItem[])=>void; afterRecord:()=>void}) {
  function candidates() {
    const task = ledger.getTask(task_id);
    if (task?.status !== "OPEN" || (task.endpoint !== "pr" && !isRolloutEndpoint(task.endpoint)))
      throw Error("Expected an OPEN PR or rollout task");
    const repos = ledger.getTaskRepos(task_id);
    if (!repos.length || task.open_blockers || !ledger.verify(task_id).ok)
      throw Error("Check task attachments, blockers and ledger integrity");
    const events = ledger.getTaskEvents(task_id);
    return repos.map((row) => {
      const { repo, branch, base_sha } = row;
      const checkout = resolveTaskCheckout(ledger.workbenchRoot, row);
      const ref = "refs/heads/" + branch;
      const getHead = () => runGit(checkout.dir, ["rev-parse", "--verify", ref + "^{commit}"]).stdout.trim();
      const head = getHead();
      if (!head || !base_sha) throw Error("Cannot resolve attachment HEAD/base: " + repo + ":" + branch);
      const check = ledger.checkPushReadiness({
        task_id,
        repo,
        branch,
        head_sha: head,
        checkoutDir: checkout.registered ? checkout.dir : undefined,
      });
      if (!check.ready || !check.recordedReviewRoles.length)
        throw Error("Verification required: " + (check.missing.join(", ") || "independent review"));
      const receipt = events
        .filter(
          (e) =>
            e.repo &&
            canonicalRepoPath(ledger.workbenchRoot, e.repo) === repo &&
            e.branch === branch &&
            e.event_type === "EVIDENCE_CAPTURED",
        )
        .map((e) => ({ event: e, payload: JSON.parse(e.payload_json) }))
        .findLast(
          ({ event, payload }) => payload.kind === "pr" && evidenceSource(payload, event.actor) !== "manual",
        );
      const hint = "Run forge ledger pr-sync " + task_id + " --repo " + repo + " --branch " + branch;
      if (
        receipt?.event.sha !== head ||
        receipt.payload.status !== "pass" ||
        receipt.payload.meta?.pr_head_oid !== head ||
        !receipt.payload.meta?.pr_url
      )
        throw Error(hint);
      return {
        repo,
        branch,
        base_sha,
        verified_head: head,
        dir: checkout.dir,
        url: String(receipt.payload.meta.pr_url),
        hint,
      };
    });
  }
  const initial = candidates();
  const items = initial.map(({ repo, branch, base_sha, verified_head, dir, url, hint }) => {
    try {
      const pr = verifiedPr(dir, branch, verified_head, url, process.env, Boolean(callbacks));
      callbacks?.verifyTarget(repo,branch,pr.baseRefOid,pr.state);
      if (typeof pr.baseRefName !== "string" || !pr.baseRefName) throw Error("PR has no base branch");
      requireReleaseBase(ledger, task_id, pr.baseRefName);
      return {
        repo,
        branch,
        base_sha,
        base_branch: pr.baseRefName as string,
        verified_head,
        pr_url: String(pr.url),
        pr_number: Number(pr.url.split("/").pop()),
      };
    } catch (err) {
      throw Error(hint + ": " + err);
    }
  });
  return withImmediateTx(ledger.db, () => {
    if (JSON.stringify(candidates()) !== JSON.stringify(initial))
      throw Error("Handoff changed; repeat forge ledger pr-sync");
    callbacks?.beforeRecord(items);
    const sql_owners: NonNullable<Snapshot["sql_owners"]> = [];
    const sql_files = sql.map((spec) => {
      const match = /^(\[[^\]]+\](?::\d+)?|[^:,\s]+(?::\d+)?):(.+)$/.exec(spec);
      const path = match && canonicalizeOsPath(ledger.workbenchRoot, match[2]);
      const host = match && normalizeDbHost(match[1]);
      if (!host || !path || !statSync(path).isFile()) throw Error("Invalid SQL host or file: " + spec);
      const bytes = readFileSync(path);
      const gitDir = dirname(path);
      const commonDir = (dir: string) =>
        runGit(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout.trim();
      const owner = commonDir(gitDir);
      if (owner) {
        const top = runGit(gitDir, ["rev-parse", "--show-toplevel"]).stdout.trim();
        const rel = relative(realpathSync(top), path);
        const family = initial.filter((c) => commonDir(c.dir) === owner);
        if (!family.length && realpathSync(top) !== realpathSync(ledger.workbenchRoot))
          throw Error("SQL belongs to an unattached checkout: " + path);
        const owning = family.filter((c) => realpathSync(c.dir) === realpathSync(top));
        if (family.length && !owning.length) throw Error("SQL belongs to an unattached checkout: " + path);
        if (owning.length > 1) throw Error("Ambiguous SQL checkout: use the owning worktree path");
        for (const candidate of owning) {
          const { repo, branch, verified_head } = candidate;
          sql_owners.push({ path, repo, branch, verified_head });
          const expected = runGit(candidate.dir, ["rev-parse", "--verify", candidate.verified_head + ":" + rel]);
          const blob = createHash(candidate.verified_head.length === 64 ? "sha256" : "sha1")
            .update("blob " + bytes.length + "\0")
            .update(bytes)
            .digest("hex");
          if (expected.code || expected.stdout.trim() !== blob)
            throw Error("SQL differs from verified commit: " + path);
        }
      }
      return { host, path, sha256: createHash("sha256").update(bytes).digest("hex") };
    });
    const snapshot: Snapshot = { items, sql_files, sql_owners, rollback_plan: rollback?.trim() || null };
    const event = appendEventInTx(ledger.db, {
      task_id,
      event_type: "HANDOFF_RECORDED",
      actor: "agent",
      payload: { ...snapshot },
    });
    const ledger_tip = task_id + "@" + event.entry_hash;
    ledger.db
      .query("INSERT OR REPLACE INTO task_handoffs VALUES (?,?,?,?,?,?)")
      .run(
        task_id,
        event.ts,
        ledger_tip,
        JSON.stringify(items),
        JSON.stringify(sql_files),
        snapshot.rollback_plan,
      );
    ledger.db.query("UPDATE tasks SET status='HANDED_OFF' WHERE task_id=?").run(task_id);
    callbacks?.afterRecord();
    return {
      task_id,
      status: "HANDED_OFF",
      ledger_tip,
      ...snapshot,
      trailers: items.map((i) =>
        ["Forge-Task: " + task_id, "Verified-Head: " + i.verified_head, "Ledger-Tip: " + ledger_tip].join("\n"),
      ),
    };
  });
}

function invalidateTaskReleases(ledger: Ledger, task_id: string) {
  const affected = ledger.db
    .query<
      { release_id: string; runbook_id: string | null },
      [string]
    >("SELECT DISTINCT r.release_id,r.runbook_id FROM releases r JOIN release_items i USING(release_id) WHERE i.task_id=? AND r.status IN ('DRAFT','VERIFIED','APPROVED')")
    .all(task_id);
  for (const release of affected) {
    if (
      release.runbook_id &&
      ["APPROVED", "PENDING"].includes(ledger.getRunbook(release.runbook_id)?.status ?? "")
    )
      ledger.revokeRunbook(release.runbook_id);
    ledger.db
      .query("UPDATE releases SET status='CANCELLED', updated_at=? WHERE release_id=?")
      .run(nowIso(), release.release_id);
  }
}

export function resume(ledger: Ledger, task_id: string, reason?: string) {
  return withImmediateTx(ledger.db, () => {
    if (ledger.getTask(task_id)?.status !== "HANDED_OFF") throw Error("Expected HANDED_OFF task: " + task_id);
    invalidateTaskReleases(ledger, task_id);
    appendEventInTx(ledger.db, {
      task_id,
      event_type: "TASK_RESUMED",
      actor: "agent",
      payload: { reason: reason ?? null },
    });
    ledger.db.query("UPDATE tasks SET status='OPEN' WHERE task_id=?").run(task_id);
    return { task_id, status: "OPEN" };
  });
}
