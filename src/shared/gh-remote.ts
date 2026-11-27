import { parseYamlFile } from "../config";
import { runGit } from "../git";
import { join, resolve } from "node:path";
import { unwrapShellPrefix } from "./shell";

/**
 * Parse a real Git remote URL (`git@host:owner/repo.git`, `https://host/owner/repo`, `ssh://...`).
 * NEVER accepts local filesystem paths like `/acme/svc` or `../acme/svc`.
 */
export function parseGitRemoteRepo(
  raw: string,
): { host: string; owner: string; repo: string } | null {
  const cleaned = raw.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  if (!cleaned) return null;
  // ssh scp-style: git@github.com:owner/repo
  const scp = cleaned.match(/^[^@/\s]+@([^:\s]+):([^/\s]+)\/([^/\s]+)$/);
  if (scp) {
    return {
      host: scp[1].toLowerCase(),
      owner: scp[2].toLowerCase(),
      repo: scp[3].toLowerCase(),
    };
  }
  // URL style: https://github.com/owner/repo or ssh://git@ghe.local/owner/repo
  const url = cleaned.match(/^(https?|ssh):\/\/(?:[^@/\s]+@)?([^:/\s]+)(?::(\d+))?\/([^/\s]+)\/([^/\s]+)$/i);
  if (url) {
    const [, scheme, hostname, port, owner, repo] = url;
    const defaultPort = scheme.toLowerCase() === "ssh" ? 22 : scheme.toLowerCase() === "https" ? 443 : 80;
    const host = hostname.toLowerCase() + (port && Number(port) !== defaultPort ? `:${Number(port)}` : "");
    return { host, owner: owner.toLowerCase(), repo: repo.toLowerCase() };
  }
  return null;
}

/**
 * Parse a `gh -R` / PR-URL repository spec (`[host/]owner/repo` or full remote URL).
 * Rejects absolute/relative filesystem paths (`/acme/svc`, `./acme/svc`, `../acme/svc`).
 */
export function parseGhRepoSpec(
  raw: string,
): { host: string; owner: string; repo: string } | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("/") || trimmed.startsWith(".")) return null;
  const asRemote = parseGitRemoteRepo(trimmed);
  if (asRemote) return asRemote;

  const cleaned = trimmed.replace(/\/+$/, "").replace(/\.git$/i, "");
  const parts = cleaned.split("/");
  if (parts.some((p) => !p || p === "." || p === "..")) return null;
  if (parts.length === 2) {
    return {
      host: "github.com",
      owner: parts[0].toLowerCase(),
      repo: parts[1].toLowerCase(),
    };
  }
  if (parts.length === 3 && /^[A-Za-z0-9][A-Za-z0-9._-]*(?::\d+)?$/.test(parts[0])) {
    return {
      host: parts[0].toLowerCase(),
      owner: parts[1].toLowerCase(),
      repo: parts[2].toLowerCase(),
    };
  }
  return null;
}

/**
 * Token-aware HTTP write / ClickHouse HTTP detection for curl, wget, and HTTPie.
 * Handles short attached flags (`-XPOST`, `-dfoo`, `-d@file`, `-Tfile`, `-Ffile=@x`),
 * all `--data*` variants (`--data-ascii`, `--data-binary`, `--data-raw`, `--data-urlencode`),
 * `--json`, `--request`, `--form`, `--upload-file`, wget `--post-*`/`--body-*`/`--method`,
 * and ClickHouse HTTP `:8123` / `query=`.
 */
const GH_PR_CREATE_SHORT_VALUE_FLAGS = new Set([
  "R",
  "H",
  "B",
  "a",
  "b",
  "F",
  "l",
  "m",
  "p",
  "r",
  "t",
  "T",
]);

const GH_PR_CREATE_SHORT_BOOL_FLAGS = new Set(["d", "e", "f", "w"]);

const GH_PR_CREATE_LONG_VALUE_FLAGS = new Set([
  "--repo",
  "--head",
  "--base",
  "--assignee",
  "--attach",
  "--body",
  "--body-file",
  "--label",
  "--milestone",
  "--project",
  "--recover",
  "--reviewer",
  "--template",
  "--title",
]);

const GH_PR_CREATE_LONG_BOOL_FLAGS = new Set([
  "--draft",
  "--dry-run",
  "--editor",
  "--fill",
  "--fill-first",
  "--fill-verbose",
  "--no-maintainer-edit",
  "--web",
  "--help",
]);

// Exact Go strconv.ParseBool spellings (case-sensitive, no whitespace trimming; used by spf13/pflag in gh CLI)
const PFLAG_BOOL_TRUE_VALUES = new Set(["1", "t", "T", "true", "True", "TRUE"]);

const PFLAG_BOOL_FALSE_VALUES = new Set(["0", "f", "F", "false", "False", "FALSE"]);

