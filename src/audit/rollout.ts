import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { redactAuditText } from "../shared/redact";
import { object, string, timestamp, turnId, type RolloutRecord } from "./rollout-record";
import { rolloutUsage, type RolloutIncrement, type RolloutUsage } from "./rollout-usage";
import { createTrace, type TraceEntry } from "./trace";
import { roles as auditRoles } from "./usage";

export type { RolloutIncrement, RolloutUsage } from "./rollout-usage";
export type RolloutSession = {
  session_id: string;
  role: string;
  model: string | null;
  effort: string | null;
  started_at: string | null;
  ended_at: string | null;
  tool_calls: number;
  usage: RolloutUsage;
};
type Note = (message: string) => void;

const relevant = new Set([
  "session_meta", "event_msg", "turn_context", "response_item", "token_usage_record", "token_count",
  "custom_tool_call", "custom_tool_call_output", "function_call", "function_call_output",
]);
const eventKinds = new Set([
  "task_started", "task_complete", "task_completed", "turn_started", "turn_completed", "turn_aborted",
  "token_count", "token_usage_record", "agent_message", "user_message", "item_completed", "thread_settings_applied",
]);
const responseKinds = new Set([
  "message", "custom_tool_call", "custom_tool_call_output", "function_call", "function_call_output",
]);

function safeRoot(path: string) {
  const absolute = resolve(path);
  // macOS exposes these system-owned directory aliases to local CLI users and fixtures.
  const canonical = process.platform === "darwin" && /^\/(?:tmp|var)(?:\/|$)/.test(absolute)
    ? "/private" + absolute : absolute;
  let segmentPath: string = sep;
  for (const segment of canonical.split(sep).filter(Boolean)) {
    segmentPath = join(segmentPath, segment);
    const stat = lstatSync(segmentPath, { throwIfNoEntry: false });
    if (!stat) return null;
    if (!stat.isDirectory() || !(stat.mode & 0o111) || (segmentPath === canonical && !(stat.mode & 0o444)))
      throw Error("Unreadable session directory");
  }
  return canonical;
}

function filesIn(root: string, note: Note) {
  const files: string[] = [];
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop()!;
    try {
      const stat = lstatSync(dir);
      if (!stat.isDirectory() || !(stat.mode & 0o444) || !(stat.mode & 0o111)) throw Error("Unreadable session directory");
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isSymbolicLink()) note("Session directory or file symlink skipped");
        else if (entry.isDirectory()) pending.push(path);
        else if (entry.isFile() && extname(path) === ".jsonl") files.push(path);
      }
    } catch {
      note("Session directory unreadable");
    }
  }
  return files.sort();
}

function recordsIn(path: string, visit: (record: RolloutRecord) => boolean | void, note: Note,
  onEncrypted?: (count: number) => void,
) {
  let invalid = 0;
  let encrypted = 0;
  const decode = new TextDecoder("utf-8", { fatal: true });
  const gap = () => visit({ type: "rollout_gap", ts: null, ordinal: null, payload: {} });
  function line(bytes: Buffer) {
    let raw;
    try {
      const text = decode.decode(bytes);
      if (!text.trim()) return;
      raw = object(JSON.parse(text));
    } catch {
      invalid++;
      gap();
      return;
    }
    const type = string(raw.type);
    if (!type) {
      invalid++;
      gap();
      return;
    }
    const payload = object(raw.payload);
    if (type === "encrypted" || payload.encrypted_content) {
      encrypted++;
      return;
    }
    if (!relevant.has(type)) return;
    if (type === "event_msg" && !eventKinds.has(string(payload.type) ?? "")) return;
    if (type === "event_msg" && payload.type === "item_completed" &&
        !["UserMessage", "AgentMessage"].includes(string(object(payload.item).type) ?? "")) return;
    if (type === "response_item" && !responseKinds.has(string(payload.type) ?? "")) return;
    return visit({
      type, payload, ts: timestamp(raw.timestamp ?? raw.ts ?? payload.timestamp),
      ordinal: typeof raw.ordinal === "number" && Number.isSafeInteger(raw.ordinal) && raw.ordinal >= 0 ? raw.ordinal : null,
    });
  }

  try {
    if (!safeRoot(dirname(path))) throw Error("Missing rollout parent");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || !(stat.mode & 0o444)) throw Error("Unreadable rollout");
      const chunk = Buffer.allocUnsafe(64 * 1024);
      const parts: Buffer[] = [];
      let count: number;
      while ((count = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
        let offset = 0;
        while (offset < count) {
          const newline = chunk.indexOf(10, offset);
          if (newline < offset || newline >= count) {
            parts.push(Buffer.from(chunk.subarray(offset, count)));
            break;
          }
          const bytes = chunk.subarray(offset, newline);
          const complete = parts.length ? Buffer.concat([...parts, bytes]) : bytes;
          parts.length = 0;
          if (line(complete) === false) return;
          offset = newline + 1;
        }
      }
      if (parts.length) line(Buffer.concat(parts));
    } finally {
      closeSync(fd);
    }
  } catch {
    note("Rollout file unreadable");
  } finally {
    if (invalid) note(`Rollout skipped ${invalid} invalid JSONL or UTF-8 line(s)`);
    if (encrypted) onEncrypted?.(encrypted);
  }
}

