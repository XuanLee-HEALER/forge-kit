import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";

const internal = ".forge-";
export const pruneDirectoryName = internal + "prune";
export const backupName = (task: string) => internal + "previous-" + task;
export const tempPrefix = internal + "part-";

export function validAuditTask(task: string): boolean {
  return /^[a-zA-Z0-9._-]{3,80}$/.test(task) && !/^\.forge-(?:prune$|previous-|part-)/i.test(task);
}

export function requireAuditTask(task: string): void {
  if (!validAuditTask(task)) throw Error("Invalid audit task ID");
}

export function auditStat(path: string) {
  return lstatSync(path, { throwIfNoEntry: false });
}

export function auditChild(parent: string, name: string): string {
  const path = join(parent, name);
  if (auditStat(path) && !readdirSync(parent).includes(name)) {
    throw Error("Archive path does not match its owner");
  }
  return path;
}

export function auditDirectory(path: string, privateMode: boolean | "read", create = false): string | null {
  let entry = auditStat(path);
  if (!entry && create) {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    entry = auditStat(path);
  }
  if (!entry) return null;
  const mode = entry.mode & 0o7777;
  const validMode = privateMode ? mode === 0o700 || privateMode === "read" && mode === 0o500 : !!(mode & 0o100);
  if (!entry.isDirectory() || !validMode) {
    throw Error("Unsafe or inaccessible archive directory");
  }
  return path;
}

export function auditRoot(root: string, create = false, readOnly = false): string | null {
  if (!auditDirectory(root, false)) return null;
  const workbench = auditDirectory(auditChild(root, ".workbench"), false, create);
  return workbench && auditDirectory(auditChild(workbench, "audit"), readOnly ? "read" : true, create);
}

function privateFileMode(mode: number, readOnly = false) {
  return (mode & 0o7777) === 0o600 || readOnly && (mode & 0o7777) === 0o400;
}

export function auditFile(path: string, privateMode: boolean | "read" = true) {
  const entry = auditStat(path);
  if (!entry) return null;
  if (!entry.isFile() || entry.nlink !== 1 ||
    (privateMode ? !privateFileMode(entry.mode, privateMode === "read") : (entry.mode & 0o7422) !== 0o400)) {
    throw Error("Unsafe or inaccessible archive file");
  }
  return entry;
}

export function readPrivateFile(path: string): string | null {
  const entry = auditFile(path, "read");
  if (!entry) return null;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || !privateFileMode(opened.mode, true) ||
      opened.dev !== entry.dev || opened.ino !== entry.ino) throw Error("Archive file changed during read");
    return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(fd));
  } finally {
    closeSync(fd);
  }
}

export function writePrivateFile(path: string, content: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    if ((fstatSync(fd).mode & 0o7777) !== 0o600) throw Error("Cannot set private archive file permissions");
    writeFileSync(fd, content, "utf8");
  } finally {
    closeSync(fd);
  }
}

// Audit batches are flat. Refuse unexpected nested entries and links before moving or removing a batch.
export function inspectBatch(path: string): boolean {
  if (!auditDirectory(path, true)) return false;
  for (const name of readdirSync(path)) auditFile(join(path, name));
  return true;
}

export function removeBatch(path: string): void {
  if (inspectBatch(path)) rmSync(path, { recursive: true });
}

export function recoverBackup(root: string, task: string): void {
  const backup = auditChild(root, backupName(task));
  if (!inspectBatch(backup)) return;
  const visible = auditChild(root, task);
  if (!inspectBatch(visible)) {
    renameSync(backup, visible);
    return;
  }
  if (!auditFile(join(visible, "summary.json")) || !auditFile(join(visible, "summary.md"))) {
    throw Error("Archive backup recovery could not replace an incomplete directory");
  }
  removeBatch(backup);
}
