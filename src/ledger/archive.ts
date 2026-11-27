import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isOid, runGit } from "../git";
import { installedInstance } from "../workflow-config";
import { prRemoteRefs, reachableFromRefs, resolveTaskCheckout } from "./checkout";
import type { TaskReader } from "./queries";
import { checkReadiness } from "./readiness";
import { deploymentStages } from "./release-inspection";
import { removeTaskRunDirectory } from "./task-runs";
import { appendEventInTx, withImmediateTx } from "./transactions";
import { isRolloutEndpoint, nowIso, usesV05, type LedgerReader, type TaskRecord } from "./types";

interface ArchiveLedger extends TaskReader {
  exportArchive(task_id: string, closedTs?: string): string;
}

export interface CloseTaskParams {
  task_id: string;
  summary?: string;
  archive?: boolean;
  forceIncomplete?: boolean;
  forceReason?: string;
  actor?: string;
  session_id?: string | null;
}

export function closeTask(ledger: ArchiveLedger, params: CloseTaskParams): { task: TaskRecord; archivePath: string | null } {
  const ev = withImmediateTx(ledger.db, () => {
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
    const closedEv = appendEventInTx(ledger.db, {
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
    return closedEv;
  });

  const task = ledger.getTask(params.task_id)!;
  let archivePath: string | null = null;
  if (params.archive !== false) {
    archivePath = ledger.exportArchive(task.task_id, ev.ts);
  }
  return { task, archivePath };
}

export function exportArchive(ledger: LedgerReader & { readonly dbPath: string }, task_id: string, closedTs?: string): string {
  const task = ledger.getTask(task_id);
  if (!task) throw new Error(`Task not found: ${task_id}`);
  const ts = closedTs ?? task.closed_at ?? task.updated_at;
  const month = ts.slice(0, 7);
  const dir = join(dirname(ledger.dbPath), "archive", month);
  mkdirSync(dir, { recursive: true });
  const outPath = join(dir, `${task.task_id}.md`);
  const repos = ledger.getTaskRepos(task.task_id);
  const events = ledger.getTaskEvents(task.task_id);

  const lines: string[] = [
    `# Task Ledger Archive: ${task.task_id}`,
    "",
    `- **Title**: ${task.title}`,
    `- **Status**: ${task.status}`,
    `- **Endpoint / Depth**: ${task.endpoint} / ${task.verification_depth}`,
    `- **Created / Closed**: ${task.created_at} → ${task.closed_at ?? "-"}`,
    `- **Chain Tip Hash**: \`${task.tip_hash}\``,
    "",
    "## Repositories",
    "",
  ];
  if (repos.length === 0) {
    lines.push("- (none)");
  } else {
    for (const r of repos) {
      lines.push(
        `- \`${r.repo}\` (${r.branch}): base=\`${r.base_sha ?? "-"}\`, head=\`${r.head_sha ?? "-"}\``,
      );
    }
  }
  lines.push("", "## Event Chain", "");
  for (const ev of events) {
    lines.push(
      `- \`#${ev.seq}\` [${ev.ts}] **${ev.event_type}** (${ev.actor}${ev.repo ? `, ${ev.repo}` : ""}${ev.sha ? `@${ev.sha.slice(0, 8)}` : ""}) \`${ev.entry_hash}\`: ${ev.payload_json}`,
    );
  }
  writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
  return outPath;
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
  if (!params.apply) return { cutoff, candidates: selectCandidates(), deleted: [] };
  const result = withImmediateTx(ledger.db, () => {
    const candidates = selectCandidates();
    const remove = ledger.db.query(`DELETE FROM tasks WHERE task_id = ? AND ${eligible}`);
    const deleted = candidates.filter(id => {
      removeTaskRunDirectory(ledger.workbenchRoot, id);
      return remove.run(id, cutoff).changes > 0;
    });
    ledger.db.query("DELETE FROM exemptions WHERE expires_at IS NOT NULL AND expires_at < ?").run(nowIso());
    return { cutoff, candidates, deleted };
  });
  if (result.deleted.length) ledger.db.exec("VACUUM;");
  return result;
}