function sessionMeta(payload: Record<string, unknown>, path: string) {
  const source = object(payload.source);
  const subagent = object(source.subagent);
  const spawn = object(subagent.thread_spawn);
  const threadSource = object(payload.thread_source);
  return {
    id: string(payload.id) ?? string(payload.thread_id) ?? string(payload.session_id),
    alias: string(payload.session_id),
    parent: string(payload.parent_thread_id) ?? string(spawn.parent_thread_id) ??
      string(subagent.parent_thread_id) ?? string(source.parent_thread_id) ?? string(threadSource.parent_thread_id),
    role: string(payload.agent_role) ?? string(spawn.agent_role) ?? string(payload.role),
    subagent: payload.source === "subagent" || payload.thread_source === "subagent" ||
      Object.hasOwn(source, "subagent") || Object.hasOwn(threadSource, "subagent"),
    path,
  };
}
type SessionFile = ReturnType<typeof sessionMeta>;

function indexRollouts(note: Note) {
  const configured = process.env.FORGE_CODEX_SESSIONS_DIR?.trim();
  const codexHome = process.env.CODEX_HOME?.trim();
  const selected = resolve(configured || join(codexHome || join(homedir(), ".codex"), "sessions"));
  const groups = new Map<string, SessionFile[]>();
  const paths = new Set([selected, join(dirname(selected), "archived_sessions")]);
  for (const path of paths) {
    let root: string | null;
    try { root = safeRoot(path); }
    catch {
      note("Session directory is unreadable or has a symlink");
      continue;
    }
    if (!root) {
      if (path === selected) note("Session directory missing");
      continue;
    }
    for (const file of filesIn(root, note)) {
      let meta: SessionFile | undefined;
      recordsIn(file, record => {
        if (record.type !== "session_meta") return;
        const parsed = sessionMeta(record.payload, file);
        if (!parsed.id) return;
        meta = parsed;
        return false;
      }, note);
      if (!meta?.id) {
        note("Rollout metadata missing");
        continue;
      }
      const list = groups.get(meta.id) ?? [];
      list.push(meta);
      groups.set(meta.id, list);
    }
  }
  return groups;
}

