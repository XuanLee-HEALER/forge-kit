import { parseArgs } from "node:util";
import type { Ledger } from "./store";
import type { RunbookPrAction, RunbookSqlFileAction, RunbookStatus, RunbookTagAction } from "./types";

export const runbookCommands = {
  runbook(ledger, rest) {
    const sub = rest[0];
    if (!sub || sub === "--help" || sub === "-h" || (sub === "create" && ["--help","-h"].includes(rest[1]))) {
      console.log(`Usage: forge ledger runbook <create|show|list|complete|revoke>
  create --title <text> [--id rb-xxxx] <actions>
    Ordinary runbook: optionally associate --task <id>. Register at least one --pr <repo>:<num>, --tag <repo>:<tag>:<sha>,
                --sql <host>:<path>, or --kubectl "<command>". Flags may repeat.
    Fast-track plan: add --exact --task <id>. Register a --pr for each attached repo when merging to main.
                   Pass each custom delivery stage as --stage <id> in declared order.
                   Register Kubernetes operations as versioned instance stages.
                   Production endpoints may also register an exact --tag or --sql.
    Fast-forward: use --exact --task <id> --push <repo>:<branch> for each attached repository at the configured push endpoint.
    Example: forge ledger runbook create --exact --task fix-1 --title "Merge reviewed change" --pr api:42
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
          exact: { type: "boolean" },
          stage: { type: "string", multiple: true },
          push: { type: "string", multiple: true },
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
      if (values.exact && !values.task) throw Error("--exact requires --task <id>");
      if ((values.stage || values.push) && !values.exact) throw Error("--stage and --push require --exact --task <id>");
      if (values.exact && values.kubectl?.length) throw Error("Register exact Kubernetes operations via --stage <id>");
      const rec = ledger.createRunbook({
        runbook_id: values.id,
        task_id: values.task,
        ...(values.exact && {exact_stages: values.stage ?? [],exact_push:values.push ?? []}),
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
      throw new Error(`Unknown forge ledger runbook subcommand: ${sub}`);
    }
  },
} satisfies Record<string, (ledger: Ledger, rest: string[]) => void>;
