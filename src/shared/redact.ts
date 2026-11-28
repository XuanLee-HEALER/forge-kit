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

// Audit messages can contain prose before and after a shell example. Consume
// its complete logical line, including quoted or escaped multiline arguments.
export function redactAuditRuntimeCommand(text: string): string {
  const normalized = text.replace(/\\(?:\r?\n|["'])/g, "");
  if (!containsQueryArguments(normalized)) return text;
  // Keep opaque serialized argument arrays and shell expansions on the conservative path.
  // Their values may span lines without a shell quote surrounding the option value.
  if (/["']\s*,\s*["']rt["']|\$\(|<<|\\["']/.test(text)) return "[runtime query arguments omitted]";
  const lines = text.split("\n");
  const kept: string[] = [];
  let omitted = false;
  for (let i = 0; i < lines.length; i++) {
    const begin = i;
    while (i + 1 < lines.length && /\\\r?$/.test(lines[i])) i++;
    let command = lines.slice(begin, i + 1).join("\n");
    const invocation = runtimeQuery.exec(command.replace(/\\\r?\n/g, ""));
    if (invocation) {
      let quote = "";
      let line = command;
      for (;;) {
        for (let offset = 0; offset < line.length; offset++) {
          const ch = line[offset];
          if (ch === "\\" && quote !== "'") offset++;
          else if (quote) { if (ch === quote) quote = ""; }
          else if (ch === "'" || ch === '"') quote = ch;
        }
        if (!quote || i + 1 === lines.length) break;
        line = lines[++i];
      }
      command = lines.slice(begin, i + 1).join("\n");
      if (queryOption.test(command)) {
        kept.push("[runtime query arguments omitted]");
        omitted = true;
        continue;
      }
    }
    kept.push(command);
  }
  const result = kept.join("\n");
  // Encoded commands and pretty-printed argument arrays may span other
  // boundaries. Suppress ambiguous remnants instead of publishing raw inputs.
  if (!omitted || containsQueryArguments(result.replace(/\\(?:\r?\n|["'])/g, ""))) return "[runtime query arguments omitted]";
  return result;
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