function sessionTree(groups: Map<string, SessionFile[]>, anchors: string[], note: Note) {
  const aliases = new Map<string, Set<string>>();
  const children = new Map<string, Set<string>>();
  const parents = new Map<string, Set<string>>();
  function add(map: Map<string, Set<string>>, key: string, value: string) {
    const values = map.get(key) ?? new Set<string>();
    values.add(value);
    map.set(key, values);
  }
  for (const [id, files] of groups)
    for (const file of files) if (file.alias) add(aliases, file.alias, id);
  function canonical(ref: string) {
    if (groups.has(ref)) return ref;
    const matches = aliases.get(ref);
    return matches?.size === 1 ? [...matches][0] : ref;
  }
  for (const [id, files] of groups) {
    for (const file of files) if (file.parent) {
      const parent = canonical(file.parent);
      add(children, parent, id);
      add(parents, id, parent);
    }
  }

  const selected = new Set<string>();
  const roots = new Set<string>();
  const pending = [...new Set(anchors)];
  while (pending.length) {
    const ref = pending.pop()!;
    const id = canonical(ref);
    if (selected.has(id)) continue;
    if (!groups.has(id)) {
      note(aliases.has(ref) ? "Session anchor is ambiguous" : "Session anchor has no matching rollout");
      continue;
    }
    selected.add(id);
    const ancestors = parents.get(id);
    if ((ancestors?.size ?? 0) > 1) note("Conflicting rollout parent threads");
    if (!ancestors?.size) roots.add(id);
    for (const parent of ancestors ?? []) {
      if (groups.has(parent)) pending.push(parent);
      else {
        roots.add(id);
        note("Missing parent thread");
      }
    }
  }
  if (roots.size > 1) note("Multiple rollout roots");
  for (const id of selected) for (const child of children.get(id) ?? []) selected.add(child);
  const parentCounts = new Map<string, number>();
  const independent: string[] = [];
  for (const id of selected) {
    const linked = [...(parents.get(id) ?? [])].filter(parent => selected.has(parent));
    if (linked.length < (parents.get(id)?.size ?? 0)) note("Missing parent thread");
    if ((parents.get(id)?.size ?? 0) > 1) note("Conflicting rollout parent threads");
    parentCounts.set(id, linked.length);
    if (!linked.length) independent.push(id);
  }
  for (const id of independent) for (const child of children.get(id) ?? []) {
    const remaining = parentCounts.get(child)! - 1;
    parentCounts.set(child, remaining);
    if (!remaining) independent.push(child);
  }
  if (independent.length < selected.size) note("Cycle in rollout parent threads");
  return [...selected].sort().map(id => ({ id, files: groups.get(id)!, canonical }));
}

function mergedRecords(files: SessionFile[], note: Note, onEncrypted: (count: number) => void) {
  const identityOf = (record: RolloutRecord) => JSON.stringify([record.type, record.ts, record.payload]);
  const copies = files.map(file => {
    const records: RolloutRecord[] = [];
    const seen = new Map<number, RolloutRecord>();
    recordsIn(file.path, record => {
      if (record.ordinal !== null) {
        const duplicate = seen.get(record.ordinal);
        if (duplicate) {
          if (identityOf(duplicate) !== identityOf(record)) note("Conflicting records with one rollout ordinal");
          return;
        }
        seen.set(record.ordinal, record);
      }
      records.push(record);
    }, note, onEncrypted);
    return records;
  }).sort((a, b) => b.length - a.length);
  const baseline = copies[0] ?? [];
  if (copies.length <= 1) return baseline;
  note("Duplicate rollout files");
  const records: RolloutRecord[] = [];
  const identities = new Set<string>();
  const ordinals = new Map<number, string>();
  for (const copy of copies) {
    const counts = new Map<string, number>();
    for (const record of copy) {
      const key = identityOf(record);
      const occurrence = (counts.get(key) ?? 0) + 1;
      counts.set(key, occurrence);
      const identity = key + "\n" + occurrence;
      if (identities.has(identity)) continue;
      if (record.ordinal !== null) {
        const first = ordinals.get(record.ordinal);
        if (first && first !== identity) {
          note("Conflicting records in duplicate rollout");
          continue;
        }
        ordinals.set(record.ordinal, identity);
      }
      identities.add(identity);
      records.push(record);
    }
  }
  return records.length === baseline.length ? baseline : records.sort((a, b) => {
    if (a.ordinal !== null && b.ordinal !== null) return a.ordinal - b.ordinal;
    return (a.ts ?? "").localeCompare(b.ts ?? "");
  });
}

const knownRoles = new Set<string>(auditRoles);

function roleBucket(raw: string | null) {
  if (!raw) return null;
  const value = raw.toLowerCase().trim();
  if (knownRoles.has(value)) return value;
  if (knownRoles.has("reviewer-" + value)) return "reviewer-" + value;
  return null;
}

