import { type ApprovedRunbookEntry } from "./runbook-state";
import { canonicalizeOsPath, sha256File } from "../shared/path";
import {
  expandEnvSplitStrings,
  hasShellExpansion,
  hasUnquotedRedirect,
  splitShellSegments,
  splitShellTokens,
  stripUnquotedShellRedirections,
  unwrapShellPrefix,
} from "../shared/shell";

export const SQL_WRITE_RE =
  /\b(insert|update|delete|merge|replace|alter|drop|create|truncate|grant|revoke|copy|call|do|reindex|vacuum|refresh|comment|lock|set|begin|commit|setval|nextval|pg_terminate_backend|pg_cancel_backend|optimize|attach|detach|rename|kill)\b/i;

const SQL_FILE_FLAG_RE = /(^|\s)(-f|--file)(\s|=|$)|\\i\b/;

export function isHttpWriteCommand(cmd: string, depth = 0): boolean {
  for (const seg of splitShellSegments(cmd)) {
    const toks = splitShellTokens(seg);
    if (!toks || toks.length === 0) {
      // Fail closed on unparseable shell segment mentioning an HTTP client
      if (/\b(curl|wget|http|https)\b/.test(seg)) return true;
      continue;
    }
    let matchedDirect = false;
    for (let i = 0; i < toks.length; i++) {
      const bin = toks[i].split("/").pop() ?? "";
      if (bin !== "curl" && bin !== "wget" && bin !== "http" && bin !== "https") {
        // Inspect nested/wrapped shell arguments (e.g. `bash -c 'curl -XPOST ...'`).
        // Fail closed if nesting exceeds max depth so deeply nested wrappers cannot bypass!
        if (/\b(curl|wget|http|https)\b/.test(toks[i])) {
          if (depth >= 3) return true;
          if (isHttpWriteCommand(toks[i], depth + 1)) return true;
        }
        continue;
      }
      matchedDirect = true;
      const rest = toks.slice(i + 1);
      for (let j = 0; j < rest.length; j++) {
        const a = rest[j];
        if (/:8123\b/i.test(a) || /[?&]query=/i.test(a)) return true;

        if (bin === "curl") {
          if (a === "-X" || a === "--request") {
            const method = (rest[j + 1] ?? "").toUpperCase();
            if (method && method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
              return true;
            }
            j++;
            continue;
          }
          if (a.startsWith("-X") && a.length > 2) {
            const method = a.slice(2).toUpperCase();
            if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
              return true;
            }
            continue;
          }
          if (a.startsWith("--request=")) {
            const method = a.slice("--request=".length).toUpperCase();
            if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
              return true;
            }
            continue;
          }
          if (
            a === "-d" ||
            a.startsWith("-d") ||
            a === "-F" ||
            a.startsWith("-F") ||
            a === "-T" ||
            a.startsWith("-T") ||
            a === "--json" ||
            a.startsWith("--json=") ||
            a === "--form" ||
            a.startsWith("--form=") ||
            a === "--form-string" ||
            a.startsWith("--form-string=") ||
            a === "--upload-file" ||
            a.startsWith("--upload-file=") ||
            a === "--data" ||
            a.startsWith("--data-") ||
            a.startsWith("--data=")
          ) {
            return true;
          }
        } else if (bin === "wget") {
          if (
            a === "--post-data" ||
            a.startsWith("--post-data=") ||
            a === "--post-file" ||
            a.startsWith("--post-file=") ||
            a === "--body-data" ||
            a.startsWith("--body-data=") ||
            a === "--body-file" ||
            a.startsWith("--body-file=")
          ) {
            return true;
          }
          if (a === "--method" || a.startsWith("--method=")) {
            const method = (a === "--method" ? rest[j + 1] ?? "" : a.slice("--method=".length)).toUpperCase();
            if (method && method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
              return true;
            }
          }
        } else if (bin === "http" || bin === "https") {
          if (/^(POST|PUT|DELETE|PATCH)$/i.test(a)) {
            return true;
          }
        }
      }
      break;
    }
    if (!matchedDirect) {
      for (const t of toks) {
        if (/\b(curl|wget|http|https)\b/.test(t) && t !== seg) {
          if (depth >= 3) return true;
          if (isHttpWriteCommand(t, depth + 1)) return true;
        }
      }
    }
  }
  return false;
}

