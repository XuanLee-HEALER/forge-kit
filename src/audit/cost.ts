import type { Database } from "bun:sqlite";
import { parseArgs } from "node:util";
import { loadModelsConfig, type ModelsConfig } from "../config";
import { redactAuditText } from "../shared/redact";
import { validateSummary } from "./cost-summary";
import { listAuditTasks, readAuditDatabase, readAuditSummary } from "./files";
import type { Rework, Summary } from "./summary";
import { roles, stages, sumUsage, tokenFields, type Usage } from "./usage";

function taskDates(root: string, warnings: string[]) {
  const dates = new Map<string, number>();
  let db: Database | null = null;
  try {
    db = readAuditDatabase(root);
    const tasks = db?.query<{ task_id: string; created_at: string }, []>("SELECT task_id, created_at FROM tasks").all() ?? [];
    for (const task of tasks) dates.set(task.task_id, Date.parse(task.created_at));
  } catch { warnings.push("Ledger task coverage is unavailable."); }
  finally { db?.close(); }
  return dates;
}

function estimatedCost(summary: Summary, pricing: ModelsConfig["pricing"]) {
  if (summary.billing_usage_incomplete || !Object.keys(summary.by_model).length) return null;
  let amount = 0;
  for (const [model, usage] of Object.entries(summary.by_model)) {
    const input = usage.uncached_input_tokens;
    const cached = usage.cached_input_tokens;
    const output = usage.output_tokens;
    if (input === null || cached === null || output === null) return null;
    if (input === 0 && cached === 0 && output === 0) continue;
    const price = model && pricing && Object.hasOwn(pricing, model) ? pricing[model] : null;
    if (!price) return null;
    amount += input / 1e6 * price.input_per_1m + cached / 1e6 * price.cached_input_per_1m + output / 1e6 * price.output_per_1m;
  }
  return Number.isFinite(amount) ? amount : null;
}

function reworkScore(rework: Rework) {
  return rework.review_blocked + rework.review_incomplete + rework.verify_failures + rework.test_failures +
    rework.lint_failures + rework.build_failures + rework.spec_amendments;
}

function aggregate(summaries: Summary[]) {
  const values = summaries.map(summary => summary.usage);
  const usage = sumUsage(values, true);
  const average_usage_denominators = Object.fromEntries(tokenFields.map(field =>
    [field, values.filter(value => value[field] !== null).length]));
  const average_usage = Object.fromEntries(tokenFields.map(field =>
    [field, usage[field] === null ? null : usage[field] / average_usage_denominators[field]]));
  const groups = (key: "by_role" | "by_stage", names: readonly string[]) =>
    Object.fromEntries(names.map(name => [name, sumUsage(summaries.map(summary =>
      (summary[key] as Record<string, Usage>)[name]), true)]));
  const by_role = groups("by_role", roles);
  const by_stage = groups("by_stage", stages);
  const shares = (buckets: Record<string, Usage>) => Object.fromEntries(Object.entries(buckets)
    .map(([key, value]) => [key, usage.total_tokens ? (value.total_tokens ?? 0) / usage.total_tokens : null]));
  const rework_top = summaries.map(({ task_id, rework }) => ({ task_id, rework, score: reworkScore(rework) }))
    .sort((a, b) => b.score - a.score || (a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0));
  return {
    usage, average_usage, average_usage_denominators, by_role, by_stage,
    role_shares: shares(by_role), stage_shares: shares(by_stage), rework_top,
  };
}

