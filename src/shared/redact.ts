export const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(https?|postgres|postgresql|mysql|redis|clickhouse):\/\/[^\s/@"']+@/gi, "$1://***@"],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1***"],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}(?:\.[A-Za-z0-9._-]+)?/g, "***"],
  [
    /\b(PGPASSWORD|MYSQL_PWD|REDISCLI_AUTH|OPENAI_API_KEY|ANTHROPIC_AUTH_TOKEN|[A-Z_]*(?:SECRET|TOKEN|PASSWORD|API_KEY)[A-Z_]*)=(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s]+)/g,
    "$1=***",
  ],
  [/(--(?:password|passwd|token|secret|api[-_]key|auth[-_]token)(?:=|[ \t]+))(?:"[^"]*"|'[^']*'|[^\s]+)/gi, "$1***"],
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
  return argv.map((arg, index) =>
    index > 0 && /^--(?:password|passwd|token|secret|api[-_]key|auth[-_]token)$/i.test(argv[index - 1])
      ? "***" : redactSecrets(arg));
}