function isAllowedDbcredSubstitution(
  inner: string,
  workbenchRoot: string,
  workdir: string,
): boolean {
  const trimmed = inner.trim();
  if (!trimmed || /[;|&`<>()\n\r\0'"]/.test(trimmed)) return false;
  const parts = trimmed.split(/[ \t]+/).filter(Boolean);
  if (parts.length !== 2) return false;
  const [bin, envArg] = parts;
  if (!/^[A-Za-z0-9._-]+$/.test(envArg)) return false;
  // Never permit bare `dbcred` resolved via PATH; must be an explicit relative/absolute path
  if (!bin.includes("/")) return false;
  const expectedReal = canonicalizeOsPath(workbenchRoot, ".workbench/bin/dbcred");
  const candidateReal = canonicalizeOsPath(workdir, bin);
  if (!expectedReal || !candidateReal) return false;
  return candidateReal === expectedReal;
}

/**
 * Quote-aware single-command safety check for Runbook-approved SQL migration files:
 * - Permits literal `&` / `?` inside single/double quotes (e.g. PostgreSQL DSN query params).
 * - Permits ONLY exact double-quoted `$(<path-to-.workbench/bin/dbcred> <env>)` credential substitution.
 * - Permits ONLY exact `2>&1` / `1>&2` fd duplication; rejects ALL other output redirections (`>`).
 * - Rejects shell chaining (`;`, `&&`, `||`, `|`, `&`, `\n`), subshells, backticks, heredocs, and arbitrary `$(...)`.
 */
function isSafeSingleSqlShellCommand(
  cmd: string,
  workbenchRoot: string,
  workdir: string,
): boolean {
  let quote: "'" | '"' | null = null;
  let escape = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    const next = cmd[i + 1];
    if (ch === "\0" || ch === "\n" || ch === "\r") return false;
    if (escape) {
      escape = false;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') {
        quote = null;
        continue;
      }
      if (ch === "`") return false;
      if (ch === "$" && next === "(") {
        const closeIdx = cmd.indexOf(")", i + 2);
        if (closeIdx === -1) return false;
        const inner = cmd.slice(i + 2, closeIdx);
        if (!isAllowedDbcredSubstitution(inner, workbenchRoot, workdir)) return false;
        i = closeIdx;
        continue;
      }
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === "$" && next === "'") {
      // Reject Bash ANSI-C `$'...'` quoting for approved SQL migrations to guarantee zero escape-decoding ambiguity
      return false;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    // Reject ALL unquoted `$(...)` (dbcred substitution is only allowed inside double quotes)
    if (ch === "$" && next === "(") return false;
    if (ch === "<") {
      if (next === "<" || next === ">" || next === "&") return false;
      // Reject numbered input redirections on non-stdin fds (e.g. `3< migration.sql`), allow only plain `<` or `0<`
      let dStart = i - 1;
      while (dStart >= 0 && cmd[dStart] >= "0" && cmd[dStart] <= "9") dStart--;
      const numStr = cmd.slice(dStart + 1, i);
      const beforeNum = dStart >= 0 ? cmd[dStart] : undefined;
      if (
        numStr.length > 0 &&
        (beforeNum === undefined || beforeNum === " " || beforeNum === "\t") &&
        numStr !== "0"
      ) {
        return false;
      }
      continue;
    }
    if (ch === ">") {
      // Allow ONLY standalone `2>&1` or `1>&2` fd duplication; reject all file output redirections (`> file`, `>> file`, etc.)
      const prev = cmd[i - 1];
      const beforePrev = cmd[i - 2];
      const targetFd = cmd[i + 2];
      const afterTarget = cmd[i + 3];
      const validSrcFd =
        (prev === "2" || prev === "1") &&
        (beforePrev === undefined || beforePrev === " " || beforePrev === "\t");
      const validDup =
        validSrcFd &&
        next === "&" &&
        (targetFd === "1" || targetFd === "2") &&
        targetFd !== prev &&
        (afterTarget === undefined || afterTarget === " " || afterTarget === "\t");
      if (!validDup) return false;
      i += 2; // consume `>&1` / `>&2`
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "`" || ch === "(" || ch === ")") {
      return false;
    }
  }
  return !escape && quote === null;
}

/**
 * Quote-aware tokenization for a validated single SQL command that separates `< file` / `<file`
 * stdin redirections and drops benign `2>&1` / `1>&2` fd duplications.
 */
function extractSqlTokensAndStdinRedirects(
  cmd: string,
): { args: string[]; stdinFiles: string[] } | null {
  const rawTokens: Array<{ kind: "word" | "stdin" | "fddup"; value: string }> = [];
  let cur = "";
  let hasWord = false;
  let quote: "'" | '"' | null = null;
  let escape = false;

  const flush = () => {
    if (!hasWord) return;
    if (cur === "2>&1" || cur === "1>&2") {
      rawTokens.push({ kind: "fddup", value: cur });
    } else {
      rawTokens.push({ kind: "word", value: cur });
    }
    cur = "";
    hasWord = false;
  };

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    const next = cmd[i + 1];
    if (escape) {
      cur += ch;
      hasWord = true;
      escape = false;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
      hasWord = true;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
        if (next === '"' || next === "\\" || next === "$" || next === "`") {
          escape = true;
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        quote = null;
      } else {
        cur += ch;
      }
      hasWord = true;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === "$" && next === "'") {
      return null;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasWord = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      flush();
      continue;
    }
    if (ch === "<") {
      if (hasWord && /^\d+$/.test(cur)) {
        if (cur !== "0") return null; // Only fd 0 (`0<` or `<`) feeds client stdin!
        cur = "";
        hasWord = false;
      } else {
        flush();
      }
      rawTokens.push({ kind: "stdin", value: "<" });
      continue;
    }
    cur += ch;
    hasWord = true;
  }
  if (quote !== null || escape) return null;
  flush();

  const args: string[] = [];
  const stdinFiles: string[] = [];
  for (let i = 0; i < rawTokens.length; i++) {
    const tok = rawTokens[i];
    if (tok.kind === "fddup") continue;
    if (tok.kind === "stdin") {
      const nextTok = rawTokens[++i];
      if (!nextTok || nextTok.kind !== "word" || !nextTok.value) return null;
      stdinFiles.push(nextTok.value);
      continue;
    }
    args.push(tok.value);
  }
  return { args, stdinFiles };
}

