export const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(https?|postgres|postgresql|mysql|redis|clickhouse):\/\/[^ \t-\r/?#@"]+@/gi, "$1://***@"],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1***"],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}(?:\.[A-Za-z0-9._-]+)?/g, "***"],
  [
    /\b(PGPASSWORD|MYSQL_PWD|REDISCLI_AUTH|OPENAI_API_KEY|ANTHROPIC_AUTH_TOKEN|(?:[A-Z_][A-Z0-9_]*)?(?:SECRET|TOKEN|PASSWORD|API_KEY)[A-Z0-9_]*)=(?:"(?:\\[\s\S]|[^"\\])*(?:"|\\?$)|'[^']*(?:'|$)|[^ \t-\r]+)/g,
    "$1=***",
  ],
  [/(--(?:password|passwd|token|secret|api[-_]key|auth[-_]token)(?:=|[ \t]+))(?:"(?:\\[\s\S]|[^"\\])*(?:"|\\?$)|'[^']*(?:'|$)|[^ \t-\r]+)/gi, "$1***"],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, "sk-***"],
];

export function redactWithPatterns(text: string, patterns: Array<[RegExp, string]>): string {
  for (const [pattern, replacement] of patterns) text = text.replace(pattern, replacement);
  return text;
}

export function redactSecrets(text: string) {
  return redactWithPatterns(text, SECRET_PATTERNS);
}

export function redactArguments(argv: string[]) {
  const option = /^--(?:password|passwd|token|secret|api[-_]key|auth[-_]token)$/i;
  const environment = /^(?:MYSQL_PWD|REDISCLI_AUTH|(?:[A-Z_][A-Z0-9_]*)?(?:SECRET|TOKEN|PASSWORD|API_KEY)[A-Z0-9_]*)$/;
  return argv.map((arg, index) => {
    if (index > 0 && option.test(argv[index - 1])) return "***";
    const end = arg.indexOf("=");
    if (end >= 0 && (option.test(arg.slice(0, end)) || environment.test(arg.slice(0, end)))) return arg.slice(0, end + 1) + "***";
    return redactSecrets(arg);
  });
}

export const auditSecretKey = /(?:secret|token|password|passwd|api[-_]?key|authorization|credential|access[-_]?key|private[-_]?key)/i;

const auditOptionName = "(?:access[-_]key(?:[-_]id)?|private[-_]key|credentials?|authorization|" +
  "(?:access|bearer|refresh|oauth|id)[-_]token|client[-_]secret)";
const auditOption = new RegExp("^--" + auditOptionName + "$", "i");
const auditOptionValue = new RegExp(
  String.raw`(--${auditOptionName}(?:=|[ \t]+))(?:"(?:\\[\s\S]|[^"\\])*(?:"|\\?$)|'[^']*(?:'|$)|[^ \t-\r]+)`, "gi",
);
const phoneNumber = String.raw`(?:(?:\+?86[ -]?)?1[3-9]\d{9}|(?:\+?1[ .-]?)?(?:(?:\(\d{3}\)[ .-]?|\d{3}[ .-])\d{3}[ .-]\d{4}|[2-9]\d{2}[2-9]\d{6})|\+(?:\d[ -]?){8,14}\d)(?![\w/-]|\.[\w-])`;
const standalonePhone = new RegExp(String.raw`(?<![\w/.:+-])` + phoneNumber, "g");
const labeledPhone = new RegExp(String.raw`(?<![\p{L}\p{N}./_-])([\p{L}]+[:：][ \t]*)` + phoneNumber, "gu");

const auditPatterns: Array<[RegExp, string]> = [
  [/-----BEGIN ([A-Z0-9 ]+(?:PRIVATE KEY|CERTIFICATE)|PRIVATE KEY|CERTIFICATE)-----[\s\S]*?(?:-----END \1-----|$)/g, "[redacted PEM]"],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/?#"<>]+@/gi, "$1***@"],
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]+\b/g, "***"],
  [/\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|(?:AKIA|ASIA|AIDA|AROA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35}|(?:LTAI|AKID)[A-Za-z0-9]{12,})\b/g, "***"],
  [/(?<![A-Z0-9.!#$%&'*+/=?^_`{|}~-])[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}(?![\w-]|\.[\w-])/gi, "[redacted email]"],
  [labeledPhone, "$1[redacted phone]"],
  [standalonePhone, "[redacted phone]"],
  [/\b([A-Z0-9_]*(?:ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|AUTHORIZATION)[A-Z0-9_]*)=(?:"(?:\\[\s\S]|[^"\\])*(?:"|\\?$)|'[^']*(?:'|$)|[^ \t-\r]+)/g, "$1=***"],
  [auditOptionValue, "$1***"],
  [/((?:["'])(?:[\w.-]*(?:secret|token|password|passwd|api[_-]?key|authorization|credential|access[_-]?key|private[_-]?key)[\w.-]*)(?:["'])\s*:\s*)(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')/gi, '$1"***"'],
];

export function redactAuditText(text: string): string {
  return redactSecrets(redactWithPatterns(text, auditPatterns));
}

const runtimeQuery = /(?:^|[^\w.-])(?:forge|src\/bin\/cli\.ts|dist\/cli\.js|\.workbench\/bin\/cli\.js)(?:["']?\s+(?:--\s+)?["']?|["']\s*,\s*["'])rt(?:["']?\s+["']?|["']\s*,\s*["'])query\b/;
const queryOption = /(?<![\w-])--(?:expr|param)(?=$|[=\s"'\\])/;

function containsQueryArguments(text: string): boolean {
  if (!queryOption.test(text)) return false;
  const invocation = runtimeQuery.exec(text);
  return invocation !== null && queryOption.test(text.slice(invocation.index + invocation[0].length));
}

// Keep unrelated report lines. A newline ends a direct command only outside
// quotes and continuations; quoted data can span any number of report lines.
function commandEnd(lines: string[], start: number, offset: number) {
  let quote = "";

  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    let continued = false;
    for (let k = i === start ? offset : 0; k < line.length; k++) {
      const ch = line[k];
      // Shell substitutions and heredocs can introduce their own quoting grammar.
      // Withhold the remainder when the end of their data cannot be established.
      const substitution = ch === "$" && ["(", "{", "'"].includes(line[k + 1]);
      if (quote !== "'" && (substitution || ch === "`" || !quote && line.startsWith("<<", k)))
        return lines.length - 1;
      if (ch === "\\" && quote !== "'") {
        continued = ++k === line.length || line[k] === "\r" && k + 1 === line.length;
      } else if (quote) {
        if (ch === quote) quote = "";
      } else if (ch === "'" || ch === '"') quote = ch;
    }
    if (!quote && !continued) return i;
  }
  return lines.length - 1;
}

export function redactAuditRuntimeCommand(text: string): string {
  const normalize = (value: string) => value.replace(/\\\r?\n/g, "").replace(/\\(["'])/g, "$1");
  if (!containsQueryArguments(normalize(text))) return text;
  const lines = text.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const begin = i;
    while (i + 1 < lines.length && /\\\r?$/.test(lines[i])) i++;
    let block = lines.slice(begin, i + 1).join("\n");
    if (runtimeQuery.test(normalize(block))) {
      const head = runtimeQuery.exec(lines[begin]);
      // A split/encoded invocation can have quoting outside this display line.
      if (!head) return [...kept, "[runtime query arguments omitted]"].join("\n");
      let argsStart = head.index + head[0].length;
      if (/["']/.test(lines[begin].charAt(argsStart))) argsStart++;
      const marks = [...lines[begin].matchAll(/`+/g)];
      const inlineExample = marks.length === 2 && marks[0].index! < argsStart && marks[1].index! >= argsStart
        && marks[0][0] === marks[1][0] && !/\\\s*$/.test(lines[begin]);
      i = inlineExample ? begin : commandEnd(lines, begin, argsStart);
      block = lines.slice(begin, i + 1).join("\n");
      if (queryOption.test(block)) {
        // Serialized argv and heredocs can continue independently of shell quotes.
        if (/["']\s*,\s*["']rt["']/.test(block))
          return [...kept, "[runtime query arguments omitted]"].join("\n");
        kept.push("[runtime query arguments omitted]");
        continue;
      }
    }
    kept.push(block);
  }
  const result = kept.join("\n");
  return containsQueryArguments(normalize(result)) ? "[runtime query arguments omitted]" : result;
}

export function redactAuditArguments(argv: string[]) {
  const queryCommand = containsQueryArguments(argv.join(" "));
  return redactArguments(argv).map((arg, index) => {
    const previous = argv[index - 1] ?? "";
    if (auditOption.test(previous) || queryCommand && /^--(?:expr|param)$/.test(previous)) return "***";
    if (queryCommand && /^--(?:expr|param)=/.test(arg)) return arg.slice(0, arg.indexOf("=") + 1) + "***";
    return redactAuditText(redactAuditRuntimeCommand(arg));
  });
}
