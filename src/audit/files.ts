import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { withImmediateTx } from "../ledger/transactions";
import { ledgerDbPath, type LedgerReader } from "../ledger/types";
import { ensurePrivateIgnored } from "../shared/audit-ignore";
import { redactAuditText } from "../shared/redact";
import { legacyArchiveText, prepareLegacyArchive, type ArchiveLedger } from "./files-legacy";
import {
  auditChild, auditDirectory, auditFile, auditRoot, backupName, inspectBatch, pruneDirectoryName, readPrivateFile, removeBatch,
  requireAuditTask, tempPrefix, validAuditTask, writePrivateFile,
} from "./files-path";
import { auditOwner, findStagedAudit, listStagedAudits, restoreOwnedAudit } from "./files-staging";
import { captureEvidence } from "./summary-evidence";
import { buildAudit, summaryMarkdown } from "./summary";

interface AuditOptions {
  session?: string;
  noTrace?: boolean;
}

function retryCommand(task: string, options: AuditOptions = {}) {
  const visible = redactAuditText(task) === task ? task : "<task_id>";
  const parts = ["forge ledger archive"];
  if (!task.startsWith("-")) parts.push(visible);
  if (options.session) {
    const id = options.session;
    parts.push("--session", /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id) && redactAuditText(id) === id
      ? id : "<original-session-id>");
  }
  if (options.noTrace) parts.push("--no-trace");
  if (task.startsWith("-")) parts.push("--", visible);
  return parts.join(" ");
}

function publishAudit(ledger: LedgerReader, task: string, root: string, draft: string, publishLegacy?: () => void) {
  if (auditRoot(ledger.workbenchRoot) !== root || !inspectBatch(draft)) throw Error("Audit draft is unavailable");
  restoreOwnedAudit(ledger.db, root, task);
  const visible = auditChild(root, task);
  const backup = auditChild(root, backupName(task));
  const hadPrevious = inspectBatch(visible);
  if (hadPrevious) renameSync(visible, backup);
  let installed = false;
  try {
    renameSync(draft, visible);
    installed = true;
    publishLegacy?.();
  } catch (error) {
    if (installed) renameSync(visible, draft);
    if (hadPrevious) renameSync(backup, visible);
    throw error;
  }
  if (!hadPrevious) return false;
  try {
    removeBatch(backup);
    return false;
  } catch {
    return true;
  }
}