function extractHostsFromConnStr(connStr: string): { hosts: string[]; invalid: boolean } {
  const hosts: string[] = [];
  const trimmed = connStr.trim();
  const uriMatch = trimmed.match(/^(?:postgres(?:ql)?|mysql):\/\/(.*)$/i);
  if (uriMatch) {
    // Replace validated `$(.../dbcred <env>)` placeholders before URI authority/path splitting
    // so slashes inside the helper path (e.g. `.workbench/bin/dbcred`) never truncate the authority!
    const rest = uriMatch[1].replace(/\$\([^)]*\)/g, "CRED");
    const qIdx = rest.indexOf("?");
    const beforeQuery = qIdx >= 0 ? rest.slice(0, qIdx) : rest;
    const queryStr = qIdx >= 0 ? rest.slice(qIdx + 1) : "";
    const slashIdx = beforeQuery.indexOf("/");
    const authority = slashIdx >= 0 ? beforeQuery.slice(0, slashIdx) : beforeQuery;
    const atIdx = authority.lastIndexOf("@");
    const hostPortList = atIdx >= 0 ? authority.slice(atIdx + 1) : authority;
    let invalid = false;
    const addEncodedHost = (encoded: string) => {
      try {
        for (const entry of decodeURIComponent(encoded).split(",")) {
          if (entry.trim()) hosts.push(entry.trim());
          else invalid = true;
        }
      } catch {
        invalid = true;
      }
    };
    if (hostPortList.length > 0) {
      for (const part of hostPortList.split(",")) {
        const p = part.trim();
        let host = p;
        if (p.startsWith("[")) {
          const endBracket = p.indexOf("]");
          if (endBracket < 0) { invalid = true; continue; }
          host = p.slice(1, endBracket);
        } else {
          const colonIdx = p.lastIndexOf(":");
          if (colonIdx >= 0) host = p.slice(0, colonIdx);
        }
        addEncodedHost(host);
      }
    }
    if (queryStr) {
      for (const pair of queryStr.split("&")) {
        if (!pair) continue;
        const eqIdx = pair.indexOf("=");
        const rawKey = eqIdx >= 0 ? pair.slice(0, eqIdx) : pair;
        const rawVal = eqIdx >= 0 ? pair.slice(eqIdx + 1) : "";
        try {
          const key = decodeURIComponent(rawKey).toLowerCase();
          if (key === "host") {
            for (const entry of rawVal.split(",")) addEncodedHost(entry);
          } else {
            decodeURIComponent(rawVal);
            if (key === "service" || key === "hostaddr") invalid = true;
          }
        } catch {
          invalid = true;
        }
      }
    }
    return { hosts, invalid };
  }

  // libpq keyword=value connection string (e.g. `host = prod-db.internal dbname=app`)
  if (trimmed.includes("=")) {
    let i = 0;
    while (i < trimmed.length) {
      while (i < trimmed.length && (trimmed[i] === " " || trimmed[i] === "\t")) i++;
      if (i >= trimmed.length) break;
      const eqIdx = trimmed.indexOf("=", i);
      if (eqIdx < 0) return { hosts, invalid: true };
      const key = trimmed.slice(i, eqIdx).trim().toLowerCase();
      if (!/^[a-z_][a-z0-9_]*$/.test(key)) return { hosts, invalid: true };
      i = eqIdx + 1;
      while (i < trimmed.length && (trimmed[i] === " " || trimmed[i] === "\t")) i++;
      if (i >= trimmed.length) return { hosts, invalid: true };
      let val = "";
      if (trimmed[i] === "'") {
        i++;
        let closed = false;
        while (i < trimmed.length) {
          if (trimmed[i] === "\\" && i + 1 < trimmed.length) {
            val += trimmed[i + 1];
            i += 2;
          } else if (trimmed[i] === "'") {
            i++;
            closed = true;
            break;
          } else {
            val += trimmed[i++];
          }
        }
        if (!closed) return { hosts, invalid: true };
      } else {
        while (i < trimmed.length && trimmed[i] !== " " && trimmed[i] !== "\t") {
          if (trimmed[i] === "\\" && i + 1 < trimmed.length) {
            val += trimmed[i + 1];
            i += 2;
          } else {
            val += trimmed[i++];
          }
        }
      }
      if (key === "service" || key === "hostaddr") return { hosts, invalid: true };
      if (key === "host") {
        if (!val.trim()) return { hosts, invalid: true };
        for (const h of val.split(",")) {
          if (!h.trim()) return { hosts, invalid: true };
          hosts.push(h.trim());
        }
      }
    }
  }
  return { hosts, invalid: false };
}

