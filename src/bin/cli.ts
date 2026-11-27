import { runForgeCli } from "../cli";
import { runGuardCli } from "../guard";
import { emitPreToolUseDeny } from "../hook-io";
import { GUARD_BUDGET_MS, GUARD_TIMEOUT_MESSAGE } from "../guard/evaluate";
import { spawnSync } from "node:child_process";

const [command, ...args] = process.argv.slice(2);

async function main() {
  if (!["ledger", "verify", "git", "ship", "guard", "ledger-hook", "dbcred", "cmdfmt", "lang-check"].includes(command)) {
    return runForgeCli();
  }
  const { findWorkbenchRoot } = await import("../config");
  const { checkMigration } = await import("../managed-assets");
  try {
    if (command !== "verify") checkMigration(findWorkbenchRoot());
  }
  catch (error) {
    if (command !== "guard") throw error;
    emitPreToolUseDeny("工作台迁移未完成，请恢复 forge sync。");
    return;
  }
  process.argv.splice(2, 1);
  switch (command) {
    case "ledger": return (await import("../ledger")).runLedgerCli();
    case "git": return (await import("../wb-git")).runWbGitCli();
    case "dbcred": return (await import("../dbcred")).runDbCredCli();
    case "cmdfmt": return (await import("../cmdfmt")).runCmdFmtCli();
    case "lang-check": return (await import("../lang-check")).runLangCheckCli();
    case "ledger-hook": return (await import("../ledger-hook")).runLedgerHookCli();
    case "guard": {
      if (args[0] === "--evaluate") {
        try { await runGuardCli(); }
        catch { emitPreToolUseDeny("安全守卫异常，已阻止执行。"); }
        return;
      }
      const child = spawnSync(process.execPath, [process.argv[1], "guard", "--evaluate"], {
        stdio: ["inherit", "pipe", "pipe"], timeout: GUARD_BUDGET_MS, killSignal: "SIGKILL",
      });
      if (child.error || child.status !== 0) emitPreToolUseDeny(GUARD_TIMEOUT_MESSAGE);
      else process.stdout.write(child.stdout);
      return;
    }
    case "verify":
    case "ship": {
      const result = command === "ship"
        ? (await import("../forge-ship")).shipCli(args)
        : (await import("../wb-verify")).verifyCli(args);
      console.log(JSON.stringify(result));
      process.exitCode = result.ok ? 0 : 1;
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
