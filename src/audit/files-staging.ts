import type { Database } from "bun:sqlite";
import { readdirSync, renameSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  auditChild, auditDirectory, inspectBatch, pruneDirectoryName, recoverBackup, removeBatch,
  requireAuditTask, validAuditTask,
} from "./files-path";

const creationHash = /^[0-9a-f]{64}$/;

export interface StagedAudit {
  task: string;
  hash: string;
  path: string;
  root: string;
}

export function auditOwner(db: Database, task: string): string | null {
  const row = db.query<{ entry_hash: string }, [string]>(
    "SELECT e.entry_hash FROM tasks t JOIN events e USING (task_id) WHERE t.task_id=? AND e.event_type='TASK_OPENED' ORDER BY e.seq LIMIT 1",
  ).get(task);
  return row && creationHash.test(row.entry_hash) ? row.entry_hash : null;
}

function stagePath(root: string, task: string, hash: string, create = false, readOnly = false): StagedAudit | null {
  requireAuditTask(task);
  if (!creationHash.test(hash)) throw Error("Invalid audit owner");
  const mode = readOnly ? "read" : true;
  const staging = auditDirectory(auditChild(root, pruneDirectoryName), mode, create);
  const dir = staging && auditDirectory(auditChild(staging, task), mode, create);
  return dir ? { task, hash, path: auditChild(dir, hash), root } : null;
}

function removeEmptyStage(staged: StagedAudit): void {
  const parent = dirname(staged.path);
  if (auditDirectory(parent, true) && !readdirSync(parent).length) rmdirSync(parent);
  const staging = dirname(parent);
  if (auditDirectory(staging, true) && !readdirSync(staging).length) rmdirSync(staging);
}

export function findStagedAudit(root: string, task: string, hash: string, readOnly = false): StagedAudit | null {
  const staged = stagePath(root, task, hash, false, readOnly);
  return staged && auditDirectory(staged.path, readOnly ? "read" : true) ? staged : null;
}

export function restoreStagedAudit(staged: StagedAudit): void {
  if (!inspectBatch(staged.path)) return;
  if (inspectBatch(auditChild(staged.root, staged.task))) {
    throw Error("Audit prune recovery refused to overwrite a visible archive");
  }
  renameSync(staged.path, join(staged.root, staged.task));
  removeEmptyStage(staged);
}

export function reclaimStagedAudit(staged: StagedAudit): void {
  removeBatch(staged.path);
  removeEmptyStage(staged);
}

export function restoreOwnedAudit(db: Database, root: string, task: string): void {
  const hash = auditOwner(db, task);
  const staged = hash && findStagedAudit(root, task, hash);
  if (staged) restoreStagedAudit(staged);
  recoverBackup(root, task);
}

export function stageTaskAudit(db: Database, root: string, task: string): StagedAudit | null {
  requireAuditTask(task);
  restoreOwnedAudit(db, root, task);
  const visible = auditChild(root, task);
  if (!inspectBatch(visible)) return null;
  const hash = auditOwner(db, task);
  if (!hash) throw Error("Cannot confirm the audit owner from the creation event");
  const staged = stagePath(root, task, hash, true)!;
  if (inspectBatch(staged.path)) throw Error("Audit prune staging already exists");
  renameSync(visible, staged.path);
  return staged;
}

export function listStagedAudits(root: string, readOnly = false): { entries: StagedAudit[]; unsafe: number } {
  const entries: StagedAudit[] = [];
  let unsafe = 0;
  const mode = readOnly ? "read" : true;
  const staging = auditDirectory(auditChild(root, pruneDirectoryName), mode);
  for (const task of staging ? readdirSync(staging).sort() : []) {
    try {
      requireAuditTask(task);
      const dir = auditDirectory(auditChild(staging!, task), mode);
      if (!dir) continue;
      for (const hash of readdirSync(dir).sort()) {
        try {
          const staged = findStagedAudit(root, task, hash, readOnly);
          if (staged) entries.push(staged);
        } catch {
          unsafe++;
        }
      }
    } catch {
      unsafe++;
    }
  }
  return { entries, unsafe };
}