const DISALLOWED_PSQL_ENV_VARS = new Set([
  "PSQLRC",
  "PGSERVICE",
  "PGSERVICEFILE",
  "PGHOSTADDR",
]);

const DISALLOWED_MYSQL_ENV_VARS = new Set([
  "MYSQL_HOME",
  "MYSQL_GROUP_SUFFIX",
  "MYSQL_TEST_LOGIN_FILE",
]);

const DISALLOWED_USQL_ENV_VARS = new Set([
  "USQLRC",
  "PSQLRC",
  "PGSERVICE",
  "PGSERVICEFILE",
  "PGHOSTADDR",
  "MYSQL_HOME",
]);

const PSQL_LONG_VALUE_FLAGS = new Set([
  "--host",
  "--port",
  "--username",
  "--dbname",
  "--file",
  "--set",
  "--variable",
  "--pset",
]);

const PSQL_LONG_BOOL_FLAGS = new Set([
  "--no-psqlrc",
  "--quiet",
  "--echo-all",
  "--echo-errors",
  "--echo-queries",
  "--single-transaction",
  "--tuples-only",
  "--no-align",
  "--csv",
  "--expanded",
  "--no-password",
  "--password",
]);

const PSQL_SHORT_VALUE_FLAGS = new Set(["h", "p", "U", "d", "f", "v", "P"]);

const PSQL_SHORT_BOOL_FLAGS = new Set(["X", "q", "a", "b", "e", "1", "t", "A", "x", "w", "W"]);

const USQL_LONG_VALUE_FLAGS = new Set(["--file", "--set", "--variable", "--pset"]);

const USQL_LONG_BOOL_FLAGS = new Set([
  "--no-rc",
  "--quiet",
  "--single-transaction",
  "--no-align",
  "--tuples-only",
  "--json",
  "--csv",
]);

const USQL_SHORT_VALUE_FLAGS = new Set(["f", "v", "P"]);

const USQL_SHORT_BOOL_FLAGS = new Set(["X", "q", "1", "A", "t", "J", "C"]);

const MYSQL_LONG_VALUE_FLAGS = new Set([
  "--host",
  "--port",
  "--user",
  "--password",
  "--database",
  "--default-character-set",
  "--ssl-mode",
  "--protocol",
]);

