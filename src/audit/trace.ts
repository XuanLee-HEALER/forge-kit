import { auditSecretKey, redactAuditArguments, redactAuditRuntimeCommand, redactAuditText } from "../shared/redact";
import { object, string, turnId, type RolloutRecord } from "./rollout-record";
import { summarizeOutput, type OutputCall } from "./trace-output";

export type TraceEntry = {
  ts: string | null;
  session_id: string;
  role: string;
  kind: "user_message" | "assistant_final" | "tool_call" | "tool_output";
  text?: string;
  tool?: string;
  call_id?: string;
  parameters?: unknown;
  output_summary?: string;
};

function content(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const parts = value.flatMap(item => {
    const entry = object(item);
    const type = string(entry.type);
    if (typeof item === "string") return [item];
    if (type && !["text", "input_text", "output_text"].includes(type)) return [];
    return typeof entry.text === "string" ? [entry.text] : [];
  });
  return parts.length ? parts.join("\n") : null;
}

function removeTemplates(text: string) {
  return text.replace(/<(environment_context|system-reminder|developer_instructions|INSTRUCTIONS|user_shell_command)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi, "");
}

function removeToolBodies(text: string) {
  return removeTemplates(text).replace(
    /<(developer|system|file_?contents?|file_body)(?:\s[^>]*)?>[\s\S]*?(?:<\/\1>|$)/gi, "",
  );
}

const bodyKey = /^(?:file_?contents?|content|text|body|instructions|output|stdout|stderr|diff|patch)$/i;

