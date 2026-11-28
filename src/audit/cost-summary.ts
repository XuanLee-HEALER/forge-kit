import { redactAuditText } from "../shared/redact";
import type { Rework, Summary } from "./summary";
import { roles, stages, sumUsage, tokenFields, type Usage } from "./usage";

const reworkFields = [
  "review_records", "review_rounds", "review_blocked", "review_incomplete", "verify_failures",
  "test_failures", "lint_failures", "build_failures", "spec_amendments",
] as const;
const statuses = ["OPEN", "HANDED_OFF", "CLOSED", "CANCELLED"];
const archiveStatuses = ["complete", "partial", "no_rollout"];
const legacyRoles = roles.filter(role => role !== "reviewer");
type ReadSummary = Omit<Summary, "by_role"> & { by_role: Omit<Summary["by_role"], "reviewer"> & { reviewer?: Usage } };

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function timestamp(value: unknown) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function validUsage(value: unknown): value is Usage {
  if (!record(value) || !tokenFields.every(field => Object.hasOwn(value, field) && (value[field] === null || count(value[field]))))
    return false;
  const { cache_hit_rate: rate, input_tokens: input, cached_input_tokens: cached } = value;
  return rate === null || count(input) && input > 0 && count(cached) && cached <= input && rate === cached / input;
}
function validBuckets(buckets: unknown, usage: Usage, keys?: readonly string[]) {
  if (!record(buckets)) return false;
  if (keys && (Object.keys(buckets).length !== keys.length || !keys.every(key => Object.hasOwn(buckets, key)))) return false;
  const values = Object.values(buckets);
  if (!values.every(validUsage)) return false;
  const sum = sumUsage(values, true);
  return tokenFields.every(field => sum[field] === usage[field]);
}

function safeString(value: unknown) {
  return typeof value === "string" && redactAuditText(value) === value;
}

export function validateSummary(value: unknown, id: string): ReadSummary {
  if (!record(value) || value.schema_version !== 1 || value.task_id !== redactAuditText(id) ||
      !timestamp(value.created_at) || !timestamp(value.captured_at) ||
      !(value.closed_at === null || timestamp(value.closed_at)) ||
      !statuses.some(status => status === value.status) || !safeString(value.endpoint) ||
      !archiveStatuses.some(status => status === value.archive_status) ||
      !Array.isArray(value.warnings) || !value.warnings.every(safeString) ||
      ![value.wall_clock_ms, value.active_ms].every(field => field === null || count(field)) ||
      !Array.isArray(value.usage_missing) || !value.usage_missing.every(field => tokenFields.includes(field)) ||
      typeof value.billing_usage_incomplete !== "boolean" ||
      !validUsage(value.usage) || !validBuckets(value.by_role, value.usage,
        record(value.by_role) && Object.hasOwn(value.by_role, "reviewer") ? roles : legacyRoles) ||
      !validBuckets(value.by_stage, value.usage, stages) || !validBuckets(value.by_model, value.usage) ||
      !Object.keys(value.by_model as object).every(safeString) ||
      !record(value.rework) || !reworkFields.every(field => count((value.rework as Rework)[field]) ||
        field === "review_rounds" && (value.rework as Rework)[field] === null) ||
      !Array.isArray(value.sessions) || !value.sessions.every(session =>
        record(session) && safeString(session.session_id) &&
        [session.role, session.model, session.effort].every(field => field === null || safeString(field)) &&
        [session.started_at, session.ended_at].every(field => field === null || timestamp(field)) &&
        (session.tool_calls === null || count(session.tool_calls)) && validUsage(session.usage)))
    throw Error("Invalid audit summary");
  return {
    schema_version: 1, task_id: value.task_id, status: value.status, endpoint: value.endpoint,
    created_at: value.created_at, closed_at: value.closed_at, captured_at: value.captured_at,
    wall_clock_ms: value.wall_clock_ms, active_ms: value.active_ms, archive_status: value.archive_status,
    warnings: value.warnings, sessions: value.sessions.map(session => ({
      session_id: session.session_id, role: session.role, model: session.model, effort: session.effort,
      started_at: session.started_at, ended_at: session.ended_at, tool_calls: session.tool_calls,
      usage: projectUsage(session.usage),
    })),
    usage: projectUsage(value.usage), usage_missing: value.usage_missing, billing_usage_incomplete: value.billing_usage_incomplete,
    by_role: projectBuckets(value.by_role), by_stage: projectBuckets(value.by_stage), by_model: projectBuckets(value.by_model),
    rework: Object.fromEntries(reworkFields.map(key => [key, (value.rework as Rework)[key]])),
  } as ReadSummary;
}

function projectUsage(value: Usage) {
  return {
    ...Object.fromEntries(tokenFields.map(key => [key, value[key]])),
    cache_hit_rate: value.cache_hit_rate,
  } as Usage;
}

function projectBuckets(value: unknown) {
  return Object.fromEntries(Object.entries(value as Record<string, Usage>).map(([key, usage]) => [key, projectUsage(usage)]));
}
