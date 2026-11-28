import { existsSync } from "node:fs";
import { autoAudit } from "../audit/files";
import { auditRoot, validAuditTask } from "../audit/files-path";
import { restoreStagedAudit, stageTaskAudit, type StagedAudit } from "../audit/files-staging";
import { auditPruneWarning, reconcileStagedAudits, retryPruneItems } from "../audit/prune";
import { isOid, runGit } from "../git";
import { installedInstance } from "../workflow-config";
import { prRemoteRefs, reachableFromRefs, resolveTaskCheckout } from "./checkout";
import type { TaskReader } from "./queries";
import { checkReadiness } from "./readiness";
import { deploymentStages } from "./release-inspection";
import { removeTaskRunDirectory } from "./task-runs";
import { appendEventInTx, withImmediateTx } from "./transactions";
import { isRolloutEndpoint, nowIso, usesV05, type LedgerReader, type TaskRecord } from "./types";

export { exportArchive } from "../audit/files-legacy";

export interface CloseTaskParams {
  task_id: string;
  summary?: string;
  archive?: boolean;
  forceIncomplete?: boolean;
  forceReason?: string;
  actor?: string;
  session_id?: string | null;
}

export function closeTask(ledger: TaskReader, params: CloseTaskParams): { task: TaskRecord; archivePath: string | null } {
  withImmediateTx(ledger.db, () => {
    const task = ledger.getTask(params.task_id);
    if (!task) throw new Error(`Task not found: ${params.task_id}`);
    if (task.status !== "OPEN") {
      throw new Error(`Task ${params.task_id} is already ${task.status}`);
    }

    // Enforce readiness across all attached repos unless endpoint is investigation or explicit force-incomplete
    if (task.endpoint !== "investigation" && !params.forceIncomplete) {
      const repos = ledger.getTaskRepos(params.task_id);
      const allMissing: string[] = [];
      if (repos.length === 0) {
        allMissing.push(
          `development task (${task.endpoint}) has no attached repository; attach a repo or use --force-incomplete --reason "..."`,
        );
      }
      for (const r of repos) {
        // Verify against LIVE git branch HEAD when the repo exists on disk so unrecorded commits
        // cannot let closeTask succeed using stale earlier evidence!
        let effectiveSha = r.head_sha;
        const { dir: candidateDir } = resolveTaskCheckout(ledger.workbenchRoot, r, true);
        if (existsSync(candidateDir)) {
          const liveRes = runGit(
            candidateDir,
            ["rev-parse", "--verify", `refs/heads/${r.branch}`],
            3000,
          );
          if (liveRes.code === 0 && liveRes.stdout.trim()) {
            effectiveSha = liveRes.stdout.trim();
          } else {
            // A deployment observer witnesses an exact artifact version independently of any Git ref.
            // Other endpoint types still require reachability from their delivery destination.
            const remoteRefs = task.endpoint === "fat" ? ["refs/remotes/origin/fat"]
              : task.endpoint === "pr" ? prRemoteRefs(candidateDir, r.branch)
              : isRolloutEndpoint(task.endpoint) ? ["refs/remotes/origin/main", "refs/remotes/origin/master"] : [];
            const observedDeployment = isRolloutEndpoint(task.endpoint) && usesV05(ledger, params.task_id) &&
              deploymentStages(installedInstance(ledger.workbenchRoot), task.endpoint).length > 0 &&
              r.head_sha && isOid(r.head_sha) &&
              runGit(candidateDir, ["--no-replace-objects", "cat-file", "-e", r.head_sha + "^{commit}"]).code === 0;
            if (r.head_sha && (observedDeployment || reachableFromRefs(candidateDir, r.head_sha, remoteRefs))) {
              const deliveredCheck = checkReadiness(ledger, {
                task_id: params.task_id,
                repo: r.repo,
                branch: r.branch,
                head_sha: r.head_sha,
                checkEndpoint: true,
              }, true);
              if (deliveredCheck.ready) {
                continue;
              }
              allMissing.push(
                `${r.repo}:${r.branch} live branch refs/heads/${r.branch} could not be resolved on disk (and recorded ${r.head_sha.slice(0, 8)} lacks full evidence; detach obsolete branch with 'forge ledger detach' if abandoned)`,
                ...deliveredCheck.missing,
              );
              continue;
            }
            // Fail closed: repo exists on disk, so an unresolvable/missing branch MUST NOT
            // silently close using unverified/stale stored head_sha!
            allMissing.push(
              `${r.repo}:${r.branch} live branch refs/heads/${r.branch} could not be resolved on disk (if renamed/abandoned, run 'forge ledger detach ${params.task_id} --repo ${r.repo} --branch ${r.branch}')`,
            );
            continue;
          }
        }
        if (!effectiveSha) {
          allMissing.push(`${r.repo}:${r.branch} has no recorded head_sha`);
          continue;
        }
        const check = checkReadiness(ledger, {
          task_id: params.task_id,
          repo: r.repo,
          branch: r.branch,
          head_sha: effectiveSha,
          checkEndpoint: true,
        }, true);
        if (!check.ready) allMissing.push(...check.missing);
      }
      if (allMissing.length > 0) {
        throw new Error(
          `Cannot close task ${params.task_id}; missing completion evidence:\n- ${allMissing.join("\n- ")}\n(Pass --force-incomplete --reason "..." only if intentionally closing with documented gaps.)`,
        );
      }
    }

    if (params.forceIncomplete && !params.forceReason?.trim()) {
      throw new Error("--force-incomplete requires --reason <text>");
    }

    const ts = nowIso();
    appendEventInTx(ledger.db, {
      task_id: params.task_id,
      event_type: "TASK_CLOSED",
      actor: params.actor ?? "agent",
      session_id: params.session_id,
      ts,
      payload: {
        summary: params.summary ?? "",
        ...(params.forceIncomplete
          ? { force_incomplete: true, force_reason: params.forceReason }
          : {}),
      },
    });
    ledger.db
      .query("UPDATE tasks SET status = 'CLOSED', closed_at = ?, updated_at = ? WHERE task_id = ?")
      .run(ts, ts, params.task_id);
  });

  const task = ledger.getTask(params.task_id)!;
  const archivePath = params.archive === false ? null : autoAudit(ledger, task.task_id);
  return { task, archivePath };
}

