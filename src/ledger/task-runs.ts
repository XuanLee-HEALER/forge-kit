import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { LedgerReader } from "./types";

const taskName = /^[a-zA-Z0-9._-]{3,80}$/;

function runsRoot(root: string) {
  const dir = join(root, ".workbench", "runs");
  if (existsSync(dir) && !lstatSync(dir).isDirectory()) throw Error("Expected a runs directory: " + dir);
  return dir;
}

export function taskRunDirectory(root: string, task: string) {
  if (!taskName.test(task)) throw Error("Invalid task ID");
  const dir = join(runsRoot(root), task);
  mkdirSync(dir, {recursive: true, mode: 0o700});
  if (!lstatSync(dir).isDirectory()) throw Error("Expected a task runs directory: " + dir);
  return dir;
}

// Explicit ledger pruning removes the owner row. Clear its disposable output
// first so an interrupted prune can be retried using the same row.
export function removeTaskRunDirectory(root: string, task: string) {
  if (!taskName.test(task)) return;
  const dir = join(runsRoot(root), task);
  rmSync(dir, {recursive: true, force: true});
}

export function pruneTaskRuns(ledger: LedgerReader, days: number, apply: boolean) {
  if (!Number.isFinite(days) || days < 0) throw Error("Invalid ledger.retention_days");
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const dir = runsRoot(ledger.workbenchRoot);
  const candidates: string[] = [];
  const deleted: string[] = [];
  for (const entry of existsSync(dir) ? readdirSync(dir, {withFileTypes: true}) : []) {
    if (!entry.isDirectory()) continue;
    const task = ledger.getTask(entry.name);
    if (!task || !["CLOSED","CANCELLED"].includes(task.status) || !task.closed_at || task.closed_at >= cutoff) continue;
    candidates.push(entry.name);
    if (apply) {
      rmSync(join(dir, entry.name), {recursive: true});
      deleted.push(entry.name);
    }
  }
  return {cutoff, candidates, deleted};
}
