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

  const ids = prompt.match(/rb-[a-z0-9-]+/gi);
  if (!ids) return undefined;
  const approve = !/[\r\n]/.test(input.prompt ?? "") && /^(?:批准|approve)[ \t]+(rb-[a-z0-9-]+(?:[ \t]+rb-[a-z0-9-]+)*)$/i.test(prompt);
  const revoke = !/[\r\n]/.test(input.prompt ?? "") && prompt.match(
    /^(?:(?:请[ \t]*)?(?:撤销|取消|作废|撤回)[ \t]*|(?:please[ \t]+)?(?:revoke|cancel)(?=[ \t:：])[ \t]*)(?:(?:发版|执行|runbook|release)[ \t]*)?[:：]?[ \t]*(rb-[a-z0-9-]+(?:[ \t]+rb-[a-z0-9-]+)*)(?:，同时批准[ \t]+rb-[a-z0-9-]+)?[。.!！]?$/i,
  );
  const mentioned = [...new Set(ids.map(id => id.toLowerCase()))];
  const revokeIds = revoke ? [...new Set(revoke[1].toLowerCase().split(/[ \t]+/))] : [];
  const approveIds = approve ? mentioned : [];
  const ledger = new Ledger(workbenchRoot);
  const notes: string[] = [];
  try {
    if (!approve && (/批准|approve/i.test(prompt) || !revoke && mentioned.some(id => ledger.getRunbook(id)?.status === "PENDING"))) {
      notes.push("未识别为 Runbook 批准。请单独回复「批准 <runbook_id>」或「approve <runbook_id>」，不附带其他文字或标点。");
    }
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