function parsePflagBool(rawVal: string): boolean | "invalid" {
  if (PFLAG_BOOL_TRUE_VALUES.has(rawVal)) return true;
  if (PFLAG_BOOL_FALSE_VALUES.has(rawVal)) return false;
  return "invalid";
}

const GH_PR_CREATE_CSV_LONG_FLAGS = new Set([
  "--assignee",
  "--label",
  "--project",
  "--reviewer",
]);

const GH_PR_CREATE_CSV_SHORT_FLAGS = new Set(["a", "l", "p", "r"]);

/**
 * Exact Go `encoding/csv` single-record (`Reader.Read()`) validator matching spf13/pflag `readAsCSV`
 * used by StringSlice flags (`--assignee`, `--label`, `--project`, `--reviewer`).
 * - Empty string `""` short-circuits in pflag and is valid.
 * - Leading blank lines (`\n` / `\r\n`) are skipped; if nothing remains, `csv.Reader.Read()` returns EOF (invalid).
 * - Unquoted `\n` or `\r\n` terminates record 1 immediately (trailing lines are ignored by pflag's single Read()).
 * - Quoted fields require closing `"` followed by `,`, `\n`, `\r\n`, or EOF.
 */
function isValidPflagCsvSlice(raw: string): boolean {
  if (raw.length === 0) return true;
  // Go encoding/csv readLine() drops a single trailing `\r` right before EOF (dropCR)
  const input = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
  let i = 0;
  // Skip leading empty lines (`\n` or `\r\n`) as Go encoding/csv does
  while (i < input.length) {
    if (input[i] === "\n") {
      i++;
    } else if (input[i] === "\r" && input[i + 1] === "\n") {
      i += 2;
    } else {
      break;
    }
  }
  if (i >= input.length) return false; // EOF on newline/CR-only input

  let atFieldStart = true;
  let inQuotes = false;
  for (; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          i++; // Escaped quote
        } else if (
          i + 1 === input.length ||
          input[i + 1] === "\n" ||
          (input[i + 1] === "\r" && input[i + 2] === "\n")
        ) {
          return true; // Record 1 ended cleanly at EOF / LF / CRLF
        } else if (input[i + 1] === ",") {
          inQuotes = false;
          atFieldStart = true;
          i++;
        } else {
          return false; // Extraneous character after closing quote
        }
      }
      continue;
    }

    if (ch === "\n" || (ch === "\r" && input[i + 1] === "\n")) {
      return true; // Unquoted LF / CRLF terminates record 1
    }
    if (atFieldStart) {
      if (ch === '"') {
        inQuotes = true;
        atFieldStart = false;
      } else if (ch === ",") {
        atFieldStart = true;
      } else {
        atFieldStart = false;
      }
    } else {
      if (ch === '"') return false; // Bare quote in unquoted field
      if (ch === ",") atFieldStart = true;
    }
  }
  return !inQuotes;
}

export interface ParsedGhPrCreateArgs {
  parseError: boolean;
  help: boolean;
  dryRun: boolean;
  web: boolean;
  hasAttach: boolean;
  repo: string | null;
  head: string | null;
}

/**
 * Unified, single-pass pflag-accurate parser for `gh pr create` (and alias `gh pr new`) arguments.
 * Covers ALL value and boolean flags from `gh pr create --help`:
 * - Exact Go strconv.ParseBool validation on every boolean flag (`--draft`, `--dry-run`, `--web`, `--help`, etc.)
 * - Exact Go encoding/csv validation on StringSlice flags (`--assignee`, `--label`, `--project`, `--reviewer`)
 * - Immediate `parseError = true` on invalid bool/CSV values, unknown flags, missing flag values, or unexpected positionals
 * - Immediate `help = true` on short `-h` (matching gh CLI help interceptor precedence over `--help=f`)
 * - Last-write-wins for valid repeated flags (`--help --help=f`, `--head a --head b`, `--repo a --repo b`)
 */
