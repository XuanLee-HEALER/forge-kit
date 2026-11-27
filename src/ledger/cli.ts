import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { findWorkbenchRoot } from "../config";
import { evidenceCommands } from "./cli-evidence";
import { queryCommands } from "./cli-queries";
import { runbookCommands } from "./cli-runbook";
import { taskCommands } from "./cli-tasks";
import { fastTrackCommand } from "./fast-track";
import { handoff, resume } from "./handoff";
import { releaseCommand } from "./release";
import { telemetryCli } from "./stats";
import { Ledger } from "./store";
import { ledgerDbPath } from "./types";

const commands: Record<string, (ledger: Ledger, rest: string[]) => void> = {
  ...taskCommands,
  ...evidenceCommands,
  ...queryCommands,
  ...runbookCommands,
};

export async function runLedgerCli(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const USAGE = `Usage: forge ledger <command> [options]
Commands:
  open         --id <id> --title <title> --endpoint <investigation|local|pr|prod|instance-endpoint> --depth <targeted|full> [--repo <r> --branch <b> --base <sha> --head <sha> --worktree <p>]
  attach       <task_id> --repo <r> --branch <b> [--base <sha> --head <sha> --worktree <p>]
  detach       <task_id> --repo <r> --branch <b> [--reason <text>]
  reopen       <task_id> [--endpoint <ep>] [--depth <d>] [--reason <text>]
  set-endpoint <task_id> --endpoint <ep> [--reason <text>]
  freeze      <task_id> [--spec-dir <dir>] [--lock-tests <glob>]...
  amend       <task_id> --scope <requirement|invariant|tech_spec|test_spec> --reason <text>
  spec-status <task_id>
  decide      <task_id> --key <k> --summary <text> [--supersedes <seq>]
  blocker   <task_id> <open|close> --id <bid> --summary <text>
  record    <task_id> --kind <prod|verify|deploy|smoke|manual|note> --status <pass|fail|fallback|info> --summary <text> [--repo <r> --branch <b> --sha <sha> --meta <json>]
  reviews <task_id>
  pr-sync <task_id> --repo <repo> [--pr <number-or-url>] [--branch <branch>]
  review-record <task_id> [--repo <repo>] [--branch <branch>] --role <business|quality|simplify|comments> --base <sha> --head <sha> --status <pass|blocked|incomplete> --report <file> --summary <text> [--session-id <id>] [--model <name>] [--effort <level>]
                To resolve a failed review, cite its #N or seq N in --summary and explain each fix and its verification in the report.
  exempt    --repo <r> --branch <b> --reason <text> [--sha <sha> --ttl-hours <n>]
  status    [--task <id>] [--repo <r> --branch <b>] [--json]
  query     [--q <fts>] [--repo <r>] [--status <OPEN|HANDED_OFF|CLOSED|CANCELLED>] [--since <iso>] [--json]
  fast-track prepare <task_id> --to <endpoint> --paths <globs> [--runbook <rb-id>] [--repos <repos>] [--ttl <minutes>]
  fast-track status [<id>] [--task <task_id>]
  fast-track revoke <id> [--reason <reason>] (PENDING)
  ACTIVE: send "快轨撤销 <id>" as the entire message in the approving root session.
          Inspect the receipt and target for any claimed action.
  handoff   <task_id> [--sql host:path ...] [--rollback note]
  resume    <task_id> [--reason note]
  release   create --title text [--from-handoffs | --tasks ids | --prs repo#num,...] [--order repos]\n            PR selectors include every attachment of the selected handoff.
  release   verify|runbook|observe|complete|cancel <release_id> | status [release_id]
            For each executed SQL/tag/kubectl action, record its result on a release item:
            record <task> --kind prod --repo <repo> --branch <branch> --sha <handoff-sha> --status pass --summary <result> --meta '{"runbook_id":"<rb-id>","action_id":"<execution_actions ID>"}'
            For a release_observers item, run forge ledger release observe <release_id> after the target confirms delivery.
            For a prod item without an observer, record delivery at its handoff SHA with the same command, omitting --meta.
  stats     [--days N] [--json]
  tip       <task_id>
  verify-tip <task_id>@<hash> | --task <id> --tip <hash>
  verify    [--task <id>] [--json]
  close     <task_id> [--summary <text>] [--no-archive] [--force-incomplete --reason <text>]
  archive   <task_id>
  cancel    <task_id> --reason <text>
  prune     --before <days> [--apply] | --runs-only [--apply]
  runbook   <create|show|list|complete|revoke> [options]`;

  const runbookHelp = cmd === "runbook" && (!rest[0] || ["--help", "-h"].includes(rest[0]) ||
    (rest[0] === "create" && ["--help", "-h"].includes(rest[1])));
  if (!runbookHelp && (!cmd || cmd === "--help" || cmd === "-h" || rest.includes("--help") || rest.includes("-h"))) {
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
    const handler = Object.hasOwn(commands, cmd) && commands[cmd];
    if (!handler) throw new Error(`Unknown ledger command: ${cmd}`);
    handler(ledger, rest);
  } finally {
    ledger.closeDb();
  }
}
