import { emitPreToolUseDeny } from "../hook-io";
import { runGuardCli } from "../guard";

runGuardCli().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  emitPreToolUseDeny(`安全守卫未捕获异常（fail-closed）：${msg}`);
});