const MYSQL_LONG_BOOL_FLAGS = new Set([
  "--verbose",
  "--batch",
  "--skip-column-names",
  "--silent",
  "--ssl",
  "--skip-ssl",
  "--no-auto-rehash",
]);

const MYSQL_SHORT_VALUE_FLAGS = new Set(["h", "P", "u", "p", "D"]);

const MYSQL_SHORT_BOOL_FLAGS = new Set(["v", "B", "N", "s", "A"]);

function normalizeSqlHosts(bin: string, values: string[]): string[] {
  return values.flatMap((value) => bin === "psql" ? value.split(",") : [value])
    .map((host) => host.trim().toLowerCase());
}

function parseSqlClientArgs(bin: "psql" | "mysql" | "usql", toks: string[], inspectWrites: boolean) {
  const hostCandidates: string[] = [];
  const longValueFlags =
    bin === "psql"
      ? PSQL_LONG_VALUE_FLAGS
      : bin === "usql"
        ? USQL_LONG_VALUE_FLAGS
        : MYSQL_LONG_VALUE_FLAGS;
  const longBoolFlags =
    bin === "psql"
      ? PSQL_LONG_BOOL_FLAGS
      : bin === "usql"
        ? USQL_LONG_BOOL_FLAGS
        : MYSQL_LONG_BOOL_FLAGS;
  const shortValueFlags =
    bin === "psql"
      ? PSQL_SHORT_VALUE_FLAGS
      : bin === "usql"
        ? USQL_SHORT_VALUE_FLAGS
        : MYSQL_SHORT_VALUE_FLAGS;
  const shortBoolFlags =
    bin === "psql"
      ? PSQL_SHORT_BOOL_FLAGS
      : bin === "usql"
        ? USQL_SHORT_BOOL_FLAGS
        : MYSQL_SHORT_BOOL_FLAGS;

  const flagFiles: string[] = [];
  const positionals: string[] = [];
  let dbname: string | undefined;
  let stopFlags = false;

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!stopFlags && t === "--") {
      stopFlags = true;
      continue;
    }
    if (!stopFlags && t.startsWith("--")) {
      const eq = t.indexOf("=");
      const name = eq >= 0 ? t.slice(0, eq) : t;
      const eqVal = eq >= 0 ? t.slice(eq + 1) : null;
      if (longBoolFlags.has(name)) {
        if (eqVal !== null) return null;
        continue;
      }
      if (longValueFlags.has(name) || (inspectWrites && name === (bin === "psql" ? "--command" : "--execute"))) {
        const val = eqVal !== null ? eqVal : toks[++i];
        if (val === undefined || val === "") return null;
        if (name === "--file") flagFiles.push(val);
        else if (name === "--host") hostCandidates.push(val);
        else if (name === "--dbname" && bin === "psql") {
          if (dbname !== undefined) return null;
          dbname = val;
        }
        continue;
      }
      return null; // Reject unknown or dangerous long flag (`--command`, `--execute`, `--output`, `--defaults-file`, etc.)
    }
    if (!stopFlags && t.startsWith("-") && t.length > 1) {
      for (let j = 1; j < t.length; j++) {
        const ch = t[j];
        if (shortBoolFlags.has(ch)) continue;
        if (shortValueFlags.has(ch) || (inspectWrites && ch === (bin === "psql" ? "c" : "e"))) {
          const val = j < t.length - 1 ? t.slice(j + 1) : toks[++i];
          if (val === undefined || val === "") return null;
          if (ch === "f") flagFiles.push(val);
          else if (ch === "h") hostCandidates.push(val);
          else if (ch === "d" && bin === "psql") {
            if (dbname !== undefined) return null;
            dbname = val;
          }
          break;
        }
        return null; // Reject unknown or dangerous short flag (`-c`, `-Xc`, `-e`, `-Be`, `-o`, etc.)
      }
      continue;
    }
    positionals.push(t);
  }

  // Parse positional connection targets per client grammar
  if (bin === "psql") {
    if (positionals.length > 2 || (dbname !== undefined && positionals.length > 0)) return null;
    const connection = dbname ?? positionals[0];
    if (connection) {
      const parsedConn = extractHostsFromConnStr(connection);
      if (parsedConn.invalid) return null;
      hostCandidates.push(...parsedConn.hosts);
    }
  } else if (bin === "usql") {
    // usql requires a single explicit URI DSN positional
    if (positionals.length !== 1 || !/^(?:postgres(?:ql)?|mysql):\/\//i.test(positionals[0])) {
      return null;
    }
    const parsedConn = extractHostsFromConnStr(positionals[0]);
    if (parsedConn.invalid) return null;
    hostCandidates.push(...parsedConn.hosts);
  } else {
    if (positionals.length > 1) return null;
  }

  return { hostCandidates, flagFiles };
}

