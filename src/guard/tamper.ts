import { resolve } from "node:path";
import type { WorkbenchConfig } from "../config";
import { extractShellCommand, type CodexHookInput } from "../hook-io";
import { splitShellSegments, splitShellTokens, unwrapShellPrefix } from "../shared/shell";
import { canonicalizeMaybePath } from "../shared/path";
import { writeTargets } from "./write-targets";

export function checkLedgerTamper(workbenchRoot: string, input: CodexHookInput, cfg: WorkbenchConfig): string | null {
  const policy = canonicalizeMaybePath(resolve(workbenchRoot, ".workbench/ship-policy.yaml"));
  const ledger = canonicalizeMaybePath(resolve(workbenchRoot, ".workbench/ledger"));
  for (const path of writeTargets(input)) {
    if (path === policy || policy.startsWith(path + "/")) return "ship-policy.yaml requires an operator edit.";
    if (cfg.guard.block_ledger_direct_edits && (path === ledger || path.startsWith(ledger + "/") || ledger.startsWith(path + "/")))
      return "物理保险丝：禁止直接修改 .workbench/ledger/ 下的账本文件，请使用 forge ledger CLI。";
  }
  if (cfg.guard.block_ledger_direct_edits) {
    const piped = new Set<number>();
    const segments = splitShellSegments(extractShellCommand(input) ?? "", piped);
    const hookFile = (path: string) => /(?:^|\/)ledger-hook(?:\.[jt]s)?$/.test(path);
    for (const [index, segment] of segments.entries()) {
      const {bin, args} = unwrapShellPrefix(splitShellTokens(segment) ?? []);
      const interpreter = ["bun","node","sh","bash","dash","zsh"].includes(bin ?? "");
      const source = piped.has(index) && unwrapShellPrefix(splitShellTokens(segments[index - 1]) ?? []);
      const dispatchesHook = bin === "forge" && args[0] === "ledger-hook";
      const runsHookFile = interpreter && (args.some(hookFile) || source && source.bin === "cat" && source.args.some(hookFile));
      if (dispatchesHook || hookFile(bin ?? "") || runsHookFile)
        return "物理保险丝：禁止通过 Shell 直接调用 ledger-hook。";
    }
  }
  return null;
}
