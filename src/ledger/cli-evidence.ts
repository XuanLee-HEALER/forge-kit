import { parseArgs } from "node:util";
import { syncPr } from "./delivery-tools";
import { recordReview } from "./review-record";
import type { Ledger } from "./store";
import { evidenceSource, reviewFactKind } from "./types";

export const evidenceCommands = {
  decide(ledger, rest) {
    const task_id = rest[0];
    const { values } = parseArgs({
      args: rest.slice(1),
      options: {
        key: { type: "string" },
        summary: { type: "string" },
        supersedes: { type: "string" },
        actor: { type: "string", default: "agent" },
      },
    });
    if (!task_id || !values.key || !values.summary) {
      throw new Error("Usage: forge ledger decide <task_id> --key <k> --summary <text>");
    }
    const ev = ledger.recordDecision({
      task_id,
      key: values.key,
      summary: values.summary,
      supersedes_seq: values.supersedes ? Number(values.supersedes) : undefined,
      actor: values.actor,
    });
    console.log(JSON.stringify(ev, null, 2));
  },

  blocker(ledger, rest) {
    const task_id = rest[0];
    const action = rest[1] as "open" | "close";
    const { values } = parseArgs({
      args: rest.slice(2),
      options: {
        id: { type: "string" },
        summary: { type: "string" },
        actor: { type: "string", default: "agent" },
      },
    });
    if (!task_id || (action !== "open" && action !== "close") || !values.id || !values.summary) {
      throw new Error("Usage: forge ledger blocker <task_id> <open|close> --id <bid> --summary <text>");
    }
    const ev = ledger.recordBlocker({
      task_id,
      action,
      blocker_id: values.id,
      summary: values.summary,
      actor: values.actor,
    });
    console.log(JSON.stringify(ev, null, 2));
  },

  reviews(ledger, rest) {
    if (rest.length !== 1 || !ledger.getTask(rest[0])) throw Error("Expected an existing task ID");
    const records = ledger.getTaskEvents(rest[0]).flatMap(event => {
      if (event.event_type !== "EVIDENCE_CAPTURED") return [];
      const evidence = JSON.parse(event.payload_json);
      const kind = reviewFactKind(evidence);
      if (!kind) return [];
      const meta = evidence.meta ?? {};
      const model = typeof meta.model === "string" ? meta.model : meta.model?.model;
      const effort = meta.effort ?? meta.model?.effort;
      return [{ kind, seq: event.seq, repo: event.repo, branch: event.branch, base: meta.base,
        head: event.sha, role: meta.role, status: meta.report_status ?? evidence.status,
        backend: meta.backend, attempts: meta.attempts, coverage: meta.coverage, scheduling: meta.scheduling,
        limitations: meta.limitations, missing_materials: meta.missing_materials,
        source: evidenceSource(evidence, event.actor), summary: evidence.summary,
        report_path: meta.report_path, report_sha256: meta.report_sha256, session_id: meta.session_id,
        model, effort }];
    });
    console.log(JSON.stringify(records, null, 2));
    return;
  },

  "pr-sync"(ledger, rest) {
    const [task, ...args] = rest;
    const { values } = parseArgs({ args, options: { repo: { type: "string" }, pr: { type: "string" }, branch: { type: "string" } } });
    if (!task || !values.repo) throw new Error("Expected task ID and --repo");
    console.log(syncPr(ledger, task, values.repo, values.pr, values.branch).payload_json);
  },

  "review-record"(ledger, rest) {
    const [task, ...args] = rest;
    const { values } = parseArgs({ args, options: {
      repo: { type: "string" }, branch: { type: "string" }, role: { type: "string" },
      base: { type: "string" }, head: { type: "string" }, status: { type: "string" },
      report: { type: "string" }, summary: { type: "string" }, "session-id": { type: "string" },
      model: { type: "string" }, effort: { type: "string" },
    } });
    if (!task) throw Error("Expected a task ID");
    console.log(JSON.stringify(recordReview(ledger, task, values), null, 2));
  },

  record(ledger, rest) {
    const task_id = rest[0];
    const { values } = parseArgs({
      args: rest.slice(1),
      options: {
        kind: { type: "string" },
        status: { type: "string", default: "info" },
        summary: { type: "string" },
        repo: { type: "string" },
        branch: { type: "string" },
        sha: { type: "string" },
        meta: { type: "string" },
      },
    });
    if (!task_id || !values.kind || !values.summary) {
      throw new Error("Usage: forge ledger record <task_id> --kind <k> --status <s> --summary <text>");
    }
    const manualKinds = ["prod", "verify", "deploy", "smoke", "manual", "note"] as const;
    const kind = manualKinds.find(kind => kind === values.kind);
    if (!kind) throw new Error("forge ledger record accepts manual attestations only; run the actual verification or review tool for executable evidence. For native reports, use forge ledger review-record.");
    const parsedMeta = values.meta ? JSON.parse(values.meta) : {};
    const ev = ledger.recordEvidence({
      task_id,
      kind,
      source: "manual",
      status: values.status as "pass" | "fail" | "fallback" | "info",
      summary: values.summary,
      repo: values.repo,
      branch: values.branch,
      sha: values.sha,
      meta: Object.keys(parsedMeta).length > 0 ? parsedMeta : undefined,
    });
    console.log(JSON.stringify(ev, null, 2));
  },

  exempt(ledger, rest) {
    const { values } = parseArgs({
      args: rest,
      options: {
        repo: { type: "string" },
        branch: { type: "string" },
        reason: { type: "string" },
        sha: { type: "string" },
        "ttl-hours": { type: "string", default: "24" },
      },
    });
    if (!values.repo || !values.branch || !values.reason) {
      throw new Error("Usage: forge ledger exempt --repo <r> --branch <b> --reason <text>");
    }
    const rec = ledger.addExemption({
      repo: values.repo,
      branch: values.branch,
      reason: values.reason,
      head_sha: values.sha,
      ttl_hours: Number(values["ttl-hours"]),
    });
    console.log(JSON.stringify(rec, null, 2));
  },
} satisfies Record<string, (ledger: Ledger, rest: string[]) => void>;
