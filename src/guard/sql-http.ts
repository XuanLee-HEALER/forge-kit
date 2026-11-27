import { normalizeDbHosts } from "../config";
import { type ApprovedRunbookEntry } from "./runbook-state";
import { canonicalizeOsPath, sha256File } from "../shared/path";
import {
  resolveSegmentCwd,
  tokenizeSimpleShellCommand,
  hasUnquotedPipe,
  hasUnquotedRedirect,
  splitShellSegments,
  splitShellTokens,
  splitShellTokensWithMeta,
  stripUnquotedShellRedirections,
  unwrapShellPrefix,
} from "../shared/shell";

const psqlOption = (arg: string) => arg.replace(/^-(?!-)[01aAbeEHnqstwWxXz]+/, "-");

export const SQL_WRITE_RE =
  /\b(insert|update|delete|merge|replace|alter|drop|create|truncate|grant|revoke|copy|call|do|reindex|vacuum|refresh|comment|lock|set|begin|commit|setval|nextval|pg_terminate_backend|pg_cancel_backend|optimize|attach|detach|rename|kill)\b/i;

export function isHttpWriteCommand(cmd: string): boolean {
  for (const seg of splitShellSegments(cmd)) {
    const toks = splitShellTokens(seg) ?? [];
    const { bin, args } = unwrapShellPrefix(toks);
    if (!bin) continue;
    if (["sh", "bash", "zsh"].includes(bin) && args.some(a => /^-[a-z]*c$/.test(a))) {
      const i = args.findIndex(a => /^-[a-z]*c$/.test(a));
      if (args[i + 1] && isHttpWriteCommand(args[i + 1])) return true;
    }
    if (!["curl", "wget", "http", "https"].includes(bin)) continue;
    if (/^https?$/.test(bin) && !args.some(a => /^(GET|HEAD|OPTIONS)$/i.test(a)) &&
        (hasUnquotedRedirect(seg, "<") || args.some(a => /^[\w.-]+(?::?=(?!=)|@)/.test(a)) ||
         (hasUnquotedPipe(cmd) && /\|\s*(?:[^\s|]+\/)?https?\s/.test(cmd)))) return true;
    for (const [i, arg] of args.entries()) {
      if (/:8123\b|[?&]query=/i.test(arg)) return true;
      if (bin === "curl" && /^(?:-[fsSsvkLqI]*[dFT]|--(?:data|form|upload-file|json)\b)/.test(arg)) return true;
      if (bin === "wget" && /^--(?:post|body)-(?:data|file)\b/.test(arg)) return true;
      const methodFlag = /^(?:-[fsSsvkLqI]*X|--request=?|--method=?)(.*)$/.exec(arg);
      const method = methodFlag && (methodFlag[1] || args[i + 1]);
      if (method && !/^(GET|HEAD|OPTIONS)$/i.test(method)) return true;
      if (/^https?$/.test(bin) && /^(POST|PUT|PATCH|DELETE)$/i.test(arg)) return true;
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
  const [bin, subcommand, envArg, ...flags] = parts;
  if (subcommand !== "dbcred") return false;
  if (!envArg || !/^[A-Za-z0-9._/-]+$/.test(bin)) return false;
  if (flags.length && !(flags.length === 1 && flags[0] === "--ro")) {
    return false;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(envArg)) return false;
  // Never permit bare `dbcred` resolved via PATH; must be an explicit relative/absolute path
  if (!bin.includes("/")) return false;
  const expectedReal = canonicalizeOsPath(workbenchRoot, ".workbench/bin/forge");
  const candidateReal = canonicalizeOsPath(workdir, bin);
  if (!expectedReal || !candidateReal) return false;
  return candidateReal === expectedReal;
}

// The approval grammar accepts literal argv, one file input, and an optional
// credential substitution in a quoted URI. Anything outside it needs another command.
function migrationMatches(cmd: string, root: string, cwd: string, runbook: ApprovedRunbookEntry, prodHosts: string[]) {
  const credentials: string[] = [];
  const words: string[] = [];
  const files: string[] = [];
  let stdin = false;
  const lexer = /\s+|(?:2>&1|1>&2)(?=\s|$)|(?:0?<)|(?:[A-Za-z_]\w*=)?'(?:[^']*)'|(?:[A-Za-z_]\w*=)?"(?:[^"\\]*)"|[^\s'"\\;&|<>$()#~*?\x60]+/gy;
  if (/[\r\n\0]/.test(cmd)) return false;
  for (let pos = 0; pos < cmd.length;) {
    lexer.lastIndex = pos;
    const token = lexer.exec(cmd)?.[0];
    if (!token) return false;
    pos = lexer.lastIndex;
    if (!token.trim()) continue;
    if (/^\d+$/.test(token) && cmd[pos] === "<") return false;
    if (token === "<" || token === "0<") {
      if (stdin) return false;
      stdin = true;
      continue;
    }
    if (pos < cmd.length && !/[\s<]/.test(cmd[pos])) return false;
    if (token === "2>&1" || token === "1>&2") continue;
    let value = token;
    if (token.startsWith('"')) {
      value = token.replace(/^("(?:postgres(?:ql)?|mysql):\/\/)\$\(([^()]*)\)(?=@)/i, (_, scheme, inner) => {
        credentials.push(inner);
        return scheme + "credential";
      });
    }
    if (/[$\x60]/.test(value)) return false;
    value = value.replace(/^(.*?)['"](.*)['"]$/, "$1$2");
    (stdin ? files : words).push(value);
    stdin = false;
  }
  const env = new Map<string, string>();
  while (words.length && /^[A-Za-z_]\w*=/.test(words[0])) {
    const [key, ...parts] = words.shift()!.split("=");
    env.set(key, parts.join("="));
  }
  const bin = words.shift()?.split("/").pop();
  if (stdin || !bin || !["mysql", "psql", "usql"].includes(bin)) return false;
  const setting = (key: string) => env.get(key) ?? process.env[key] ?? "";
  if (["PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE", "PSQLRC", "USQLRC", "MYSQL_HOME",
       "MYSQL_GROUP_SUFFIX", "MYSQL_TEST_LOGIN_FILE"].some(key => setting(key))) return false;
  const hosts: string[] = [];
  let database: string | undefined;
  for (let i = 0; i < words.length; i++) {
    // psql scans boolean shorthands until the first option consuming a value.
    const arg = bin === "psql" ? psqlOption(words[i]) : words[i];
    if (bin === "psql" && arg === "-" && words[i] !== "-") continue;
    if (bin === "mysql" && (arg === "--ssl-mode" || arg.startsWith("--ssl-mode="))) {
      const mode = arg === "--ssl-mode" ? words[++i] : arg.slice("--ssl-mode=".length);
      if (!/^(DISABLED|PREFERRED|REQUIRED|VERIFY_CA|VERIFY_IDENTITY)$/i.test(mode ?? "")) return false;
      continue;
    }
    if (bin !== "mysql" && /^(?:-X|-w|-q|--quiet|--single-transaction)$/.test(arg)) continue;
    if (bin === "psql" && ["--no-psqlrc", "--no-password"].includes(arg)) continue;
    const connectionFlag = bin === "mysql" ? /^(?:-([uP])(.*)|--(port|user)(?:=(.*))?)$/ :
      /^(?:-([Up])(.*)|--(port|username)(?:=(.*))?)$/;
    const connection = bin !== "usql" && connectionFlag.exec(arg);
    if (connection) {
      const value = connection[2] || connection[4] || words[++i];
      if (!value || !/^[\w.-]+$/.test(value)) return false;
      continue;
    }
    if (bin !== "mysql" && arg === "-v" && words[i + 1] === "ON_ERROR_STOP=1") { i++; continue; }
    const flag = /^(--file|--host|--dbname)(?:=(.*))?$/.exec(arg) ?? /^(-[fhd])(.*)$/.exec(arg);
    if (flag) {
      const value = flag[2] || words[++i];
      if (!value || value.startsWith("-")) return false;
      if (["-f", "--file"].includes(flag[1]) && bin !== "mysql") files.push(value);
      else if (["-h", "--host"].includes(flag[1]) && bin !== "usql") hosts.push(value);
      else if (["-d", "--dbname"].includes(flag[1]) && bin === "psql" && database === undefined) database = value;
      else return false;
    } else if (!arg.startsWith("-") && database === undefined) database = arg;
    else return false;
  }
  if (database && /^(postgres(?:ql)?|mysql):\/\//i.test(database) && bin !== "mysql") {
    try {
      const uri = new URL(database);
      if (!uri.hostname || [...uri.searchParams.keys()].some(k => !["sslmode", "application_name"].includes(k))) return false;
      hosts.push(decodeURIComponent(uri.hostname));
    } catch { return false; }
  } else if (bin === "usql" || database && !/^[\w.-]+$/.test(database)) return false;
  if (!hosts.length) hosts.push(setting(bin === "mysql" ? "MYSQL_HOST" : "PGHOST"));
  const destinations = new Set(hosts.flatMap(normalizeDbHosts));
  const [host] = destinations;
  if (!host || destinations.size !== 1 || !prodHosts.includes(host) || files.length !== 1) return false;
  if (!credentials.every(inner => isAllowedDbcredSubstitution(inner, root, cwd))) return false;
  const path = canonicalizeOsPath(cwd, files[0]);
  return !!path && runbook.actions.sql_files.some(f => f.path === path && normalizeDbHosts(f.host).includes(host) && f.sha256 === sha256File(path));
}

// Only disregard an inherited host when the client has a literal host operand.
function hasExplicitHost(bin: string | undefined, args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    let arg = bin === "psql" ? psqlOption(args[i]) : args[i];
    const host = /^(?:-h(.*)|--host(?:=(.*))?)$/.exec(arg);
    if (host) {
      const value = arg === "-h" || arg === "--host" ? args[i + 1] : host[1] ?? host[2];
      return !!value && normalizeDbHosts(value).every(h => /^[\w.:[\]-]+$/.test(h) && !h.startsWith("-"));
    }
    const valueFlag = bin === "psql" ? /^-[cfvUpPL]/ : bin === "mysql" ? /^-[uePD]/ : /^-[qd]/;
    if (valueFlag.test(arg)) { if (arg.length === 2) i++; continue; }
    if (/^--(?:command|execute|file|username|user|port|set|query|database)$/.test(arg)) { i++; continue; }
    if (bin === "psql" && (arg === "-d" || arg === "--dbname")) arg = args[++i] ?? "";
    if (bin === "psql") arg = arg.replace(/^(?:--dbname=|-d)(?=postgres)/i, "");
    if (/^postgres(?:ql)?:\/\//i.test(arg) && bin === "psql") {
      try {
        const uri = new URL(arg);
        return !!uri.hostname && !["host", "service", "hostaddr"].some(key => uri.searchParams.has(key));
      } catch { return false; }
    }
    if (bin === "psql" && /^(--no-psqlrc|--no-password|--quiet|--single-transaction)$/.test(arg)) continue;
    if (arg.startsWith("-") && arg !== "-" && !/^--[\w-]+=/.test(arg)) return false;
  }
  return false;
}

function productionHost(cmd: string, prodHosts: string[]) {
  for (const segment of splitShellSegments(cmd)) {
    const tokens = splitShellTokens(stripUnquotedShellRedirections(segment)) ?? [];
    const { bin, args, effective, ambiguous } = unwrapShellPrefix(tokens);
    const hosts: string[] = [];
    // Decode individual escapes so an unrelated malformed selector cannot hide a valid host.
    let hostText = segment;
    if (ambiguous || bin === "psql" || bin === "mysql" || bin === "clickhouse-client") {
      const explicit = hasExplicitHost(bin, args);
      const uncertain = ambiguous || args.some(a => /^(?:--defaults|--login-path)|[$\x60]/.test(a));
      if (explicit && !uncertain) hostText = args.join(" ");
      else {
        if (bin === "clickhouse-client" || ambiguous) hosts.push(effective("CLICKHOUSE_HOST"));
        if (bin === "psql" || ambiguous) hosts.push(effective("PGHOST"));
        if (bin === "mysql" || ambiguous) hosts.push(effective("MYSQL_HOST"));
      }
      if (bin === "psql" || ambiguous) hosts.push(effective("PGHOSTADDR"));
    }
    const literal = hostText.replace(/%([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))).toLowerCase();
    const inherited = hosts.flatMap(normalizeDbHosts);
    const host = prodHosts.find(h => literal.includes(h) || inherited.includes(h));
    if (host) return host;
  }
}

function literalCurlRead(cmd: string) {
  const argv = tokenizeSimpleShellCommand(cmd);
  if (!argv || argv[0]?.split("/").pop() !== "curl") return false;
  let body: string | undefined, urls = 0;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--data-binary" || arg.startsWith("--data-binary=")) {
      if (body !== undefined) return false;
      body = arg === "--data-binary" ? argv[++i] : arg.slice(14);
    } else if (arg === "-H" || arg === "--header") {
      if (!/^Content-Type:\s*[\w.+/-]+(?:\s*;\s*charset=[\w-]+)?$/i.test(argv[++i] ?? "")) return false;
    } else if (arg === "-X" || arg === "--request") {
      if (argv[++i]?.toUpperCase() !== "POST") return false;
    } else if (/^https?:\/\//i.test(arg) && !/[?&]query=/i.test(arg)) urls++;
    else if (!/^-[fsSkL]+$/.test(arg)) return false;
  }
  return urls === 1 && !!body && /^\s*(select|show|describe|explain)\b[^;]*;?\s*$/i.test(body) &&
    !SQL_WRITE_RE.test(body) && !/[$\x60]/.test(body);
}

