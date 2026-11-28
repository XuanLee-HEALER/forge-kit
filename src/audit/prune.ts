import { unlinkSync } from "node:fs";
import { withImmediateTx } from "../ledger/transactions";
import type { LedgerReader } from "../ledger/types";
import { redactAuditText } from "../shared/redact";
import { auditChild, auditDirectory, auditFile, auditRoot, backupName, validAuditTask } from "./files-path";
import {
  auditOwner, findStagedAudit, listStagedAudits, reclaimStagedAudit, restoreOwnedAudit, restoreStagedAudit,
  type StagedAudit,
} from "./files-staging";

export function auditPruneWarning(task: string, action: string): string {
  return `Audit prune could not ${action} ${redactAuditText(task)}. Retry with forge ledger prune --before <days> --apply.`;
}

export function reconcileStagedAudits(ledger: LedgerReader, root: string | null, apply: boolean): string[] {
  if (!root) return [];
  const { entries, unsafe } = listStagedAudits(root, !apply);
  const warnings: string[] = [];
  if (unsafe) warnings.push(`${unsafe} unsafe audit prune staging entries require inspection.`);
  for (const entry of entries) {
    const owns = auditOwner(ledger.db, entry.task) === entry.hash;
    if (!apply) {
      warnings.push(`Audit ${redactAuditText(entry.task)} is pending ${owns ? "restoration" : "cleanup"}.`);
      continue;
    }
    try {
      if (owns) restoreStagedAudit(entry);
      else reclaimStagedAudit(entry);
    } catch {
      warnings.push(auditPruneWarning(entry.task, owns ? "restore" : "reclaim"));
    }
  }
  return warnings;
}

export function retryPruneItems(ledger: LedgerReader, staged: StagedAudit[]): string[] {
  if (!staged.length) return [];
  const pending = () => staged.map(item => auditPruneWarning(item.task, "finish cleanup or recovery for"));
  if (ledger.db.inTransaction) return pending();
  try {
    return withImmediateTx(ledger.db, () => {
      const warnings: string[] = [];
      for (const item of staged) {
        const owned = auditOwner(ledger.db, item.task) === item.hash;
        try {
          if (auditRoot(ledger.workbenchRoot) !== item.root) throw Error("Audit directory changed");
          const current = findStagedAudit(item.root, item.task, item.hash);
          if (!current) continue;
          if (owned) restoreStagedAudit(current);
          else reclaimStagedAudit(current);
        } catch {
          warnings.push(auditPruneWarning(item.task, owned ? "restore" : "reclaim"));
        }
      }
      return warnings;
    });
  } catch {
    return pending();
  }
}

export function pruneAuditTraces(ledger: LedgerReader, days: number, apply: boolean) {
  if (!Number.isFinite(days) || days < 0) throw Error("Invalid ledger.retention_days");
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const scan = () => {
    const candidates: string[] = [];
    const deleted: string[] = [];
    const warnings: string[] = [];
    const root = auditRoot(ledger.workbenchRoot, false, !apply);
    if (!root) return { cutoff, candidates, deleted, warnings };
    const rows = ledger.db.query<{ task_id: string }, [string]>(
      "SELECT task_id FROM tasks WHERE status IN ('CLOSED','CANCELLED') AND closed_at < ? ORDER BY task_id",
    ).all(cutoff);
    for (const row of rows) {
      const id = row.task_id;
      if (!validAuditTask(id)) continue;
      try {
        if (apply) restoreOwnedAudit(ledger.db, root, id);
        const mode = apply ? true : "read";
        let dir = auditDirectory(auditChild(root, id), mode);
        if (!apply && !dir) {
          dir = auditDirectory(auditChild(root, backupName(id)), "read");
          const owner = auditOwner(ledger.db, id);
          if (!dir && owner) dir = findStagedAudit(root, id, owner, true)?.path ?? null;
        }
        if (!dir) continue;
        const trace = auditChild(dir, "trace.jsonl");
        if (!auditFile(trace, mode)) continue;
        candidates.push(id);
        if (apply) {
          unlinkSync(trace);
          deleted.push(id);
        }
      } catch {
        warnings.push(`Could not inspect or remove audit trace for ${redactAuditText(id)}. Retry with forge ledger prune --audit-traces-only --apply.`);
      }
    }
    return { cutoff, candidates, deleted, warnings };
  };
  try {
    return apply ? withImmediateTx(ledger.db, scan) : scan();
  } catch {
    throw Error("Audit trace retention could not access the audit directory safely. Retry with forge ledger prune --audit-traces-only.");
  }
}
