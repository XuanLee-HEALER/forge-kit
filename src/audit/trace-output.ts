import { extractGitSubcommand } from "../shared/git-cmd";
import { redactAuditText } from "../shared/redact";
import { tokenizeSimpleShellCommand } from "../shared/shell-tokens";
import { object, string } from "./rollout-record";

export type OutputCall = { name: string; namespace: string | null; parameters: unknown };

const statusPattern = /^(?:ok|success|failed|completed|timeout|error|pass)$/i;
const textTypes = new Set(["text", "input_text", "output_text"]);
const shellTools = /(?:^|[.])(?:exec|exec_command|write_stdin|wait|shell|shell_command|run_command|terminal)$/i;
const scriptTools = /(?:^|[._-])(?:eval|node_repl|python|run_code|execute_code)(?:$|[._-])/i;
const fileTools = /(?:^|[._-])(?:read|list|search|find|fetch|open|view|edit|patch|diff|file|resource|browse|query|screenshot)(?:$|[._-])/i;
const bodyCommand = /(?:^|[\s/;&|])(?:cat|sed|awk|head|tail|more|less|nl|cut|sort|tee|tr|strings|base64|find|rg|grep|diff|printenv|env|xargs|curl|wget|perl|python[23]?|ruby|jq|yq|sqlite3)(?=$|[\s;&|])|\bgit\b[^\n]*(?:\b(?:diff|show|log|grep|cat-file|blame)\b)|\b(?:node|deno|bun)\s+(?:-e|--eval|eval|print)\b|\b(?:printf|echo)\b|[<>][<>]|\n/;
const sourceReader = /^(?:cat|sed|awk|head|tail|more|less|nl|cut|sort|tee|tr|strings|base64|find|rg|grep|printenv|env|curl|wget|jq|yq|sqlite3|printf|echo)$/;

function stripTerminal(text: string) {
  return text
    .replace(/(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c|$)/g, "")
    .replace(/(?:\x1b[P^_X]|[\x90\x98\x9e\x9f])[^\x1b\x9c]*(?:\x1b\\|\x9c|$)/g, "")
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|\x1b[ -/]*[@-Z\\-~]/g, "")
    .replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
}

function removeOutputBodies(text: string) {
  return text.replace(
    /<(environment_context|system-reminder|developer_instructions|INSTRUCTIONS|user_shell_command|developer|system|file_?contents?|file_body)(?=\s|>)[^>]*(?:>[\s\S]*?(?:<\/\1\s*>|$)|$)/gi,
    "\n",
  );
}

