import { installedInstance } from "../workflow-config";
import { existsSync } from "node:fs";
import { ledgerDbPath } from "./types";
import { fastTrackCommand } from "./fast-track";
import { releaseCommand } from "./release";
import { handoff, resume } from "./handoff";
import { telemetryCli } from "./stats";
import { reviewNative, syncPr } from "./delivery-tools";
import { findWorkbenchRoot } from "../config";
import { runReviewFallback } from "./review-fallback";
import { handedOffOwner, Ledger } from "./store";
import {
  evidenceSource,
  type DeliveryEndpoint,
  type RunbookPrAction,
  type RunbookSqlFileAction,
  type RunbookStatus,
  type RunbookTagAction,
  type SpecAmendScope,
  type VerificationDepth,
} from "./types";
import { parseArgs } from "node:util";

export async function runLedgerCli(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const USAGE = `Usage: forge ledger <command> [options]
Commands:
  open         --id <id> --title <title> --endpoint <investigation|local|fat|pr|prod> --depth <targeted|full> [--repo <r> --branch <b> --base <sha> --head <sha> --worktree <p>]
  attach       <task_id> --repo <r> --branch <b> [--base <sha> --head <sha> --worktree <p>]
  detach       <task_id> --repo <r> --branch <b> [--reason <text>]
  reopen       <task_id> [--endpoint <ep>] [--depth <d>] [--reason <text>]
  set-endpoint <task_id> --endpoint <ep> [--reason <text>]
  freeze      <task_id> [--spec-dir <dir>] [--lock-tests <glob>]...
  amend       <task_id> --scope <requirement|invariant|tech_spec|test_spec> --reason <text>
  spec-status <task_id>
  decide      <task_id> --key <k> --summary <text> [--supersedes <seq>]
  blocker   <task_id> <open|close> --id <bid> --summary <text>
  record    <task_id> --kind <fat|prod|verify|deploy|smoke|manual|note> --status <pass|fail|fallback|info> --summary <text> [--repo <r> --branch <b> --sha <sha> --meta <json>]
  reviews <task_id>
  review-native --task <id> --repo <repo> --base <ref> [--branch <branch>]
  pr-sync <task_id> --repo <repo> [--pr <number-or-url>] [--branch <branch>]
  review-fallback <task_id> --repo <repo> --role <role> --sha <full-sha>
  exempt    --repo <r> --branch <b> --reason <text> [--sha <sha> --ttl-hours <n>]
  status    [--task <id>] [--repo <r> --branch <b>] [--json]
  query     [--q <fts>] [--repo <r>] [--status <OPEN|HANDED_OFF|CLOSED|CANCELLED>] [--since <iso>] [--json]
  fast-track prepare <task_id> --to <endpoint> --paths <globs> --runbook <rb-id> [--repos <repos>] [--ttl <minutes>]
  fast-track status [<id>] [--task <task_id>] | revoke <id> [--reason <reason>]
  handoff   <task_id> [--sql host:path ...] [--rollback note]
  resume    <task_id> [--reason note]
  release   create --title text [--from-handoffs | --tasks ids | --prs repo#num,...] [--order repos]\n            PR selectors include every attachment of the selected handoff.
  release   verify|runbook|complete|cancel <release_id> | status [release_id]
            For each executed SQL/tag/kubectl action, record its result on a release item:
            record <task> --kind prod --repo <repo> --branch <branch> --sha <handoff-sha> --status pass --summary <result> --meta '{"runbook_id":"<rb-id>","action_id":"<execution_actions ID>"}'
            For each prod item, record delivery at its handoff SHA with the same command, omitting --meta.
  stats     [--days N] [--json]
  tip       <task_id>
  verify-tip <task_id>@<hash> | --task <id> --tip <hash>
  verify    [--task <id>] [--json]
  close     <task_id> [--summary <text>] [--no-archive] [--force-incomplete --reason <text>]
  archive   <task_id>
  cancel    <task_id> --reason <text>
  prune     --before <days> [--apply]
  runbook   <create|show|list|complete|revoke> [options]`;

  if (!cmd || cmd === "--help" || cmd === "-h" || rest.includes("--help") || rest.includes("-h")) {
    console.log(USAGE);
    return;
  }

  const root = findWorkbenchRoot();
  const telemetry = ["stats","tip","verify-tip"].includes(cmd);
  const releaseStatus = (cmd === "release" || cmd === "fast-track") && rest[0] === "status";
  if (releaseStatus && !existsSync(ledgerDbPath(root))) {
    if (cmd==="fast-track") parseArgs({args:rest.slice(1),allowPositionals:true,options:{task:{type:"string"}}});
    else if (rest.length !== 1) throw Error("Unknown release or invalid status arguments");
    console.log("[]");
    return;
  }
  const ledger = new Ledger(root, {readonly:telemetry || releaseStatus || cmd === "reviews"});
  try {
    if (cmd === "reviews") {
      if (rest.length !== 1 || !ledger.getTask(rest[0])) throw Error("Expected an existing task ID");
      const records = ledger.getTaskEvents(rest[0]).flatMap(event => {
        if (event.event_type !== "EVIDENCE_CAPTURED") return [];
        const evidence = JSON.parse(event.payload_json);
        if (evidence.kind !== "review") return [];
        const meta = evidence.meta ?? {};
        return [{ seq: event.seq, repo: event.repo, branch: event.branch, base: meta.base,
          head: event.sha, role: meta.role, status: meta.report_status ?? evidence.status,
          backend: meta.backend, source: evidenceSource(evidence, event.actor), summary: evidence.summary }];
      });
      console.log(JSON.stringify(records, null, 2));
      return;
    }
    if (telemetry) return telemetryCli(ledger,cmd,rest);
    if (cmd === "fast-track") {
      console.log(JSON.stringify(fastTrackCommand(ledger,rest), null, 2));
      return;
    }
    if (cmd === "release") {
      const result = releaseCommand(ledger,rest);
      console.log(JSON.stringify(result,null,2));
      if ("ok" in result && !result.ok) process.exitCode = 1;
      return;
    }
    if (cmd === "resume" || cmd === "handoff") {
      const [id,...args] = rest;
      if (!id) throw Error("Expected task ID");
      const result = cmd === "resume"
        ? resume(ledger,id,parseArgs({args,options:{reason:{type:"string"}}}).values.reason)
        : (() => {
            const {values} = parseArgs({args,options:{sql:{type:"string",multiple:true},rollback:{type:"string"}}});
            return handoff(ledger,id,values.sql ?? [],values.rollback);
          })();
      console.log(JSON.stringify(result,null,2));
      return;
    }
    if (cmd === "open") {
      const { values } = parseArgs({
        args: rest,
        options: {
          id: { type: "string" },
          title: { type: "string" },
          endpoint: { type: "string" },
          depth: { type: "string", default: "full" },
          repo: { type: "string" },
          branch: { type: "string" },
          worktree: { type: "string" },
          base: { type: "string" },
          head: { type: "string" },
          actor: { type: "string", default: "agent" },
        },
      });
      if (!values.id || !values.title) {
        throw new Error("--id and --title are required");
      }
      const res = ledger.openTask({
        task_id: values.id,
        title: values.title,
        endpoint: values.endpoint ?? installedInstance(root)?.delivery.value.endpoint ?? "pr",
        depth: values.depth as VerificationDepth,
        repo: values.repo,
        branch: values.branch,
        worktree: values.worktree,
        base_sha: values.base,
        head_sha: values.head,
        actor: values.actor,
      });
      console.log(JSON.stringify(res.task, null, 2));
    } else if (cmd === "attach") {
      const task_id = rest[0];
      const { values } = parseArgs({
        args: rest.slice(1),
        options: {
          repo: { type: "string" },
          branch: { type: "string" },
          worktree: { type: "string" },
          base: { type: "string" },
          head: { type: "string" },
          actor: { type: "string", default: "agent" },
        },
      });
      if (!task_id || !values.repo || !values.branch) {
        throw new Error("Usage: forge ledger attach <task_id> --repo <r> --branch <b>");
      }
      const ev = ledger.attachRepo({
        task_id,
        repo: values.repo,
        branch: values.branch,
        worktree: values.worktree,
        base_sha: values.base,
        head_sha: values.head,
        actor: values.actor,
      });
      console.log(JSON.stringify(ev, null, 2));
    } else if (cmd === "detach") {
      const task_id = rest[0];
      const { values } = parseArgs({
        args: rest.slice(1),
        options: {
          repo: { type: "string" },
          branch: { type: "string" },
          reason: { type: "string" },
          actor: { type: "string", default: "agent" },
        },
      });
      if (!task_id || !values.repo || !values.branch) {
        throw new Error("Usage: forge ledger detach <task_id> --repo <r> --branch <b> [--reason <text>]");
      }
      const ev = ledger.detachRepo({
        task_id,
        repo: values.repo,
        branch: values.branch,
        reason: values.reason,
        actor: values.actor,
      });
      console.log(JSON.stringify(ev, null, 2));
    } else if (cmd === "reopen") {
      const task_id = rest[0];
      const { values } = parseArgs({
        args: rest.slice(1),
        options: {
          endpoint: { type: "string" },
          depth: { type: "string" },
          reason: { type: "string" },
          actor: { type: "string", default: "agent" },
        },
      });
      if (!task_id) {
        throw new Error(
          "Usage: forge ledger reopen <task_id> [--endpoint <ep>] [--depth <d>] [--reason <text>]",
        );
      }
      const res = ledger.reopenTask({
        task_id,
        endpoint: values.endpoint as DeliveryEndpoint | undefined,
        depth: values.depth as VerificationDepth | undefined,
        reason: values.reason,
        actor: values.actor,
      });
      console.log(JSON.stringify(res, null, 2));
    } else if (cmd === "set-endpoint") {
      const task_id = rest[0];
      const { values } = parseArgs({
        args: rest.slice(1),
        options: {
          endpoint: { type: "string" },
          reason: { type: "string" },
          actor: { type: "string", default: "agent" },
        },
      });
      if (!task_id || values.endpoint === undefined) {
        throw new Error("Usage: forge ledger set-endpoint <task_id> --endpoint <ep> [--reason <text>]");
      }
      const res = ledger.updateEndpoint({
        task_id,
        endpoint: values.endpoint as DeliveryEndpoint,
        reason: values.reason,
        actor: values.actor,
      });
      console.log(JSON.stringify(res, null, 2));
    } else if (cmd === "freeze") {
      const task_id = rest[0];
      const { values } = parseArgs({
        args: rest.slice(1),
        options: {
          "spec-dir": { type: "string" },
          "lock-tests": { type: "string", multiple: true },
          actor: { type: "string", default: "agent" },
        },
      });
      if (!task_id) {
        throw new Error(
          "Usage: forge ledger freeze <task_id> [--spec-dir <dir>] [--lock-tests <glob>]...",
        );
      }
      const res = ledger.freezeSpec({
        task_id,
        spec_dir: values["spec-dir"],
        locked_test_globs: values["lock-tests"] as string[] | undefined,
        actor: values.actor,
      });
      console.log(JSON.stringify(res, null, 2));
    } else if (cmd === "amend") {
      const task_id = rest[0];
      const { values } = parseArgs({
        args: rest.slice(1),
        options: {
          scope: { type: "string" },
          reason: { type: "string" },
          actor: { type: "string", default: "agent" },
        },
      });
      if (!task_id || !values.scope || !values.reason) {
        throw new Error(
          "Usage: forge ledger amend <task_id> --scope <requirement|invariant|tech_spec|test_spec> --reason <text>",
        );
      }
      const res = ledger.amendSpec({
        task_id,
        scope: values.scope as SpecAmendScope,
        reason: values.reason,
        actor: values.actor,
      });
      console.log(JSON.stringify(res, null, 2));
    } else if (cmd === "spec-status") {
      const task_id = rest[0];
      if (!task_id) throw new Error("Usage: forge ledger spec-status <task_id>");
      const task = ledger.getTask(task_id);
      if (!task) throw new Error(`Task not found: ${task_id}`);
      console.log(JSON.stringify(ledger.getSpecState(task_id), null, 2));
    } else if (cmd === "decide") {
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
    } else if (cmd === "blocker") {
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
    } else if (cmd === "review-native") {
      const { values } = parseArgs({ args: rest, options: { task: { type: "string" }, repo: { type: "string" },
        base: { type: "string" }, branch: { type: "string" } } });
      if (!values.task || !values.repo || !values.base) throw new Error("Expected --task, --repo and --base");
      const result = JSON.parse(reviewNative(ledger, values.task, values.repo, values.base, values.branch).payload_json);
      console.log(JSON.stringify(result));
      if (result.status !== "pass") process.exitCode = 1;
    } else if (cmd === "pr-sync") {
      const [task, ...args] = rest;
      const { values } = parseArgs({ args, options: { repo: { type: "string" }, pr: { type: "string" }, branch: { type: "string" } } });
      if (!task || !values.repo) throw new Error("Expected task ID and --repo");
      console.log(syncPr(ledger, task, values.repo, values.pr, values.branch).payload_json);
    } else if (cmd === "review-fallback") {
      const [task, ...args] = rest;
      const { values } = parseArgs({ args, options: { repo: { type: "string" }, role: { type: "string" }, sha: { type: "string" } } });
      if (!task || !values.repo || !values.role || !values.sha) throw new Error("Expected task ID, --repo, --role and --sha");
      const event = runReviewFallback(ledger, task, values.repo, values.role, values.sha);
      const result = JSON.parse(event.payload_json);
      console.log(JSON.stringify(result));
      if (result.status === "fail") process.exitCode = 1;
    } else if (cmd === "record") {
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
      const manualKinds = ["fat", "prod", "verify", "deploy", "smoke", "manual", "note"] as const;
      const kind = manualKinds.find(kind => kind === values.kind);
      if (!kind) throw new Error("ledger record accepts manual attestations only; run the actual verification or review tool for executable evidence.");
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
    } else if (cmd === "exempt") {
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
    } else if (cmd === "status") {
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
    } else if (cmd === "query") {
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
    } else if (cmd === "verify") {
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
    } else if (cmd === "close") {
      const task_id = rest[0];
      const { values } = parseArgs({
        args: rest.slice(1),
        options: {
          summary: { type: "string" },
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
        archive: !values["no-archive"],
        forceIncomplete: Boolean(values["force-incomplete"]),
        forceReason: values.reason,
        actor: values.actor,
      });
      console.log(JSON.stringify(res, null, 2));
    } else if (cmd === "archive") {
      const task_id = rest[0];
      if (!task_id) throw new Error("Usage: forge ledger archive <task_id>");
      const archivePath = ledger.exportArchive(task_id);
      console.log(JSON.stringify({ task_id, archivePath }, null, 2));
    } else if (cmd === "cancel") {
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
    } else if (cmd === "prune") {
      const { values } = parseArgs({
        args: rest,
        options: {
          before: { type: "string" },
          apply: { type: "boolean", default: false },
        },
      });
      if (!values.before) {
        throw new Error("Usage: forge ledger prune --before <days> [--apply]");
      }
      const days = Number(values.before.replace(/d$/i, ""));
      if (!Number.isFinite(days) || days < 0) {
        throw new Error(`Invalid --before days: ${values.before}`);
      }
      const res = ledger.prune({ beforeDays: days, apply: Boolean(values.apply) });
      console.log(JSON.stringify(res, null, 2));
    } else if (cmd === "runbook") {
      const sub = rest[0];
      if (!sub || sub === "--help" || sub === "-h" || (sub === "create" && ["--help","-h"].includes(rest[1]))) {
        console.log(`Usage: forge ledger runbook <create|show|list|complete|revoke>
  create --title <text> [--id rb-xxxx] <actions>
    Standalone: register at least one --pr <repo>:<num>, --tag <repo>:<tag>:<sha>,
                --sql <host>:<path>, or --kubectl "<command>". Flags may repeat.
    Task delivery: add --task <id>. Register a --pr for each attached repo when merging to main.
                   Pass each custom delivery stage as --stage <id> in declared order.
                   Register Kubernetes operations as versioned instance stages.
                   Production endpoints may also register an exact --tag or --sql.
    FAT task: use --task <id> --fat <repo>:fat for each attached repository. The only destination is refs/heads/fat.
    Example: forge ledger runbook create --task fix-1 --title "Merge reviewed change" --pr api:42
  show     <runbook_id>
  list     [--status <PENDING|APPROVED|COMPLETED|REVOKED>]
  complete <runbook_id>
  revoke   <runbook_id>
Note: Approval is NEVER a CLI action; the user confirms in chat with "批准 <runbook_id>" (handled by UserPromptSubmit hook).`);
        return;
      }
      if (sub === "create") {
        const { values } = parseArgs({
          args: rest.slice(1),
          options: {
            id: { type: "string" },
            task: { type: "string" },
            title: { type: "string" },
            tag: { type: "string", multiple: true },
            pr: { type: "string", multiple: true },
            sql: { type: "string", multiple: true },
            kubectl: { type: "string", multiple: true },
            stage: { type: "string", multiple: true },
            fat: { type: "string", multiple: true },
          },
        });
        if (!values.title) throw new Error("Usage: forge ledger runbook create --title <text> ...");
        const tags: RunbookTagAction[] = (values.tag ?? []).map((spec) => {
          const parts = spec.split(":");
          if (parts.length !== 3) {
            throw new Error(`Invalid --tag "${spec}" (expected <repo>:<tag>:<sha>)`);
          }
          return { repo: parts[0], tag: parts[1], sha: parts[2] };
        });
        const prs: RunbookPrAction[] = (values.pr ?? []).map((spec) => {
          const idx = spec.lastIndexOf(":");
          if (idx <= 0) {
            throw new Error(`Invalid --pr "${spec}" (expected <repo>:<number>)`);
          }
          return { repo: spec.slice(0, idx), number: Number(spec.slice(idx + 1).replace(/^#/, "")) };
        });
        const sql_files: RunbookSqlFileAction[] = (values.sql ?? []).map((spec) => {
          const idx = spec.indexOf(":");
          if (idx <= 0) {
            throw new Error(`Invalid --sql "${spec}" (expected <host>:<path>)`);
          }
          return { host: spec.slice(0, idx), path: spec.slice(idx + 1), sha256: "" };
        });
        if(values.task && values.kubectl?.length) throw Error("--task deliveries register Kubernetes operations via --stage <id>");
        if(values.fat?.length && !values.task) throw Error("--fat requires --task");
        if (values.stage?.length && !values.task) throw Error("--stage requires --task");
        const rec = ledger.createRunbook({
          runbook_id: values.id,
          task_id: values.task,
          ...(values.task && {exact_stages: values.stage ?? [],exact_fat:values.fat ?? []}),
          title: values.title,
          actions: {
            tags,
            prs,
            sql_files,
            kubectl_commands: values.kubectl ?? [],
          },
        });
        console.log(
          JSON.stringify(
            {
              ...rec,
              actions: JSON.parse(rec.actions_json),
              approval_prompt_hint: `请用户确认后回复：批准 ${rec.runbook_id}`,
            },
            null,
            2,
          ),
        );
      } else if (sub === "show") {
        const id = rest[1];
        if (!id) throw new Error("Usage: forge ledger runbook show <runbook_id>");
        const rec = ledger.getRunbook(id);
        if (!rec) throw new Error(`Runbook not found: ${id}`);
        console.log(JSON.stringify({ ...rec, actions: JSON.parse(rec.actions_json) }, null, 2));
      } else if (sub === "list") {
        const { values } = parseArgs({
          args: rest.slice(1),
          options: { status: { type: "string" } },
        });
        const list = ledger.listRunbooks(values.status as RunbookStatus | undefined);
        console.log(
          JSON.stringify(
            list.map((r) => ({ ...r, actions: JSON.parse(r.actions_json) })),
            null,
            2,
          ),
        );
      } else if (sub === "complete") {
        const id = rest[1];
        if (!id) throw new Error("Usage: forge ledger runbook complete <runbook_id>");
        console.log(JSON.stringify(ledger.completeRunbook(id), null, 2));
      } else if (sub === "revoke") {
        const id = rest[1];
        if (!id) throw new Error("Usage: forge ledger runbook revoke <runbook_id>");
        console.log(JSON.stringify(ledger.revokeRunbook(id), null, 2));
      } else {
        throw new Error(`Unknown ledger runbook subcommand: ${sub}`);
      }
    } else {
      throw new Error(`Unknown ledger command: ${cmd}`);
    }
  } finally {
    ledger.closeDb();
  }
}
