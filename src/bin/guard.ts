import { GUARD_BUDGET_MS, GUARD_TIMEOUT_MESSAGE } from "../guard/evaluate";
import { spawnSync } from "node:child_process";
import { emitPreToolUseDeny } from "../hook-io";
import { runGuardCli } from "../guard";

// A separate process keeps the deadline effective while SQLite, Git or filesystem I/O is blocking.
if (process.argv[2] !== "--evaluate") {
  const child = spawnSync(process.execPath, [process.argv[1], "--evaluate"], {
    stdio: ["inherit", "pipe", "pipe"], timeout: GUARD_BUDGET_MS, killSignal: "SIGKILL",
  });
  if (child.error || child.status !== 0) emitPreToolUseDeny(GUARD_TIMEOUT_MESSAGE);
  else process.stdout.write(child.stdout);
} else runGuardCli().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  emitPreToolUseDeny(`安全守卫未捕获异常（fail-closed）：${msg}`);
});