export interface CancelTaskParams {
  task_id: string;
  reason: string;
  actor?: string;
  session_id?: string | null;
}

export function cancelTask(ledger: LedgerReader, params: CancelTaskParams): TaskRecord {
  withImmediateTx(ledger.db, () => {
    const task = ledger.getTask(params.task_id);
    if (!task) throw new Error(`Task not found: ${params.task_id}`);
    if (task.status !== "OPEN") {
      throw new Error(`Task ${params.task_id} is already ${task.status}`);
    }
    const ts = nowIso();
    appendEventInTx(ledger.db, {
      task_id: params.task_id,
      event_type: "TASK_CANCELLED",
      actor: params.actor ?? "agent",
      session_id: params.session_id,
      ts,
      payload: { reason: params.reason },
    });
    ledger.db
      .query("UPDATE tasks SET status = 'CANCELLED', closed_at = ?, updated_at = ? WHERE task_id = ?")
      .run(ts, ts, params.task_id);
  });
  return ledger.getTask(params.task_id)!;
}

export interface PruneParams { beforeDays: number; apply: boolean }

export function prune(ledger: LedgerReader, params: PruneParams): {
  cutoff: string;
  candidates: string[];
  deleted: string[];
  warnings?: string[];
} {
  const cutoff = new Date(
    Date.now() - params.beforeDays * 86400_000,
  ).toISOString();
  const eligible = "status IN ('CLOSED', 'CANCELLED') AND COALESCE(closed_at, updated_at) < ? AND NOT EXISTS (SELECT 1 FROM release_items r WHERE r.task_id=tasks.task_id) AND NOT EXISTS (SELECT 1 FROM fast_track_envelopes f JOIN exact_ship_envelopes e ON e.envelope_id=f.envelope_id WHERE f.task_id=tasks.task_id)";
  const selectCandidates = () => {
    const rows = ledger.db.query(`SELECT task_id FROM tasks WHERE ${eligible} ORDER BY created_at ASC`)
      .all(cutoff) as Array<{ task_id: string }>;
    return rows.map((row) => row.task_id);
  };
  const getAuditRoot = () => {
    try {
      return auditRoot(ledger.workbenchRoot, false, !params.apply);
    } catch {
      throw Error("Audit prune could not access the audit directory safely. Retry with forge ledger prune --before <days>.");
    }
  };
  if (!params.apply) {
    const warnings = reconcileStagedAudits(ledger, getAuditRoot(), false);
    return { cutoff, candidates: selectCandidates(), deleted: [], ...(warnings.length ? { warnings } : {}) };
  }
  if (ledger.db.inTransaction) throw Error("Prune requires its own ledger transaction");
  const staged: StagedAudit[] = [];
  let failure = "apply ledger changes";
  let failedTask = "pending audits";
  let result;
  try {
    result = withImmediateTx(ledger.db, () => {
      const root = getAuditRoot();
      const warnings = reconcileStagedAudits(ledger, root, true);
      const candidates = selectCandidates();
      const remove = ledger.db.query(`DELETE FROM tasks WHERE task_id = ? AND ${eligible}`);
      const deleted: string[] = [];
      for (const id of candidates) {
        failedTask = id;
        failure = "stage";
        const item = root && validAuditTask(id) ? stageTaskAudit(ledger.db, root, id) : null;
        if (item) staged.push(item);
        failure = "delete";
        removeTaskRunDirectory(ledger.workbenchRoot, id);
        if (remove.run(id, cutoff).changes > 0) deleted.push(id);
        else if (item) {
          restoreStagedAudit(item);
          staged.pop();
        }
      }
      failure = "commit changes for";
      ledger.db.query("DELETE FROM exemptions WHERE expires_at IS NOT NULL AND expires_at < ?").run(nowIso());
      return { cutoff, candidates, deleted, warnings };
    });
  } catch {
    const warnings = retryPruneItems(ledger, staged);
    throw Error([auditPruneWarning(failedTask, failure), ...warnings].join("\n"));
  }
  result.warnings.push(...retryPruneItems(ledger, staged));
  if (result.deleted.length) ledger.db.exec("VACUUM;");
  const { warnings, ...counts } = result;
  return { ...counts, ...(warnings.length ? { warnings } : {}) };
}