export function parseGhPrCreateArgs(args: string[]): ParsedGhPrCreateArgs {
  const out: ParsedGhPrCreateArgs = {
    parseError: false,
    help: false,
    dryRun: false,
    web: false,
    hasAttach: false,
    repo: null,
    head: null,
  };
  let shortHelpSeen = false;
  let stopFlags = false;

  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (!stopFlags && t === "--") {
      stopFlags = true;
      continue;
    }
    if (stopFlags || !t.startsWith("-") || t === "-") {
      // `gh pr create` accepts zero positional arguments
      out.parseError = true;
      continue;
    }

    if (t.startsWith("--")) {
      const eqIdx = t.indexOf("=");
      const name = eqIdx === -1 ? t : t.slice(0, eqIdx);
      const eqVal = eqIdx === -1 ? null : t.slice(eqIdx + 1);

      if (GH_PR_CREATE_LONG_VALUE_FLAGS.has(name)) {
        let val: string;
        if (eqVal !== null) {
          val = eqVal;
        } else if (i + 1 < args.length) {
          val = args[++i];
        } else {
          out.parseError = true;
          continue;
        }
        if (GH_PR_CREATE_CSV_LONG_FLAGS.has(name) && !isValidPflagCsvSlice(val)) {
          out.parseError = true;
          continue;
        }
        if (name === "--repo") out.repo = val;
        else if (name === "--head") out.head = val;
        else if (name === "--attach") out.hasAttach = true;
        continue;
      }

      if (GH_PR_CREATE_LONG_BOOL_FLAGS.has(name)) {
        let bVal: boolean;
        if (eqVal !== null) {
          const parsed = parsePflagBool(eqVal);
          if (parsed === "invalid") {
            out.parseError = true;
            continue;
          }
          bVal = parsed;
        } else {
          bVal = true;
        }
        if (name === "--help" && !shortHelpSeen) out.help = bVal;
        else if (name === "--dry-run") out.dryRun = bVal;
        else if (name === "--web") out.web = bVal;
        continue;
      }

      // Unknown long flag (including `--version`, etc.)
      out.parseError = true;
      continue;
    }

    // Single-dash short flag cluster (e.g. `-d`, `-dHtopic`, `-w=F`, `-h=f`, `-dh=false`, `-t --help`)
    for (let k = 1; k < t.length; k++) {
      const ch = t[k];
      if (ch === "h") {
        // gh CLI intercepts `-h` unconditionally as help (even `-h=f` or followed by `--help=f`)
        shortHelpSeen = true;
        out.help = true;
        if (t[k + 1] === "=") break;
        continue;
      }
      if (GH_PR_CREATE_SHORT_VALUE_FLAGS.has(ch)) {
        let val: string;
        if (k < t.length - 1) {
          const rest = t.slice(k + 1);
          val = rest.startsWith("=") ? rest.slice(1) : rest;
        } else if (i + 1 < args.length) {
          val = args[++i];
        } else {
          out.parseError = true;
          break;
        }
        if (GH_PR_CREATE_CSV_SHORT_FLAGS.has(ch) && !isValidPflagCsvSlice(val)) {
          out.parseError = true;
          break;
        }
        if (ch === "R") out.repo = val;
        else if (ch === "H") out.head = val;
        break;
      }
      if (GH_PR_CREATE_SHORT_BOOL_FLAGS.has(ch)) {
        let bVal: boolean;
        if (t[k + 1] === "=") {
          const parsed = parsePflagBool(t.slice(k + 2));
          if (parsed === "invalid") {
            out.parseError = true;
            break;
          }
          bVal = parsed;
          if (ch === "w") out.web = bVal;
          break;
        }
        if (ch === "w") out.web = true;
        continue;
      }
      // Unknown short flag
      out.parseError = true;
      break;
    }
  }

  return out;
}

export function repoOrigin(dir: string) {
  const result = runGit(dir, ["remote", "get-url", "origin"], 3000);
  return result.code === 0 ? parseGitRemoteRepo(result.stdout) : null;
}

export function resolveGhDefaultHost(effective: (key: string) => string, cwd = process.cwd()): string {
  const host = effective("GH_HOST");
  if (host) return host.toLowerCase();
  const home = effective("HOME");
  const configHome = effective("XDG_CONFIG_HOME") || (home && join(home, ".config"));
  const configDir = effective("GH_CONFIG_DIR") || (configHome && join(configHome, "gh"));
  if (configDir) {
    const config = parseYamlFile<Record<string, unknown>>(resolve(cwd, configDir, "hosts.yml"));
    const hosts = Object.keys(config ?? {}).map((key) => key.toLowerCase());
    if (hosts.length === 1) return hosts[0];
  }
  return "github.com";
}

const HOSTLESS_GH_REPO = /^[^/@:]+\/[^/]+$/;

export function qualifyGhRepoSpec(spec: string, effective: (key: string) => string, cwd: string): string {
  return HOSTLESS_GH_REPO.test(spec) ? `${resolveGhDefaultHost(effective, cwd)}/${spec}` : spec;
}

export function extractGhPrSubcommand(toks: string[], prefix = unwrapShellPrefix(toks)) {
  const index = toks.findIndex((tok) => tok === "gh" || tok.endsWith("/gh"));
  if (index < 0) return null;
  const args = prefix.bin === "gh" ? prefix.args : toks.slice(index + 1);
  const flags: string[] = [];
  let sawPr = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("-")) {
      flags.push(arg);
      if (arg === "-R" || arg === "--repo") flags.push(args[++i] ?? "");
      continue;
    }
    if (sawPr) return { subcmd: arg, subArgs: [...flags, ...args.slice(i + 1)], prefix };
    if (arg !== "pr") return null;
    sawPr = true;
  }
  return null;
}
