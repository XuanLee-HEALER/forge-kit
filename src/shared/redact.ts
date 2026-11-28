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

const auditPatterns: Array<[RegExp, string]> = [
  [/-----BEGIN ([A-Z0-9 ]+(?:PRIVATE KEY|CERTIFICATE)|PRIVATE KEY|CERTIFICATE)-----[\s\S]*?(?:-----END \1-----|$)/g, "[redacted PEM]"],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/?#"<>]+@/gi, "$1***@"],
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]+\b/g, "***"],
  [/\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|(?:AKIA|ASIA|AIDA|AROA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35}|(?:LTAI|AKID)[A-Za-z0-9]{12,})\b/g, "***"],
  [/(?<![\w./+-])[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}(?![\w-]|\.[\w-])/gi, "[redacted email]"],
  [/(?<![\w/.:+-])(?:\+?86[ -]?)?1[3-9]\d{9}(?![\w/-]|\.[\w-])|(?<![\w/.:+-])(?:\+?1[ .-]?)?(?:(?:\(\d{3}\)[ .-]?|\d{3}[ .-])\d{3}[ .-]\d{4}|[2-9]\d{2}[2-9]\d{6})(?![\w/-]|\.[\w-])|(?<![\w/.:+-])\+(?:\d[ -]?){8,14}\d(?![\w/-]|\.[\w-])/g, "[redacted phone]"],
  [/\b([A-Z0-9_]*(?:ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|AUTHORIZATION)[A-Z0-9_]*)=(?:"(?:\\[\s\S]|[^"\\])*(?:"|\\?$)|'[^']*(?:'|$)|[^ \t-\r]+)/g, "$1=***"],
  [/(--(?:access[-_]key(?:[-_]id)?|private[-_]key|credentials?|authorization|bearer[-_]token)(?:=|[ \t]+))(?:"(?:\\[\s\S]|[^"\\])*(?:"|\\?$)|'[^']*(?:'|$)|[^ \t-\r]+)/gi, "$1***"],
  [/((?:["'])(?:[\w.-]*(?:secret|token|password|passwd|api[_-]?key|authorization|credential|access[_-]?key|private[_-]?key)[\w.-]*)(?:["'])\s*:\s*)(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')/gi, '$1"***"'],
];

export function redactAuditText(text: string): string {
  return redactSecrets(redactWithPatterns(text, auditPatterns));
}