function sessionTime(records: RolloutRecord[], note: Note) {
  let started_at: string | null = null, ended_at: string | null = null;
  const starts = new Map<string, string>();
  const intervals: [number, number][] = [];
  for (const { type, ts, payload } of records) {
    if (ts) {
      if (!started_at || ts < started_at) started_at = ts;
      if (!ended_at || ts > ended_at) ended_at = ts;
    }
    if (type !== "event_msg") continue;
    const kind = string(payload.type) ?? "";
    const id = turnId(payload) ?? "implicit";
    const start = timestamp(payload.started_at);
    if (kind === "task_started" || kind === "turn_started") {
      if (start ?? ts) starts.set(id, (start ?? ts)!);
    } else if (["task_complete", "task_completed", "turn_completed", "turn_aborted"].includes(kind)) {
      const from = start ?? starts.get(id);
      const to = timestamp(payload.completed_at) ?? ts;
      if (from && to && from <= to) intervals.push([Date.parse(from), Date.parse(to)]);
      else note("Turn boundary is missing or inconsistent");
      starts.delete(id);
    }
  }
  if (starts.size || !intervals.length) note("Turn boundaries are incomplete");
  if (!started_at || !ended_at) note("Session timestamps are missing");
  return { started_at, ended_at, intervals };
}

export function readRollouts(anchors: string[], roles: Record<string, string>, includeTrace = true) {
  const warnings = new Set<string>();
  const sessions: RolloutSession[] = [];
  const increments: RolloutIncrement[] = [];
  const intervals: [number, number][] = [];
  const session_intervals: Record<string, [number, number][]> = Object.create(null);
  const trace: TraceEntry[] = [];
  let usage_incomplete = false;
  let encrypted = 0;
  const note = (message: string) => { warnings.add(message); };
  if (!anchors.length) {
    note("No session anchors");
    return { sessions, increments, intervals, session_intervals, trace, warnings: [...warnings], usage_incomplete: true };
  }
  const groups = indexRollouts(note);
  for (const { id, files, canonical } of sessionTree(groups, anchors, note)) {
    const explicitRoles = files.map(file => roleBucket(file.role)).filter(role => role !== null);
    const ledgerRole = Object.entries(roles).find(([key]) => canonical(key) === id)?.[1] ?? null;
    const role = explicitRoles[0] ?? roleBucket(ledgerRole) ??
      (files.some(file => file.parent || file.subagent) ? "other" : "main");
    if (new Set(explicitRoles).size > 1) note("Conflicting rollout roles");
    const genericRole = files.some(file => file.role?.toLowerCase().trim() === "reviewer");
    if (role === "other" && !explicitRoles.length && !roleBucket(ledgerRole) && !genericRole)
      note(`Session role is missing or unknown: ${redactAuditText(id)}`);
    const records = mergedRecords(files, (message) => {
      note(message);
      if (message !== "Duplicate rollout files") usage_incomplete = true;
    }, count => { encrypted += count; });
    if (!records.length) continue;
    const time = sessionTime(records, note);
    const usage = rolloutUsage(records, id, role, (message) => {
      note(message);
      if (message !== "Actual model is missing for usage") usage_incomplete = true;
    });
    const display = (values: string[]) => values.length ? redactAuditText(values.join(", ")) : null;
    if (!usage.model.length) note("Session model is missing");
    if (!usage.effort.length) note("Session effort is missing");
    if (usage.increments.some(({ usage }) => usage.input_tokens === null ||
      usage.cached_input_tokens === null || usage.output_tokens === null)) {
      note("Usage billing fields are incomplete");
      usage_incomplete = true;
    }
    const projected = createTrace(records, id, role, includeTrace);
    const session_id = redactAuditText(id);
    sessions.push({
      session_id, role, model: display(usage.model), effort: display(usage.effort),
      started_at: time.started_at, ended_at: time.ended_at, tool_calls: projected.tool_calls, usage: usage.usage,
    });
    for (const increment of usage.increments) {
      const model = increment.model;
      increments.push({ ...increment, session_id,
        model: model && redactAuditText(model) === model ? model : null });
    }
    for (const interval of time.intervals) intervals.push(interval);
    session_intervals[session_id] = time.intervals;
    for (const entry of projected.trace) trace.push(entry);
  }
  if (includeTrace)
    trace.sort((a, b) => (a.ts ?? "\uffff").localeCompare(b.ts ?? "\uffff") || a.session_id.localeCompare(b.session_id));
  if (encrypted) note(`Rollout skipped ${encrypted} encrypted record(s)`);
  usage_incomplete ||= !sessions.length || [...warnings].some(message =>
    /^(?:Session anchor|Missing parent|Conflicting rollout parent|Cycle in rollout)/.test(message));
  return { sessions, increments, intervals, session_intervals, trace, warnings: [...warnings].sort(), usage_incomplete };
}