function toolParameters(value: unknown, key = "", depth = 0): unknown {
  if (auditSecretKey.test(key)) return "***";
  if (bodyKey.test(key) || depth >= 8) return "[omitted]";
  if (typeof value === "string") {
    if (depth < 7 && /^\s*[\[{]/.test(value)) {
      try { return toolParameters(JSON.parse(value), key, depth + 1); }
      catch { /* An ordinary string can start with a bracket. */ }
    }
    if (/\*\*\* Begin Patch|^diff --git |<<-?\s*['"]?[A-Za-z_]/m.test(value)) return "[file content omitted]";
    return redactAuditText(redactAuditRuntimeCommand(removeToolBodies(value)));
  }
  if (Array.isArray(value)) {
    const entries = value.every(entry => typeof entry === "string") ? redactAuditArguments(value) : value;
    return entries.map(entry => toolParameters(entry, key, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([field, entry]) =>
      [redactAuditText(field), toolParameters(entry, field, depth + 1)]));
  }
  return value;
}

type Message = {
  ts: string | null;
  role: "user" | "assistant";
  id: string | null;
  turn: string | null;
  text: string;
  mirror: boolean;
};

function toolKind({ type, payload }: RolloutRecord) {
  return type === "response_item" ? string(payload.type) : type;
}

function toolCallId({ payload }: RolloutRecord, index: number) {
  return string(payload.call_id) ?? string(payload.id) ?? String(index);
}

export function createTrace(records: RolloutRecord[], session: string, role: string, includeTrace = true) {
  if (!includeTrace) {
    const ids = new Set<string>();
    for (const [index, record] of records.entries()) {
      const type = toolKind(record);
      if (type === "function_call" || type === "custom_tool_call") ids.add(toolCallId(record, index));
    }
    return { tool_calls: ids.size, trace: [] };
  }
  const session_id = redactAuditText(session);
  const entries = new Map<number, TraceEntry>();
  const messages = new Map<number, Message>();
  const calls = new Map<string, OutputCall>();
  const outputs: { index: number; ts: string | null; id: string; value: unknown }[] = [];
  const outputIds = new Set<string>();
  let latestTurn: string | null = null;
  for (const [index, record] of records.entries()) {
    const { type, payload, ts } = record;
    const kind = string(payload.type);
    if (type === "turn_context" || (type === "event_msg" && ["task_started", "turn_started"].includes(kind ?? "")))
      latestTurn = turnId(payload) ?? latestTurn;
    const turn = turnId(payload) ?? latestTurn;
    const id = string(payload.id);
    if (type === "event_msg" && ["task_complete", "task_completed", "turn_completed"].includes(kind ?? "") && turn) {
      const end = content(payload.last_agent_message);
      if (end !== null) {
        messages.set(index, { ts, role: "assistant", id: null, turn, text: end, mirror: true });
      }
    }
    if (type === "response_item" && kind === "message") {
      const text = content(payload.content);
      if (text === null) continue;
      if (payload.role === "user") messages.set(index, { ts, role: "user", id, turn, text, mirror: false });
      if (payload.role === "assistant" && ["final_answer", "final"].includes(string(payload.phase) ?? ""))
        messages.set(index, { ts, role: "assistant", id, turn, text, mirror: false });
    }
    if (type === "event_msg" && ["user_message", "agent_message"].includes(kind ?? "")) {
      const text = content(payload.message ?? payload.content ?? payload.text);
      if (text !== null && (kind === "user_message" || ["final_answer", "final"].includes(string(payload.phase) ?? "")))
        messages.set(index, { ts, role: kind === "user_message" ? "user" : "assistant", id, turn, text, mirror: true });
    }
    if (type === "event_msg" && kind === "item_completed") {
      const item = object(payload.item);
      const text = content(item.content);
      if (text !== null && (item.type === "UserMessage" || (item.type === "AgentMessage" && item.phase === "final_answer")))
        messages.set(index, { ts, role: item.type === "UserMessage" ? "user" : "assistant",
          id: string(item.id), turn, text, mirror: true });
    }
    const toolType = toolKind(record);
    if (toolType === "function_call" || toolType === "custom_tool_call") {
      const callId = toolCallId(record, index);
      if (calls.has(callId)) continue;
      const name = string(payload.name) ?? "unknown";
      const parameters = toolParameters(payload.arguments ?? payload.input);
      calls.set(callId, { name, namespace: string(payload.namespace), parameters });
      entries.set(index, { ts, session_id, role, kind: "tool_call", tool: redactAuditText(name),
        call_id: redactAuditText(callId), parameters });
    }
    if (toolType === "function_call_output" || toolType === "custom_tool_call_output") {
      const outputId = id ?? string(payload.call_id);
      if (outputId && outputIds.has(outputId)) continue;
      if (outputId) outputIds.add(outputId);
      outputs.push({ index, ts, id: string(payload.call_id) ?? "", value: payload.output });
    }
  }

  const primary = new Set<string>();
  const ids = new Set<string>();
  const emittedMirrors = new Set<string>();
  const messageKey = (message: Message) => JSON.stringify([message.role, message.turn, removeTemplates(message.text)]);
  for (const message of messages.values()) if (!message.mirror) primary.add(messageKey(message));
  for (const [index, message] of messages) {
    const text = redactAuditText(redactAuditRuntimeCommand(removeTemplates(message.text)));
    if (!text.trim() || (message.id && ids.has(message.id))) continue;
    const key = messageKey(message);
    if (message.mirror && (primary.has(key) || emittedMirrors.has(key))) continue;
    if (message.mirror) emittedMirrors.add(key);
    if (message.id) ids.add(message.id);
    entries.set(index, { ts: message.ts, session_id, role,
      kind: message.role === "user" ? "user_message" : "assistant_final", text });
  }
  for (const output of outputs) {
    const call = calls.get(output.id);
    const name = call?.name ?? "unknown";
    entries.set(output.index, { ts: output.ts, session_id, role, kind: "tool_output", tool: redactAuditText(name),
      ...(output.id ? { call_id: redactAuditText(output.id) } : {}),
      output_summary: call && name !== "unknown"
        ? summarizeOutput(call, output.value) : "Unmatched tool output" });
  }
  return { tool_calls: calls.size, trace: [...entries.entries()].sort(([a], [b]) => a - b).map(([, entry]) => entry) };
}
