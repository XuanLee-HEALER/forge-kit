import { type CodexHookInput } from "../hook-io";
import { Ledger } from "../ledger/store";
import { type RunbookActions } from "../ledger/types";

function formatRunbookScopeSummary(actions: RunbookActions): string {
  const parts: string[] = [];
  for (const t of actions.tags ?? []) {
    parts.push(`tag(${t.repo}:${t.tag}@${t.sha.slice(0, 8)})`);
  }
  for (const p of actions.prs ?? []) {
    parts.push(`pr(${p.repo}#${p.number})`);
  }
  for (const s of actions.sql_files ?? []) {
    parts.push(`sql(${s.host}:${s.path.split("/").pop()})`);
  }
  for (const k of actions.kubectl_commands ?? []) {
    parts.push(`kubectl(${k})`);
  }
  return parts.join(", ");
}

export function handleUserPromptRunbookDirectives(
  workbenchRoot: string,
  input: CodexHookInput,
): string | undefined {
  // Only root-session human prompts may approve/revoke runbooks; ignore subagents.
  if (input.agent_id || input.agent_type) return undefined;
  const prompt = (input.prompt ?? "").trim();
  const sessionId = (input.session_id ?? "").trim();
  if (!prompt || !sessionId) return undefined;

  const revokeIds = new Set<string>();
  const revokeRe =
    /(?:撤销|取消|作废|撤回|revoke|cancel)\s*(?:发版|执行|runbook|release)?\s*[:：]?\s*(rb-[a-z0-9-]{4,32})\b/gi;
  for (const m of prompt.matchAll(revokeRe)) {
    if (m[1]) revokeIds.add(m[1].toLowerCase());
  }

  const approveIds = new Set<string>();
  const approveRe =
    /(?:批准(?:发版|执行|runbook)?|确认(?:发版|执行|runbook)|同意(?:发版|执行|runbook)|approve(?:\s+runbook|\s+release)?)\s*[:：]?\s*(rb-[a-z0-9-]{4,32})\b/gi;
  const negPrefixRe = /(?:不要|暂不|不|别|未|don't|do\s+not|not|never)\s*$/i;
  for (const m of prompt.matchAll(approveRe)) {
    const id = m[1]?.toLowerCase();
    if (!id || revokeIds.has(id)) continue;
    const before = prompt.slice(Math.max(0, (m.index ?? 0) - 16), m.index ?? 0);
    if (negPrefixRe.test(before)) continue;
    approveIds.add(id);
  }

  if (revokeIds.size === 0 && approveIds.size === 0) return undefined;

  const ledger = new Ledger(workbenchRoot);
  const notes: string[] = [];
  try {
    for (const id of revokeIds) {
      try {
        ledger.revokeRunbook(id);
        notes.push(`[Forge Runbook] 已撤销发版单 ${id}，相关放行立即失效。`);
      } catch (err) {
        notes.push(
          `[Forge Runbook] 撤销 ${id} 失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    for (const id of approveIds) {
      try {
        const { record, actions } = ledger.approveRunbookFromUserPrompt({
          runbook_id: id,
          session_id: sessionId,
        });
        notes.push(
          `[Forge Runbook] 用户已在主会话批准发版单 ${record.runbook_id}（有效至 ${record.expires_at}，绑定当前 session）。` +
            `底层 guard 将自动放行已登记项：${formatRunbookScopeSummary(actions)}。` +
            `请按 Runbook 自动推进执行，完成后运行 \`.workbench/bin/ledger runbook complete ${record.runbook_id}\`。`,
        );
      } catch (err) {
        notes.push(
          `[Forge Runbook] 批准 ${id} 未生效：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } finally {
    ledger.closeDb();
  }
  return notes.length > 0 ? notes.join("\n") : undefined;
}
