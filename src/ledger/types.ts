import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { join } from "node:path";

export function normalizeReviewRole(role?: string | null): string {
  const raw = (role ?? "").trim().toLowerCase();
  if (!raw) return "default";
  if (raw.startsWith("review-")) return raw.slice("review-".length);
  return raw;
}

export type TaskStatus = "OPEN" | "CLOSED" | "CANCELLED";

export type DeliveryEndpoint = "investigation" | "local" | "fat" | "pr" | "prod";

export type VerificationDepth = "targeted" | "full";

export type SpecAmendScope = "requirement" | "invariant" | "tech_spec" | "test_spec";

export interface SpecFrozenPayload {
  spec_dir: string;
  files: { ssot: string; tech_spec: string; test_spec: string };
  hashes: { ssot: string; tech_spec: string; test_spec: string };
  locked_test_globs: string[];
}

export interface SpecAmendedPayload {
  scope: SpecAmendScope;
  reason: string;
  stale_stages: string[];
}

export interface TaskSpecState {
  task_id: string;
  state: "NONE" | "FROZEN" | "AMENDED";
  freeze_seq: number | null;
  amend_seq: number | null;
  spec_dir: string | null;
  files: { ssot: string; tech_spec: string; test_spec: string } | null;
  hashes: { ssot: string; tech_spec: string; test_spec: string } | null;
  locked_test_globs: string[];
  amend_scope: SpecAmendScope | null;
  amend_scopes: SpecAmendScope[];
  amend_reason: string | null;
  stale_stages: string[];
  drifted_files: string[];
  evidence_floor_seq: { lint: number; test: number; review: number; fat: number };
}

export function sha256String(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export const ENDPOINT_RANK: Record<DeliveryEndpoint, number> = {
  investigation: 0,
  local: 1,
  fat: 2,
  pr: 3,
  prod: 4,
};

export interface TaskRecord {
  task_id: string;
  title: string;
  status: TaskStatus;
  endpoint: DeliveryEndpoint;
  verification_depth: VerificationDepth;
  open_blockers: number;
  last_verified_sha: string | null;
  tip_hash: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface TaskRepoRecord {
  repo: string;
  branch: string;
  worktree: string | null;
  task_id: string;
  base_sha: string | null;
  head_sha: string | null;
  attached_at: string;
}

export interface TaskBlockerRecord {
  task_id: string;
  blocker_id: string;
  status: "OPEN" | "CLOSED";
  summary: string;
  opened_at: string;
  closed_at: string | null;
}

export interface EventRecord {
  id: number;
  task_id: string;
  seq: number;
  ts: string;
  event_type: string;
  actor: string;
  session_id: string | null;
  tool_use_id: string | null;
  repo: string | null;
  branch: string | null;
  sha: string | null;
  payload_json: string;
  prev_hash: string;
  entry_hash: string;
}

export interface ExemptionRecord {
  id: number;
  repo: string;
  branch: string;
  head_sha: string | null;
  reason: string;
  created_at: string;
  expires_at: string | null;
}

export type RunbookStatus = "PENDING" | "APPROVED" | "COMPLETED" | "REVOKED";

export interface RunbookTagAction {
  repo: string;
  tag: string;
  sha: string;
}

export interface RunbookPrAction {
  repo: string;
  number: number;
}

export interface RunbookSqlFileAction {
  host: string;
  path: string;
  sha256: string;
}

export interface RunbookActions {
  tags: RunbookTagAction[];
  prs: RunbookPrAction[];
  sql_files: RunbookSqlFileAction[];
  kubectl_commands: string[];
}

export interface RunbookRecord {
  runbook_id: string;
  task_id: string | null;
  title: string;
  status: RunbookStatus;
  actions_json: string;
  actions_hash: string;
  created_at: string;
  approved_at: string | null;
  approved_session_id: string | null;
  expires_at: string | null;
  completed_at: string | null;
  revoked_at: string | null;
}

export const VALID_ENDPOINTS = new Set<string>([
  "investigation",
  "local",
  "fat",
  "pr",
  "prod",
]);

export const VALID_DEPTHS = new Set<string>(["targeted", "full"]);

export function nowIso(): string {
  return new Date().toISOString();
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

export function computeEntryHash(fields: {
  prev_hash: string;
  task_id: string;
  seq: number;
  ts: string;
  event_type: string;
  actor: string;
  session_id: string | null;
  tool_use_id: string | null;
  repo: string | null;
  branch: string | null;
  sha: string | null;
  payload_json: string;
}): string {
  // Length-prefixed canonical framing prevents field-delimiter collision attacks.
  const preimage = JSON.stringify([
    fields.prev_hash,
    fields.task_id,
    fields.seq,
    fields.ts,
    fields.event_type,
    fields.actor,
    fields.session_id ?? null,
    fields.tool_use_id ?? null,
    fields.repo ?? null,
    fields.branch ?? null,
    fields.sha ?? null,
    fields.payload_json,
  ]);
  return createHash("sha256").update(preimage).digest("hex");
}

export function ledgerDbPath(workbenchRoot: string): string {
  return join(workbenchRoot, ".workbench", "ledger", "ledger.sqlite");
}

export interface LedgerReader {
  readonly db: Database;
  readonly workbenchRoot: string;
  getTask(task_id: string): TaskRecord | null;
  getTaskEvents(task_id: string): EventRecord[];
  getRunbook(runbook_id: string): RunbookRecord | null;
  getSpecState(task_id: string): TaskSpecState;
  listOpenTasks(): TaskRecord[];
}
