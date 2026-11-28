import { extractGitSubcommand } from "../shared/git-cmd";
import { redactAuditText } from "../shared/redact";
import { tokenizeSimpleShellCommand } from "../shared/shell-tokens";
import { object, string } from "./rollout-record";

export type OutputCall = { name: string; namespace: string | null; parameters: unknown };

const statusPattern = /^(?:ok|success|failed|completed|timeout|error|pass)$/i;
const textTypes = new Set(["text", "input_text", "output_text"]);
const shellTools = /(?:^|[.])(?:exec|exec_command|write_stdin|wait|shell|shell_command|run_command|terminal)$/i;
// Retain prose from tools whose normal reply is a short informational value.
// Other tools use output syntax to distinguish diagnostics from arbitrary stdout.
const proseTools = /^(?:weather|get_weather|calculate|calculator)$/i;
const sourceReader = /^(?:cat|bat|batcat|sed|awk|head|tail|more|less|nl|cut|sort|tee|tr|strings|base64|hexdump|xxd|find|rg|grep|printenv|env|curl|wget|jq|yq|sqlite3|printf|echo)$/;
const fileReaderTool = /(?:^|\.|__)(?:read_file|read_files|read_text_file|read_multiple_files|get_file_contents|read_resource)$/i;

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

type OutputChannel = "text" | "stderr";
type OutputParts = Record<OutputChannel, string[]> & { metadata: Set<string>; omitted: boolean; structured: boolean };

function exitCode(value: unknown, parts: OutputParts) {
  if (typeof value === "number" && Number.isSafeInteger(value)) parts.metadata.add("Exit code " + value);
}

const closingHeader = /^(?:Final output|Output|Original output):$/i;
const execHeader = /^(?:Chunk ID:|Wall time(?:[: ]|$)|Process (?:exited with |running with session ID )|Exit code:|Script (?:completed|running with cell ID)\b|Warning: truncated output\b|Total (?:output )?lines: \d+\s*$)/i;

function readExecEnvelope(lines: string[], parts: OutputParts) {
  let start = 0;
  for (; start < lines.length; start++) {
    const line = lines[start].trim();
    if (closingHeader.test(line)) return lines.slice(start + 1).join("\n");
    if (!line || /^Original token count: \d+$/i.test(line)) continue;
    if (!execHeader.test(line)) break;
    const exit = /^(?:Process exited with (?:code|status)|Exit code:)\s*(-?\d+)$/i.exec(line);
    if (exit) exitCode(Number(exit[1]), parts);
    else if (/^Script completed\b/i.test(line)) parts.metadata.add("completed");
    else if (/^Warning: truncated output\b/i.test(line)) parts.omitted = true;
  }
  return lines.slice(start).join("\n");
}

