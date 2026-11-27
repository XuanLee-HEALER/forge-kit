import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalRepoPath } from "../config";
import * as archive from "./archive";
import * as evidence from "./evidence";
import * as queries from "./queries";
import * as readiness from "./readiness";
import {
  approveRunbookFromUserPrompt,
  completeRunbook,
  createRunbook,
  getRunbook,
  listActiveApprovedRunbooks,
  listRunbooks,
  revokeRunbook,
} from "./runbook";
import { ensureInitialized, verify } from "./schema";
import { amendSpec, freezeSpec, getSpecState, listActiveSpecLocks } from "./spec";
import * as tasks from "./tasks";
import {
  ledgerDbPath,
  type EventRecord,
  type ExemptionRecord,
  type RunbookActions,
  type RunbookRecord,
  type RunbookStatus,
  type SpecAmendScope,
  type TaskBlockerRecord,
  type TaskRecord,
  type TaskRepoRecord,
  type TaskSpecState,
} from "./types";
export { handedOffOwner } from "./queries";

export class Ledger {
  readonly db: Database;
  readonly dbPath: string;
  readonly workbenchRoot: string;

  constructor(workbenchRoot: string, opts?: { dbPath?: string; busyTimeoutMs?: number; readonly?: boolean }) {
    this.workbenchRoot = workbenchRoot;
    this.dbPath = opts?.dbPath ?? ledgerDbPath(workbenchRoot);
    if (!opts?.readonly) mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath, opts?.readonly ? { readonly:true } : { create:true });
    this.db.function("canonical_repo", repo =>
      typeof repo === "string" ? canonicalRepoPath(workbenchRoot,repo) : null);
    // Set busy_timeout FIRST (lower than outer hook timeout to prevent colliding timeouts).
    const busyMs = opts?.busyTimeoutMs ?? 2500;
    this.db.exec(`PRAGMA busy_timeout = ${busyMs};`);
    this.db.exec("PRAGMA foreign_keys = ON;");
    if (!opts?.readonly) ensureInitialized(this.db);
  }

  closeDb(): void {
    this.db.close();
  }

  openTask(params: tasks.OpenTaskParams): { task: TaskRecord; event: EventRecord } {
    return tasks.openTask(this, params);
  }

  attachRepo(params: tasks.AttachRepoParams): EventRecord {
    return tasks.attachRepo(this, params);
  }

  detachRepo(params: tasks.DetachRepoParams): EventRecord {
    return tasks.detachRepo(this, params);
  }

  reopenTask(params: tasks.ReopenTaskParams): { task: TaskRecord; event: EventRecord } {
    return tasks.reopenTask(this, params);
  }

  updateEndpoint(params: tasks.UpdateEndpointParams): { task: TaskRecord; event: EventRecord } {
    return tasks.updateEndpoint(this, params);
  }

  recordDecision(params: evidence.RecordDecisionParams): EventRecord {
    return evidence.recordDecision(this, params);
  }

  recordBlocker(params: evidence.RecordBlockerParams): EventRecord {
    return evidence.recordBlocker(this, params);
  }

  recordEvidence(params: evidence.RecordEvidenceParams): EventRecord {
    return evidence.recordEvidence(this, params);
  }

  addExemption(params: evidence.AddExemptionParams): ExemptionRecord {
    return evidence.addExemption(this.db, params);
  }

  bindExemptionHeadSha(id: number, head_sha: string): void {
    return evidence.bindExemptionHeadSha(this.db, id, head_sha);
  }

  findActiveExemption(
    repo: string,
    branch: string,
  ): ExemptionRecord | null {
    return evidence.findActiveExemption(this.db, repo, branch);
  }

  findOpenTasksByRepoBranch(repo: string, branch: string): TaskRecord[] {
    return queries.findOpenTasksByRepoBranch(this.db, repo, branch);
  }

  /**
   * Trace a detached worktree commit (e.g. FAT merge commit whose parents include the feature branch HEAD)
   * back to its owning OPEN task.
   */
  findOpenTasksByRepoCommits(repo: string, shas: string[]): TaskRecord[] {
    return queries.findOpenTasksByRepoCommits(this.db, repo, shas);
  }

  getTask(task_id: string): TaskRecord | null {
    return queries.getTask(this.db, task_id);
  }

  getTaskRepos(task_id: string): TaskRepoRecord[] {
    return queries.getTaskRepos(this, task_id);
  }

  getTaskBlockers(task_id: string): TaskBlockerRecord[] {
    return queries.getTaskBlockers(this.db, task_id);
  }

  getTaskEvents(task_id: string): EventRecord[] {
    return queries.getTaskEvents(this.db, task_id);
  }

  listOpenTasks(): TaskRecord[] {
    return queries.listOpenTasks(this.db);
  }

  /**
   * Freeze the 3-document dev cycle spec package (ssot.md, tech-spec.md, test-spec.md)
   * by recording their SHA-256 digests and optional locked test globs in the task hash chain.
   */
  freezeSpec(params: {
    task_id: string;
    spec_dir?: string;
    locked_test_globs?: string[];
    actor?: string;
    session_id?: string | null;
  }): { event: EventRecord; spec: TaskSpecState } {
    return freezeSpec(this, params);
  }

  /**
   * Explicitly amend a frozen spec package (requires prior SPEC_FROZEN and non-empty reason).
   * Unlocks editing for the declared scope and marks downstream stages STALE until re-frozen & re-verified.
   */
  amendSpec(params: {
    task_id: string;
    scope: SpecAmendScope;
    reason: string;
    actor?: string;
    session_id?: string | null;
  }): { event: EventRecord; spec: TaskSpecState } {
    return amendSpec(this, params);
  }

  /**
   * Inspect current spec freeze/amend state, disk SHA-256 drift, and per-stage stale floors.
   */
  getSpecState(task_id: string): TaskSpecState {
    return getSpecState(this, task_id);
  }

  /**
   * Return spec states for all OPEN tasks that currently have a frozen or amended spec package.
   */
  listActiveSpecLocks(): TaskSpecState[] {
    return listActiveSpecLocks(this);
  }

  /**
   * Check readiness for a specific (task, repo, head_sha):
   * - Zero open blockers;
   * - If spec package is frozen: zero silent disk drift and not left in un-refrozen AMENDED state;
   * - Latest post-amend status of each executed verification kind (test/build/lint/hurl) for this exact
   *   (repo, head_sha) must not be `fail`;
   * - Unstarted review selections require a subsequent tool pass for the same role and range;
   * - Current tasks require the configured verification receipt or, for default verification, both a
   *   passing static check and an executed test. Legacy tasks retain their original evidence rules:
   * - For legacy `targeted`: at least one of test/build/lint/hurl must be `pass`;
   * - For legacy `full`: static check (`lint`) MUST be `pass`, at least one of test/build/hurl MUST be `pass`,
   *   and latest review status must be `pass` or `fallback`.
   */
  checkPushReadiness(params: readiness.ReadinessParams): {
    ready: boolean;
    missing: string[];
    hasExplicitFailure: boolean;
    recordedReviewRoles: string[];
  } {
    return readiness.checkReadiness(this, params, false);
  }

  closeTask(params: archive.CloseTaskParams): { task: TaskRecord; archivePath: string | null } {
    return archive.closeTask(this, params);
  }

  exportArchive(task_id: string, closedTs?: string): string {
    return archive.exportArchive(this, task_id, closedTs);
  }

  cancelTask(params: archive.CancelTaskParams): TaskRecord {
    return archive.cancelTask(this, params);
  }

  verify(task_id?: string): {
    ok: boolean;
    checked_tasks: number;
    checked_events: number;
    errors: string[];
  } {
    return verify(this, task_id);
  }

  query(params: queries.QueryParams): { tasks: TaskRecord[]; events: EventRecord[] } {
    return queries.query(this.db, params);
  }

  prune(params: archive.PruneParams): {
    cutoff: string;
    candidates: string[];
    deleted: string[];
  } {
    return archive.prune(this, params);
  }

  formatCompactContext(maxTasks = 8): string {
    return queries.formatCompactContext(this, maxTasks);
  }

  createRunbook(params: {
    runbook_id?: string;
    task_id?: string | null;
    title: string;
    actions: Partial<RunbookActions>;
    exact_stages?: string[];
    exact_push?: string[];
  }): RunbookRecord {
    return createRunbook(this, params);
  }

  getRunbook(runbook_id: string): RunbookRecord | null {
    return getRunbook(this, runbook_id);
  }

  listRunbooks(status?: RunbookStatus): RunbookRecord[] {
    return listRunbooks(this, status);
  }

  /**
   * Exclusively invoked by `ledger-hook` upon receiving a genuine root-session `UserPromptSubmit`.
   * NEVER exposed via `ledger` CLI so an agent cannot self-approve a runbook.
   */
  approveRunbookFromUserPrompt(params: {
    runbook_id: string;
    session_id: string;
    ttl_minutes?: number;
  }): { record: RunbookRecord; actions: RunbookActions } {
    return approveRunbookFromUserPrompt(this, params);
  }

  listActiveApprovedRunbooks(
    session_id: string,
  ): Array<{ record: RunbookRecord; actions: RunbookActions }> {
    return listActiveApprovedRunbooks(this, session_id);
  }

  completeRunbook(runbook_id: string): RunbookRecord {
    return completeRunbook(this, runbook_id);
  }

  revokeRunbook(runbook_id: string): RunbookRecord {
    return revokeRunbook(this, runbook_id);
  }
}
