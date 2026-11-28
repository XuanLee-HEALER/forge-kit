import { auditSecretKey, redactAuditText } from "../shared/redact";
import type { AdapterExecution, CapturedStream } from "./adapter-process";

export function sensitiveRuntimeKey(key: string): boolean {
  const compact = key.replace(/[-_. \t]/g, "");
  return auditSecretKey.test(compact) || /(?:email|phone|mobile|telephone|passphrase|authheader|mysqlpwd|rediscliauth|cookies?$)/i.test(compact);
}

function visibleText(text: string): string {
  return text
    .replace(/(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c|$)/g, "")
    .replace(/(?:\x1b[P^_X]|[\x90\x98\x9e\x9f])[^\x1b\x9c]*(?:\x1b\\|\x9c|$)/g, "")
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|\x1b[ -/]*[@-Z\\-~]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "");
}

export function runtimeSecrets(params: ReadonlyMap<string, string>): string[] {
  return [...new Set([...params].filter(([key, value]) => sensitiveRuntimeKey(key) && value)
    .flatMap(([, value]) => [value, visibleText(value), ...value.split("\n"), ...visibleText(value).split("\n")]))]
    .filter(Boolean).sort((a, b) => b.length - a.length);
}

function redactTextFields(text: string) {
  const fields = /(?<![\w.-])(["']?)([\w.-]+(?:[ \t]+(?:key|token|number|secret|header))?)\1[ \t]*[:=][ \t]*/gi;
  let start = 0;
  let output = "";
  for (let field = fields.exec(text); field; field = fields.exec(text)) {
    const [, , key] = field;
    if (!sensitiveRuntimeKey(key)) continue;
    const valueStart = fields.lastIndex;
    const endOfLine = text.indexOf("\n", valueStart);
    const end = endOfLine === -1 ? text.length : endOfLine;
    const value = text.slice(valueStart, end).trim();
    output += text.slice(start, valueStart) + "***";
    // An unclosed value or block can extend past this record. Its safe boundary is unknown.
    if (!value || /^[|>{\[]/.test(value) || /\\$/.test(value) ||
        value.startsWith('"') && !/^"(?:\\.|[^"\\])*"/.test(value) ||
        value.startsWith("'") && !/^'[^']*'/.test(value)) return { text: output, uncertainTail: true };
    start = end;
    while (/^[ \t]/.test(text[start + 1] ?? "")) {
      const next = text.indexOf("\n", start + 1);
      if (next < 0) return { text: output, uncertainTail: false };
      start = next;
    }
    fields.lastIndex = start;
  }
  return { text: output + text.slice(start), uncertainTail: false };
}

function projectText(raw: string, secrets: readonly string[]) {
  let text = raw;
  for (const secret of secrets) text = text.replaceAll(secret, "***");
  text = visibleText(text);
  for (const secret of secrets) text = text.replaceAll(secret, "***");
  const projected = redactTextFields(text);
  return { ...projected, text: redactAuditText(projected.text) };
}

export function safeRuntimeText(raw: string, secrets: readonly string[] = []): string {
  return projectText(raw, secrets).text;
}

// Bun exposes the original number spelling to the reviver. Keep it through the
// safe projection so JSON encoding cannot round large integers or decimals.
type RawJson = { readonly rawJSON: string };
type JsonWithSource = typeof JSON & {
  parse(text: string, reviver: (key: string, value: unknown, context?: { source?: string }) => unknown): unknown;
  rawJSON?(text: string): RawJson;
  isRawJSON?(value: unknown): value is RawJson;
};
const preciseJson: JsonWithSource = JSON;

function parseRuntimeJson(text: string, secrets: readonly string[]): { value: unknown; omitted: boolean } | undefined {
  try {
    let omitted = false;
    const value: unknown = preciseJson.parse(text, (_key: string, item: unknown, context?: { source?: string }) => {
      if (typeof item !== "number") return item;
      const source = context?.source;
      if (sensitiveNumber(source ?? String(item), secrets)) return "***";
      if (source && JSON.stringify(item) === source) return item;
      if (source && preciseJson.rawJSON && preciseJson.isRawJSON) return preciseJson.rawJSON(source);
      omitted = true;
      return "[number omitted]";
    });
    return { value, omitted };
  } catch { return undefined; }
}

function sensitiveNumber(source: string, secrets: readonly string[]): boolean {
  const normalized = String(Number(source));
  return secrets.includes(source) || secrets.includes(normalized) ||
    redactAuditText(source) !== source || redactAuditText(normalized) !== normalized;
}

export function safeRuntimeValue(value: unknown, secrets: readonly string[] = [], depth = 0): unknown {
  if (depth >= 64) return "[omitted]";
  if (typeof value === "string") return safeRuntimeText(value, secrets);
  if (preciseJson.isRawJSON?.(value)) return value;
  if (Array.isArray(value)) return value.map(item => safeRuntimeValue(item, secrets, depth + 1));
  if (value !== null && typeof value === "object") {
    const projected = new Map<string, unknown>();
    for (const [key, item] of Object.entries(value)) {
      const visibleKey = visibleText(key);
      const safeKey = safeRuntimeText(visibleKey, secrets);
      if (projected.has(safeKey)) continue;
      projected.set(safeKey, sensitiveRuntimeKey(visibleKey) ? "***" : safeRuntimeValue(item, secrets, depth + 1));
    }
    return Object.fromEntries(projected);
  }
  if (secrets.includes(String(value))) return "***";
  return value;
}

type Projection = { data?: unknown; text?: string; omitted: boolean; gitSha?: string };

function reportedGitSha(data: unknown): string | undefined {
  if (data === null || typeof data !== "object" || !Object.hasOwn(data, "git_sha")) return;
  const sha = (data as Record<string, unknown>).git_sha;
  if (typeof sha === "string" && (sha.length === 40 || sha.length === 64) && /^[a-fA-F0-9]+$/.test(sha)) return sha;
}

function looksStructured(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith('"') || trimmed.startsWith("[") &&
    !/^\[[\p{L}\p{N} ._:+/\-]+\](?:\s|\[|$)/u.test(trimmed);
}

function decodeRecords(bytes: Buffer, decoder: TextDecoder): string {
  const records = [];
  let start = 0;
  for (let newline = bytes.indexOf(10); newline >= 0; newline = bytes.indexOf(10, start)) {
    try { records.push(decoder.decode(bytes.subarray(start, newline + 1))); }
    catch { break; }
    start = newline + 1;
  }
  return records.join("");
}

function projectRecords(text: string, secrets: readonly string[]): { text: string; omitted: boolean } {
  const safe = [];
  let plain = "";
  let omitted = false;
  for (const line of visibleText(text).match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const index = looksStructured(line) ? 0 : line.search(/\{\s*"[^"\n]+"\s*:/);
    if (index < 0) {
      plain += line;
      continue;
    }
    const prefix = projectText(plain + line.slice(0, index), secrets);
    safe.push(prefix.text);
    const parsed = parseRuntimeJson(line.slice(index), secrets);
    if (prefix.uncertainTail || !parsed) return { text: safe.join(""), omitted: true };
    omitted ||= parsed.omitted;
    safe.push(JSON.stringify(safeRuntimeValue(parsed.value, secrets)));
    if (line.endsWith("\n")) safe.push("\n");
    plain = "";
  }
  const tail = projectText(plain, secrets);
  safe.push(tail.text);
  return { text: safe.join(""), omitted: omitted || tail.uncertainTail };
}

function projectStream(stream: CapturedStream, secrets: readonly string[]): Projection {
  const { bytes } = stream;
  if (bytes.length === 0) return { omitted: false };
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let incomplete = stream.incomplete;
  let text: string;
  const prefix = incomplete ? bytes.subarray(0, bytes.lastIndexOf(10) + 1) : bytes;
  try { text = decoder.decode(prefix); }
  catch {
    text = decodeRecords(prefix, decoder);
    incomplete = true;
  }
  if (!incomplete) {
    const parsed = parseRuntimeJson(text, secrets);
    if (parsed) return { data: safeRuntimeValue(parsed.value, secrets), omitted: parsed.omitted, gitSha: reportedGitSha(parsed.value) };
  }
  const records = projectRecords(text, secrets);
  return { ...records, omitted: records.omitted || incomplete };
}

export function safeAdapterOutput(execution: AdapterExecution, limits: { max_bytes: number; max_lines: number },
  secrets: readonly string[]) {
  const stdout = projectStream(execution.stdout, secrets);
  const stderr = projectStream(execution.stderr, secrets);
  let bytes = limits.max_bytes;
  let lines = limits.max_lines;
  let truncated = stdout.omitted || stderr.omitted || execution.stdout.clipped || execution.stderr.clipped;

  function reserve(text: string, lineCount: number) {
    const size = Buffer.byteLength(text);
    if (size > bytes || lineCount > lines) {
      truncated = true;
      return false;
    }
    bytes -= size;
    lines -= lineCount;
    return true;
  }

  function boundedText(text: string): string {
    const records = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const kept = [];
    for (const record of records) {
      if (!reserve(JSON.stringify(record).slice(1, -1), 1)) break;
      kept.push(record);
    }
    return kept.join("").trimEnd();
  }

  let data: unknown = null;
  if (stdout.data !== undefined) {
    if (reserve(JSON.stringify(stdout.data), 1)) data = stdout.data;
  }
  const output = stdout.text === undefined ? null : boundedText(stdout.text) || null;
  let warning;
  if (stderr.data !== undefined) {
    const json = JSON.stringify(stderr.data);
    if (reserve(JSON.stringify(json).slice(1, -1), 1)) warning = json;
  } else if (stderr.text !== undefined) warning = boundedText(stderr.text) || undefined;
  return { data, output, warning, truncated, gitSha: reportedGitSha(data) === stdout.gitSha ? stdout.gitSha : undefined };
}