function addResult(value: unknown, parts: OutputParts, explicit: boolean, depth = 0, channel: OutputChannel = "text") {
  if (value === null || value === undefined) return;
  if (depth >= 5) { parts.omitted = true; return; }
  const add = (child: unknown, target = channel) => addResult(child, parts, explicit, depth + 1, target);
  if (typeof value === "string") {
    const text = stripTerminal(value).trim();
    if (!text) return;
    // Some CLI tools return JSON encoded as one text block.
    if (/^[\[{]/.test(text)) {
      try {
        const decoded: unknown = JSON.parse(text);
        if (explicit && (execResult(object(decoded)) || Array.isArray(decoded) &&
          decoded.length && decoded.every(entry => promiseResult(object(entry)))))
          add(decoded);
        else parts.structured = true;
        return;
      } catch { /* Ordinary text can start with a bracket. */ }
    }
    if (explicit && execHeader.test(text.split("\n", 1)[0])) {
      add(readExecEnvelope(text.split("\n"), parts));
      return;
    }
    parts[channel].push(text);
    return;
  }
  if (Array.isArray(value)) {
    for (const block of value) {
      const data = object(block);
      if (textTypes.has(string(data.type) ?? "") && typeof data.text === "string")
        add(data.text);
      else if (explicit && promiseResult(data)) add(data.value);
      else parts.structured = true;
    }
    if (!value.length) parts.structured = true;
    return;
  }
  const data = object(value);
  if (explicit && promiseResult(data)) {
    add(data.value);
    return;
  }
  exitCode(data.exit_code ?? data.exitCode, parts);
  if (typeof data.status === "string" && statusPattern.test(data.status))
    parts.metadata.add(data.status);
  if (data.isError === true) parts.metadata.add("error");
  if (data.type !== undefined) {
    if (textTypes.has(string(data.type) ?? "") && typeof data.text === "string")
      add(data.text);
    else parts.structured = true;
    return;
  }
  if (typeof data.stdout === "string" || typeof data.stderr === "string") {
    if (typeof data.stdout === "string") add(data.stdout);
    if (typeof data.stderr === "string") add(data.stderr, "stderr");
  } else if (Array.isArray(data.content)) add(data.content);
  else if (explicit && (execResult(data) || execResult(object(data.output)))) {
    if (typeof data.output === "string" || Array.isArray(data.output))
      add(data.output);
    else add(data.result ?? data.output);
  } else if (explicit && typeof data.output === "string" && Object.keys(data).length === 1)
    add(data.output);
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
const cliError = /^--[\w-]+ must be (?:a |an )?[\w -]+[.!]?$|^(?:[\w.-]+:\s+)?(?:unknown (?:command|option|argument|flag)|invalid (?:command|option|argument|flag)|(?:--[\w-]+ )?(?:requires|expects)\s+(?:an? |\d+)|unexpected (?:argument|option)|missing required (?:argument|option))\b/i;
const failure = /^(?:(?:\(fail\)|✗|✖|×|❌)|(?:FAIL(?:ED)?|not ok|Build failed)\b|[1-9]\d* (?:tests? )?(?:fail(?:ed|ures?)?|errors?)\b)/i;
const stackFrame = /^(?:at\s+[\w$.[\]<> -]+(?:\s+\([^)]*:\d+:\d+\)|:\d+:\d+)|at\s+[^\s]+:\d+:\d+|File "[^"]+", line \d+(?:, in [\w.<>]+)?|-->\s+[^\s]+:\d+:\d+)$/;
const progress = /^(?:\(pass\)|\(fail\)|✓|✗|✔|✖|√|×|✅|❌|PASS\b|FAIL\b|FAILED\b|ok(?:\s|$)|not ok(?:\s|$)|=== RUN\b|--- (?:PASS|FAIL|SKIP):|test .+ \.\.\. (?:ok|FAILED|ignored)$|tests? result:|(?:Test Suites|Tests|Snapshots|Time|Duration)\s*:|\d+\s+(?:tests?\b|pass(?:ed)?\b|fail(?:ed|ures?)?\b|skip(?:ped)?\b|error(?:s)?\b|assertions?\b)|(?:Ran|Running|Collected|collecting|collected)\s+(?:\d+\s+(?:tests?|items?|specs?)|tests?\b)|bun test v\d|tap version\b|(?:Compiling|Compiled|Building|Built|Bundled|Bundling|Build (?:completed|failed|succeeded)|Finished|Successfully (?:built|compiled)|Checking|Transforming)\s+\S)/i;
const diffStart = /^(?:diff --(?:git|cc|combined)\b|\*\*\* (?:Begin Patch|Add File|Update File|Delete File)|@@|Index: |--- [ab]\/|\+\+\+ [ab]\/)/;
const bodyStart = /^(?:(?:FILE|SOURCE|FILE CONTENTS?|SOURCE CODE|CONTENTS?)\s*:|(?:contents|source|file body) of\b|[-=_]{3,}.*\b(?:file|source|captured (?:stdout|stderr))\b)/i;
const sourceLine = /^(?:(?:\d+[:\s]+[|:]|>\s*\d+\s*\||\|\s*(?:\^|[A-Za-z\d])|\^+\s*$)|(?:\$ |>>> |[+]{1,2}\s|[>%#]\s+(?:bun|npm|yarn|pnpm|git|node|cd|export)\b)|(?:import|export|const|let|var|function|class|interface|type|def|package|use|fn|return)\s+\S|\/\*|\*\/|\/\/|<\/?[a-z][\w.-]*(?:[ >]|$)|[\]}][;,]?\s*$|[\w.$()[\]"'-]+\s*(?:=|=>|:=)|[\w.$]+\([^)]*\)\s*(?:[;{.]|$)|[^\s:]+:\d+:\S)/i;
const cliStatus = /^(?:On branch [\w./-]+$|Your branch is (?:up to date|ahead|behind)\b|nothing to commit\b|working tree clean$|(?:Changes not staged|Changes to be committed|Untracked files):$|No (?:changes|matches|results|tasks|commits|files|issues)(?: found| detected| to report)?[.!]?$|(?:[\w./-]+\.)?(?:test|spec)\.[a-z\d]+:$|(?:Configuration |Health )?checks? (?:succeeded|passed|completed)[.!]?$)/i;
const gitBranchStatus = /^## [\w./-]+(?:\.\.\.[\w./-]+)?(?: \[(?:ahead|behind) \d+(?:, (?:ahead|behind) \d+)?\])?$/;
const markdownHeading = /^#{1,6}\s+\S/;
const documentEnd = /^[-=_]{3,} END (?:FILE|SOURCE|DOCUMENT) [-=_]{3,}$/i;

function wrappedCommand(input: string) {
  // A single literal exec call can identify a body-producing subprocess. Opaque
  // or mixed invocations still undergo the same content-based filtering.
  if ((input.match(/\btools\.[a-z_]+\b/g) ?? []).length !== 1) return "";
  const literal = /\btools\.exec_command\(\s*\{\s*(?:"cmd"|'cmd'|cmd)\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*(?=[,}])/.exec(input)?.[1];
  if (!literal) return "";
  if (literal.startsWith("'")) return literal.includes("\\") ? "" : literal.slice(1, -1);
  try { return JSON.parse(literal) as string; }
  catch { return ""; }
}

function context(call: OutputCall) {
  const execution = shellTools.test(call.name) || /^(?:shell|terminal)$/i.test(call.namespace ?? "");
  const args = object(call.parameters);
  const command = args.cmd ?? args.command ?? args.argv ?? args.code ?? call.parameters;
  const input = Array.isArray(command) && command.every(arg => typeof arg === "string") ? command.join(" ") :
    typeof command === "string" ? command : "";
  const commandText = /\btools\./.test(input) ? wrappedCommand(input) : input;
  const argv = Array.isArray(command) && command.every(arg => typeof arg === "string")
    ? command : tokenizeSimpleShellCommand(commandText);
  const executable = argv?.[0] ?? "";
  const program = executable.split(/[\\/]/).at(-1) ?? "";
  const gitCommand = program === "git" ? extractGitSubcommand(argv ?? [])?.subcmd : undefined;
  const sourceOnly = execution && (sourceReader.test(program) ||
    /^(?:show|log|grep|cat-file|blame)$/.test(gitCommand ?? "") ||
    /^(?:node|deno|bun|perl|python[23]?|ruby)$/.test(program) &&
    argv?.some(arg => /^(?:-e|-c|--eval|eval|print)$/.test(arg))) ? program : "";
  return { execution, allowsProse: !execution && proseTools.test(call.name), sourceOnly,
    fileReader: fileReaderTool.test(call.name), gitStatus: gitCommand === "status",
    commandEcho: commandText && safeOutputText(commandText.trim()) };
}

function excerpts(text: string, { allowsProse, sourceOnly, commandEcho, fileReader, gitStatus }: ReturnType<typeof context>) {
  const priority: string[] = [];
  const ordinary: string[] = [];
  if (fileReader) return { priority, ordinary, skipped: !!text.trim() };
  let fence: string | null = null;
  let body: "diff" | "file" | "document" | null = null;
  let boundary = false;
  let structuredDepth = 0;
  let tap = false;
  let sourceFrame = false;
  let skipped = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const branchStatus = gitStatus && gitBranchStatus.test(line);
    if (!body && !fence && !structuredDepth && /^TAP version \d+$/i.test(line)) tap = true;
    if (tap && !body && !fence && !structuredDepth && /^# (?:Subtest:|(?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) \d)/i.test(line)) {
      if (!sourceOnly) ordinary.push(line);
      continue;
    }
    if (body === "document" || markdownHeading.test(line) && !branchStatus && !body && !fence && !structuredDepth) {
      body = documentEnd.test(line) ? null : "document";
      skipped = true;
      continue;
    }
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
    if (line === "*** End Patch" || documentEnd.test(line)) {
      body = null; boundary = true; skipped = true; continue;
    }
    const diagnostic = strongDiagnostic.test(line) || stackFrame.test(line) || cliError.test(line) || failure.test(line);
    const status = branchStatus || progress.test(line) || cliStatus.test(line);
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
    } else if (!allowsProse || sourceFrame || /^\s/.test(raw) || /^\d+\s+\S/.test(line)) skipped = true;
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
  const parts: OutputParts = { metadata: new Set(), text: [], stderr: [], omitted: false, structured: false };
  addResult(output, parts, policy.execution);
  const extract = (chunks: string[], sourcePolicy: typeof policy) => {
    const joined = chunks.join("\n");
    const cleaned = removeOutputBodies(stripTerminal(joined));
    const { priority, ordinary, skipped } = excerpts(safeOutputText(cleaned), sourcePolicy);
    return { priority, ordinary, omitted: skipped || cleaned !== joined };
  };
  const stdout = extract(parts.text, policy);
  const stderr = extract(parts.stderr, { ...policy, allowsProse: false, sourceOnly: "" });
  const omitted = parts.omitted || stderr.omitted || stdout.omitted;
  return utf8Limit([...parts.metadata, ...stderr.priority, ...stdout.priority, ...stdout.ordinary, ...stderr.ordinary,
    omitted ? "Output body omitted" : "", parts.structured ? "Structured output" : "",
  ].filter(Boolean).join("\n") || "Output unavailable");
}
