import { auditTask } from "../audit/files";
import { pruneAuditTraces } from "../audit/prune";
import { lifecycleSession } from "./session";
import { redactAuditText } from "../shared/redact";
import { parseArgs } from "node:util";
import { loadWorkbenchConfig } from "../config";
import { handedOffOwner } from "./queries";
import type { Ledger } from "./store";
import { pruneTaskRuns } from "./task-runs";
import { evidenceSource } from "./types";

function printArchiveResult(result: unknown) {
  console.log(JSON.stringify(result, (_key, value) =>
    typeof value === "string" ? redactAuditText(value) : value, 2));
}

export const queryCommands = {
  status(ledger, rest) {
    const { values } = parseArgs({
      args: rest,
      options: {
        task: { type: "string" },
        repo: { type: "string" },
        branch: { type: "string" },
        json: { type: "boolean", default: false },
      },
    });
    if (values.task) {
      const task = ledger.getTask(values.task);
      if (!task) throw new Error(`Task not found: ${values.task}`);
      const events = ledger.getTaskEvents(values.task);
      const data = {
        task,
        spec: ledger.getSpecState(values.task),
        repos: ledger.getTaskRepos(values.task),
        blockers: ledger.getTaskBlockers(values.task),
        events,
        evidence: events.filter(event => event.event_type === "EVIDENCE_CAPTURED").map(event => {
          const payload = JSON.parse(event.payload_json);
          return `[${evidenceSource(payload, event.actor)}] ${payload.kind}/${payload.status}`;
        }),
      };
      console.log(JSON.stringify(data, null, 2));
    } else if (values.repo && values.branch) {
      const tasks = ledger.findOpenTasksByRepoBranch(values.repo, values.branch);
      const owner = handedOffOwner(ledger,values.repo,values.branch);
      if (owner) tasks.push(owner);
      const exemption = ledger.findActiveExemption(values.repo, values.branch);
      console.log(JSON.stringify({ tasks, exemption }, null, 2));
    } else {
      const open = ledger.listOpenTasks();
      if (values.json) {
        console.log(
          JSON.stringify(
            open.map((t) => ({
              ...t,
              repos: ledger.getTaskRepos(t.task_id),
              blockers: ledger.getTaskBlockers(t.task_id),
            })),
            null,
            2,
          ),
        );
      } else if (open.length === 0) {
        console.log("No OPEN task ledgers.");
      } else {
        console.log(ledger.formatCompactContext(50));
      }
    }
  },

  query(ledger, rest) {
    const { values } = parseArgs({
      args: rest,
      options: {
        q: { type: "string" },
        repo: { type: "string" },
        status: { type: "string" },
        since: { type: "string" },
        limit: { type: "string", default: "50" },
        json: { type: "boolean", default: false },
      },
    });
    const res = ledger.query({
      q: values.q,
      repo: values.repo,
      status: values.status,
      since: values.since,
      limit: Number(values.limit),
    });
    console.log(JSON.stringify(res, null, 2));
  },

  verify(ledger, rest) {
    const { values } = parseArgs({
      args: rest,
      options: {
        task: { type: "string" },
        json: { type: "boolean", default: false },
      },
    });
    const res = ledger.verify(values.task);
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok) process.exitCode = 1;
  },

  close(ledger, rest) {
    const task_id = rest[0];
    const { values } = parseArgs({
      args: rest.slice(1),
      options: {
        summary: { type: "string" },
        "session-id": { type: "string" },
        "no-archive": { type: "boolean", default: false },
        "force-incomplete": { type: "boolean", default: false },
        reason: { type: "string" },
        actor: { type: "string", default: "agent" },
      },
    });
    if (!task_id) throw new Error("Usage: forge ledger close <task_id>");
    const res = ledger.closeTask({
      task_id,
      summary: values.summary,
      session_id: lifecycleSession(values["session-id"]),
      archive: !values["no-archive"],
      forceIncomplete: Boolean(values["force-incomplete"]),
      forceReason: values.reason,
      actor: values.actor,
    });
    printArchiveResult(res);
  },

  archive(ledger, rest) {
    const { positionals, values } = parseArgs({
      args: rest, allowPositionals: true,
      options: { session: { type: "string" }, "no-trace": { type: "boolean" } },
    });
    if (positionals.length !== 1) throw Error("Expected one task ID");
    const [task_id] = positionals;
    const result = auditTask(ledger, task_id, { session: values.session, noTrace: values["no-trace"] });
    printArchiveResult({ task_id, ...result });
  },

  cancel(ledger, rest) {
    const task_id = rest[0];
    const { values } = parseArgs({
      args: rest.slice(1),
      options: {
        reason: { type: "string" },
        actor: { type: "string", default: "agent" },
      },
    });
    if (!task_id || !values.reason) {
      throw new Error("Usage: forge ledger cancel <task_id> --reason <text>");
    }
    const res = ledger.cancelTask({
      task_id,
      reason: values.reason,
      actor: values.actor,
    });
    console.log(JSON.stringify(res, null, 2));
  },

  prune(ledger, rest) {
    const { values } = parseArgs({
      args: rest,
      options: {
        before: { type: "string" },
        "audit-traces-only": { type: "boolean" },
        "runs-only": { type: "boolean" },
        apply: { type: "boolean", default: false },
      },
    });
    if (values["audit-traces-only"]) {
      if (values.before !== undefined || values["runs-only"]) throw Error("Choose one prune mode");
      const days = loadWorkbenchConfig(ledger.workbenchRoot).ledger.retention_days;
      printArchiveResult(pruneAuditTraces(ledger, days, Boolean(values.apply)));
      return;
    }
    if (values["runs-only"]) {
      if (values.before) throw Error("--runs-only uses the configured ledger.retention_days");
      const days = loadWorkbenchConfig(ledger.workbenchRoot).ledger.retention_days;
      console.log(JSON.stringify(pruneTaskRuns(ledger, days, Boolean(values.apply)), null, 2));
      return;
    }
    if (!values.before) {
      throw new Error("Usage: forge ledger prune --before <days> [--apply]");
    }
    const days = Number(values.before.replace(/d$/i, ""));
    if (!Number.isFinite(days) || days < 0) {
      throw new Error(`Invalid --before days: ${values.before}`);
    }
    const res = ledger.prune({ beforeDays: days, apply: Boolean(values.apply) });
    console.log(JSON.stringify(res, null, 2));
  },
} satisfies Record<string, (ledger: Ledger, rest: string[]) => void>;