function safeOutputText(text: string) {
  return redactAuditText(text)
    .replace(/\b(Authorization:\s*Basic\s+)\S+/gi, "$1***")
    .replace(/\b([\w.-]*(?:password|passwd|token|secret|api[-_]?key|credentials?)):\s+[^\n]+/gi, "$1: ***")
    .replace(/(["'])(?:file:\/\/\/|\/(?!\/)|~\/|[A-Z]:[\\/]|\\\\)[^"'\n]*\1/gi, "$1[redacted path]$1")
    .replace(/\bfile:\/\/\/[^\s"'<>()[\]{},;:]+/gi, "[redacted path]")
    .replace(/(?<![\w/:])(?:\/[\p{L}\p{N}_.~%-]+)+[^\s"'<>()[\]{},;:]*/gu, "[redacted path]")
    .replace(/(?<![\w/])(?:~[\\/]|[A-Za-z]:[\\/]|\\\\)[^\s"'<>()[\]{},;]+/g, "[redacted path]")
    .replace(/(?<![\w/-])(?:\.\/)?\.(?:codex|workbench|ssh|aws|gnupg|config|env)(?:[\\/][^\s"'<>()[\]{},;:]*)?/g, "[redacted path]");
}

type OutputParts = { metadata: Set<string>; text: string[]; omitted: boolean; structured: boolean };

function exitCode(value: unknown, parts: OutputParts) {
  if (typeof value === "number" && Number.isSafeInteger(value)) parts.metadata.add("Exit code " + value);
}

function addResult(value: unknown, parts: OutputParts, explicit: boolean, depth = 0) {
  if (value === null || value === undefined) return;
  if (depth >= 5) { parts.omitted = true; return; }
  if (typeof value === "string") {
    const text = stripTerminal(value).trim();
    if (!text) return;
    // Some CLI tools return JSON encoded as one text block.
    if (/^[\[{]/.test(text)) {
      try {
        const decoded: unknown = JSON.parse(text);
        if (explicit && (execResult(object(decoded)) || Array.isArray(decoded) &&
          decoded.length && decoded.every(entry => promiseResult(object(entry)))))
          addResult(decoded, parts, true, depth + 1);
        else parts.structured = true;
        return;
      } catch { /* Ordinary text can start with a bracket. */ }
    }
    const lines = text.split("\n");
    if (explicit && /^Script (?:completed|running with cell ID)\b/.test(lines[0])) {
      const start = lines.findIndex(line => line === "Output:" || line === "Final output:");
      if (lines[0].startsWith("Script completed")) parts.metadata.add("completed");
      if (start >= 0) addResult(lines.slice(start + 1).join("\n"), parts, true, depth + 1);
      else if (lines.length > 1) parts.omitted = true;
      return;
    }
    if (explicit && /^Warning: truncated output\b/.test(lines[0])) {
      parts.omitted = true;
      const start = lines.findIndex(line => /^Total lines: \d+$/.test(line));
      if (start >= 0) addResult(lines.slice(start + 1).join("\n"), parts, true, depth + 1);
      return;
    }
    if (explicit && /^(?:Chunk ID:|Wall time:|Process exited with |Exit code:)/.test(lines[0])) {
      let i = 0;
      for (; i < lines.length; i++) {
        const line = lines[i].trim();
        const exit = /^(?:Process exited with (?:code|status)|Exit code:)\s*(-?\d+)\s*$/i.exec(line);
        if (exit) exitCode(Number(exit[1]), parts);
        else if (/^(?:Final output|Output|Original output):$/i.test(line)) { i++; break; }
        else if (!/^(?:Chunk ID:|Wall time:|Process running with session ID |Original token count:|$)/.test(line)) break;
      }
      addResult(lines.slice(i).join("\n"), parts, true, depth + 1);
      return;
    }
    parts.text.push(text);
    return;
  }
  if (Array.isArray(value)) {
    for (const block of value) {
      const data = object(block);
      if (textTypes.has(string(data.type) ?? "") && typeof data.text === "string")
        addResult(data.text, parts, explicit, depth + 1);
      else if (explicit && promiseResult(data)) addResult(data.value, parts, true, depth + 1);
      else parts.structured = true;
    }
    if (!value.length) parts.structured = true;
    return;
  }
  const data = object(value);
  if (explicit && promiseResult(data)) {
    addResult(data.value, parts, true, depth + 1);
    return;
  }
  exitCode(data.exit_code ?? data.exitCode, parts);
  if (typeof data.status === "string" && statusPattern.test(data.status))
    parts.metadata.add(data.status);
  if (data.isError === true) parts.metadata.add("error");
  if (data.type !== undefined) {
    if (textTypes.has(string(data.type) ?? "") && typeof data.text === "string")
      addResult(data.text, parts, explicit, depth + 1);
    else parts.structured = true;
    return;
  }
  if (typeof data.stdout === "string" || typeof data.stderr === "string") {
    if (typeof data.stdout === "string") addResult(data.stdout, parts, explicit, depth + 1);
    if (typeof data.stderr === "string") addResult(data.stderr, parts, explicit, depth + 1);
  } else if (Array.isArray(data.content)) addResult(data.content, parts, explicit, depth + 1);
  else if (explicit && (execResult(data) || execResult(object(data.output)))) {
    if (typeof data.output === "string" || Array.isArray(data.output))
      addResult(data.output, parts, explicit, depth + 1);
    else addResult(data.result ?? data.output, parts, true, depth + 1);
  } else if (explicit && typeof data.output === "string" && Object.keys(data).length === 1)
    addResult(data.output, parts, true, depth + 1);
  else parts.structured = true;
}

function execResult(data: Record<string, unknown>, depth = 0): boolean {
  if (depth >= 5) return false;
  return Object.hasOwn(data, "stdout") || Object.hasOwn(data, "stderr") ||
    (Object.hasOwn(data, "output") && ["exit_code", "exitCode", "wall_time_seconds", "status", "session_id", "chunk_id"]
      .some(key => Object.hasOwn(data, key))) ||
    Object.hasOwn(data, "result") && Object.keys(data).length === 1 && execResult(object(data.result), depth + 1) ||
    promiseResult(data, depth);
}

function promiseResult(data: Record<string, unknown>, depth = 0) {
  return data.status === "fulfilled" && Object.keys(data).length === 2 &&
    execResult(object(data.value), depth + 1);
}

const strongDiagnostic = /^(?:[a-z][\w.]*(?:Error|Exception)|Error|Exception|error(?:\[[A-Z]\d+\])?|fatal(?: error)?|warning|warn|panic|Traceback|Caused by|FAIL(?:ED)?|not ok)\s*[:!]|^(?:.+?:\d+(?::\d+|\(\d+\))?\)?\s*(?:[: -]\s*)?(?:error|warning)\b)|^\[?(?:ERROR|WARN|FATAL)\]\s+|^(?:npm (?:ERR!|error|warn)|bun error|[\w-]+(?:\.sh)?: (?:line \d+:|command not found|permission denied|no such file))\b/i;
const stackFrame = /^(?:at\s+[\w$.[\]<> -]+(?:\s+\([^)]*:\d+:\d+\)|:\d+:\d+)|at\s+[^\s]+:\d+:\d+|File "[^"]+", line \d+(?:, in [\w.<>]+)?|-->\s+[^\s]+:\d+:\d+)$/;
const progress = /^(?:\(pass\)|\(fail\)|✓|✗|✔|✖|√|×|✅|❌|PASS\b|FAIL\b|FAILED\b|ok(?:\s|$)|not ok(?:\s|$)|=== RUN\b|--- (?:PASS|FAIL|SKIP):|test .+ \.\.\. (?:ok|FAILED|ignored)$|tests? result:|(?:Test Suites|Tests|Snapshots|Time|Duration)\s*:|\d+\s+(?:tests?\b|pass(?:ed)?\b|fail(?:ed|ures?)?\b|skip(?:ped)?\b|error(?:s)?\b|assertions?\b)|(?:Ran|Running|Collected|collecting|collected)\s+(?:\d+\s+(?:tests?|items?|specs?)|tests?\b)|bun test v\d|tap version\b|(?:Compiling|Compiled|Building|Built|Bundled|Bundling|Build (?:completed|failed|succeeded)|Finished|Successfully (?:built|compiled)|Checking|Transforming)\s+\S)/i;
const diffStart = /^(?:diff --(?:git|cc|combined)\b|\*\*\* (?:Begin Patch|Add File|Update File|Delete File)|@@|Index: |--- [ab]\/|\+\+\+ [ab]\/)/;
const bodyStart = /^(?:(?:FILE|SOURCE|FILE CONTENTS?|SOURCE CODE|CONTENTS?)\s*:|(?:contents|source|file body) of\b|[-=_]{3,}.*\b(?:file|source|captured (?:stdout|stderr))\b)/i;
const sourceLine = /^(?:(?:\d+[:\s]+[|:]|>\s*\d+\s*\||\|\s*(?:\^|[A-Za-z\d])|\^+\s*$)|(?:\$ |>>> |[+]{1,2}\s|[>%#]\s+(?:bun|npm|yarn|pnpm|git|node|cd|export)\b)|(?:import|export|const|let|var|function|class|interface|type|def|package|use|fn|return)\s+\S|\/\*|\*\/|\/\/|<\/?[a-z][\w.-]*(?:[ >]|$)|[\]}][;,]?\s*$|[\w.$()[\]"'-]+\s*(?:=|=>|:=)|[\w.$]+\([^)]*\)\s*(?:[;{.]|$)|[^\s:]+:\d+:\S)/i;
const cliStatus = /^(?:On branch [\w./-]+$|Your branch is (?:up to date|ahead|behind)\b|nothing to commit\b|working tree clean$|(?:Changes not staged|Changes to be committed|Untracked files):$|No (?:changes|matches|results|tasks|commits|files|issues)\b|(?:[\w./-]+\.)?(?:test|spec)\.[a-z\d]+:$)/i;

function wrappedCommand(input: string) {
  // A single literal exec call is enough context for ordinary CLI output. JavaScript
  // expressions and mixed calls remain opaque and receive diagnostic-only filtering.
  if ((input.match(/\btools\.[a-z_]+\b/g) ?? []).length !== 1) return "";
  const match = /^\s*(?:(?:const|let)\s+([\w$]+)\s*=\s*|text\(\s*)await\s+tools\.exec_command\(\s*\{\s*(?:"cmd"|cmd)\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*(?:,\s*(?:"?\w+"?)\s*:\s*(?:\d+|true|false|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))*\s*,?\s*\}\s*\)/.exec(input);
  if (!match) return "";
  const rest = input.slice(match[0].length);
  if (match[1]) {
    const reference = /^\s*;?\s*text\(\s*(?:JSON\.stringify\(\s*)?([\w$]+)(?:\.output)?\s*\)?\s*\)\s*;?\s*$/.exec(rest);
    if (reference?.[1] !== match[1]) return "";
  } else if (!/^\s*\)\s*;?\s*$/.test(rest)) return "";
  const literal = match[2];
  if (literal.startsWith("'")) return literal.includes("\\") ? "" : literal.slice(1, -1);
  try { return JSON.parse(literal) as string; }
  catch { return ""; }
}

function context(call: OutputCall) {
  const execution = shellTools.test(call.name) || /^(?:shell|terminal)$/i.test(call.namespace ?? "");
  const args = object(call.parameters);
  const command = args.cmd ?? args.command ?? args.argv ?? call.parameters;
  const input = Array.isArray(command) && command.every(arg => typeof arg === "string") ? command.join(" ") :
    typeof command === "string" ? command : "";
  const commandText = /\btools\./.test(input) ? wrappedCommand(input) : input;
  const argv = Array.isArray(command) && command.every(arg => typeof arg === "string")
    ? command : tokenizeSimpleShellCommand(commandText);
  const executable = argv?.[0] ?? "";
  const program = executable.split(/[\\/]/).at(-1) ?? "";
  const sourceOnly = execution && (sourceReader.test(program) ||
    program === "git" && /^(?:show|log|grep|cat-file|blame)$/.test(extractGitSubcommand(argv ?? [])?.subcmd ?? "") ||
    /^(?:node|deno|bun|perl|python[23]?|ruby)$/.test(program) &&
    argv?.some(arg => /^(?:-e|-c|--eval|eval|print)$/.test(arg))) ? program : "";
  const diagnosticsOnly = call.name === "unknown" || fileTools.test(call.name) || scriptTools.test(call.name) ||
    execution && (!executable || bodyCommand.test(commandText) || /^(?:\.\.?\/|\/tmp\/)/.test(executable) ||
      /^\b(?:sh|bash|zsh|fish|node|bun|deno)\b.+\.[cm]?[jt]sx?(?:\s|$)/.test(commandText));
  return { execution, diagnosticsOnly, sourceOnly, commandEcho: commandText && safeOutputText(commandText.trim()) };
}

function excerpts(text: string, { diagnosticsOnly, sourceOnly, commandEcho }: ReturnType<typeof context>) {
  const priority: string[] = [];
  const ordinary: string[] = [];
  let fence: string | null = null;
  let body: "diff" | "file" | null = null;
  let boundary = false;
  let structuredDepth = 0;
  let sourceFrame = false;
  let skipped = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const mark = /^(`{3,}|~{3,})/.exec(line)?.[1];
    if (mark) {
      if (!fence) fence = mark;
      else if (mark[0] === fence[0] && mark.length >= fence.length && line === mark) fence = null;
      skipped = true;
      continue;
    }
    if (fence) { skipped = true; continue; }
    if (structuredDepth || /^[{\[]\s*(?:[{\["0-9-]|$)/.test(line)) {
      const brackets = line.replace(/"(?:[^"\\]|\\.)*"/g, "").match(/[{}\[\]]/g) ?? [];
      structuredDepth = Math.max(0, structuredDepth + brackets.reduce((depth, bracket) =>
        depth + ("{[".includes(bracket) ? 1 : -1), 0));
      skipped = true;
      continue;
    }
    if (!line) { boundary ||= raw === ""; sourceFrame = false; continue; }
    if (diffStart.test(line)) { body = "diff"; boundary = false; skipped = true; continue; }
    if (bodyStart.test(line)) { body = "file"; boundary = false; skipped = true; continue; }
    if (/^(?:\*\*\* End Patch|[-=_]{3,} END (?:FILE|SOURCE) [-=_]{3,})$/i.test(line)) {
      body = null; boundary = true; skipped = true; continue;
    }
    const diagnostic = strongDiagnostic.test(line) || stackFrame.test(line);
    const status = progress.test(line) || stackFrame.test(line) || cliStatus.test(line);
    if (sourceOnly) {
      if (line.startsWith(sourceOnly + ":") &&
        /(?:permission denied|no such file or directory|invalid option|usage:|command not found)\b/i.test(line))
        priority.push(line);
      else skipped = true;
      continue;
    }
    if (body && !(body === "diff" && !/^[ +\-\\]/.test(raw) && diagnostic ||
      boundary && !/^\s/.test(raw) && (diagnostic || status))) {
      skipped = true;
      continue;
    }
    body = null;
    boundary = false;
    if (line === commandEcho || sourceLine.test(line) && !diagnostic) { skipped = true; continue; }
    if (diagnostic) {
      priority.push(line);
      sourceFrame = true;
    } else if (status) {
      ordinary.push(line);
      sourceFrame = false;
    } else if (diagnosticsOnly || sourceFrame || /^\s/.test(raw) || /^\d+\s+\S/.test(line)) skipped = true;
    else ordinary.push(line);
  }
  return { priority, ordinary, skipped };
}

function utf8Limit(text: string) {
  const budget = 2048;
  if (Buffer.byteLength(text) <= budget) return text;
  const suffix = "…";
  let size = 0, end = 0;
  for (const character of text) {
    size += Buffer.byteLength(character);
    if (size > budget - Buffer.byteLength(suffix)) break;
    end += character.length;
  }
  return text.slice(0, end) + suffix;
}

export function summarizeOutput(call: OutputCall, output: unknown) {
  const policy = context(call);
  const parts: OutputParts = { metadata: new Set(), text: [], omitted: false, structured: false };
  addResult(output, parts, policy.execution);
  const joined = parts.text.join("\n");
  const cleaned = removeOutputBodies(stripTerminal(joined));
  const safe = safeOutputText(cleaned);
  const { priority, ordinary, skipped } = excerpts(safe, policy);
  const omitted = parts.omitted || skipped || cleaned !== joined;
  return utf8Limit([...parts.metadata, ...priority, ...ordinary,
    omitted ? "Output body omitted" : "", parts.structured ? "Structured output" : "",
  ].filter(Boolean).join("\n") || "Output unavailable");
}
