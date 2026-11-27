import { parseArgs } from "node:util";
import { installedInstance } from "../workflow-config";
import type { Ledger } from "./store";
import type { DeliveryEndpoint, SpecAmendScope, VerificationDepth } from "./types";

export const taskCommands = {
  open(ledger, rest) {
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
      endpoint: values.endpoint ?? installedInstance(ledger.workbenchRoot)?.delivery.value.endpoint ?? "pr",
      depth: values.depth as VerificationDepth,
      repo: values.repo,
      branch: values.branch,
      worktree: values.worktree,
      base_sha: values.base,
      head_sha: values.head,
      actor: values.actor,
    });
    console.log(JSON.stringify(res.task, null, 2));
  },

  attach(ledger, rest) {
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
  },

  detach(ledger, rest) {
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
  },

  reopen(ledger, rest) {
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
  },

  "set-endpoint"(ledger, rest) {
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
  },

  freeze(ledger, rest) {
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
  },

  amend(ledger, rest) {
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
  },

  "spec-status"(ledger, rest) {
    const task_id = rest[0];
    if (!task_id) throw new Error("Usage: forge ledger spec-status <task_id>");
    const task = ledger.getTask(task_id);
    if (!task) throw new Error(`Task not found: ${task_id}`);
    console.log(JSON.stringify(ledger.getSpecState(task_id), null, 2));
  },
} satisfies Record<string, (ledger: Ledger, rest: string[]) => void>;
