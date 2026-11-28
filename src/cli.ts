import { parseArgs } from "node:util";
import { findWorkbenchRoot } from "./config";
import { resolveInstance, runInstanceStage } from "./instance";
import { checkMigration } from "./managed-assets";
import { checkCodexHooksTrust, doctorWorkbench } from "./workbench/doctor";
import { initWorkbench, syncWorkbench } from "./workbench/install";
import { addRepo } from "./workbench/repos";

export { findKitRoot } from "./kit-root";
export type { DoctorIssue } from "./workbench/doctor";
export { addRepo, checkCodexHooksTrust, doctorWorkbench, initWorkbench, syncWorkbench };

export async function runForgeCli(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(`forge-kit CLI

Usage:
  forge init <dir> [--name <name>] [--git-org <org>] [--force]
  forge add-repo <repo-path> [--workbench <dir>] [--force]
  forge sync [<dir>]
  forge doctor [<dir>] [--json]
  forge apply [<dir>] [--repo <path>...] [--focus <rel-path>...] [--days N] [--json]
  forge apply check [--repo <r>] [--domain <d> | --path <rel-path>...] [--json]
  forge apply status [--repo <r>] [--json]
  forge instance list [--json]
  forge instance show <kind> <id> [--json]
  forge instance run <stage-id>
  forge rt <list|status|changes|logs|query|metrics> [--json]
  forge verify --task <task-id> --cwd <checkout> --mode all   Run the configured verification stages
  forge ship | ledger | git | guard | ledger-hook | dbcred | cmdfmt | lang-check`);
    return;
  }

  if (cmd === "apply") {
    return (await import("./apply/cli")).runApplyCli(rest);
  }
  if (cmd === "rt") {
    return (await import("./rt/cli")).runRuntimeCli(rest);
  }

  if (cmd === "instance") {
    const [verb, ...args] = rest.filter((a) => a !== "--json");
    const root = findWorkbenchRoot();
    checkMigration(root);
    const c = resolveInstance(root);
    if (verb === "run" && args.length === 1) {
      const id = args[0];
      const stage = c.stages.get(id);
      if (stage?.source === "core" && stage.id === "verify") {
        const {verifyCli}=await import("./wb-verify");
        const result=verifyCli([]);
        console.log(JSON.stringify(result));
        process.exitCode=result.ok?0:1;
      } else {
        process.exitCode = runInstanceStage(root, id);
      }
      return;
    }
    const items = [
      c.verification,
      c.delivery,
      ...c.actions.values(),
      ...c.stages.values(),
      ...c.skills.values(),
    ];
    if (verb === "list" && !args.length) {
      console.log(JSON.stringify(items, null, 2));
      return;
    }
    const found = items.find((i) => i.kind === args[0] && i.id === args[1]);
    if (verb === "show" && args.length === 2 && found) {
      console.log(JSON.stringify(found, null, 2));
      return;
    }
    throw Error(
      "Expected forge instance list, show <kind> <id>, or run <stage-id>; check IDs with forge instance list",
    );
  }
  if (cmd === "init") {
    const targetDir = rest[0];
    if (!targetDir) throw new Error("Usage: forge init <dir>");
    const { values } = parseArgs({
      args: rest.slice(1),
      options: {
        name: { type: "string" },
        "git-org": { type: "string" },
        force: { type: "boolean", default: false },
      },
    });
    const res = initWorkbench({
      targetDir,
      name: values.name,
      gitOrg: values["git-org"],
      force: Boolean(values.force),
    });
    console.log(JSON.stringify(res, null, 2));
  } else if (cmd === "add-repo") {
    const repoPath = rest[0];
    if (!repoPath) throw new Error("Usage: forge add-repo <repo-path>");
    const { values } = parseArgs({
      args: rest.slice(1),
      options: {
        workbench: { type: "string" },
        force: { type: "boolean", default: false },
      },
    });
    const res = addRepo({
      repoPath,
      workbenchDir: values.workbench,
      force: Boolean(values.force),
    });
    console.log(JSON.stringify(res, null, 2));
  } else if (cmd === "sync") {
    const targetDir = rest[0];
    const res = syncWorkbench({ targetDir });
    console.log(JSON.stringify(res, null, 2));
  } else if (cmd === "doctor") {
    const targetDir = rest[0] && !rest[0].startsWith("-") ? rest[0] : undefined;
    const jsonMode = rest.includes("--json");
    const res = doctorWorkbench(targetDir);
    if (jsonMode) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(`forge doctor (${res.root}): ${res.ok ? "OK" : "FAILED"}`);
      for (const issue of res.issues) {
        console.log(`  [${issue.level.toUpperCase()}] (${issue.check}) ${issue.message}`);
      }
      if (res.issues.length === 0) console.log("  All checks passed.");
      const trust = checkCodexHooksTrust(res.root);
      if (trust.checked && trust.totalCount > 0 && trust.trustedCount < trust.totalCount) {
        console.log(
          `  [HINT] (hooks-trust) Codex hooks in ${trust.hooksPath} have ${trust.trustedCount}/${trust.totalCount} trusted handler(s) in ~/.codex/config.toml. Open Codex in this workbench and approve via /hooks (or Codex Desktop Settings -> Hooks) to activate guard & ledger hooks.`,
        );
      }
    }
    if (!res.ok) process.exitCode = 1;
  } else {
    throw new Error(`Unknown command: ${cmd}`);
  }
}
