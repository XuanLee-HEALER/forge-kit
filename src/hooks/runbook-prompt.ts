import { type CodexHookInput } from "../hook-io";
import { approveRunbookFromUserPrompt, revokeRunbook } from "../ledger/runbook";
import { humanFastTrack } from "../ledger/fast-track";
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

  const fast =
    !/[\r\n]/.test(input.prompt ?? "") &&
    /^(快轨批准|快轨撤销|fast-track approve|fast-track revoke)[ \t]+(ft-\d+-[a-f0-9]+)$/.exec(prompt);
  if (fast) {
    const ledger = new Ledger(workbenchRoot);
    try {
      const e = humanFastTrack(ledger, fast[2], sessionId, ["快轨批准", "fast-track approve"].includes(fast[1]));
      return (
        e.envelope_id +
        " " +
        e.status +
        (e.status==="ACTIVE" ? " · 使用 forge ship run --envelope "+e.envelope_id+" 逐项兑现。" : "") +
        ("delivery" in e && "notice" in e && e.notice ? " " + e.notice + " " + JSON.stringify(e.delivery) : "")
      );
    } catch (error) {
      return "Fast-track directive refused: " + error;
    } finally {
      ledger.closeDb();
    }
  }
  const ids = prompt.match(/rb-[a-z0-9-]+/gi);
  if (!ids) return undefined;
  const approve = !/[\r\n]/.test(input.prompt ?? "") && /^(?:批准|approve)[ \t]+(rb-[a-z0-9-]+(?:[ \t]+rb-[a-z0-9-]+)*)$/i.test(prompt);
  const revoke = !/[\r\n]/.test(input.prompt ?? "") && prompt.match(
    /^(?:(?:请[ \t]*)?(?:撤销|取消|作废|撤回)[ \t]*|(?:please[ \t]+)?(?:revoke|cancel)(?=[ \t:：])[ \t]*)(?:(?:发版|执行|runbook|release)[ \t]*)?[:：]?[ \t]*(rb-[a-z0-9-]+(?:[ \t]+rb-[a-z0-9-]+)*)(?:，同时批准[ \t]+rb-[a-z0-9-]+)?[。.!！]?$/i,
  );
  const mentioned = [...new Set(ids.map(id => id.toLowerCase()))];
  const revokeIds = revoke ? [...new Set(revoke[1].toLowerCase().split(/[ \t]+/))] : [];
  const approveIds = approve ? mentioned : [];
  const deadline = Date.now() + 4500;
  const ledger = new Ledger(workbenchRoot, {busyTimeoutMs: 500});
  const notes: string[] = [];
  try {
    if (!approve && (/批准|approve/i.test(prompt) || !revoke && mentioned.some(id => ledger.getRunbook(id)?.status === "PENDING"))) {
      notes.push("未识别为 Runbook 批准。请单独回复「批准 <runbook_id>」或「approve <runbook_id>」，不附带其他文字或标点。");
    }
    for (const id of revokeIds) {
      try {
        revokeRunbook(ledger,id,sessionId);
        notes.push(`[Forge Runbook] 已撤销发版单 ${id}，相关放行立即失效。`);
      } catch (err) {
        notes.push(
          `[Forge Runbook] 撤销 ${id} 失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    for (const id of approveIds) {
      try {
        const { record, actions, releaseId } = approveRunbookFromUserPrompt(ledger,{
          runbook_id: id,
          session_id: sessionId,
        },deadline);
        const binding=ledger.db.query<{envelope_id:string},[string]>("SELECT envelope_id FROM exact_ship_envelopes WHERE runbook_id=?").get(id);
        if(binding) {
          notes.push(`已批准 ${id}。按本次授权激活 ${binding.envelope_id}，然后运行 forge ship run --envelope ${binding.envelope_id}。逐项回执齐备后执行器自动完成 runbook。`);
          continue;
        }
        notes.push(
          `[Forge Runbook] 用户已在主会话批准发版单 ${record.runbook_id}（有效至 ${record.expires_at}，绑定当前 session）。` +
            `登记范围：${formatRunbookScopeSummary(actions)}。` +
            (actions.prs?.length ? "请操作者在托管平台核对目标分支、固定 HEAD 和必需检查，手动合并所列 PR。" : "") +
            (releaseId ? `发布线程随后运行 forge ledger release verify ${releaseId} 核验远端结果。` : "") +
            `完成登记项后运行 forge ledger runbook complete ${record.runbook_id}。`,
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
