import { redactSecrets } from "../cmdfmt";
import { collectProdDbHosts, findWorkbenchRoot, loadWorkbenchConfig } from "../config";
import { checkGitPhysicalFuse } from "./git-gh";
import { checkCloudAndRedisOps, checkKubectl } from "./infra";
import { checkLedgerGate } from "./ledger-gate";
import { loadApprovedRunbooksForSession } from "./runbook-state";
import { checkSpecAndTestLocks } from "./spec-lock";
import { checkProdDb, isHttpWriteCommand } from "./sql-http";
import { checkLedgerTamper } from "./tamper";
import {
  emitPreToolUseDeny,
  extractShellCommand,
  extractToolWorkdir,
  readHookStdinStrict,
  type CodexHookInput,
} from "../hook-io";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export function evaluatePreToolUse(
  workbenchRoot: string,
  input: CodexHookInput,
): string | null {
  const cfg = loadWorkbenchConfig(workbenchRoot);

  // Tier 1a: Ledger immutability & frozen spec/test physical locks (applies to ALL tools: file-edit, apply_patch, shell)
  const tamper = checkLedgerTamper(workbenchRoot, input, cfg);
  if (tamper) return tamper;
  const specLock = checkSpecAndTestLocks(workbenchRoot, input, cfg);
  if (specLock) return specLock;

  // Shell-only checks (never run on apply_patch / file-edit tools!)
  const cmd = extractShellCommand(input);
  if (!cmd) return null;

  const toolWorkdir = extractToolWorkdir(input);

  // Tier 1b: Physical fuses (strict env parsing so corrupted environments.json fails closed!)
  const prodHosts = collectProdDbHosts(workbenchRoot, cfg, { strict: true });
  if (
    cfg.guard.require_prod_db_hosts &&
    prodHosts.length === 0 &&
    (/\b(usql|psql|mysql)\b/.test(cmd) || isHttpWriteCommand(cmd))
  ) {
    return "物理保险丝（fail-closed）：工作台已启用 require_prod_db_hosts，但未配置任何 prod_db_hosts，拒绝执行数据库/HTTP 写命令直至补齐配置。";
  }
  const approvedRunbooks = loadApprovedRunbooksForSession(workbenchRoot, input.session_id);
  const fuseReason =
    checkProdDb(cmd, prodHosts, toolWorkdir, approvedRunbooks, workbenchRoot) ??
    checkKubectl(cmd, approvedRunbooks) ??
    checkCloudAndRedisOps(cmd) ??
    checkGitPhysicalFuse(workbenchRoot, cmd, toolWorkdir, cfg, approvedRunbooks);
  if (fuseReason) return fuseReason;

  // Tier 2: Passive dev ledger gate
  return checkLedgerGate(workbenchRoot, cmd, toolWorkdir, cfg, approvedRunbooks);
}

function logGuardError(root: string, err: unknown): void {
  try {
    const logPath = join(root, ".workbench", "ledger", "hook-errors.log");
    mkdirSync(dirname(logPath), { recursive: true });
    const msg = redactSecrets(err instanceof Error ? err.message : String(err));
    appendFileSync(logPath, `${new Date().toISOString()} [guard] ${msg}\n`);
  } catch {
    // Ignore log failure
  }
}

export async function runGuardCli(): Promise<void> {
  const parsed = await readHookStdinStrict();
  if (!parsed.ok) {
    // Fail-closed on malformed hook input so high-risk tools never bypass silently.
    emitPreToolUseDeny(`安全守卫输入解析失败（fail-closed）：${parsed.error}`);
    return;
  }
  if (!parsed.input) return;

  const root = findWorkbenchRoot(parsed.input.cwd);
  try {
    const denyReason = evaluatePreToolUse(root, parsed.input);
    if (denyReason) {
      emitPreToolUseDeny(denyReason);
    }
  } catch (err) {
    logGuardError(root, err);
    const safeMsg = redactSecrets(err instanceof Error ? err.message : String(err));
    emitPreToolUseDeny(
      `安全守卫执行异常（fail-closed，防止高风险操作被静默放行）：${safeMsg}`,
    );
  }
}
