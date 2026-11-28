import type { LedgerReader } from "../ledger/types";
import { redactAuditText } from "../shared/redact";
import { readRollouts } from "./rollout";
import { captureEvidence, time } from "./summary-evidence";
import { stageClassifier } from "./summary-stages";
import { roles, stages, sumUsage, tokenFields, usageBuckets, type Usage } from "./usage";

function activeDuration(intervals: [number, number][]) {
  let end = -Infinity;
  let duration = 0;
  const valid = intervals.filter(([start, finish]) => Number.isFinite(start) && Number.isFinite(finish) && finish >= start);
  for (const [start, finish] of valid.sort(([startA], [startB]) => startA - startB)) {
    duration += Math.max(0, finish - Math.max(start, end));
    end = Math.max(end, finish);
  }
  return valid.length ? duration : null;
}

export function buildAudit(ledger: LedgerReader, taskId: string, session?: string) {
  const captured = Date.now();
  const evidence = captureEvidence(ledger, taskId, session);
  const { task } = evidence;
  const rollout = readRollouts(evidence.anchors, evidence.roles);
  const classify = stageClassifier(evidence, rollout.sessions, rollout.session_intervals, captured);
  const increments = rollout.increments;
  const values = increments.map(increment => increment.usage);
  const roleKeys = increments.map(increment => roles.find(role => role === increment.role) ?? "other");
  const stageKeys = increments.map(({ ts, from_ts }) => classify(ts, from_ts));
  const modelKeys = increments.map(({ model }) => model && model === redactAuditText(model) ? model : "");
  const modelNames = [...new Set(modelKeys)].sort();
  const usageMissing = tokenFields.filter(field => !values.length || values.some(value => value[field] === null));
  const active = activeDuration(rollout.intervals);
  const wall = time(task.closed_at ?? captured) - time(task.created_at);
  const warnings = [...evidence.warnings, ...rollout.warnings];
  if (!evidence.anchors.length) warnings.push("The task has no known rollout session anchors.");
  if (!rollout.sessions.length) warnings.push("No matching rollout sessions were available.");
  if (active === null && rollout.sessions.length) warnings.push("No complete turn interval was observed.");
  if (!Number.isFinite(wall) || wall < 0) warnings.push("The task wall clock duration is unavailable.");
  if (rollout.sessions.length && usageMissing.length)
    warnings.push("Token coverage is incomplete for " + usageMissing.join(", ") + ".");
  if (modelNames.includes("")) warnings.push("Some token usage has no identifiable model.");
  const summary = {
    schema_version: 1,
    task_id: redactAuditText(task.task_id),
    status: task.status,
    endpoint: redactAuditText(task.endpoint),
    created_at: redactAuditText(task.created_at),
    closed_at: task.closed_at === null ? null : redactAuditText(task.closed_at),
    captured_at: new Date(captured).toISOString(),
    wall_clock_ms: Number.isFinite(wall) && wall >= 0 ? wall : null,
    active_ms: active,
    archive_status: (!rollout.sessions.length ? "no_rollout" : warnings.length ? "partial" : "complete") as
      "no_rollout" | "partial" | "complete",
    warnings: [...new Set(warnings.map(redactAuditText))],
    sessions: rollout.sessions.map(item => ({
      session_id: redactAuditText(item.session_id),
      role: item.role === null ? null : redactAuditText(item.role),
      model: item.model === null ? null : redactAuditText(item.model),
      effort: item.effort === null ? null : redactAuditText(item.effort),
      started_at: item.started_at,
      ended_at: item.ended_at,
      tool_calls: item.tool_calls,
      usage: item.usage,
    })),
    usage: sumUsage(values),
    usage_missing: usageMissing,
    billing_usage_incomplete: !values.length ||
      values.some(usage => usage.uncached_input_tokens === null || usage.cached_input_tokens === null || usage.output_tokens === null) ||
      rollout.usage_incomplete,
    by_role: usageBuckets(roles, values, index => roleKeys[index]),
    by_stage: usageBuckets(stages, values, index => stageKeys[index]),
    by_model: usageBuckets(modelNames, values, index => modelKeys[index]),
    rework: evidence.rework,
  };
  return { summary, trace: rollout.trace };
}

export type Summary = ReturnType<typeof buildAudit>["summary"];
export type Rework = Summary["rework"];

function cell(value: string | number | null) {
  return String(value ?? "—").replace(/[\r\n]/g, " ").replace(/\|/g, "\\|");
}

export function summaryMarkdown(summary: Summary) {
  const { task_id, usage, by_role, by_stage, by_model, sessions, rework, warnings, usage_missing, billing_usage_incomplete, ...metadata } = summary;
  const columns = [...tokenFields, "cache_hit_rate"] as const;
  const header = (fields: readonly string[]) => ["| " + fields.join(" | ") + " |", "| " + fields.map(() => "---").join(" | ") + " |"];
  const row = (fields: (string | number | null)[]) => "| " + fields.map(cell).join(" | ") + " |";
  const usageRow = (value: Usage) => columns.map(field => value[field]);
  const result = [
    "# Audit " + cell(task_id), "",
    ...header(["Field", "Value"]), ...Object.entries(metadata).map(([key, value]) => row([key, value])), "",
    "## Token usage", "",
    ...header(["Group", ...columns]), row(["Total", ...usageRow(usage)]),
    ...Object.entries(by_role).map(([key, value]) => row(["Role " + key, ...usageRow(value)])),
    ...Object.entries(by_stage).map(([key, value]) => row(["Stage " + key, ...usageRow(value)])),
    ...Object.entries(by_model).map(([key, value]) => row(["Model " + (key || "—"), ...usageRow(value)])), "",
    "## Sessions", "",
    ...header(["ID", "Role", "Model", "Effort", "Started", "Ended", "Tool calls", ...columns]),
    ...sessions.map(item => row([item.session_id, item.role, item.model, item.effort, item.started_at, item.ended_at, item.tool_calls, ...usageRow(item.usage)])), "",
    "## Rework", "",
    ...header(["Metric", "Count"]), ...Object.entries(rework).map(([key, value]) => row([key, value])), "",
  ];
  if (warnings.length) result.push("## Warnings", "", ...warnings.map(warning => "- " + cell(warning)), "");
  return result.join("\n");
}