function costReport(root: string, task: string | undefined, since: number | undefined) {
  const warnings: string[] = [];
  const dates = taskDates(root, warnings);
  let listed: string[] = [];
  try { if (task === undefined) listed = listAuditTasks(root); }
  catch { warnings.push("The audit directory could not be listed."); }
  const ids = task === undefined ? [...new Set([...dates.keys(), ...listed])].sort() : [task];
  const summaries: Summary[] = [];
  const coverage = {
    matched_tasks: 0, readable_summaries: 0, missing_summaries: 0, damaged_summaries: 0, partial_summaries: 0,
    unknown_creation_time: 0, no_rollout_summaries: 0,
  };
  for (const id of ids) {
    const date = dates.get(id);
    if (since !== undefined && date !== undefined && date < since) continue;
    let summary: Summary | undefined;
    let damaged = false;
    try {
      const value = readAuditSummary(root, id);
      if (value !== null && value !== undefined) summary = validateSummary(value, id);
    } catch { damaged = true; }
    if (since !== undefined) {
      const created = date !== undefined && Number.isFinite(date) ? date : Date.parse(summary?.created_at ?? "");
      if (created < since) continue;
      if (!Number.isFinite(created)) {
        coverage.unknown_creation_time++;
        continue;
      }
    }
    coverage.matched_tasks++;
    if (damaged) coverage.damaged_summaries++;
    else if (!summary) coverage.missing_summaries++;
    else {
      summaries.push(summary);
      coverage.readable_summaries++;
      if (summary.archive_status === "partial") coverage.partial_summaries++;
      if (summary.archive_status === "no_rollout") coverage.no_rollout_summaries++;
    }
  }
  if (!summaries.length) warnings.push("No audit summary is available for the selection.");
  if (coverage.missing_summaries) warnings.push("Some matching tasks have no audit summary.");
  if (coverage.damaged_summaries) warnings.push("Some matching tasks have a damaged or unreadable audit summary.");
  if (coverage.unknown_creation_time) warnings.push("Some tasks were excluded because their creation time is unknown.");
  if (coverage.partial_summaries || coverage.no_rollout_summaries) warnings.push("Rollout coverage is incomplete.");
  let pricing: ModelsConfig["pricing"];
  try { pricing = loadModelsConfig(root).pricing; }
  catch { warnings.push("The model pricing configuration could not be read."); }
  const prices = summaries.map(summary => estimatedCost(summary, pricing));
  const sum = prices.reduce<number>((total, value) => total + (value ?? 0), 0);
  const estimated_cost = prices.length && prices.length === coverage.matched_tasks && !coverage.unknown_creation_time &&
    prices.every(price => price !== null) && Number.isFinite(sum) ? sum : null;
  if (estimated_cost === null && summaries.length) warnings.push("A complete estimate is unavailable because pricing or usage coverage is incomplete.");
  const since_at = since === undefined ? null : new Date(since).toISOString();
  if (task !== undefined) {
    const summary = summaries[0];
    return {
      ...summary, task_id: redactAuditText(task), since_at, coverage, estimated_cost,
      warnings: [...new Set([...(summary?.warnings ?? []), ...warnings])],
    };
  }
  return { ...aggregate(summaries), since_at, coverage, estimated_cost, warnings };
}

function printCost(report: ReturnType<typeof costReport>) {
  const cell = (value: string | number | null | undefined) => String(value ?? "—").replace(/[\t\r\n]/g, " ");
  const row = (...values: (string | number | null | undefined)[]) => console.log(values.map(cell).join("\t"));
  const percent = (rate: number | null) => rate === null ? null : (rate * 100).toFixed(2) + "%";
  const single = "task_id" in report;
  row(single ? "Task " + report.task_id : "Task cost totals");
  if (report.since_at !== null) row("created_since", report.since_at);
  row("estimated_cost", report.estimated_cost);
  row("Coverage", ...Object.keys(report.coverage));
  row("Tasks", ...Object.values(report.coverage));
  if (report.usage && report.by_role && report.by_stage && report.coverage.readable_summaries) {
    const columns = [...tokenFields, "cache_hit_rate"];
    const counts = (usage: Usage) => [...tokenFields.map(field => usage[field]), percent(usage.cache_hit_rate)];
    row("");
    row("Token usage", ...columns);
    row("Total", ...counts(report.usage));
    if (!single && "average_usage" in report && report.average_usage && report.average_usage_denominators) {
      const mean = report.average_usage;
      const denominators = report.average_usage_denominators;
      row("Average per task", ...tokenFields.map(field => mean[field]));
      row("Average denominators", ...tokenFields.map(field => denominators[field]));
    }
    row("");
    const showBuckets = (label: string, buckets: Record<string, Usage>, shares?: Record<string, number | null>) => {
      row(label, ...columns, ...(shares ? ["total_share"] : []));
      for (const [key, usage] of Object.entries(buckets))
        row(key, ...counts(usage), ...(shares ? [percent(shares[key])] : []));
    };
    showBuckets("Role", report.by_role, "role_shares" in report ? report.role_shares : undefined);
    row("");
    showBuckets("Stage", report.by_stage, "stage_shares" in report ? report.stage_shares : undefined);
    if (single && report.rework) {
      row("");
      row("Rework", ...Object.keys(report.rework));
      row("Count", ...Object.values(report.rework));
    }
    if (!single && "rework_top" in report && report.rework_top?.length) {
      row("");
      row("Rework rank", "Task", "Score");
      for (const [index, { task_id, score }] of report.rework_top.entries()) row(index + 1, task_id, score);
    }
  }
  if (report.warnings.length) {
    row("");
    for (const warning of report.warnings) row("Warning", warning);
  }
}

export function costCli(root: string, args: string[]) {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: {
      days: { type: "string" }, json: { type: "boolean" },
    } });
  } catch { throw Error("Expected ledger cost [task] [--days N] [--json]"); }
  const { values, positionals } = parsed;
  if (positionals.length > 1) throw Error("Expected at most one task ID");
  let since: number | undefined;
  if (values.days !== undefined) {
    const days = Number(values.days);
    since = Date.now() - days * 86400000;
    if (!/^\d+$/.test(values.days) || !Number.isSafeInteger(days) || days <= 0 || since < -8640000000000000)
      throw Error("--days must be a positive integer within the supported date range");
  }
  const report = costReport(root, positionals[0], since);
  if (values.json) console.log(JSON.stringify(report));
  else printCost(report);
}