function parseApprovedSqlMigrationCommand(
  workbenchRoot: string,
  cmd: string,
  workdir: string,
): { host: string; sqlRealPath: string } | null {
  if (!isSafeSingleSqlShellCommand(cmd, workbenchRoot, workdir)) return null;
  if (splitShellSegments(cmd).length !== 1) return null;
  const extracted = extractSqlTokensAndStdinRedirects(cmd);
  if (!extracted || extracted.args.length < 2) return null;
  const { args: toks, stdinFiles } = extracted;

  // Identify client binary FIRST, then apply case-sensitive client-specific env & option rules!
  const rawEnvPairs: Array<[string, string]> = [];
  let idx = 0;
  while (idx < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[idx])) {
    const eq = toks[idx].indexOf("=");
    rawEnvPairs.push([toks[idx].slice(0, eq), toks[idx].slice(eq + 1)]);
    idx++;
  }
  const bin = (toks[idx] ?? "").split("/").pop() ?? "";
  if (bin !== "psql" && bin !== "usql" && bin !== "mysql") return null;

  const disallowedEnv =
    bin === "psql"
      ? DISALLOWED_PSQL_ENV_VARS
      : bin === "usql"
        ? DISALLOWED_USQL_ENV_VARS
        : DISALLOWED_MYSQL_ENV_VARS;
  const inlineEnv = new Map(rawEnvPairs);
  for (const key of disallowedEnv) {
    if (inlineEnv.get(key) ?? process.env[key]) return null;
  }
  const hostEnvKey = bin === "psql" ? "PGHOST" : bin === "mysql" ? "MYSQL_HOST" : null;
  const parsed = parseSqlClientArgs(bin, toks.slice(idx + 1), false);
  if (!parsed) return null;
  const { hostCandidates, flagFiles } = parsed;
  const allFiles = [...flagFiles, ...stdinFiles];
  if (allFiles.length !== 1 || !allFiles[0]) return null;

  if (hostCandidates.length === 0 && hostEnvKey) {
    const host = inlineEnv.get(hostEnvKey) ?? process.env[hostEnvKey];
    if (host) hostCandidates.push(host);
  }
  const normalizedHosts = new Set(normalizeSqlHosts(bin, hostCandidates));
  if (normalizedHosts.has("") || normalizedHosts.size !== 1) return null;
  const effectiveHost = [...normalizedHosts][0];

  const sqlRealPath = canonicalizeOsPath(workdir, allFiles[0]);
  if (!sqlRealPath) return null;
  return { host: effectiveHost, sqlRealPath };
}

function findSqlClient(toks: string[]) {
  const idx = toks.findIndex((tok) => /(?:^|\/)(psql|mysql|usql)$/.test(tok));
  return { bin: toks[idx]?.split("/").pop(), args: toks.slice(idx + 1) };
}