function writeAudit(ledger: ArchiveLedger, taskId: string, options: AuditOptions, legacy: boolean) {
  requireAuditTask(taskId);
  if (ledger.db.inTransaction) throw Error("Audit publication requires a committed ledger state. Retry with forge ledger archive <task_id>.");
  const snapshot = captureEvidence(ledger, taskId, options.session);
  let draft: string | undefined;
  let legacyDraft: ReturnType<typeof prepareLegacyArchive> | undefined;
  try {
    const { summary, trace } = buildAudit(snapshot, !options.noTrace);
    const root = auditRoot(ledger.workbenchRoot, true);
    if (!root) throw Error("Audit directory is unavailable");
    withImmediateTx(ledger.db, () => {
      if (auditRoot(ledger.workbenchRoot) !== root) throw Error("Audit directory changed");
      ensurePrivateIgnored(ledger.workbenchRoot, ["audit"]);
    });
    draft = mkdtempSync(join(root, tempPrefix));
    auditDirectory(draft, true);
    writePrivateFile(join(draft, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
    writePrivateFile(join(draft, "summary.md"), summaryMarkdown(summary));
    if (!options.noTrace) {
      const lines = trace.map((record: unknown) => JSON.stringify(record));
      writePrivateFile(join(draft, "trace.jsonl"), lines.length ? lines.join("\n") + "\n" : "");
    }
    if (legacy) {
      legacyDraft = prepareLegacyArchive(
        ledger, taskId, snapshot.task.closed_at ?? snapshot.task.updated_at,
        legacyArchiveText(snapshot.task, snapshot.repos, snapshot.events),
      );
    }
    const pending = withImmediateTx(ledger.db, () => {
      const task = ledger.getTask(taskId);
      if (!task || task.tip_hash !== snapshot.task.tip_hash) return null;
      return publishAudit(ledger, taskId, root, draft!, legacyDraft?.publish);
    });
    if (pending === null) throw Error("task changed during archive");
    const warnings = [...summary.warnings];
    if (pending) warnings.push("A previous audit batch remains pending cleanup");
    return { archivePath: legacyDraft?.archivePath ?? null, archive_status: summary.archive_status, warnings };
  } catch (error) {
    const reason = error instanceof Error && error.message === "task changed during archive"
      ? "task changed during archive" : "archive files could not be prepared or published safely";
    throw Error(`Audit archive failed for ${redactAuditText(taskId)} (${reason}). Check the archive destination, then retry ${retryCommand(taskId, options)}.`);
  } finally {
    // Each failed publication leaves the previous batch in its destination or the marked backup.
    try {
      if (draft && auditRoot(ledger.workbenchRoot) === dirname(draft)) removeBatch(draft);
    } catch { /* A private draft can be inspected independently. */ }
    try { legacyDraft?.cleanup(); } catch { /* The legacy draft stays in its private directory. */ }
  }
}

export function auditTask(ledger: ArchiveLedger, taskId: string, options: AuditOptions = {}) {
  return writeAudit(ledger, taskId, options, true);
}

export function autoAudit(ledger: ArchiveLedger, taskId: string, options: { legacy?: boolean } = {}): string | null {
  try {
    const result = writeAudit(ledger, taskId, {}, options.legacy !== false);
    if (result.warnings.length) {
      const shown = result.warnings.slice(0, 3).map(warning => redactAuditText(warning).replace(/[\x00-\x1f\x7f]/g, " "));
      const extra = result.warnings.length - shown.length;
      console.error(
        `Audit archive for ${redactAuditText(taskId)} is ${result.archive_status}. ` +
        shown.join(" ") + (extra ? ` See the audit summary for ${extra} more warnings.` : ""),
      );
    }
    return result.archivePath;
  } catch {
    const state = ledger.getTask(taskId)?.status ?? "unavailable";
    console.error(`Audit archive failed for ${redactAuditText(taskId)} after task status ${state}. Check the archive destination, then retry ${retryCommand(taskId)}.`);
    return null;
  }
}

function readBatchSummary(root: string, name: string): string | null {
  const batch = auditDirectory(auditChild(root, name), "read");
  return batch && readPrivateFile(auditChild(batch, "summary.json"));
}

export function readAuditDatabase(root: string): Database | null {
  if (!auditDirectory(root, false)) return null;
  const path = ledgerDbPath(root);
  const workbench = auditDirectory(auditChild(root, ".workbench"), false);
  const dir = workbench && auditDirectory(auditChild(workbench, "ledger"), false);
  if (!dir || !auditFile(auditChild(dir, "ledger.sqlite"), false)) return null;
  for (const name of ["ledger.sqlite-wal", "ledger.sqlite-shm"]) auditFile(auditChild(dir, name), false);
  return new Database(path, { readonly: true });
}

export function readAuditSummary(root: string, task: string): unknown {
  requireAuditTask(task);
  try {
    const dir = auditRoot(root, false, true);
    if (!dir) return null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const visible = readBatchSummary(dir, task);
        if (visible !== null) return JSON.parse(visible);
        const backup = readBatchSummary(dir, backupName(task));
        if (backup !== null) return JSON.parse(backup);
        const staging = auditDirectory(auditChild(dir, pruneDirectoryName), "read");
        const db = staging && readAuditDatabase(root);
        if (db) {
          try {
            const owner = auditOwner(db, task);
            const staged = owner && findStagedAudit(dir, task, owner, true);
            if (staged) {
              const content = readPrivateFile(auditChild(staged.path, "summary.json"));
              if (content !== null && auditOwner(db, task) === owner) return JSON.parse(content);
            }
          } finally {
            db.close();
          }
        }
        const retried = readBatchSummary(dir, task);
        if (retried !== null) return JSON.parse(retried);
        if (attempt === 2) return null;
      } catch (error) {
        if (attempt === 2) throw error;
      }
    }
    return null;
  } catch {
    throw Error("Audit summary is unsafe, unreadable, or corrupt");
  }
}

export function listAuditTasks(root: string): string[] {
  try {
    const dir = auditRoot(root, false, true);
    if (!dir) return [];
    const tasks = new Set<string>();
    const prefix = backupName("");
    for (const entry of readdirSync(dir)) {
      if (validAuditTask(entry)) tasks.add(entry);
      else if (entry.startsWith(prefix) && validAuditTask(entry.slice(prefix.length))) tasks.add(entry.slice(prefix.length));
    }
    const staging = auditDirectory(auditChild(dir, pruneDirectoryName), "read");
    const db = staging && readAuditDatabase(root);
    if (db) {
      try {
        for (const entry of listStagedAudits(dir, true).entries) {
          if (auditOwner(db, entry.task) === entry.hash) tasks.add(entry.task);
        }
      } finally {
        db.close();
      }
    }
    return [...tasks].sort();
  } catch {
    throw Error("Audit inventory is unsafe or unreadable");
  }
}