export function checkProdDb(cmd: string, prodHosts: string[], toolWorkdir = process.cwd(),
  approvedRunbooks: ApprovedRunbookEntry[] | (() => ApprovedRunbookEntry[]) = [], workbenchRoot = toolWorkdir): string | null {
  if (!prodHosts.length) return null;
  const pipedInputs = new Set<number>();
  const segments = splitShellSegments(cmd, pipedInputs);
  for (const [index, segment] of segments.entries()) {
    const words = splitShellTokensWithMeta(stripUnquotedShellRedirections(segment)) ?? [];
    for (const word of words) {
      if (!word.hasExpansion) continue;
      const sub = /(?:\$\(|`)((?:[^\s()`]*\/)?(?:psql|mysql|usql|clickhouse-client|sqlite3|curl|wget|https?)\s+[\s\S]+)[)`]/.exec(word.value);
      if (sub) {
        const denied = checkProdDb(sub[1], prodHosts, toolWorkdir, [], workbenchRoot);
        if (denied) return denied;
      }
    }
    const tokens = words.map(word => word.value);
    const { bin, args, ambiguous } = unwrapShellPrefix(tokens);
    if (ambiguous && /\b(?:psql|mysql|usql|clickhouse-client|sqlite3)\b/.test(segment) && productionHost(segment, prodHosts))
      return "物理保险丝：无法确定 prod 数据库写入目标与输入。";
    if (["sh", "bash", "zsh"].includes(bin ?? "")) {
      const index = args.findIndex(a => /^-[a-z]*c$/.test(a));
      if (index >= 0 && args[index + 1]) {
        const denied = checkProdDb(args[index + 1], prodHosts, toolWorkdir, approvedRunbooks, workbenchRoot);
        if (denied) return denied;
      }
    }
    const sqlClient = ["psql", "mysql", "usql", "clickhouse-client", "sqlite3"].includes(bin ?? "");
    const httpClient = ["curl", "wget", "http", "https"].includes(bin ?? "");
    if (!sqlClient && !httpClient) continue;
    const host = productionHost(segment, prodHosts.map(h => h.toLowerCase()));
    if (!host) continue;
    if (httpClient) {
      const binaryBody = /(?:^|\s)--data-binary(?:=|\s)/.test(segment);
      const readQuery = binaryBody ? literalCurlRead(segment) :
        /(?:[?&]query=|(?:-d|--data(?:-raw)?)\s+['"]?)select\b/i.test(segment) && !SQL_WRITE_RE.test(segment);
      const pipedRequest = pipedInputs.has(index) && /^https?$/.test(bin ?? "") && !args.some(a => /^(GET|HEAD|OPTIONS)$/i.test(a));
      if ((isHttpWriteCommand(segment) || pipedRequest) && !readQuery)
        return "物理保险丝：检测到向 prod 数据库 (" + host + ") 发送写请求。";
      continue;
    }
    const fileInput = args.some(arg => /^(?:--(?:file|queries-file)(?:=|$)|-[Xq1]*f)/.test(arg)) ||
      (bin === "psql" && args.some(arg => /^-[^-cdfhLopPUv]*f/.test(arg))) ||
      /\\i\b|\.read\s|\bsource\s/i.test(segment) || hasUnquotedRedirect(segment, "<");
    const piped = pipedInputs.has(index);
    if (fileInput || piped) {
      const cwd = resolveSegmentCwd(segments, index, toolWorkdir);
      const approved = typeof approvedRunbooks === "function" ? approvedRunbooks() : approvedRunbooks;
      if (!piped && approved.some(r => migrationMatches(segment, workbenchRoot, cwd, r, prodHosts))) continue;
      return "物理保险丝：连接 prod 数据库 (" + host + ") 且 SQL 来自文件或标准输入，请先批准对应 Runbook。";
    }
    const write = args.join(" ").match(SQL_WRITE_RE);
    if (write) return "物理保险丝：连接 prod 数据库 (" + host + ") 且包含写操作关键字 " + write[1].toUpperCase();
  }
  return null;
}