function extractCheckProdDbHosts(bin: "psql" | "usql" | "mysql", args: string[]) {
  const parsedArgs = parseSqlClientArgs(bin, args, true);
  if (parsedArgs) {
    const hosts = parsedArgs.hostCandidates;
    return { hosts, unsafeOverride: normalizeSqlHosts(bin, hosts).some((h) => !h || hasShellExpansion(h)) };
  }
  // Even with unsupported options, inspect known host selectors. Ambiguous operands
  // must not suppress the inherited host when deciding whether production is in scope.
  const hosts: string[] = [];
  let unsafeOverride = false;
  let stopFlags = false;
  let positionals = 0;
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (!stopFlags && tok === "--") { stopFlags = true; continue; }
    let conn = tok;
    if (!stopFlags && tok.startsWith("-")) {
      const eq = tok.indexOf("=");
      const opt = eq < 0 ? tok : tok.slice(0, eq);
      if (["--defaults-file", "--defaults-extra-file", "--defaults-group-suffix", "--login-path"].includes(opt)) {
        unsafeOverride = true;
      }
      if (opt === "--host" || opt === "--dbname" || /^-[hd]/.test(tok)) {
        const value = tok.startsWith("--") ? (eq < 0 ? args[++i] : tok.slice(eq + 1))
          : tok.slice(2) || args[++i];
        if (!value) { unsafeOverride = true; continue; }
        if (opt === "--host" || tok.startsWith("-h")) { hosts.push(value); continue; }
        conn = value;
      } else {
        const values = bin === "mysql" ? MYSQL_LONG_VALUE_FLAGS : PSQL_LONG_VALUE_FLAGS;
        if (eq < 0 && (values.has(opt) || ["-c", "-e", "-f", "-U", "-u", "-P", "-v", "--execute", "--command", "--connect-timeout"].includes(opt))) i++;
        else if (eq < 0 && !opt.startsWith("--")) unsafeOverride = true;
        else if (eq < 0 && opt.startsWith("--") &&
          !(bin === "mysql" ? MYSQL_LONG_BOOL_FLAGS : PSQL_LONG_BOOL_FLAGS).has(opt)) unsafeOverride = true;
        continue;
      }
    }
    if (stopFlags || !tok.startsWith("-")) positionals++;
    if (bin !== "mysql" && (/^(postgres(?:ql)?|mysql):\/\//i.test(conn) || conn.includes("="))) {
      if (positionals > 1) unsafeOverride = true;
      const parsed = extractHostsFromConnStr(conn);
      hosts.push(...parsed.hosts);
      if (parsed.invalid) unsafeOverride = true;
    }
  }
  if (normalizeSqlHosts(bin, hosts).some((h) => !h || hasShellExpansion(h))) unsafeOverride = true;
  return { hosts, unsafeOverride };
}

function hasSqlClientFileOption(cmd: string): boolean {
  for (const seg of splitShellSegments(cmd)) {
    const toks = splitShellTokens(seg);
    if (!toks || toks.length === 0) continue;
    const prefix = unwrapShellPrefix(toks);
    const { bin, args } = prefix.ambiguous ? findSqlClient(expandEnvSplitStrings(toks)) : prefix;
    if (bin !== "psql" && bin !== "usql" && bin !== "mysql") continue;
    for (const t of args) {
      if (t === "--") break;
      if (t === "--file" || t.startsWith("--file=")) return true;
      if (t.startsWith("-") && !t.startsWith("--") && t.length > 1) {
        if (bin === "psql" || bin === "usql") {
          for (let j = 1; j < t.length; j++) {
            const ch = t[j];
            if (ch === "f") return true;
            if (PSQL_SHORT_VALUE_FLAGS.has(ch) || ch === "c" || ch === "o" || ch === "L") break;
          }
        }
      }
    }
  }
  return false;
}

const SAFE_LEDGER_CLI_SUBCMDS = new Set([
  "runbook",
  "open",
  "close",
  "record",
  "decide",
  "blocker",
  "status",
  "query",
  "attach",
  "detach",
  "reopen",
  "set-endpoint",
  "cancel",
  "verify",
]);

/**
 * Verify that `cmd` is a standalone, metacharacter-free invocation of this workbench's own
 * canonical `.workbench/bin/ledger` CLI (which only operates on local `.workbench/ledger/ledger.sqlite`
 * and never connects to remote databases). Prevents `checkProdDb` from falsely blocking commands like
 * `.workbench/bin/ledger runbook create --sql <prod-host>:<file>` or `ledger record --summary "... <prod-host> ..."`.
 */
function isSafeWorkbenchLedgerCliCommand(
  cmd: string,
  workbenchRoot: string,
  workdir: string,
): boolean {
  let quote: "'" | '"' | null = null;
  let escape = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    const next = cmd[i + 1];
    if (ch === "\0" || ch === "\n" || ch === "\r") return false;
    if (escape) {
      escape = false;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') {
        quote = null;
        continue;
      }
      if (ch === "`" || (ch === "$" && next === "(")) return false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === "$" && next === "'") {
      return false;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "$" && next === "(") return false;
    if (
      ch === ";" ||
      ch === "|" ||
      ch === "&" ||
      ch === ">" ||
      ch === "<" ||
      ch === "`" ||
      ch === "(" ||
      ch === ")"
    ) {
      return false;
    }
  }
  if (escape || quote !== null) return false;
  if (splitShellSegments(cmd).length !== 1) return false;
  const toks = splitShellTokens(cmd);
  if (!toks || toks.length < 2) return false;
  const bin = toks[0];
  if (!bin.includes("/")) return false;
  const expectedLedger = canonicalizeOsPath(workbenchRoot, ".workbench/bin/ledger");
  const candidateLedger = canonicalizeOsPath(workdir, bin);
  if (!expectedLedger || !candidateLedger || candidateLedger !== expectedLedger) {
    return false;
  }
  return SAFE_LEDGER_CLI_SUBCMDS.has(toks[1]);
}

export function checkProdDb(
  cmd: string,
  prodHosts: string[],
  toolWorkdir = process.cwd(),
  approvedRunbooks: ApprovedRunbookEntry[] = [],
  workbenchRoot = toolWorkdir,
): string | null {
  if (prodHosts.length === 0) return null;
  if (isSafeWorkbenchLedgerCliCommand(cmd, workbenchRoot, toolWorkdir)) return null;
  const matchedHosts: string[] = [];
  for (const seg of splitShellSegments(cmd)) {
    const toks = splitShellTokens(stripUnquotedShellRedirections(seg)) ?? [];
    const { bin, effective, args, ambiguous } = unwrapShellPrefix(toks);
    let literal = seg;
    const hosts: string[] = [];
    if (ambiguous) {
      const client = findSqlClient(expandEnvSplitStrings(toks));
      if (client.bin === "psql" || client.bin === "mysql" || client.bin === "usql") {
        hosts.push(...normalizeSqlHosts(client.bin, extractCheckProdDbHosts(client.bin, client.args).hosts));
      }
      for (const key of ["PGHOST", "PGHOSTADDR", "MYSQL_HOST"]) {
        hosts.push(...normalizeSqlHosts("psql", [effective(key), process.env[key] ?? ""]));
      }
    } else if (bin === "psql" || bin === "mysql" || bin === "usql") {
      const parsed = extractCheckProdDbHosts(bin, args);
      hosts.push(...parsed.hosts);
      if (hosts.length && !parsed.unsafeOverride) literal = args.join(" ");
      else if (bin !== "usql") hosts.push(effective(bin === "psql" ? "PGHOST" : "MYSQL_HOST"));
      if (bin === "psql") hosts.push(effective("PGHOSTADDR"));
    }
    const normalized = normalizeSqlHosts(bin ?? "", hosts);
    matchedHosts.push(...prodHosts.filter((h) => literal.toLowerCase().includes(h.toLowerCase()) || normalized.includes(h.toLowerCase())));
  }
  if (matchedHosts.length === 0) return null;
  const matchedHost = matchedHosts[0];

  // ClickHouse HTTP write or POST/PUT/DELETE via curl/wget/http
  if (isHttpWriteCommand(cmd)) {
    if (SQL_WRITE_RE.test(cmd) || !/\bselect\b/i.test(cmd)) {
      return `物理保险丝：检测到向 prod 数据库 (${matchedHost}) 发送写请求，禁止自动执行。`;
    }
  }

  if (SQL_FILE_FLAG_RE.test(cmd) || hasUnquotedRedirect(cmd, "<") || hasSqlClientFileOption(cmd)) {
    if (approvedRunbooks.length > 0) {
      const parsed = parseApprovedSqlMigrationCommand(workbenchRoot, cmd, toolWorkdir);
      if (parsed && prodHosts.some((h) => h.toLowerCase() === parsed.host)) {
        const liveSha = sha256File(parsed.sqlRealPath);
        if (
          liveSha &&
          approvedRunbooks.some((rb) =>
            rb.actions.sql_files.some(
              (sf) =>
                sf.host.toLowerCase() === parsed.host &&
                sf.path === parsed.sqlRealPath &&
                sf.sha256 === liveSha,
            ),
          )
        ) {
          return null;
        }
      }
    }
    return `物理保险丝：检测到连接 prod 数据库 (${matchedHost}) 且 SQL 来自文件或标准输入，禁止自动执行（如需发版迁移，请先创建 Runbook 登记 SQL 文件并由用户在对话中回复「批准 <runbook_id>」）。`;
  }
  const m = cmd.match(SQL_WRITE_RE);
  if (m) {
    return `物理保险丝：检测到连接 prod 数据库 (${matchedHost}) 且包含写操作关键字 ${m[1].toUpperCase()}，禁止自动执行。`;
  }
  return null;
}
