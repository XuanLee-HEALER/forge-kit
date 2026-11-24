import {
  accessSync,
  appendFileSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { redactSecrets } from "./cmdfmt";
import { findWorkbenchRoot, loadWorkbenchConfig } from "./config";
import { getHeadAndParents, locateRepo, runGit } from "./git";
import {
  extractGitSubcommand,
  extractGhPrSubcommand,
  unwrapShellPrefix,
  hasUnquotedRedirect,
  parseGhPrCreateArgs,
  parseGhRepoSpec,
  qualifyGhRepoSpec,
  parseGitRemoteRepo,
  resolveGitDirFlags,
  type ShellToken,
  splitShellSegments,
  stripUnquotedShellRedirections,
  splitShellTokensWithMeta,
} from "./guard";
import {
  type CodexHookInput,
  emitPostCompactMessage,
  emitSessionStartContext,
  emitUserPromptSubmitContext,
  extractResponseExitCode,
  extractResponseText,
  extractShellCommand,
  extractToolWorkdir,
  readHookStdinStrict,
} from "./hook-io";
import { Ledger, normalizeReviewRole, type RunbookActions } from "./ledger";

export interface CapturedEvidence {
  kind: "commit" | "build" | "test" | "lint" | "review" | "hurl" | "pr";
  status: "pass" | "fail" | "fallback";
  summary: string;
  targetDir: string;
  targetBranch?: string | null;
  targetOwner?: string | null;
  targetRepoSpec?: string | null;
  targetHost?: string | null;
  prUrlRepoSpec?: string | null;
  pinnedSha?: string | null;
  pinnedRef?: string | null;
  requirePinnedSha?: boolean;
  meta?: Record<string, unknown>;
}

function parseLangCheckInvocation(cmdToks: string[]): {
  argsStart: number;
  mode: "static" | "dynamic" | "all";
  targetPositional: string | null;
} | null {
  const [c0 = "", c1 = ""] = cmdToks;
  let argsStart = -1;
  if (c0 === "lang-check" || c0.endsWith("/lang-check")) {
    argsStart = 1;
  } else if (
    (c0 === "bun" || c0.endsWith("/bun")) &&
    (c1.endsWith("/lang-check.js") || c1.endsWith("/lang-check.ts"))
  ) {
    argsStart = 2;
  }
  if (argsStart < 0) return null;

  let mode: "static" | "dynamic" | "all" = "all";
  let targetPositional: string | null = null;
  let endFlags = false;
  for (let i = argsStart; i < cmdToks.length; i++) {
    const t = cmdToks[i];
    if (!endFlags && t === "--") {
      endFlags = true;
      continue;
    }
    if (!endFlags) {
      if (t === "--mode") {
        const v = cmdToks[++i];
        if (v === "static" || v === "dynamic" || v === "all") mode = v;
        else return null;
        continue;
      }
      if (t.startsWith("--mode=")) {
        const v = t.slice("--mode=".length);
        if (v === "static" || v === "dynamic" || v === "all") mode = v;
        else return null;
        continue;
      }
      if (t === "--lang") {
        i++;
        continue;
      }
      if (t.startsWith("--lang=") || t === "--json") continue;
      if (t.startsWith("-")) continue;
    }
    if (!targetPositional) targetPositional = t;
  }
  return { argsStart, mode, targetPositional };
}

function extractEslintArgs(cmdToks: string[]): string[] | null {
  const [c0 = "", c1 = "", c2 = ""] = cmdToks;
  const bin0 = c0.split("/").pop() ?? "";
  if (bin0 === "eslint") return cmdToks.slice(1);
  if ((bin0 === "npx" || bin0 === "bunx") && c1 === "eslint") return cmdToks.slice(2);
  if (bin0 === "bunx" && c1 === "--bun" && c2 === "eslint") return cmdToks.slice(3);
  return null;
}

function extractTscArgs(cmdToks: string[]): string[] | null {
  const [c0 = "", c1 = "", c2 = ""] = cmdToks;
  const bin0 = c0.split("/").pop() ?? "";
  if (bin0 === "npx" && c1 === "tsc") return cmdToks.slice(2);
  if (bin0 === "bunx" && c1 === "tsc") return cmdToks.slice(2);
  if (bin0 === "bunx" && c1 === "--bun" && c2 === "tsc") return cmdToks.slice(3);
  if (bin0 === "tsc") return cmdToks.slice(1);
  return null;
}

function parseGoInvocation(cmdToks: string[]): {
  subcmd: "test" | "build" | "vet";
  argsStart: number;
  preDirs: string[];
} | null {
  const bin0 = (cmdToks[0] ?? "").split("/").pop() ?? "";
  if (bin0 !== "go") return null;
  const preDirs: string[] = [];
  let idx = 1;
  while (idx < cmdToks.length) {
    const t = cmdToks[idx];
    if (t === "-C" || t === "--C") {
      const val = cmdToks[++idx];
      if (!val) return null;
      preDirs.push(val);
      idx++;
      continue;
    }
    if (t.startsWith("-C=") || t.startsWith("--C=")) {
      const val = t.slice(t.indexOf("=") + 1);
      if (!val) return null;
      preDirs.push(val);
      idx++;
      continue;
    }
    if (t.startsWith("-C") && t.length > 2) {
      preDirs.push(t.slice(2));
      idx++;
      continue;
    }
    break;
  }
  const sub = cmdToks[idx];
  if (sub === "test" || sub === "build" || sub === "vet") {
    return { subcmd: sub, argsStart: idx + 1, preDirs };
  }
  return null;
}

function isPytestInvocation(cmdToks: string[]): { argsStart: number } | null {
  const [c0 = "", c1 = "", c2 = ""] = cmdToks;
  const bin = c0.split("/").pop() ?? "";
  if (bin === "pytest") return { argsStart: 1 };
  if (/^python3?(?:\.\d+)?$/.test(bin) && c1 === "-m" && c2 === "pytest") {
    return { argsStart: 3 };
  }
  return null;
}

const NODE_TEST_ALLOWED_VALUE_FLAGS = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "-C",
  "--conditions",
  "--env-file",
  "--env-file-if-exists",
  "--test-name-pattern",
  "--test-skip-pattern",
  "--test-reporter",
  "--test-reporter-destination",
  "--test-shard",
  "--test-timeout",
  "--test-concurrency",
  "--max-old-space-size",
  "--redirect-warnings",
  "--title",
]);

const NODE_TEST_ALLOWED_BOOL_FLAGS = new Set([
  "--test",
  "--test-force-exit",
  "--experimental-test-coverage",
  "--experimental-strip-types",
  "--experimental-transform-types",
  "--experimental-vm-modules",
  "--no-warnings",
  "--enable-source-maps",
  "--trace-uncaught",
  "--trace-warnings",
]);

function parseNodeTestInvocation(cmdToks: string[]): { files: string[] } | null {
  const bin0 = (cmdToks[0] ?? "").split("/").pop() ?? "";
  if (bin0 !== "node") return null;
  let sawTestFlag = false;
  let idx = 1;
  // Parse strictly allowlisted Node CLI options BEFORE the first positional entry point
  // (automatically rejects `--v8-options`, `-v`, `-h`, `-e`, `-p`, `-c`, `--watch`, `--test-only`, etc.)
  while (idx < cmdToks.length) {
    const t = cmdToks[idx];
    if (t === "--") {
      idx++;
      break;
    }
    if (!t.startsWith("-") || t === "-") {
      break;
    }
    const eq = t.indexOf("=");
    const name = eq >= 0 ? t.slice(0, eq) : t;
    if (name === "--test") {
      if (eq >= 0) return null;
      sawTestFlag = true;
      idx++;
      continue;
    }
    if (NODE_TEST_ALLOWED_BOOL_FLAGS.has(name) && eq < 0) {
      idx++;
      continue;
    }
    if (NODE_TEST_ALLOWED_VALUE_FLAGS.has(name)) {
      if (eq < 0) {
        if (idx + 1 >= cmdToks.length) return null;
        idx += 2;
      } else {
        idx++;
      }
      continue;
    }
    return null;
  }
  if (!sawTestFlag) return null;
  const files = cmdToks.slice(idx).filter((a) => a && a !== "--" && !a.startsWith("-"));
  return { files };
}

interface ParsedPkgManager {
  manager: "npm" | "pnpm" | "yarn" | "bun";
  dirOffsets: string[];
  subcmd: string;
  bunScript: boolean;
  scriptName: string;
  rest: string[];
  managerFlags: string[];
  forwarded: string[];
  invalidDirFlag: boolean;
  hasAmbiguousFilter: boolean;
  useWorkspaceRoot: boolean;
}

function isNpmWorkspaceSelectFlag(tok: string): boolean {
  if (tok === "-w" || tok === "--workspace" || tok.startsWith("--workspace=") || tok === "-ws") {
    return true;
  }
  if (tok === "--workspaces") return true;
  if (tok.startsWith("--workspaces=")) {
    const val = tok.slice("--workspaces=".length).toLowerCase();
    return val !== "false" && val !== "0" && val !== "";
  }
  return false;
}

function resolvePkgManagerEffectiveDir(pm: ParsedPkgManager, curDir: string): string | null {
  if (pm.invalidDirFlag || pm.hasAmbiguousFilter) return null;
  let dir = curDir;
  if (pm.dirOffsets.length > 0) {
    dir = resolve(curDir, pm.dirOffsets[pm.dirOffsets.length - 1]);
  }
  if (pm.useWorkspaceRoot) {
    let probe = dir;
    while (true) {
      if (existsSync(join(probe, "pnpm-workspace.yaml"))) {
        dir = probe;
        break;
      }
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  return dir;
}

// npm 11 config definitions with non-boolean values, including their value-taking aliases.
const NPM_VALUE_FLAGS = new Set([
  "--_auth", "--access", "--allow-directory", "--allow-file", "--allow-git", "--allow-remote",
  "--allow-scripts", "--also", "--audit-level", "--auth-type", "--before", "--browser", "--ca",
  "--cache", "--cache-max", "--cache-min", "--cafile", "--call", "--cert", "--cidr", "--color", "--cpu",
  "--depth", "--diff", "--diff-dst-prefix", "--diff-src-prefix", "--diff-unified", "--editor",
  "--enjoy-by", "--expect-result-count", "--expires", "--fetch-retries", "--fetch-retry-factor",
  "--fetch-retry-maxtimeout", "--fetch-retry-mintimeout", "--fetch-timeout", "--git", "--globalconfig",
  "--heading", "--https-proxy", "--include", "--init-author-email", "--init-author-name",
  "--init-author-url", "--init-license", "--init-module", "--init-type", "--init-version",
  "--init.author.email", "--init.author.name", "--init.author.url", "--init.license", "--init.module",
  "--init.version", "--install-strategy", "--key", "--libc", "--local-address", "--location",
  "--lockfile-version", "--loglevel", "--logs-dir", "--logs-max", "--maxsockets", "--message",
  "--min-release-age", "--min-release-age-exclude", "--name", "--node-gyp", "--node-options",
  "--noproxy", "--omit", "--only", "--orgs", "--orgs-permission", "--os", "--otp", "--pack-destination",
  "--package", "--packages", "--packages-and-scopes-permission", "--password", "--prefix", "--preid",
  "--provenance-file", "--proxy", "--reg", "--registry", "--replace-registry-host", "--save-prefix",
  "--sbom-format", "--sbom-type", "--scope", "--scopes", "--script-shell", "--searchexclude",
  "--searchlimit", "--searchopts", "--searchstaleness", "--shell", "--tag", "--tag-version-prefix",
  "--token-description", "--umask", "--user-agent", "--userconfig", "--viewer", "--which", "--workspace",
  "-C", "-L", "-c", "-m", "-w",
]);

function parsePkgManagerInvocation(cmdToks: string[]): ParsedPkgManager | null {
  const bin0 = (cmdToks[0] ?? "").split("/").pop() ?? "";
  if (bin0 !== "npm" && bin0 !== "pnpm" && bin0 !== "yarn" && bin0 !== "bun") {
    return null;
  }
  const dirOffsets: string[] = [];
  let separateBunCwd = false;
  const managerFlags: string[] = [];
  let invalidDirFlag = false;
  let hasAmbiguousFilter = false;
  let useWorkspaceRoot = false;
  let i = 1;

  const isDirFlag = (tok: string): boolean => {
    if (bin0 === "npm") return tok === "--prefix" || tok === "-C";
    if (bin0 === "pnpm") return tok === "--dir" || tok === "-C";
    return tok === "--cwd"; // yarn, bun
  };
  const extractAttachedDir = (tok: string): string | null => {
    if (bin0 === "npm" && (tok.startsWith("--prefix=") || tok.startsWith("-C="))) {
      return tok.slice(tok.indexOf("=") + 1);
    }
    if (bin0 === "pnpm" && (tok.startsWith("--dir=") || tok.startsWith("-C="))) {
      return tok.slice(tok.indexOf("=") + 1);
    }
    if ((bin0 === "yarn" || bin0 === "bun") && tok.startsWith("--cwd=")) {
      return tok.slice("--cwd=".length);
    }
    return null;
  };
  const managerValueFlags =
    bin0 === "pnpm"
      ? new Set(["--filter", "-F", "--filter-prod", "--reporter", "--config", "--loglevel"])
      : bin0 === "npm"
        ? NPM_VALUE_FLAGS
        : new Set<string>();

  const consumeManagerFlag = (tokens: string[], pos: number): number | null => {
    const tok = tokens[pos];
    if (isDirFlag(tok)) {
      if (bin0 === "bun") separateBunCwd = true;
      const val = tokens[pos + 1];
      if (!val) {
        invalidDirFlag = true;
        return pos + 1;
      }
      dirOffsets.push(val);
      return pos + 2;
    }
    const attachedDir = extractAttachedDir(tok);
    if (attachedDir !== null) {
      if (!attachedDir) {
        invalidDirFlag = true;
      } else {
        dirOffsets.push(attachedDir);
      }
      return pos + 1;
    }
    if (bin0 === "pnpm") {
      if (tok === "--workspace-root" || tok === "-w") {
        useWorkspaceRoot = true;
        managerFlags.push(tok);
        return pos + 1;
      }
      if (
        tok === "--filter" ||
        tok === "-F" ||
        tok === "--filter-prod" ||
        tok.startsWith("--filter=") ||
        tok.startsWith("-F") ||
        tok.startsWith("--filter-prod=") ||
        tok === "-r" ||
        tok === "--recursive"
      ) {
        hasAmbiguousFilter = true;
        managerFlags.push(tok);
        return !tok.includes("=") && (tok === "--filter" || tok === "-F" || tok === "--filter-prod")
          ? pos + 2
          : pos + 1;
      }
    }
    if (bin0 === "bun") {
      if (
        tok === "--filter" ||
        tok === "-F" ||
        tok.startsWith("--filter=") ||
        tok.startsWith("-F") ||
        tok === "--workspaces" ||
        (tok.startsWith("--workspaces=") &&
          !["false", "0", ""].includes(tok.slice("--workspaces=".length).toLowerCase()))
      ) {
        hasAmbiguousFilter = true;
        managerFlags.push(tok);
        return !tok.includes("=") && (tok === "--filter" || tok === "-F") ? pos + 2 : pos + 1;
      }
    }
    if (bin0 === "npm" && isNpmWorkspaceSelectFlag(tok)) {
      hasAmbiguousFilter = true;
    }
    if (bin0 === "npm" && /^(?:--(?:no-)?(?:ignore-scripts|version|hel(?:p)?|versions|usage|dry-run|if-present)|-[vhH?])$/.test(tok) && /^(true|false)$/.test(tokens[pos + 1] ?? "")) {
      managerFlags.push(tok + "=" + tokens[pos + 1]);
      return pos + 2;
    }
    managerFlags.push(tok);
    if (bin0 === "npm" && tok === "--color" && !/^(true|false|always)$/i.test(tokens[pos + 1] ?? "")) return pos + 1;
    if (!tok.includes("=") && managerValueFlags.has(tok)) {
      return pos + 2;
    }
    return pos + 1;
  };

  // 1. Parse manager flags BEFORE the subcommand
  while (i < cmdToks.length) {
    const tok = cmdToks[i];
    if (tok === "--") {
      i++;
      break;
    }
    if (!tok.startsWith("-") || tok === "-") break;
    const nextPos = consumeManagerFlag(cmdToks, i);
    if (nextPos === null || invalidDirFlag) break;
    i = nextPos;
  }

  const subcmd = cmdToks[i] ?? "";
  let rest = cmdToks.slice(i + 1);
  let scriptName = subcmd;

  // 2. For explicit `run` (`bun run --cwd ../B check`, `pnpm run -C ../B test`, `npm run --prefix ../B lint`),
  //    parse manager flags strictly BEFORE `<script>` (never after `<script>` for bun/pnpm/yarn!).
  if (subcmd === "run") {
    let r = 0;
    while (r < rest.length) {
      const tok = rest[r];
      if (tok === "--") {
        r++;
        break;
      }
      if (!tok.startsWith("-") || tok === "-") break;
      const nextPos = consumeManagerFlag(rest, r);
      if (nextPos === null || invalidDirFlag) break;
      r = nextPos;
    }
    scriptName = rest[r] ?? "";
    rest = rest.slice(r + 1);
  }

  const bunScript = bin0 === "bun" && (subcmd === "test" || subcmd === "build") && separateBunCwd;
  // Bun 1.4.4 dispatches --cwd DIR to a script, but --cwd=DIR to the built-in.
  if (bin0 === "bun" && !bunScript && (subcmd === "test" || subcmd === "build")) {
    const bunValFlags = subcmd === "build"
      ? BUN_BUILD_VALUE_FLAGS
      : new Set(["-t", "--test-name-pattern", "--timeout", "--preload", "-r"]);
    for (let j = 0; j < rest.length; j++) {
      const tok = rest[j];
      if (tok === "--") break;
      if (tok === "--cwd") {
        const val = rest[++j];
        if (!val) {
          invalidDirFlag = true;
          break;
        }
        dirOffsets.push(val);
        continue;
      }
      if (tok.startsWith("--cwd=")) {
        const val = tok.slice("--cwd=".length);
        if (!val) {
          invalidDirFlag = true;
          break;
        }
        dirOffsets.push(val);
        continue;
      }
      if (!tok.includes("=") && bunValFlags.has(tok)) {
        j++;
      }
    }
  }

  let forwarded = rest[0] === "--" ? rest.slice(1) : rest;
  if (bin0 === "npm" && subcmd && subcmd !== "exec") {
    forwarded = [];
    for (let j = 0; j < rest.length;) {
      const arg = rest[j];
      if (arg === "--") {
        forwarded.push(...rest.slice(j + 1));
        break;
      }
      if (arg.startsWith("-") && arg !== "-") {
        j = consumeManagerFlag(rest, j) ?? j + 1;
      } else {
        forwarded.push(arg);
        j++;
      }
    }
  }

  return {
    manager: bin0,
    dirOffsets,
    subcmd,
    bunScript,
    scriptName,
    rest,
    managerFlags,
    forwarded,
    invalidDirFlag,
    hasAmbiguousFilter,
    useWorkspaceRoot,
  };
}

const VITEST_NON_RUN_SUBCMDS = new Set([
  "list",
  "watch",
  "dev",
  "bench",
  "typecheck",
  "init",
  "help",
]);

function extractVitestSubInvocation(
  cmdToks: string[],
): { pm: ParsedPkgManager | null; vitestArgs: string[] } | null {
  const [c0 = "", c1 = "", c2 = ""] = cmdToks;
  const bin0 = c0.split("/").pop() ?? "";
  if (bin0 === "vitest") {
    return { pm: null, vitestArgs: cmdToks.slice(1) };
  }
  if ((bin0 === "npx" || bin0 === "bunx") && c1 === "vitest") {
    return { pm: null, vitestArgs: cmdToks.slice(2) };
  }
  if (bin0 === "bunx" && c1 === "--bun" && c2 === "vitest") {
    return { pm: null, vitestArgs: cmdToks.slice(3) };
  }
  const pm = parsePkgManagerInvocation(cmdToks);
  if (pm && !pm.hasAmbiguousFilter && (pm.manager === "pnpm" || pm.manager === "yarn" || pm.manager === "bun")) {
    if (pm.subcmd === "vitest") {
      return { pm, vitestArgs: pm.rest };
    }
    if ((pm.subcmd === "exec" || pm.subcmd === "dlx") && pm.rest[0] === "vitest") {
      return { pm, vitestArgs: pm.rest.slice(1) };
    }
  }
  return null;
}

function parseVitestRunInvocation(
  cmdToks: string[],
  envToks: string[],
): { pm: ParsedPkgManager | null; vitestArgs: string[] } | null {
  const extracted = extractVitestSubInvocation(cmdToks);
  if (!extracted) return null;
  const args = extracted.vitestArgs;
  const VITEST_VALUE_FLAGS = new Set([
    "-r",
    "--root",
    "-c",
    "--config",
    "--dir",
    "-t",
    "--testNamePattern",
    "--reporter",
    "--outputFile",
    "--environment",
    "--shard",
    "--pool",
    "--project",
    "--maxWorkers",
    "--minWorkers",
    "--testTimeout",
    "--hookTimeout",
    "--bail",
    "--sequence",
  ]);
  let sawExplicitRun = false;
  let firstPositional: string | null = null;
  let stopFlags = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!stopFlags && a === "--") {
      stopFlags = true;
      continue;
    }
    if (!stopFlags && a.startsWith("-")) {
      const eq = a.indexOf("=");
      const name = eq >= 0 ? a.slice(0, eq) : a;
      const val = eq >= 0 ? a.slice(eq + 1).toLowerCase() : null;
      if (
        name === "--watch" ||
        name === "-w" ||
        name === "--ui" ||
        name === "--open" ||
        name === "--list" ||
        name === "--typecheck-only" ||
        name === "--passWithNoTests" ||
        name === "--pass-with-no-tests" ||
        name === "--no-run" ||
        name === "--merge-reports" ||
        name === "--mergeReports" ||
        name === "--clearCache" ||
        name === "--clear-cache" ||
        name === "--init" ||
        name === "--help" ||
        name === "-h" ||
        name === "--version" ||
        name === "-v"
      ) {
        if (name === "--watch" && val === "false") continue;
        return null;
      }
      if (name === "--run") {
        if (val === "false" || val === "0") return null;
        sawExplicitRun = true;
        continue;
      }
      if (eq < 0 && VITEST_VALUE_FLAGS.has(name)) {
        i++;
      }
      continue;
    }
    if (firstPositional === null) {
      firstPositional = a;
    }
  }
  if (firstPositional !== null && VITEST_NON_RUN_SUBCMDS.has(firstPositional)) {
    return null;
  }
  if (firstPositional === "run" || sawExplicitRun) {
    return extracted;
  }
  if (envToks.some((e) => /^CI=(?:1|true)$/i.test(e))) {
    return extracted;
  }
  return null;
}

function parseSvelteCheckInvocation(
  cmdToks: string[],
): { pm: ParsedPkgManager | null; checkArgs: string[] } | null {
  const [c0 = "", c1 = "", c2 = ""] = cmdToks;
  const bin0 = c0.split("/").pop() ?? "";
  let extracted: { pm: ParsedPkgManager | null; checkArgs: string[] } | null = null;
  if (bin0 === "svelte-check") {
    extracted = { pm: null, checkArgs: cmdToks.slice(1) };
  } else if ((bin0 === "npx" || bin0 === "bunx") && c1 === "svelte-check") {
    extracted = { pm: null, checkArgs: cmdToks.slice(2) };
  } else if (bin0 === "bunx" && c1 === "--bun" && c2 === "svelte-check") {
    extracted = { pm: null, checkArgs: cmdToks.slice(3) };
  } else {
    const pm = parsePkgManagerInvocation(cmdToks);
    if (pm && !pm.hasAmbiguousFilter && (pm.manager === "pnpm" || pm.manager === "yarn" || pm.manager === "bun")) {
      if (pm.subcmd === "svelte-check") {
        extracted = { pm, checkArgs: pm.rest };
      } else if ((pm.subcmd === "exec" || pm.subcmd === "dlx") && pm.rest[0] === "svelte-check") {
        extracted = { pm, checkArgs: pm.rest.slice(1) };
      }
    }
  }
  if (!extracted) return null;
  for (const a of extracted.checkArgs) {
    if (a === "--") break;
    if (a === "-v" || a === "--version" || a === "-h" || a === "--help" || a === "--watch") {
      return null;
    }
  }
  return extracted;
}

function isScriptNameKind(script: string, kind: "test" | "lint" | "build"): boolean {
  if (!script) return false;
  if (kind === "test") return script === "test" || script.startsWith("test:");
  if (kind === "lint") {
    return (
      script === "check" ||
      script.startsWith("check:") ||
      script === "lint" ||
      script.startsWith("lint:") ||
      script === "typecheck" ||
      script.startsWith("typecheck:")
    );
  }
  return /^(?:local:|fat:|prod:)?build(?::|$)/.test(script);
}

/**
 * Token-based verification command classifier (handles line continuations, quoting, and leading ENV=VAL assignments).
 * Anchored strictly at command start so `echo "bun test"` / grep text never false-positives.
 */
function classifyVerifyCommand(metaToks: ShellToken[]): {
  kind: "test" | "build" | "lint" | "hurl" | "lang-check";
  cmdToks: string[];
  envToks: string[];
} | null {
  const { envToks, cmdToks } = splitLeadingEnv(metaToks);
  if (cmdToks.length === 0) return null;
  const [c0, c1 = "", c2 = ""] = cmdToks;
  const bin0 = c0.split("/").pop() ?? "";
  if (bin0 === "just") {
    for (let i = 2; i < cmdToks.length; i++) {
      if (["-d", "-f", "--working-directory", "--justfile"].includes(cmdToks[i])) i++;
      else if (!cmdToks[i].startsWith("-")) return null;
    }
  }
  const makeTarget = bin0 === "make" ? extractSingleMakeTarget(cmdToks.slice(1)) : null;

  // lang-check (forge-kit unified Go/TS/Python static & dynamic checker)
  if (parseLangCheckInvocation(cmdToks)) {
    return { kind: "lang-check", cmdToks, envToks };
  }

  // go test / vet / build (supports both `go -C <dir> vet` and `go vet -C <dir>`, and absolute paths)
  const goInv = parseGoInvocation(cmdToks);
  if (goInv) {
    const kind =
      goInv.subcmd === "test" ? "test" : goInv.subcmd === "vet" ? "lint" : "build";
    return { kind, cmdToks, envToks };
  }

  // Runner-specific invocations BEFORE generic package-manager scripts (handles `pnpm vitest run`, `pnpm svelte-check`, etc.)
  if (parseVitestRunInvocation(cmdToks, envToks) !== null) {
    return { kind: "test", cmdToks, envToks };
  }
  if (parseSvelteCheckInvocation(cmdToks) !== null) {
    return { kind: "lint", cmdToks, envToks };
  }
  if (parseNodeTestInvocation(cmdToks) !== null) {
    return { kind: "test", cmdToks, envToks };
  }

  // Unified package-manager script classification (`npm`, `pnpm`, `yarn`, `bun` with leading dir flags & explicit `run`)
  const pm = parsePkgManagerInvocation(cmdToks);
  if (pm && !pm.invalidDirFlag) {
    const scriptName = pm.scriptName;
    if (pm.manager === "bun") {
      if (pm.subcmd === "build") return { kind: "build", cmdToks, envToks };
      if (pm.subcmd === "test" || (pm.subcmd === "run" && isScriptNameKind(scriptName, "test"))) {
        return { kind: "test", cmdToks, envToks };
      }
      if (pm.subcmd === "run" && isScriptNameKind(scriptName, "lint")) {
        return { kind: "lint", cmdToks, envToks };
      }
      if (pm.subcmd === "run" && isScriptNameKind(scriptName, "build")) {
        return { kind: "build", cmdToks, envToks };
      }
    } else if (pm.manager === "npm") {
      if (pm.subcmd === "test" || (pm.subcmd === "run" && isScriptNameKind(scriptName, "test"))) {
        return { kind: "test", cmdToks, envToks };
      }
      if (pm.subcmd === "run" && isScriptNameKind(scriptName, "lint")) {
        return { kind: "lint", cmdToks, envToks };
      }
      if (pm.subcmd === "run" && isScriptNameKind(scriptName, "build")) {
        return { kind: "build", cmdToks, envToks };
      }
    } else {
      // pnpm and yarn support both shorthand (`pnpm lint`, `yarn build`) and explicit `run` (`pnpm run lint`, `yarn run lint`)
      if (isScriptNameKind(scriptName, "test")) return { kind: "test", cmdToks, envToks };
      if (isScriptNameKind(scriptName, "lint")) return { kind: "lint", cmdToks, envToks };
      if (isScriptNameKind(scriptName, "build")) return { kind: "build", cmdToks, envToks };
    }
  }

  // test
  if (
    isPytestInvocation(cmdToks) !== null ||
    (bin0 === "just" && c1 === "test") ||
    (bin0 === "make" && makeTarget === "test")
  ) {
    return { kind: "test", cmdToks, envToks };
  }

  // lint / static checks
  if (
    (bin0 === "make" && (makeTarget === "lint" || makeTarget === "harness-guard")) ||
    (bin0 === "just" && (c1 === "check" || c1 === "lint" || c1 === "typecheck" || c1 === "typecheck-server")) ||
    extractTscArgs(cmdToks) !== null ||
    extractEslintArgs(cmdToks) !== null ||
    (bin0 === "npx" && c1 === "biome" && c2 === "check") ||
    (bin0 === "bunx" && ((c1 === "biome" && c2 === "check") || (c1 === "--bun" && c2 === "biome" && cmdToks[3] === "check"))) ||
    (bin0 === "biome" && c1 === "check") ||
    (bin0 === "ruff" && c1 === "check") ||
    bin0 === "pyright" ||
    bin0 === "mypy" ||
    (bin0 === "golangci-lint" && c1 === "run")
  ) {
    return { kind: "lint", cmdToks, envToks };
  }

  // build
  if (
    (bin0 === "make" && (makeTarget === "build" || makeTarget === "compile")) ||
    (bin0 === "just" && c1 === "build")
  ) {
    return { kind: "build", cmdToks, envToks };
  }

  // hurl
  if (bin0 === "hurl") {
    return { kind: "hurl", cmdToks, envToks };
  }

  return null;
}

function parseReviewJsonOutput(
  outputText: string,
  outFilePath?: string,
): {
  status?: string;
  passed?: boolean;
  errorCode?: string;
  head?: string;
  base?: string;
  role?: string;
} | null {
  const candidates: string[] = [];
  if (outFilePath && existsSync(outFilePath)) {
    try {
      candidates.push(readFileSync(outFilePath, "utf8"));
    } catch {
      // Ignore unreadable out file
    }
  }
  const trimmed = outputText.trim();
  if (trimmed.startsWith("{")) candidates.push(trimmed);
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const raw of candidates) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        return {
          status: typeof obj.status === "string" ? obj.status : undefined,
          passed: typeof obj.passed === "boolean" ? obj.passed : undefined,
          errorCode: typeof obj.errorCode === "string" ? obj.errorCode : undefined,
          head: typeof obj.head === "string" ? obj.head : undefined,
          base: typeof obj.base === "string" ? obj.base : undefined,
          role: typeof obj.role === "string" ? obj.role : undefined,
        };
      }
    } catch {
      // Try next candidate
    }
  }
  return null;
}

const ALLOWED_FAILFAST_SET_O_OPTS = new Set([
  "errexit",
  "nounset",
  "pipefail",
  "xtrace",
  "verbose",
  "noglob",
]);

function isFailFastSetSegment(seg: string): boolean {
  const meta = splitShellTokensWithMeta(seg.trim());
  if (!meta || meta.length < 2) return false;
  if (meta[0].isEnvAssign || meta[0].value !== "set") return false;
  let sawErrexit = false;
  for (let i = 1; i < meta.length; i++) {
    const tok = meta[i].value;
    if (tok === "-o") {
      const opt = meta[++i]?.value;
      if (!opt || !ALLOWED_FAILFAST_SET_O_OPTS.has(opt)) return false;
      if (opt === "errexit") sawErrexit = true;
      continue;
    }
    if (!/^-[a-zA-Z]+$/.test(tok)) return false;
    const letters = tok.slice(1);
    for (let j = 0; j < letters.length; j++) {
      const ch = letters[j];
      if (!"euoxvf".includes(ch)) return false;
      if (ch === "e") sawErrexit = true;
      if (ch === "o") {
        // `-o` in a short cluster (e.g. `set -euo pipefail`) must be at the end and consume a valid option name
        if (j !== letters.length - 1) return false;
        const opt = meta[++i]?.value;
        if (!opt || !ALLOWED_FAILFAST_SET_O_OPTS.has(opt)) return false;
        if (opt === "errexit") sawErrexit = true;
      }
    }
  }
  return sawErrexit;
}

/**
 * Only capture evidence for unambiguous shell invocations where no failing check can be masked.
 * Allows:
 * - Single-line commands chained with `&&` (and harmless redirections like `> /tmp/log 2>&1`).
 * - Multi-line scripts ONLY when either:
 *   (a) Line 1 enables fail-fast `set -e` (e.g. `set -euo pipefail`) and subsequent lines contain no
 *       `set`, `trap`, errexit-exempt flow control (`if`/`while`/`until`/etc.), or `!` negation, OR
 *   (b) Every preceding line is strictly a `cd <dir>` command followed by a single final verification line.
 * Rejects `||`, pipes (`|`), `;`, single `&`, subshells, command substitutions, and unguarded multi-line scripts.
 */
function hasAmbiguousControlFlow(cmd: string): boolean {
  let quote: "'" | '"' | "$'" | null = null;
  let escape = false;
  let atWordStart = true;
  let sawUnquotedNewline = false;
  let sawUnquotedAndAnd = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    const next = cmd[i + 1];
    if (escape) {
      escape = false;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      atWordStart = false;
      continue;
    }
    if (quote === "$'") {
      if (ch === "\\") escape = true;
      else if (ch === "'") quote = null;
      atWordStart = false;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") escape = true;
      else if (ch === '"') quote = null;
      else if (ch === "`" || (ch === "$" && next === "(")) return true;
      atWordStart = false;
      continue;
    }
    if (ch === "\r") return true;
    if (ch === "\\") {
      escape = true;
      if (next !== "\n") atWordStart = false;
      continue;
    }
    if (ch === "$" && next === "'") {
      quote = "$'";
      atWordStart = false;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      atWordStart = false;
      continue;
    }
    if (ch === "#" && atWordStart) {
      while (i + 1 < cmd.length && cmd[i + 1] !== "\n") i++;
      continue;
    }
    if (ch === "\n") {
      sawUnquotedNewline = true;
      atWordStart = true;
      continue;
    }
    if (ch === "<" && next === "<") return true; // Reject heredocs/here-strings so data lines cannot masquerade as commands
    if (ch === "|") return true;
    if (ch === ";") return true;
    if (ch === "&") {
      if (next === "&") {
        sawUnquotedAndAnd = true;
        atWordStart = true;
        i++;
        continue;
      }
      const prev = cmd[i - 1];
      if (prev === ">" || prev === "<" || next === ">") {
        atWordStart = false;
        continue;
      }
      return true;
    }
    if (ch === "`" || ch === "(" || ch === ")") return true;
    atWordStart = ch === " " || ch === "\t";
  }
  if (!sawUnquotedNewline) return false;

  // Multi-line validation: split logical non-empty, non-comment lines (after joining `\` line continuations)
  const logicalLines = cmd
    .replace(/\\\n/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  if (logicalLines.length <= 1) return false;

  // Case (a): fail-fast `set -e` / `set -euo pipefail` on line 1.
  // Reject ANY unquoted `&&` on subsequent lines (since the LHS of `&&` is exempt from `errexit` in Bash!)
  // and reject any line whose command-position word is a shell reserved/state word (`if`, `while`, `set`, `trap`, `!`, etc.)
  // while permitting ordinary filenames containing reserved substrings like `tests/edge-case.test.ts`.
  const SHELL_ERREXIT_EXEMPT_OR_STATE_WORDS = new Set([
    "if",
    "then",
    "elif",
    "else",
    "fi",
    "while",
    "until",
    "for",
    "do",
    "done",
    "case",
    "esac",
    "select",
    "trap",
    "set",
    "!",
    "coproc",
    "{",
    "}",
    "[[",
  ]);
  if (isFailFastSetSegment(logicalLines[0]) && !sawUnquotedAndAnd) {
    const rest = logicalLines.slice(1);
    const hasUnsafeLine = rest.some((l) => {
      if (splitShellSegments(l).length !== 1) return true;
      const meta = splitShellTokensWithMeta(l);
      if (!meta || meta.length === 0) return true;
      const firstWord = meta[0].value;
      const cmdWord = splitLeadingEnv(meta).cmdToks[0] ?? "";
      return (
        SHELL_ERREXIT_EXEMPT_OR_STATE_WORDS.has(firstWord) ||
        SHELL_ERREXIT_EXEMPT_OR_STATE_WORDS.has(cmdWord)
      );
    });
    if (!hasUnsafeLine) return false;
  }

  // Case (b): every line prior to the final line is strictly a simple `cd <dir>` command
  const precedingAllSimpleCd = logicalLines.slice(0, -1).every((l) => {
    const toks = splitShellTokensWithMeta(l);
    if (!toks || toks.length !== 2) return false;
    return !toks[0].isEnvAssign && toks[0].value === "cd" && !toks[1].value.startsWith("-");
  });
  if (precedingAllSimpleCd) return false;

  return true;
}

function hasInfoOnlyFlag(toks: string[]): boolean {
  if (toks[1] === "help") return true;
  const pm = parsePkgManagerInvocation(toks);
  const bunValFlags =
    pm?.manager === "bun" && !pm.bunScript && pm.subcmd === "build"
      ? BUN_BUILD_VALUE_FLAGS
      : pm?.manager === "bun" && !pm.bunScript && pm.subcmd === "test"
        ? new Set(["--cwd", "-t", "--test-name-pattern", "--timeout", "--preload", "-r"])
        : null;
  // npm manager booleans are evaluated in order in hasNonExecutingVerifyFlag.
  const scan = pm?.manager === "npm" ? pm.managerFlags.filter(arg => !["--version", "--help", "-h"].includes(arg)) : toks;
  for (let i = 0; i < scan.length; i++) {
    const t = scan[i];
    if (t === "--") break;
    if (bunValFlags && !t.includes("=") && bunValFlags.has(t)) {
      i++;
      continue;
    }
    if (
      t === "--help" ||
      t === "-h" ||
      t === "--version" ||
      t === "-V" ||
      /^-[hV]+$/.test(t)
    ) {
      return true;
    }
  }
  return false;
}

const MAKE_ALL_LONG_OPTS = [
  "always-make",
  "directory",
  "debug",
  "environment-overrides",
  "file",
  "makefile",
  "help",
  "ignore-errors",
  "include-dir",
  "jobs",
  "keep-going",
  "load-average",
  "max-load",
  "check-symlink-times",
  "just-print",
  "dry-run",
  "recon",
  "old-file",
  "assume-old",
  "print-data-base",
  "question",
  "no-builtin-rules",
  "no-builtin-variables",
  "silent",
  "quiet",
  "no-keep-going",
  "stop",
  "touch",
  "version",
  "print-directory",
  "no-print-directory",
  "what-if",
  "new-file",
  "assume-new",
  "warn-undefined-variables",
  "NeXT-option",
  "eval",
  "output-sync",
  "trace",
];
const MAKE_NON_EXEC_LONG = new Set([
  "just-print",
  "dry-run",
  "recon",
  "question",
  "touch",
  "version",
  "help",
  "ignore-errors",
  "old-file",
  "assume-old",
  "eval",
]);
const MAKE_VALUE_LONG = new Set([
  "directory",
  "file",
  "makefile",
  "include-dir",
  "what-if",
  "new-file",
  "assume-new",
  "NeXT-option",
]);
const MAKE_VALUE_SHORT = new Set(["C", "f", "I", "W", "N"]);
const MAKE_OPT_VALUE_SHORT = new Set(["j", "l", "O"]);
const MAKE_NON_EXEC_SHORT = new Set(["n", "q", "t", "v", "h", "i", "o"]);

function shouldConsumeMakeOptArg(opt: string, next: string | undefined): boolean {
  if (!next) return false;
  if (opt === "j" || opt === "jobs") return /^\d+$/.test(next);
  if (opt === "l" || opt === "load-average" || opt === "max-load") {
    // Matches GNU Make `decode_switches` floating arg: starts with digit or '.', parsed completely by C `strtod`
    // (decimal float with optional scientific exponent, or C99 hex float).
    return /^(?:(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|0[xX](?:[0-9a-fA-F]+\.?[0-9a-fA-F]*|\.[0-9a-fA-F]+)(?:[pP][+-]?\d+)?)$/.test(
      next,
    );
  }
  return false;
}

function extractSingleMakeTarget(args: string[]): string | null {
  let target: string | null = null;
  let afterDoubleDash = false;
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (!afterDoubleDash) {
      if (tok === "--") {
        afterDoubleDash = true;
        continue;
      }
      if (tok.startsWith("--") && tok.length > 2) {
        const eqIdx = tok.indexOf("=");
        const name = eqIdx >= 0 ? tok.slice(2, eqIdx) : tok.slice(2);
        const matches = MAKE_ALL_LONG_OPTS.filter((opt) => opt.startsWith(name));
        if (eqIdx < 0 && matches.length === 1) {
          const m = matches[0];
          if (
            MAKE_VALUE_LONG.has(m) ||
            m === "old-file" ||
            m === "assume-old" ||
            m === "eval" ||
            shouldConsumeMakeOptArg(m, args[i + 1])
          ) {
            i++;
          }
        }
        continue;
      }
      if (tok.startsWith("-") && tok.length > 1) {
        for (let j = 1; j < tok.length; j++) {
          const ch = tok[j];
          if (MAKE_VALUE_SHORT.has(ch) || ch === "o") {
            if (j === tok.length - 1) i++;
            break;
          }
          if (MAKE_OPT_VALUE_SHORT.has(ch)) {
            if (j === tok.length - 1 && shouldConsumeMakeOptArg(ch, args[i + 1])) {
              i++;
            }
            break;
          }
        }
        continue;
      }
    }
    if (/^[A-Za-z_][A-Za-z0-9_.-]*\s*(?:::=|:=|\+=|\?=|=)/.test(tok)) {
      continue;
    }
    if (target !== null) return null;
    target = tok;
  }
  return target;
}

function hasMakeNonExecArgs(args: string[], inMakeflags = false): boolean {
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (tok === "--") break;
    if (tok.startsWith("--") && tok.length > 2) {
      const eqIdx = tok.indexOf("=");
      const name = eqIdx >= 0 ? tok.slice(2, eqIdx) : tok.slice(2);
      const matches = MAKE_ALL_LONG_OPTS.filter((opt) => opt.startsWith(name));
      const nonExecMatch = matches.some((m) => {
        if (inMakeflags && (m === "old-file" || m === "assume-old")) return false;
        return MAKE_NON_EXEC_LONG.has(m);
      });
      if (nonExecMatch) return true;
      if (eqIdx < 0 && matches.length === 1 && MAKE_VALUE_LONG.has(matches[0])) {
        i++;
      }
      continue;
    }
    if ((tok.startsWith("-") && tok.length > 1) || (inMakeflags && i === 0 && !tok.includes("="))) {
      const letters = tok.startsWith("-") ? tok.slice(1) : tok;
      for (let j = 0; j < letters.length; j++) {
        const ch = letters[j];
        if (MAKE_NON_EXEC_SHORT.has(ch) && !(inMakeflags && ch === "o")) return true;
        if (MAKE_VALUE_SHORT.has(ch) || (inMakeflags && ch === "o")) {
          if (j === letters.length - 1) i++;
          break;
        }
        if (MAKE_OPT_VALUE_SHORT.has(ch)) break;
      }
    }
  }
  return false;
}

const TSC_WATCH_ALWAYS_VALUE_OPTS = [
  "fallbackpolling",
  "watchdirectory",
  "watchfile",
];
const TSC_WATCH_LIST_OPTS = [
  "excludedirectories",
  "excludefiles",
];
const TSC_BUILD_ALWAYS_VALUE_OPTS = new Set([
  "generatecpuprofile",
  "generatetrace",
  "locale",
  ...TSC_WATCH_ALWAYS_VALUE_OPTS,
]);
const TSC_BUILD_LIST_OPTS = new Set(TSC_WATCH_LIST_OPTS);
const TSC_NORMAL_ALWAYS_VALUE_OPTS = new Set([
  "baseurl",
  "charset",
  "declarationdir",
  "generatecpuprofile",
  "generatetrace",
  "ignoredeprecations",
  "importsnotusedasvalues",
  "jsx",
  "jsxfactory",
  "jsxfragmentfactory",
  "jsximportsource",
  "locale",
  "m",
  "maproot",
  "maxnodemodulejsdepth",
  "module",
  "moduledetection",
  "moduleresolution",
  "newline",
  "out",
  "outdir",
  "outfile",
  "p",
  "project",
  "reactnamespace",
  "rootdir",
  "sourceroot",
  "t",
  "target",
  "tsbuildinfofile",
  ...TSC_WATCH_ALWAYS_VALUE_OPTS,
]);
const TSC_NORMAL_LIST_OPTS = new Set([
  "customconditions",
  "lib",
  "modulesuffixes",
  "paths",
  "plugins",
  "rootdirs",
  "typeroots",
  "types",
  ...TSC_WATCH_LIST_OPTS,
]);

function findNearestPackageDir(startDir: string, npm: boolean): string | null {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir || (npm ? existsSync(join(dir, "node_modules")) : existsSync(join(dir, ".git")))) return null;
    dir = parent;
  }
}

function getGitTopLevel(dir: string): string | null {
  const top = runGit(dir, ["rev-parse", "--show-toplevel"], 3000);
  if (top.code !== 0) return null;
  try {
    return realpathSync.native(top.stdout.replace(/\n$/, ""));
  } catch {
    return null;
  }
}

const BENIGN_TRAILING_CMDS = new Set([
  "cd",
  "echo",
  "printf",
  "true",
  "pwd",
  "date",
  "ls",
  "wc",
  "cat",
  "head",
  "tail",
  "stat",
  ":",
]);

type ScriptKind = "test" | "lint" | "build";

function getScriptKind(name: string): ScriptKind | undefined {
  return (["test", "lint", "build"] as const).find(kind => isScriptNameKind(name, kind));
}

type VerificationHit = NonNullable<ReturnType<typeof classifyVerifyCommand>>;
type ReportPhase = { kind: "lint" | "test"; status: "pass" | "fail" };

function* jsonReportBlocks(text: string): Generator<string> {
  const start = /^[ \t]*\{/gm;
  let match: RegExpExecArray | null;
  while ((match = start.exec(text))) {
    let level = 1;
    let quoted = false;
    for (let i = start.lastIndex; i < text.length; i++) {
      const ch = text[i];
      if (quoted && ch === "\\") i++;
      else if (ch === '"') quoted = !quoted;
      else if (!quoted && ch === "{") level++;
      else if (!quoted && ch === "}" && --level === 0) {
        yield text.slice(match.index, i + 1);
        start.lastIndex = i + 1;
        break;
      }
    }
  }
}

function parseLangCheckPhases(outputText: string, passed: boolean): ReportPhase[] {
  const phases: ReportPhase[] = [];
  for (const block of jsonReportBlocks(outputText)) {
    let parsedReport: {
      ok?: boolean;
      executed?: number;
      failed?: number;
      checks?: Array<{ phase?: string; status?: string }>;
    };
    try {
      parsedReport = JSON.parse(block);
    } catch {
      continue;
    }
    // Strict JSON schema & total reconciliation: require valid types for checks/executed/failed/ok,
    // validate EVERY entry in `checks` (including skipped rows), and enforce exact agreement!
    if (
      !Array.isArray(parsedReport.checks) ||
      typeof parsedReport.executed !== "number" ||
      !Number.isInteger(parsedReport.executed) ||
      parsedReport.executed <= 0 ||
      typeof parsedReport.failed !== "number" ||
      !Number.isInteger(parsedReport.failed) ||
      parsedReport.failed < 0 ||
      typeof parsedReport.ok !== "boolean"
    ) {
      continue;
    }
    const allEntriesValid = parsedReport.checks.every(
      (c): c is { phase: "static" | "dynamic"; status: "pass" | "fail" | "skipped" } =>
        c !== null &&
        typeof c === "object" &&
        !Array.isArray(c) &&
        (c.phase === "static" || c.phase === "dynamic") &&
        (c.status === "pass" || c.status === "fail" || c.status === "skipped"),
    );
    if (!allEntriesValid) {
      continue;
    }
    const nonSkipped = parsedReport.checks.filter((c) => c.status !== "skipped");
    const staticRan = nonSkipped.filter((c) => c.phase === "static");
    const dynamicRan = nonSkipped.filter((c) => c.phase === "dynamic");
    const totalRan = staticRan.length + dynamicRan.length;
    const totalFailed = nonSkipped.filter((c) => c.status === "fail").length;
    if (
      totalRan !== parsedReport.executed ||
      totalFailed !== parsedReport.failed ||
      parsedReport.ok !== (parsedReport.failed === 0) ||
      parsedReport.ok !== passed
    ) {
      continue;
    }
    if (staticRan.length > 0) {
      phases.push({
        kind: "lint",
        status: staticRan.every((c) => c.status === "pass") ? "pass" : "fail",
      });
    }
    if (dynamicRan.length > 0) {
      phases.push({
        kind: "test",
        status: dynamicRan.every((c) => c.status === "pass") ? "pass" : "fail",
      });
    }

    return phases;
  }
  // Non-JSON summary output: require a complete `lang-check (...) -> executed=N, failed=M, ok=...`
  // header line AND match ONLY 2-space-indented check rows (`  [PASS|FAIL] (lang/phase) ...`)
  // after the header (never 4-space diagnostic excerpt lines!), reconciling exact row & fail counts.
  const lines = outputText.split(/\r?\n/);
  let headerIdx = -1;
  let declaredExecuted = -1;
  let declaredFailed = -1;
  let declaredOk = false;
  for (let li = 0; li < lines.length; li++) {
    const hm = lines[li].match(
      /^lang-check\s+\((?:static|dynamic|all)\)\s+\[[^\]]*\]\s*->\s*executed=(\d+),\s*failed=(\d+),\s*ok=(true|false)$/,
    );
    if (hm) {
      headerIdx = li;
      declaredExecuted = Number(hm[1]);
      declaredFailed = Number(hm[2]);
      declaredOk = hm[3] === "true";
      break;
    }
  }
  if (headerIdx < 0) return [];
  const staticStatuses: Array<"PASS" | "FAIL"> = [];
  const dynamicStatuses: Array<"PASS" | "FAIL"> = [];
  for (let li = headerIdx + 1; li < lines.length; li++) {
    const rm = lines[li].match(
      /^  \[(PASS|FAIL)\] \((?:go|ts|python)\/(static|dynamic)\) .+$/,
    );
    if (!rm) continue;
    if (rm[2] === "static") staticStatuses.push(rm[1] as "PASS" | "FAIL");
    else dynamicStatuses.push(rm[1] as "PASS" | "FAIL");
  }
  const totalParsed = staticStatuses.length + dynamicStatuses.length;
  const totalFailed =
    staticStatuses.filter((s) => s !== "PASS").length +
    dynamicStatuses.filter((s) => s !== "PASS").length;
  if (
    declaredExecuted <= 0 ||
    totalParsed !== declaredExecuted ||
    totalFailed !== declaredFailed ||
    declaredOk !== (declaredFailed === 0) ||
    declaredOk !== passed
  ) {
    return [];
  }
  if (staticStatuses.length > 0) {
    phases.push({
      kind: "lint",
      status: staticStatuses.every((s) => s === "PASS") ? "pass" : "fail",
    });
  }
  if (dynamicStatuses.length > 0) {
    phases.push({
      kind: "test",
      status: dynamicStatuses.every((s) => s === "PASS") ? "pass" : "fail",
    });
  }
  return phases;
}

function canVerifyCommandMutateFiles(hit: VerificationHit): boolean {
  if (hit.kind === "build") return true;
  const tsc = extractTscArgs(hit.cmdToks);
  if (tsc) {
    const index = tsc.map(arg => arg.toLowerCase()).lastIndexOf("--noemit");
    const next = tsc[index + 1]?.toLowerCase();
    if (index < 0 || next === "false" || next === "null") return true;
  }
  if (hit.kind === "lint" && hit.cmdToks.some(arg => arg === "-w" || arg.startsWith("-o"))) return true;
  return hit.cmdToks.some(arg => /^--(?:fix|fix-type|fix-unsafe|unsafe-fixes|write|apply|apply-unsafe|output-file|out-file|output|out)(?:=|$)/.test(arg));
}

function delegatesToScript(pm: ParsedPkgManager | null, hit: VerificationHit | null): boolean {
  if (!pm) return false;
  if (pm.bunScript || pm.subcmd === "run" || (pm.manager === "npm" && pm.subcmd === "test")) return true;
  return (pm.manager === "pnpm" || pm.manager === "yarn") && (!hit || !!getScriptKind(pm.scriptName));
}

function parseBoolVal(value: string): boolean {
  return !["false", "0", ""].includes(value.toLowerCase());
}

function npmCliBoolean(arg: string, key: string): boolean | undefined {
  const eq = arg.indexOf("=");
  const name = eq < 0 ? arg : arg.slice(0, eq);
  const value = eq < 0 || arg.slice(eq + 1) !== "false";
  if (name === "--" + key) return value;
  if (name === "--no-" + key) return !value;
  return undefined;
}

function ignoresLifecycleScripts(pm: ParsedPkgManager, envToks: string[]): boolean {
  let ignore = false;
  if (pm.manager === "npm") {
    for (const [key, val] of Object.entries(process.env)) {
      if (key.toLowerCase() === "npm_config_ignore_scripts") ignore = parseBoolVal(val ?? "");
    }
    for (const entry of envToks) {
      if (/^npm_config_ignore_scripts=/i.test(entry)) ignore = parseBoolVal(entry.slice(entry.indexOf("=") + 1));
    }
  }
  for (const arg of pm.managerFlags) {
    if (pm.manager === "npm") ignore = npmCliBoolean(arg, "ignore-scripts") ?? ignore;
    else if (arg === "--ignore-scripts") ignore = true;
    else if (arg === "--no-ignore-scripts") ignore = false;
    else if (arg.startsWith("--ignore-scripts=")) ignore = parseBoolVal(arg.slice("--ignore-scripts=".length));
  }
  return ignore;
}

function safeTrailingSegments(
  segments: string[], dir: string, depth = 0, forwarded: string[] = [], previous: string | null = null,
  inheritedEnv: string[] = [],
): boolean {
  for (const [i, segment] of segments.entries()) {
    if (hasUnquotedRedirect(segment, ">")) return false;
    const meta = splitShellTokensWithMeta(stripUnquotedShellRedirections(segment));
    if (!meta) return false;
    if (i === segments.length - 1) meta.push(...forwarded.map(value => ({ value, isEnvAssign: false })));
    const { cmdToks, envToks: localEnv } = splitLeadingEnv(meta);
    const envToks = [...inheritedEnv, ...localEnv];
    if (!cmdToks.length || SHELL_CONTROL_OR_STATE_BUILTINS.has(cmdToks[0])) return false;
    if (cmdToks[0] === "cd") {
      const next = resolveCdTarget(dir, previous, meta);
      if (!next) return false;
      previous = dir;
      dir = next;
      continue;
    }
    if (BENIGN_TRAILING_CMDS.has(cmdToks[0].replace(/^\/(?:usr\/)?bin\//, ""))) continue;
    const hit = classifyVerifyCommand(meta);
    if (hit && canVerifyCommandMutateFiles(hit)) return false;
    const pm = parsePkgManagerInvocation(cmdToks);
    if (!pm || !delegatesToScript(pm, hit)) {
      if (!hit) return false;
      continue;
    }
    if (depth >= 6) return false;
    const target = resolvePkgManagerEffectiveDir(pm, dir);
    const pkg = target && findNearestPackageDir(target, pm.manager === "npm");
    if (!pkg) return false;
    try {
      const scripts = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).scripts;
      const script = scripts?.[pm.scriptName];
      if (typeof script !== "string" || hasAmbiguousControlFlow(script) ||
          !safeTrailingSegments(splitShellSegments(script), pkg, depth + 1, pm.forwarded, null, envToks)) return false;
      if (!ignoresLifecycleScripts(pm, envToks)) {
        for (const prefix of ["pre", "post"]) {
          const hook = scripts[prefix + pm.scriptName];
          if (typeof hook === "string" && (hasAmbiguousControlFlow(hook) ||
              !safeTrailingSegments(splitShellSegments(hook), pkg, depth + 1, [], null, envToks))) return false;
        }
      }
    } catch {
      return false;
    }
  }
  return true;
}

function matchesScriptKind(hit: VerificationHit, expected: ScriptKind, dir: string, outputText: string, passed: boolean): boolean {
  if (hit.kind === "hurl") return expected === "test" && isValidHurlExecution(hit.cmdToks, dir, outputText);
  if (hit.kind !== "lang-check") return hit.kind === expected;
  const mode = parseLangCheckInvocation(hit.cmdToks)?.mode;
  if (mode === "all") return parseLangCheckPhases(outputText, passed).some(p => p.kind === expected && p.status === (passed ? "pass" : "fail"));
  return expected !== "build" && mode === (expected === "test" ? "dynamic" : "static");
}

function hasExecutingScriptSegment(
  segments: string[], pkgDir: string, depth: number, expectedKind: ScriptKind, forwarded: string[], outputText: string, passed: boolean, inheritedEnv: string[],
): boolean {
  const originTop = getGitTopLevel(pkgDir);
  let dir = pkgDir;
  let previous: string | null = null;
  let verified = false;
  for (const [index, seg] of segments.entries()) {
    if (verified) {
      if (!safeTrailingSegments(segments.slice(index), dir, depth, forwarded, previous, inheritedEnv)) return false;
      if (!forwarded.includes("-v")) return true;
      verified = false; // The final runner must still accept the forwarded verbose flag.
    }
    const meta = splitShellTokensWithMeta(stripUnquotedShellRedirections(seg));
    if (!meta) return false;
    if (index === segments.length - 1 && forwarded.length) {
      meta.push(...forwarded.map(value => ({ value, isEnvAssign: false })));
    }
    const { cmdToks, envToks: localEnv } = splitLeadingEnv(meta);
    const envToks = [...inheritedEnv, ...localEnv];
    if (!cmdToks.length && localEnv.length) return false;
    if (!cmdToks.length) continue;
    if (SHELL_CONTROL_OR_STATE_BUILTINS.has(cmdToks[0])) return false;
    if (cmdToks[0] === "cd") {
      const next = resolveCdTarget(dir, previous, meta);
      if (!next) return false;
      previous = dir;
      dir = next;
      continue;
    }
    const hit = classifyVerifyCommand(meta);
    const pm = parsePkgManagerInvocation(cmdToks);
    const delegates = delegatesToScript(pm, hit);
    if (index === segments.length - 1 && forwarded.includes("-v")) {
      if (hasUnquotedRedirect(seg, ">") || hasUnquotedRedirect(seg, "<")) return false;
      if (!delegates && !isPytestInvocation(cmdToks) && parseGoInvocation(cmdToks)?.subcmd !== "test") return false;
    }
    if (!hit && !delegates) {
      continue;
    }
    const target = hit ? resolveVerifyTargetDir(cmdToks, envToks, dir) : resolvePkgManagerEffectiveDir(pm!, dir);
    if (!target || (originTop && getGitTopLevel(target) !== originTop)) return false;
    if (!delegates && hit && !matchesScriptKind(hit, expectedKind, dir, outputText, passed)) continue;
    if (!extractTscArgs(cmdToks) && hasInfoOnlyFlag(cmdToks)) continue;
    if (!hasNonExecutingVerifyFlag(cmdToks, envToks, target, outputText, passed, depth + 1, !!delegates, expectedKind)) verified = true;
  }
  return verified;
}

function hasNonExecutingVerifyFlag(
  cmdToks: string[], envToks: string[], targetDir: string, outputText: string, passed: boolean, depth = 0, requireManifestScript = false, expectedKind?: ScriptKind,
): boolean {
  if (depth >= 6) return true;
  const [c0 = "", c1 = ""] = cmdToks;
  const bin0 = c0.split("/").pop() ?? "";

  if (bin0 === "make") {
    // 1. Startup environment: process.env overlaid ONLY by shell env prefix (`envToks`).
    const startupMakeEnv = new Map<string, string>();
    if (process.env.MAKEFLAGS !== undefined) startupMakeEnv.set("MAKEFLAGS", process.env.MAKEFLAGS);
    if (process.env.GNUMAKEFLAGS !== undefined) startupMakeEnv.set("GNUMAKEFLAGS", process.env.GNUMAKEFLAGS);
    for (const raw of envToks) {
      const m = raw.match(/^(GNU)?MAKEFLAGS=(.*)$/);
      if (m) {
        startupMakeEnv.set(m[1] ? "GNUMAKEFLAGS" : "MAKEFLAGS", m[2]);
      }
    }
    for (const val of startupMakeEnv.values()) {
      const mfArgs = val.trim().split(/[ \t]+/).filter(Boolean);
      if (hasMakeNonExecArgs(mfArgs, true)) return true;
    }
    // 2. Command-line variable assignments (`make test MAKEFLAGS=-n`, `MAKEFLAGS:=-n`, `MAKEFLAGS+=-n`, etc.)
    //    are additive for dry-run/ignore-errors flags and NEVER clear startup environment flags.
    for (const raw of cmdToks.slice(1)) {
      const m = raw.match(/^(?:GNU)?MAKEFLAGS\s*(?:::=|:=|\+=|\?=|=)(.*)$/);
      if (m) {
        const mfArgs = m[1].trim().split(/[ \t]+/).filter(Boolean);
        if (hasMakeNonExecArgs(mfArgs, true)) return true;
      }
    }
    return hasMakeNonExecArgs(cmdToks.slice(1), false);
  }

  if (bin0 === "just") {
    const effectiveJustEnv = new Map<string, string>();
    if (process.env.JUST_DRY_RUN !== undefined) effectiveJustEnv.set("JUST_DRY_RUN", process.env.JUST_DRY_RUN);
    if (process.env.JUST_ALLOW_MISSING !== undefined) {
      effectiveJustEnv.set("JUST_ALLOW_MISSING", process.env.JUST_ALLOW_MISSING);
    }
    for (const raw of envToks) {
      const eq = raw.indexOf("=");
      if (eq < 0) continue;
      const k = raw.slice(0, eq);
      if (k === "JUST_DRY_RUN" || k === "JUST_ALLOW_MISSING") {
        effectiveJustEnv.set(k, raw.slice(eq + 1));
      }
    }
    for (const val of effectiveJustEnv.values()) {
      if (val !== "" && !/^(?:0|false)$/i.test(val)) return true;
    }
    const justNonExecLong = new Set([
      "--dry-run",
      "--allow-missing",
      "--list",
      "--show",
      "--summary",
      "--dump",
      "--evaluate",
      "--variables",
      "--choose",
      "--clean",
      "--command",
      "--shell-command",
      "--fmt",
      "--groups",
      "--init",
      "--json",
      "--usage",
      "--changelog",
      "--completions",
      "--man",
      "--edit",
    ]);
    const justValueShort = new Set(["f", "d", "E", "F"]);
    const justNonExecShort = new Set(["n", "l", "s", "c", "e", "h", "V"]);
    for (let i = 1; i < cmdToks.length; i++) {
      const tok = cmdToks[i];
      if (tok === "--") break;
      const flagName = tok.includes("=") ? tok.slice(0, tok.indexOf("=")) : tok;
      if (justNonExecLong.has(flagName)) return true;
      if (tok.startsWith("-") && !tok.startsWith("--") && tok.length > 1) {
        for (let j = 1; j < tok.length; j++) {
          const ch = tok[j];
          if (justNonExecShort.has(ch)) return true;
          if (justValueShort.has(ch)) {
            if (j === tok.length - 1) i++;
            break;
          }
        }
      }
    }
    return false;
  }

  const goInv = parseGoInvocation(cmdToks);
  if (goInv) {
    const isGoBoolOn = (norm: string, name: string): boolean => {
      if (norm === name) return true;
      if (!norm.startsWith(`${name}=`)) return false;
      const val = norm.slice(name.length + 1).toLowerCase();
      return val !== "false" && val !== "0" && val !== "f";
    };
    for (let i = goInv.argsStart; i < cmdToks.length; i++) {
      const tok = cmdToks[i];
      if (tok === "--") break;
      const norm = tok.startsWith("--") ? tok.slice(1) : tok;
      if (isGoBoolOn(norm, "-n") || norm === "-help" || norm === "-h") return true;
      if (
        goInv.subcmd === "test" &&
        (isGoBoolOn(norm, "-c") || norm === "-list" || norm.startsWith("-list="))
      ) {
        return true;
      }
    }
    return false;
  }

  const pytestInv = isPytestInvocation(cmdToks);
  if (pytestInv) {
    const pytestNonExec = new Set([
      "--collect-only",
      "--co",
      "--fixtures",
      "--fixtures-per-test",
      "--markers",
      "--setup-only",
      "--setup-plan",
    ]);
    for (let i = pytestInv.argsStart; i < cmdToks.length; i++) {
      const tok = cmdToks[i];
      if (tok === "--") break;
      if (pytestNonExec.has(tok)) return true;
    }
    return false;
  }

  const tscArgs = extractTscArgs(cmdToks);
  if (tscArgs) {
    const stripTscOpt = (tok: string): string | null => {
      if (!tok.startsWith("-") || tok.startsWith("---")) return null;
      const name = (tok.startsWith("--") ? tok.slice(2) : tok.slice(1)).toLowerCase();
      return name || null;
    };
    const firstOpt = tscArgs[0] ? stripTscOpt(tscArgs[0]) : null;
    const isBuildMode = firstOpt === "b" || firstOpt === "build";
    const alwaysValueOpts = isBuildMode ? TSC_BUILD_ALWAYS_VALUE_OPTS : TSC_NORMAL_ALWAYS_VALUE_OPTS;
    const listValueOpts = isBuildMode ? TSC_BUILD_LIST_OPTS : TSC_NORMAL_LIST_OPTS;
    const tscFlags = new Map<string, boolean>();
    const mapCanon = (optName: string): string | null => {
      if (optName === "help" || optName === "h" || optName === "?") return "help";
      if (optName === "version" || (!isBuildMode && optName === "v")) return "version";
      if (optName === "showconfig") return "showConfig";
      if (optName === "listfilesonly") return "listFilesOnly";
      if (optName === "init") return "init";
      if (optName === "all") return "all";
      if (optName === "nocheck") return "noCheck";
      if (optName === "clean") return "clean";
      if (optName === "dry" || (isBuildMode && optName === "d")) return "dry";
      return null;
    };
    for (let i = isBuildMode ? 1 : 0; i < tscArgs.length; i++) {
      const tok = tscArgs[i];
      // Fail closed on positional `@file` response files (e.g. `@/dev/stdin`), which can inject `--version`/`--dry`/`--help`.
      if (tok.startsWith("@")) return true;
      const optName = stripTscOpt(tok);
      if (!optName) continue;
      // Non-list value options always consume the next argument verbatim (e.g. `--outDir --version`).
      if (alwaysValueOpts.has(optName)) {
        i++;
        continue;
      }
      // List / tsconfig-only non-bool options (e.g. `--types`, `--lib`) only consume the next arg
      // when it is `"null"` or does not start with `"-"` after trimming (matching TypeScript parseListTypeOption).
      if (listValueOpts.has(optName)) {
        const next = tscArgs[i + 1];
        if (next !== undefined && (next === "null" || !next.trim().startsWith("-"))) {
          i++;
        }
        continue;
      }
      const canon = mapCanon(optName);
      if (!canon) continue;
      let val = true;
      // Per TypeScript parseCommandLine: boolean option values are strictly lowercase "true" / "false" / "null" (clears option).
      const next = tscArgs[i + 1];
      if (next === "true" || next === "false" || next === "null") {
        val = next === "true";
        i++;
      }
      tscFlags.set(canon, val);
    }
    return Array.from(tscFlags.values()).some(Boolean);
  }

  const eslintArgs = extractEslintArgs(cmdToks);
  if (eslintArgs) {
    for (let i = 0; i < eslintArgs.length; i++) {
      const tok = eslintArgs[i];
      if (tok === "--") break;
      if (
        tok === "--print-config" ||
        tok.startsWith("--print-config=") ||
        tok === "--init" ||
        tok === "--inspect-config" ||
        tok === "--env-info" ||
        tok === "-v" ||
        tok === "--version" ||
        tok === "-h" ||
        tok === "--help"
      ) {
        return true;
      }
    }
    return false;
  }

  if (bin0 === "ruff" && c1 === "check") {
    for (let i = 2; i < cmdToks.length; i++) {
      const tok = cmdToks[i];
      if (tok === "--") break;
      if (tok === "--show-settings" || tok === "--show-files") return true;
    }
    return false;
  }

  if (bin0 === "npm" || bin0 === "bun" || bin0 === "pnpm" || bin0 === "yarn") {
    const flags = new Map<string, boolean>();
    if (bin0 === "npm") {
      for (const [rawKey, rawVal] of Object.entries(process.env)) {
        if (rawVal === undefined) continue;
        const k = rawKey.toLowerCase();
        if (k === "npm_config_if_present") flags.set("if-present", parseBoolVal(rawVal));
        if (k === "npm_config_dry_run") flags.set("dry-run", parseBoolVal(rawVal));
        if (k === "npm_config_usage") flags.set("usage", parseBoolVal(rawVal));
        if (k === "npm_config_versions") flags.set("versions", parseBoolVal(rawVal));
      }
      for (const raw of envToks) {
        const eq = raw.indexOf("=");
        if (eq < 0) continue;
        const k = raw.slice(0, eq).toLowerCase();
        const v = raw.slice(eq + 1);
        if (k === "npm_config_if_present") flags.set("if-present", parseBoolVal(v));
        if (k === "npm_config_dry_run") flags.set("dry-run", parseBoolVal(v));
        if (k === "npm_config_usage") flags.set("usage", parseBoolVal(v));
        if (k === "npm_config_versions") flags.set("versions", parseBoolVal(v));
      }
    }
    const pm = parsePkgManagerInvocation(cmdToks);
    if (pm?.manager !== "npm" && pm?.managerFlags.some(arg => ["-v", "--version", "-h", "--help", "-?", "--versions", "--usage"].includes(arg))) return true;
    const scriptKind = pm && getScriptKind(pm.scriptName);
    const builtinBuild = pm?.manager === "bun" && pm.subcmd === "build" && !pm.bunScript;
    if (pm && !builtinBuild && (requireManifestScript || scriptKind)) {
      const nonExecutingFlags = new Set([
        "-h", "-V", "-?", "--help", "--version", "--versions", "--usage",
        "--dry-run", "--dry", "--list", "--collect-only", "--pass-with-no-tests",
        "--passwithnotests", "--watch", "--ui", "--open", "--showconfig", "--listfilesonly",
        "--nocheck", "--clean", "--init", "--print-config", "--inspect-config", "--env-info",
        "--show-settings", "--show-files", "--merge-reports", "--mergereports", "--clear-cache",
        "--clearcache", "--typecheck-only",
      ]);
      const forwarded = pm.forwarded;
      const verbose = forwarded.includes("-v");
      const builtinTest = pm.manager === "bun" && pm.subcmd === "test" && !pm.bunScript;
      const kind = expectedKind ?? scriptKind;
      if (verbose && (builtinTest || kind !== "test")) return true;
      if (!builtinTest) {
        let manifestScript: unknown;
        const pkgDir = findNearestPackageDir(targetDir, pm.manager === "npm");
        if (pkgDir && pkgDir !== targetDir) {
          const top = getGitTopLevel(targetDir);
          if (top && getGitTopLevel(pkgDir) !== top) return true;
        }
        if (pkgDir) {
          try {
            const scripts = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).scripts;
            manifestScript = scripts?.[pm.scriptName];
            const post = scripts?.[`post${pm.scriptName}`];
            if (typeof post === "string" && post.trim() && !ignoresLifecycleScripts(pm, envToks)) {
              if (hasAmbiguousControlFlow(post) || !safeTrailingSegments(splitShellSegments(post), pkgDir, depth + 1, [], null, envToks)) return true;
            }
          } catch {
            return true;
          }
        }
        const script = typeof manifestScript === "string" ? manifestScript : null;
        if ((requireManifestScript || pm.bunScript) && script === null) return true;
        if (script !== null && (!script.trim() || hasAmbiguousControlFlow(script))) return true;
        const segments = script !== null ? splitShellSegments(script) : null;
        if (segments && pkgDir && (!kind || !hasExecutingScriptSegment(segments, pkgDir, depth, kind, forwarded, outputText, passed, envToks))) return true;
        if (verbose && script === null) return true;
      }
      for (const arg of forwarded) {
        const eq = arg.indexOf("=");
        if (eq >= 0 && /^(false|0|null)$/i.test(arg.slice(eq + 1))) continue;
        const name = eq >= 0 ? arg.slice(0, eq) : arg;
        if (nonExecutingFlags.has(name.startsWith("--") ? name.toLowerCase() : name)) return true;
      }
    }
    const checkKeys =
      pm?.manager === "bun" && pm.subcmd === "test" && !pm.bunScript
        ? ["dry-run", "pass-with-no-tests"]
        : bin0 === "npm"
          ? ["dry-run", "if-present", "no-exit-on-error", "usage", "versions", "version"]
          : ["dry-run", "if-present", "no-exit-on-error"];
    for (const arg of bin0 === "npm" && pm ? pm.managerFlags : cmdToks.slice(1)) {
      if (arg === "--") break;
      // npm 11 expands the positive help shorthands to usage. --no-help does not undo --usage.
      if (bin0 === "npm") {
        if (/^-[A-Za-z?]{2,}$/.test(arg) && !/^-[CLcmw]/.test(arg)) {
          if (arg.includes("v")) flags.set("version", true);
          if (/[hH?]/.test(arg)) flags.set("usage", true);
          continue;
        }
        const tok = arg.replace(/^-v(?==|$)/, "--version")
          .replace(/^(?:--hel(?:p)?|-[hH?])(?==|$)/, "--usage")
          .replace(/^--(?:u|us|usa|usag)(?:=(?!false$).*|$)/, "--usage");
        for (const key of checkKeys) {
          const value = npmCliBoolean(tok, key);
          if (value !== undefined) flags.set(key, value);
        }
        continue;
      }
      const tok = arg;
      for (const key of checkKeys) {
        if (tok === `--${key}`) {
          flags.set(key, true);
        } else if (tok === `--no-${key}`) {
          flags.set(key, false);
        } else if (tok.startsWith(`--${key}=`)) {
          flags.set(key, parseBoolVal(tok.slice(key.length + 3)));
        }
      }
    }
    return Array.from(flags.values()).some(Boolean);
  }

  return false;
}

/**
 * Resolve the effective repository/working directory for a verification command when
 * directory-switching flags or env vars are present (`make -C/--directory`, `just -d/--working-directory/-f`,
 * `go -C`, `bun --cwd`, `npm -C/--prefix`, `npx tsc -p/--project`).
 * Returns `null` if the target directory is ambiguous (e.g. missing value or multi-repo tsc --build).
 */
function extractMakeDirs(args: string[], startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (tok === "--") break;
    if (tok.startsWith("--") && tok.length > 2) {
      const eqIdx = tok.indexOf("=");
      const name = eqIdx >= 0 ? tok.slice(2, eqIdx) : tok.slice(2);
      const matches = MAKE_ALL_LONG_OPTS.filter((opt) => opt.startsWith(name));
      if (matches.length === 1 && matches[0] === "directory") {
        const val = eqIdx >= 0 ? tok.slice(eqIdx + 1) : args[++i];
        if (!val) return null;
        dir = resolve(dir, val);
        continue;
      }
      if (eqIdx < 0 && matches.length === 1 && MAKE_VALUE_LONG.has(matches[0])) {
        i++;
      }
      continue;
    }
    if (tok.startsWith("-") && tok.length > 1) {
      for (let j = 1; j < tok.length; j++) {
        const ch = tok[j];
        if (ch === "C") {
          const val = j < tok.length - 1 ? tok.slice(j + 1) : args[++i];
          if (!val) return null;
          dir = resolve(dir, val);
          break;
        }
        if (MAKE_VALUE_SHORT.has(ch)) {
          if (j === tok.length - 1) i++;
          break;
        }
        if (MAKE_OPT_VALUE_SHORT.has(ch)) break;
      }
    }
  }
  return dir;
}

function commonDirAncestor(dirs: string[]): string {
  if (dirs.length === 1) return dirs[0];
  const partsList = dirs.map((d) => resolve(d).split("/"));
  const common: string[] = [];
  const minLen = Math.min(...partsList.map((p) => p.length));
  for (let i = 0; i < minLen; i++) {
    const seg = partsList[0][i];
    if (partsList.every((p) => p[i] === seg)) common.push(seg);
    else break;
  }
  return common.join("/") || "/";
}

function resolvePathArgToDir(
  rawArg: string,
  curDir: string,
  stripPytestNodeId = false,
): string {
  let cleaned = stripPytestNodeId ? rawArg.split("::")[0] : rawArg;
  if (cleaned.endsWith("/...")) cleaned = cleaned.slice(0, -4) || ".";
  if (cleaned === "...") cleaned = ".";
  const abs = resolve(curDir, cleaned);
  if (existsSync(abs)) {
    try {
      return statSync(abs).isFile() ? dirname(abs) : abs;
    } catch {
      return abs;
    }
  }
  const base = cleaned.split("/").pop() ?? "";
  if (/\.[a-zA-Z0-9]{1,8}$/.test(base) && !base.startsWith(".")) {
    return dirname(abs);
  }
  return abs;
}

// Options that consume a separate argument. Bare --sourcemap and --metafile
// leave the following token as an entry point on Bun 1.4.4.
const BUN_BUILD_VALUE_FLAGS = new Set([
  "--cwd", "--outdir", "--outfile", "--target", "--format", "--root", "--public-path",
  "-e", "--external", "-d", "--define", "-l", "--loader", "--entry-naming", "--chunk-naming",
  "--asset-naming", "--banner", "--footer", "--conditions", "--env", "--tsconfig-override",
  "--jsx-factory", "--jsx-fragment", "--jsx-import-source", "--jsx-runtime", "--packages",
  "--compile-exec-argv", "--compile-executable-path", "--compile-jit-policy", "--asset",
  "--bytecode-depth", "--bytecode-order", "--min-chunk-size", "--allow-unresolved",
  "--windows-icon", "--windows-title", "--windows-publisher", "--windows-version",
  "--windows-description", "--windows-copyright", "--main-fields", "--extension-order",
  "--drop", "--feature", "--env-file", "-c", "--config", "-r", "--preload", "--require", "--import",
]);

function resolvePositionalTargetDir(
  args: string[],
  curDir: string,
  opts: {
    valueFlags: Set<string>;
    requireSingleCheckout?: boolean;
    stripPytestNodeId?: boolean;
    onlyPathLike?: boolean;
    projectFlags?: Set<string>;
    rootDirFlags?: Set<string>;
  },
): string | null {
  const positionals: string[] = [];
  let explicitProject: string | null = null;
  let explicitRoot: string | null = null;
  let endFlags = false;
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (!endFlags && tok === "--") {
      endFlags = true;
      continue;
    }
    if (!endFlags && tok.startsWith("-") && tok.length > 1) {
      const eqIdx = tok.indexOf("=");
      const flagName = eqIdx >= 0 ? tok.slice(0, eqIdx) : tok;
      if (opts.projectFlags?.has(flagName)) {
        const val = eqIdx >= 0 ? tok.slice(eqIdx + 1) : args[++i];
        if (!val) return null;
        explicitProject = val;
        continue;
      }
      if (opts.rootDirFlags?.has(flagName)) {
        const val = eqIdx >= 0 ? tok.slice(eqIdx + 1) : args[++i];
        if (!val) return null;
        explicitRoot = val;
        continue;
      }
      if (eqIdx < 0 && opts.valueFlags.has(flagName)) {
        i++;
      }
      continue;
    }
    if (opts.onlyPathLike) {
      const isPathLike =
        tok.startsWith("./") ||
        tok.startsWith("../") ||
        tok.startsWith("/") ||
        tok.includes("/") ||
        existsSync(resolve(curDir, tok));
      if (!isPathLike) continue;
    }
    positionals.push(tok);
  }
  if (positionals.length > 0) {
    const dirs = positionals.map((p) =>
      resolvePathArgToDir(p, curDir, Boolean(opts.stripPytestNodeId)),
    );
    if (opts.requireSingleCheckout && dirs.length > 1) {
      const roots = new Set([...new Set(dirs)].map(getGitTopLevel));
      if (roots.size > 1) return null;
    }
    return commonDirAncestor(dirs);
  }
  if (explicitProject) {
    return resolvePathArgToDir(explicitProject, curDir);
  }
  if (explicitRoot) {
    return resolve(curDir, explicitRoot);
  }
  return curDir;
}

function resolveVerifyTargetDir(
  cmdToks: string[],
  envToks: string[],
  curDir: string,
): string | null {
  const [c0 = "", c1 = "", c2 = ""] = cmdToks;
  const bin0 = c0.split("/").pop() ?? "";

  if (bin0 === "make") {
    // Per GNU Make docs, `-C` / `--directory` is ONLY honored on the command line (NEVER via MAKEFLAGS).
    return extractMakeDirs(cmdToks.slice(1), curDir);
  }

  if (bin0 === "just") {
    let explicitDir: string | null = process.env.JUST_WORKING_DIRECTORY || null;
    let justfile: string | null = process.env.JUST_JUSTFILE || null;
    for (const raw of envToks) {
      if (raw.startsWith("JUST_WORKING_DIRECTORY=")) explicitDir = raw.slice("JUST_WORKING_DIRECTORY=".length) || null;
      if (raw.startsWith("JUST_JUSTFILE=")) justfile = raw.slice("JUST_JUSTFILE=".length) || null;
    }
    for (let i = 1; i < cmdToks.length; i++) {
      const tok = cmdToks[i];
      if (tok === "--") break;
      if (tok === "--working-directory") {
        const val = cmdToks[++i];
        if (!val) return null;
        explicitDir = val;
      } else if (tok.startsWith("--working-directory=")) {
        explicitDir = tok.slice("--working-directory=".length);
      } else if (tok === "--justfile") {
        const val = cmdToks[++i];
        if (!val) return null;
        justfile = val;
      } else if (tok.startsWith("--justfile=")) {
        justfile = tok.slice("--justfile=".length);
      } else if (tok.startsWith("-") && !tok.startsWith("--") && tok.length > 1) {
        for (let j = 1; j < tok.length; j++) {
          const ch = tok[j];
          if (ch === "d") {
            const val = j < tok.length - 1 ? tok.slice(j + 1) : cmdToks[++i];
            if (!val) return null;
            explicitDir = val;
            break;
          }
          if (ch === "f") {
            const val = j < tok.length - 1 ? tok.slice(j + 1) : cmdToks[++i];
            if (!val) return null;
            justfile = val;
            break;
          }
          if (ch === "E" || ch === "F") {
            if (j === tok.length - 1) i++;
            break;
          }
        }
      }
    }
    if (explicitDir) return resolve(curDir, explicitDir);
    if (justfile && justfile !== "-") return dirname(resolve(curDir, justfile));
    return curDir;
  }

  const langCheckInv = parseLangCheckInvocation(cmdToks);
  if (langCheckInv) {
    return langCheckInv.targetPositional
      ? resolve(curDir, langCheckInv.targetPositional)
      : curDir;
  }

  const goInv = parseGoInvocation(cmdToks);
  if (goInv) {
    let dir = curDir;
    for (const d of goInv.preDirs) {
      dir = resolve(dir, d);
    }
    const GO_VALUE_FLAGS = new Set([
      "-o",
      "-p",
      "-asmflags",
      "-buildmode",
      "-compiler",
      "-gccgoflags",
      "-gcflags",
      "-installsuffix",
      "-ldflags",
      "-mod",
      "-modfile",
      "-overlay",
      "-pgo",
      "-pkgdir",
      "-tags",
      "-toolexec",
      "-workfile",
      "-vet",
      "-vettool",
      "-bench",
      "-benchtime",
      "-blockprofile",
      "-blockprofilerate",
      "-count",
      "-covermode",
      "-coverpkg",
      "-coverprofile",
      "-cpu",
      "-cpuprofile",
      "-exec",
      "-fuzz",
      "-fuzzminimizetime",
      "-fuzztime",
      "-list",
      "-memprofile",
      "-memprofilerate",
      "-mutexprofile",
      "-mutexprofilefraction",
      "-outputdir",
      "-parallel",
      "-run",
      "-shuffle",
      "-skip",
      "-timeout",
      "-trace",
    ]);
    const pkgPaths: string[] = [];
    for (let i = goInv.argsStart; i < cmdToks.length; i++) {
      const tok = cmdToks[i];
      if (tok === "--" || tok === "-args" || tok === "--args") break;
      if (tok === "-C" || tok === "--C") {
        const val = cmdToks[++i];
        if (!val) return null;
        dir = resolve(dir, val);
        continue;
      }
      if (tok.startsWith("-C=") || tok.startsWith("--C=")) {
        const val = tok.slice(tok.indexOf("=") + 1);
        if (!val) return null;
        dir = resolve(dir, val);
        continue;
      }
      if (tok.startsWith("-")) {
        const eqIdx = tok.indexOf("=");
        const rawFlag = eqIdx >= 0 ? tok.slice(0, eqIdx) : tok;
        const normFlag = rawFlag.startsWith("--") ? rawFlag.slice(1) : rawFlag;
        if (eqIdx < 0 && GO_VALUE_FLAGS.has(normFlag)) {
          i++;
        }
        continue;
      }
      if (
        tok === "." ||
        tok === "./..." ||
        tok.startsWith("./") ||
        tok.startsWith("../") ||
        tok.startsWith("/")
      ) {
        pkgPaths.push(tok);
      }
    }
    if (pkgPaths.length > 0) {
      return commonDirAncestor(pkgPaths.map((p) => resolvePathArgToDir(p, dir)));
    }
    return dir;
  }

  // Resolve runner-specific targets FIRST (including when invoked via `pnpm`/`yarn`/`npx`/`bunx`)
  const vitestInv = parseVitestRunInvocation(cmdToks, envToks);
  if (vitestInv) {
    const dir = vitestInv.pm ? resolvePkgManagerEffectiveDir(vitestInv.pm, curDir) : curDir;
    if (!dir) return null;
    let rootDir: string | null = null;
    let discoveryDir: string | null = null;
    let configDir: string | null = null;
    const args = vitestInv.vitestArgs;
    const posStart = args[0] === "run" ? 1 : 0;
    const positionalArgs: string[] = [];
    const VITEST_VALUE_FLAGS = new Set([
      "-t",
      "--testNamePattern",
      "--reporter",
      "--outputFile",
      "--environment",
      "--shard",
      "--pool",
      "--project",
      "--maxWorkers",
      "--minWorkers",
      "--testTimeout",
      "--hookTimeout",
      "--bail",
      "--sequence",
    ]);
    let stopFlags = false;
    for (let i = posStart; i < args.length; i++) {
      const tok = args[i];
      if (!stopFlags && tok === "--") {
        stopFlags = true;
        continue;
      }
      if (!stopFlags && (tok === "--root" || tok === "-r")) {
        const val = args[++i];
        if (!val) return null;
        rootDir = resolve(dir, val);
        continue;
      }
      if (!stopFlags && (tok.startsWith("--root=") || tok.startsWith("-r="))) {
        const val = tok.slice(tok.indexOf("=") + 1);
        if (!val) return null;
        rootDir = resolve(dir, val);
        continue;
      }
      if (!stopFlags && tok === "--dir") {
        const val = args[++i];
        if (!val) return null;
        discoveryDir = val;
        continue;
      }
      if (!stopFlags && tok.startsWith("--dir=")) {
        const val = tok.slice("--dir=".length);
        if (!val) return null;
        discoveryDir = val;
        continue;
      }
      if (!stopFlags && (tok === "--config" || tok === "-c")) {
        const val = args[++i];
        if (!val) return null;
        const abs = resolve(dir, val);
        configDir = dirname(abs);
        continue;
      }
      if (!stopFlags && (tok.startsWith("--config=") || tok.startsWith("-c="))) {
        const val = tok.slice(tok.indexOf("=") + 1);
        if (!val) return null;
        const abs = resolve(dir, val);
        configDir = dirname(abs);
        continue;
      }
      if (!stopFlags && tok.startsWith("-")) {
        if (!tok.includes("=") && VITEST_VALUE_FLAGS.has(tok)) i++;
        continue;
      }
      if (
        tok.startsWith("./") ||
        tok.startsWith("../") ||
        tok.startsWith("/") ||
        tok.includes("/") ||
        existsSync(resolve(rootDir ?? dir, tok))
      ) {
        positionalArgs.push(tok);
      }
    }
    const effectiveRoot = rootDir ?? dir;
    const effectiveDiscovery = discoveryDir ? resolve(effectiveRoot, discoveryDir) : null;
    const baseDir = effectiveDiscovery ?? effectiveRoot;
    // A shared external `--config ../shared/vitest.config.ts` can override `root` internally;
    // unless an explicit `--root`, `--dir`, or positional test path anchors the repo, suppress attribution
    // so neither the shared config repo nor an unverified root receives misattributed evidence.
    if (
      configDir &&
      !rootDir &&
      !discoveryDir &&
      positionalArgs.length === 0 &&
      configDir !== effectiveRoot &&
      !configDir.startsWith(effectiveRoot + "/")
    ) {
      return null;
    }
    if (positionalArgs.length > 0) {
      return commonDirAncestor(positionalArgs.map((p) => resolvePathArgToDir(p, baseDir)));
    }
    return baseDir;
  }

  const svelteInv = parseSvelteCheckInvocation(cmdToks);
  if (svelteInv) {
    const dir = svelteInv.pm ? resolvePkgManagerEffectiveDir(svelteInv.pm, curDir) : curDir;
    if (!dir) return null;
    let rawWs: string | null = null;
    let rawTsconfig: string | null = null;
    const args = svelteInv.checkArgs;
    for (let i = 0; i < args.length; i++) {
      const tok = args[i];
      if (tok === "--") break;
      if (tok === "--workspace") {
        const val = args[++i];
        if (!val) return null;
        rawWs = val;
      } else if (tok.startsWith("--workspace=")) {
        const val = tok.slice("--workspace=".length);
        if (!val) return null;
        rawWs = val;
      } else if (tok === "--tsconfig") {
        const val = args[++i];
        if (!val) return null;
        rawTsconfig = val;
      } else if (tok.startsWith("--tsconfig=")) {
        const val = tok.slice("--tsconfig=".length);
        if (!val) return null;
        rawTsconfig = val;
      }
    }
    // Per svelte-check CLI: relative `--tsconfig` resolves against the effective `--workspace` directory!
    const effectiveWs = rawWs ? resolve(dir, rawWs) : dir;
    if (rawTsconfig) {
      const absTs = resolve(effectiveWs, rawTsconfig);
      const tsDir = absTs.endsWith(".json") ? dirname(absTs) : absTs;
      return rawWs ? commonDirAncestor([effectiveWs, tsDir]) : tsDir;
    }
    return effectiveWs;
  }

  const nodeTestInv = parseNodeTestInvocation(cmdToks);
  if (nodeTestInv) {
    if (nodeTestInv.files.length > 0) {
      return commonDirAncestor(nodeTestInv.files.map((f) => resolvePathArgToDir(f, curDir)));
    }
    return curDir;
  }

  const pmInv = parsePkgManagerInvocation(cmdToks);
  if (pmInv) {
    const dir = resolvePkgManagerEffectiveDir(pmInv, curDir);
    if (!dir) return null;
    if (pmInv.manager === "bun" && pmInv.subcmd === "build" && !pmInv.bunScript) {
      return resolvePositionalTargetDir(pmInv.rest, dir, {
        valueFlags: BUN_BUILD_VALUE_FLAGS, onlyPathLike: true, requireSingleCheckout: true,
      });
    }
    if (pmInv.manager === "bun" && pmInv.subcmd === "test" && !pmInv.bunScript) {
      return resolvePositionalTargetDir(pmInv.rest, dir, {
        valueFlags: new Set(["--cwd", "-t", "--test-name-pattern", "--timeout", "--preload", "-r"]),
        onlyPathLike: true,
      });
    }
    return dir;
  }

  const tscArgs = extractTscArgs(cmdToks);
  if (tscArgs) {
    const stripTscOpt = (tok: string): string | null => {
      if (!tok.startsWith("-") || tok.startsWith("---")) return null;
      const name = (tok.startsWith("--") ? tok.slice(2) : tok.slice(1)).toLowerCase();
      return name || null;
    };
    const firstOpt = tscArgs[0] ? stripTscOpt(tscArgs[0]) : null;
    const isBuildMode = firstOpt === "b" || firstOpt === "build";
    const alwaysValueOpts = isBuildMode ? TSC_BUILD_ALWAYS_VALUE_OPTS : TSC_NORMAL_ALWAYS_VALUE_OPTS;
    const listValueOpts = isBuildMode ? TSC_BUILD_LIST_OPTS : TSC_NORMAL_LIST_OPTS;
    let projectPath: string | null = null;
    const buildProjects: string[] = [];
    const sourceFiles: string[] = [];
    for (let i = isBuildMode ? 1 : 0; i < tscArgs.length; i++) {
      const tok = tscArgs[i];
      const optName = stripTscOpt(tok);
      if (!optName) {
        if (isBuildMode) buildProjects.push(tok);
        else sourceFiles.push(tok);
        continue;
      }
      if (!isBuildMode && (optName === "p" || optName === "project")) {
        const val = tscArgs[++i];
        if (!val) return null;
        projectPath = val === "null" ? null : val;
        continue;
      }
      if (alwaysValueOpts.has(optName)) {
        i++;
        continue;
      }
      if (listValueOpts.has(optName)) {
        const next = tscArgs[i + 1];
        if (next !== undefined && (next === "null" || !next.trim().startsWith("-"))) i++;
        continue;
      }
      const next = tscArgs[i + 1];
      if (next === "true" || next === "false" || next === "null") i++;
    }
    if (!isBuildMode && projectPath) {
      const resolved = resolve(curDir, projectPath);
      return resolved.endsWith(".json") ? dirname(resolved) : resolved;
    }
    if (!isBuildMode && sourceFiles.length > 0) {
      return commonDirAncestor(sourceFiles.map((f) => resolvePathArgToDir(f, curDir)));
    }
    if (isBuildMode && buildProjects.length > 0) {
      const dirs = new Set(
        buildProjects.map((p) => {
          const resolved = resolve(curDir, p);
          return resolved.endsWith(".json") ? dirname(resolved) : resolved;
        }),
      );
      if (dirs.size > 1) return null;
      return Array.from(dirs)[0];
    }
    return curDir;
  }

  const pytestInv = isPytestInvocation(cmdToks);
  if (pytestInv) {
    return resolvePositionalTargetDir(cmdToks.slice(pytestInv.argsStart), curDir, {
      valueFlags: new Set([
        "-k",
        "-m",
        "-c",
        "-o",
        "-W",
        "-p",
        "-n",
        "--maxfail",
        "--tb",
        "--capture",
        "--junitxml",
        "--basetemp",
        "--confcutdir",
        "--ignore",
        "--ignore-glob",
        "--deselect",
        "--durations",
      ]),
      rootDirFlags: new Set(["--rootdir"]),
      stripPytestNodeId: true,
    });
  }

  if (bin0 === "mypy") {
    return resolvePositionalTargetDir(cmdToks.slice(1), curDir, {
      valueFlags: new Set([
        "-m",
        "--module",
        "-p",
        "--package",
        "-c",
        "--command",
        "--config-file",
        "--python-version",
        "--python-executable",
        "--platform",
        "--cache-dir",
        "--exclude",
        "--follow-imports",
        "--output",
      ]),
    });
  }

  if (bin0 === "pyright") {
    return resolvePositionalTargetDir(cmdToks.slice(1), curDir, {
      valueFlags: new Set([
        "--pythonpath",
        "--pythonplatform",
        "--pythonversion",
        "--typeshedpath",
        "--venvpath",
        "--level",
        "--threads",
      ]),
      projectFlags: new Set(["-p", "--project"]),
    });
  }

  if (bin0 === "ruff" && c1 === "check") {
    return resolvePositionalTargetDir(cmdToks.slice(2), curDir, {
      valueFlags: new Set([
        "--config",
        "--select",
        "--extend-select",
        "--ignore",
        "--exclude",
        "--output-format",
        "--target-version",
        "--cache-dir",
      ]),
    });
  }

  if (
    (bin0 === "biome" && c1 === "check") ||
    ((bin0 === "npx" || bin0 === "bunx") && c1 === "biome" && c2 === "check") ||
    (bin0 === "bunx" && c1 === "--bun" && c2 === "biome" && cmdToks[3] === "check")
  ) {
    const startIdx = bin0 === "biome" ? 2 : c1 === "--bun" ? 4 : 3;
    return resolvePositionalTargetDir(cmdToks.slice(startIdx), curDir, {
      valueFlags: new Set([
        "--config-path",
        "--diagnostic-level",
        "--max-diagnostics",
        "--reporter",
        "--since",
      ]),
    });
  }

  const eslintTargetArgs = extractEslintArgs(cmdToks);
  if (eslintTargetArgs) {
    return resolvePositionalTargetDir(eslintTargetArgs, curDir, {
      valueFlags: new Set([
        "-c",
        "--config",
        "--ext",
        "--format",
        "-f",
        "--ignore-path",
        "--ignore-pattern",
        "--max-warnings",
        "--rule",
        "--parser",
        "--cache-location",
      ]),
    });
  }

  if (bin0 === "golangci-lint" && c1 === "run") {
    return resolvePositionalTargetDir(cmdToks.slice(2), curDir, {
      valueFlags: new Set([
        "-c",
        "--config",
        "--timeout",
        "--out-format",
        "--build-tags",
        "--enable",
        "--disable",
        "--new-from-rev",
      ]),
    });
  }

  if (bin0 === "hurl") {
    return resolvePositionalTargetDir(cmdToks.slice(1), curDir, {
      valueFlags: new Set([
        "--variable",
        "--variables-file",
        "--file-root",
        "--connect-timeout",
        "--max-time",
        "--retry",
        "--retry-interval",
        "--report-html",
        "--report-json",
        "--report-junit",
        "--report-tap",
        "--output",
        "-o",
        "--cookie",
        "-b",
        "--cookie-jar",
        "-c",
        "--proxy",
        "-x",
        "--user",
        "-u",
        "--jobs",
      ]),
    });
  }

  return curDir;
}

const CODEX_GLOBAL_VALUE_OPTS = new Set([
  "-c",
  "--config",
  "--enable",
  "--disable",
  "-i",
  "--image",
  "-m",
  "--model",
  "--local-provider",
  "-p",
  "--profile",
  "-s",
  "--sandbox",
  "-C",
  "--cd",
  "--add-dir",
  "-a",
  "--ask-for-approval",
]);
const CODEX_GLOBAL_BOOL_OPTS = new Set([
  "--strict-config",
  "--oss",
  "--approve-for-me",
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "--search",
  "--no-alt-screen",
  "--no-daemon",
]);

function isValidCodexConfigOverride(val: string | undefined): boolean {
  if (!val) return false;
  const eq = val.indexOf("=");
  return eq > 0 && val.slice(0, eq).trim().length > 0;
}
const CODEX_SANDBOX_MODES = new Set([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
const CODEX_APPROVAL_POLICIES = new Set(["on-request", "never"]);
const CODEX_GLOBAL_REPEATABLE_OPTS = new Set([
  "-c",
  "--config",
  "--enable",
  "--disable",
  "--add-dir",
  "-i",
  "--image",
]);
const CODEX_GLOBAL_CANONICAL: Record<string, string> = {
  "-c": "--config",
  "-i": "--image",
  "-m": "--model",
  "-p": "--profile",
  "-s": "--sandbox",
  "-C": "--cd",
  "-a": "--ask-for-approval",
};
const CODEX_REVIEW_BOOL_OPTS = new Set([
  "--strict-config",
  "--trust",
  "--uncommitted",
]);
const CODEX_REVIEW_VALUE_OPTS = new Set([
  "-c",
  "--config",
  "--enable",
  "--disable",
  "--base",
  "--commit",
  "--title",
]);

/**
 * Parse a `codex [GLOBAL_OPTS] review [REVIEW_OPTS] [PROMPT]` invocation.
 * Returns `null` for non-`review` subcommands (e.g. `codex help review`, `codex exec "review"`),
 * help/version queries, invalid enum/conflicting/duplicate Clap flags, or unknown/ambiguous options.
 */
function parseCodexReviewCommand(
  cmdToks: string[],
  curDir: string,
): { targetDir: string; hasCommitFlag: boolean; commitVal: string | null } | null {
  if (cmdToks[0] !== "codex" && !cmdToks[0]?.endsWith("/codex")) return null;
  let targetDir = curDir;
  let reviewIdx = -1;
  const seenGlobalSingleOpts = new Set<string>();

  for (let i = 1; i < cmdToks.length; i++) {
    const tok = cmdToks[i];
    if (tok === "--") return null; // No subcommand before `--`
    if (tok === "-h" || tok === "--help" || tok === "-V" || tok === "--version") return null;
    if (tok.startsWith("-")) {
      const eqIdx = tok.indexOf("=");
      const rawFlag = eqIdx >= 0 ? tok.slice(0, eqIdx) : tok;
      if (CODEX_GLOBAL_BOOL_OPTS.has(rawFlag)) {
        if (eqIdx >= 0 || seenGlobalSingleOpts.has(rawFlag)) return null;
        seenGlobalSingleOpts.add(rawFlag);
        continue;
      }
      let flag: string | null = null;
      let val: string | undefined;
      let isSeparateVal = false;
      if (CODEX_GLOBAL_VALUE_OPTS.has(rawFlag)) {
        flag = rawFlag;
        if (eqIdx >= 0) {
          val = tok.slice(eqIdx + 1);
        } else {
          isSeparateVal = true;
          val = cmdToks[++i];
          if (val === undefined || val.startsWith("-")) return null;
        }
      } else if (
        tok.length > 2 &&
        !tok.startsWith("--") &&
        CODEX_GLOBAL_VALUE_OPTS.has(tok.slice(0, 2))
      ) {
        // Attached short flag e.g. `-C../dir`, `-mfoo`, `-sread-only`, `-anever`
        flag = tok.slice(0, 2);
        val = tok.slice(2);
      }
      if (flag) {
        const canon = CODEX_GLOBAL_CANONICAL[flag] ?? flag;
        if (!CODEX_GLOBAL_REPEATABLE_OPTS.has(flag)) {
          if (seenGlobalSingleOpts.has(canon)) return null;
          seenGlobalSingleOpts.add(canon);
        }
        if (canon === "--sandbox" && !CODEX_SANDBOX_MODES.has(val ?? "")) return null;
        if (canon === "--ask-for-approval" && !CODEX_APPROVAL_POLICIES.has(val ?? "")) return null;
        if (canon === "--config" && !isValidCodexConfigOverride(val)) return null;
        if ((canon === "--enable" || canon === "--disable") && !(val && val.trim().length > 0)) {
          return null;
        }
        if (canon === "--cd") {
          targetDir = resolve(targetDir, val ?? "");
        }
        // Variadic `-i` / `--image <FILE>...` greedily consumes following non-flag tokens (including `review`).
        if (canon === "--image" && isSeparateVal) {
          while (i + 1 < cmdToks.length && !cmdToks[i + 1].startsWith("-")) {
            i++;
          }
        }
        continue;
      }
      return null;
    }
    // First positional token is the subcommand — MUST be literally `review`!
    if (tok === "review") {
      reviewIdx = i;
      break;
    }
    return null;
  }

  if (reviewIdx < 0) return null;
  // Clap global mutual conflicts: `--approve-for-me` cannot be combined with bypass/sandbox/approval flags.
  if (
    seenGlobalSingleOpts.has("--approve-for-me") &&
    (seenGlobalSingleOpts.has("--dangerously-bypass-approvals-and-sandbox") ||
      seenGlobalSingleOpts.has("--sandbox") ||
      seenGlobalSingleOpts.has("--ask-for-approval"))
  ) {
    return null;
  }

  let hasUncommitted = false;
  let hasBase = false;
  let hasCommitFlag = false;
  let hasTitle = false;
  let commitVal: string | null = null;
  let promptCount = 0;
  let afterDoubleDash = false;
  const seenSingleOpts = new Set<string>();
  const repeatableReviewOpts = new Set(["-c", "--config", "--enable", "--disable"]);

  for (let i = reviewIdx + 1; i < cmdToks.length; i++) {
    const tok = cmdToks[i];
    if (!afterDoubleDash && tok === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && tok.startsWith("-") && tok !== "-") {
      const eqIdx = tok.indexOf("=");
      const flag = eqIdx >= 0 ? tok.slice(0, eqIdx) : tok;
      if (CODEX_REVIEW_BOOL_OPTS.has(flag)) {
        if (eqIdx >= 0 || seenSingleOpts.has(flag)) return null;
        seenSingleOpts.add(flag);
        if (flag === "--uncommitted") hasUncommitted = true;
        continue;
      }
      if (CODEX_REVIEW_VALUE_OPTS.has(flag)) {
        if (!repeatableReviewOpts.has(flag)) {
          if (seenSingleOpts.has(flag)) return null;
          seenSingleOpts.add(flag);
        }
        const val = eqIdx >= 0 ? tok.slice(eqIdx + 1) : cmdToks[++i];
        if (val === undefined || (eqIdx < 0 && val.startsWith("-"))) return null;
        if ((flag === "-c" || flag === "--config") && !isValidCodexConfigOverride(val)) return null;
        if ((flag === "--enable" || flag === "--disable") && val.trim().length === 0) return null;
        if (flag === "--base") hasBase = true;
        if (flag === "--title") hasTitle = true;
        if (flag === "--commit") {
          hasCommitFlag = true;
          commitVal = val;
        }
        continue;
      }
      // Attached `-c<key=value>` short option
      if (tok.startsWith("-c") && tok.length > 2) {
        if (!isValidCodexConfigOverride(tok.slice(2))) return null;
        continue;
      }
      // Reject `-h`, `--help`, `-hh`, `-V`, `--version`, and any unknown option (fail closed).
      return null;
    }
    promptCount++;
    if (promptCount > 1) return null;
  }

  // Clap mutual exclusivity: at most one of --uncommitted, --base, --commit, or [PROMPT].
  const targetModeCount = [hasUncommitted, hasBase, hasCommitFlag, promptCount > 0].filter(
    Boolean,
  ).length;
  if (targetModeCount > 1) {
    return null;
  }
  // Clap requires a target or [PROMPT] when --title is specified.
  if (hasTitle && targetModeCount === 0) {
    return null;
  }

  return { targetDir, hasCommitFlag, commitVal };
}

function extractCliFlagValue(toks: string[], flag: string): string | null {
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === flag && toks[i + 1]) return toks[i + 1];
    if (t.startsWith(`${flag}=`)) return t.slice(flag.length + 1);
  }
  return null;
}

const HURL_KNOWN_BOOL_FLAGS = new Set([
  "--test",
  "-v",
  "--verbose",
  "--very-verbose",
  "--color",
  "--no-color",
  "-k",
  "--insecure",
  "-L",
  "--location",
  "--location-trusted",
  "--continue-on-error",
  "--compressed",
  "--ignore-asserts",
  "--no-output",
  "--path-as-is",
  "--ipv4",
  "-4",
  "--ipv6",
  "-6",
  "--http1.0",
  "--http1.1",
  "--http2",
  "--http3",
  "--netrc",
  "-n",
  "--netrc-optional",
  "--ssl-no-revoke",
  "--interactive",
]);

function hasCliFlag(toks: string[], flag: string): boolean {
  return toks.some((t) => t === flag || t.startsWith(`${flag}=`));
}

function isValidHurlExecution(
  toks: string[],
  curDir: string,
  outputText: string,
): boolean {
  const hurlIdx = toks.findIndex((t) => t === "hurl" || t.endsWith("/hurl"));
  if (hurlIdx === -1) return false;
  if (hasInfoOnlyFlag(toks)) return false;

  // Reject runs where Hurl explicitly reports 0 executed files/entries/requests
  if (
    /(?:executed\s+(?:files|entries|requests)\s*:\s*0\b|succeeded\s+files\s*:\s*0\b|\b0\s+executed\b)/i.test(
      outputText,
    )
  ) {
    return false;
  }

  // Fail-closed flag value skipping: any flag NOT in HURL_KNOWN_BOOL_FLAGS (and without `=`)
  // consumes the following token as its option value, so `--file-root ./tests` or `--max-redirs 5`
  // is NEVER mistaken for a positional input file!
  let stopFlags = false;
  for (let i = hurlIdx + 1; i < toks.length; i++) {
    const a = toks[i];
    if (!stopFlags && a === "--") {
      stopFlags = true;
      continue;
    }
    if (!stopFlags && a.startsWith("-")) {
      if (!a.includes("=") && !HURL_KNOWN_BOOL_FLAGS.has(a)) {
        i++; // Skip option's value argument
      }
      continue;
    }
    const candidate = resolve(curDir, a);
    if (!existsSync(candidate)) continue;
    try {
      const st = statSync(candidate);
      if (st.isDirectory() || a.endsWith(".hurl")) {
        return true;
      }
    } catch {
      // Ignore unreadable path
    }
  }
  return false;
}

/**
 * POSIX/Bash `cd` target resolver (supports no-arg `$HOME`, `-L` logical default, `-P` physical,
 * `--`, and in-chain `cd -`). Returns `null` if `cd` would fail or target is indeterminate.
 */
function splitLeadingEnv(toks: ShellToken[]): { envToks: string[]; cmdToks: string[] } {
  let start = 0;
  while (start < toks.length && toks[start].isEnvAssign) {
    start++;
  }
  return {
    envToks: toks.slice(0, start).map((t) => t.value),
    cmdToks: toks.slice(start).map((t) => t.value),
  };
}

function resolveCdTarget(
  curDir: string,
  prevDir: string | null,
  toks: ShellToken[],
): string | null {
  const { envToks, cmdToks } = splitLeadingEnv(toks);
  if (cmdToks[0] !== "cd") return null;
  let effectiveHome = process.env.HOME;
  let effectiveCdpath = process.env.CDPATH;
  let explicitOldPwd: string | undefined;
  for (const raw of envToks) {
    if (raw.startsWith("HOME=")) effectiveHome = raw.slice("HOME=".length);
    else if (raw.startsWith("CDPATH=")) effectiveCdpath = raw.slice("CDPATH=".length);
    else if (raw.startsWith("OLDPWD=")) explicitOldPwd = raw.slice("OLDPWD=".length);
  }
  let physical = false;
  let idx = 1;
  while (idx < cmdToks.length) {
    const arg = cmdToks[idx];
    if (arg === "--") {
      idx++;
      break;
    }
    if (arg === "-" || !arg.startsWith("-")) break;
    // POSIX / macOS `/bin/bash` `cd` accepts ONLY `-L` and `-P` (can be bundled e.g. `-LP`).
    for (let j = 1; j < arg.length; j++) {
      const ch = arg[j];
      if (ch === "P") physical = true;
      else if (ch === "L") physical = false;
      else return null;
    }
    idx++;
  }
  const rest = cmdToks.slice(idx);
  if (rest.length > 1) return null;

  let target: string;
  if (rest.length === 0) {
    // Per Bash: unset HOME fails, whereas empty `HOME=""` acts as `cd ""` (no-op in curDir).
    if (effectiveHome === undefined) return null;
    target = effectiveHome;
  } else if (rest[0] === "-") {
    if (explicitOldPwd !== undefined) {
      // Per Bash: empty `OLDPWD=""` is still set, acting as `cd ""` (stays in curDir).
      target = explicitOldPwd;
    } else {
      if (!prevDir) return null;
      target = prevDir;
    }
  } else {
    target = rest[0];
    if (
      effectiveCdpath &&
      !target.startsWith("/") &&
      target !== "." &&
      target !== ".." &&
      !target.startsWith("./") &&
      !target.startsWith("../")
    ) {
      return null;
    }
  }

  if (physical) {
    // Per Bash 3.2: `cd -P ""` (including empty HOME= / OLDPWD=) calls chdir("") -> ENOENT!
    if (target === "") return null;
    const rawTarget = target.startsWith("/") ? target : `${curDir}/${target}`;
    try {
      if (!statSync(rawTarget).isDirectory()) return null;
      accessSync(rawTarget, fsConstants.X_OK);
      // Use OS native realpath(3) so symlinks are resolved BEFORE `..` (e.g. `/tmp/..` -> `/private`).
      return realpathSync.native(rawTarget);
    } catch {
      return null;
    }
  }

  // POSIX logical `cd -L` (Bash default): walk components, verifying current path is a directory BEFORE popping `..`.
  const parts = target.startsWith("/")
    ? []
    : curDir.split("/").filter((p) => p.length > 0);
  const currentLogicalPath = () => `/${parts.join("/")}`;

  for (const comp of target.split("/")) {
    if (comp === "" || comp === ".") continue;
    if (comp === "..") {
      const beforePop = currentLogicalPath();
      try {
        if (!statSync(beforePop).isDirectory()) return null;
      } catch {
        return null;
      }
      parts.pop();
    } else {
      parts.push(comp);
    }
  }

  const finalPath = currentLogicalPath();
  try {
    if (!statSync(finalPath).isDirectory()) return null;
    accessSync(finalPath, fsConstants.X_OK);
    return finalPath;
  } catch {
    return null;
  }
}

/**
 * Shell builtins / keywords that can terminate the shell early, flip exit codes,
 * change directories outside `cd`, or redefine commands/environment mid-chain.
 */
const SHELL_CONTROL_OR_STATE_BUILTINS = new Set([
  "!",
  "coproc",
  "exit",
  "exec",
  "return",
  "logout",
  "suspend",
  "kill",
  "eval",
  "source",
  ".",
  "alias",
  "unalias",
  "enable",
  "builtin",
  "command",
  "function",
  "trap",
  "set",
  "shopt",
  "export",
  "unset",
  "declare",
  "typeset",
  "local",
  "readonly",
  "hash",
  "pushd",
  "popd",
  "break",
  "continue",
]);

export function classifyPostToolEvidence(
  cmd: string,
  workdir: string,
  exitCode: number | null,
  outputText: string,
): CapturedEvidence[] {
  if (exitCode === null) return [];
  if (hasAmbiguousControlFlow(cmd)) return [];

  const results: CapturedEvidence[] = [];
  const segments = splitShellSegments(cmd);
  const passed = exitCode === 0;
  let curDir = workdir;
  let prevDir: string | null = null;

  const hasLeadingFailFastSet =
    segments.length > 0 && isFailFastSetSegment(segments[0]);

  // Reject any command containing shell control/state-mutating builtins (e.g. `exit 0 && make test`,
  // `exec true && make test`, `pushd ../other && make test`, `! make test`, `export MAKEFLAGS=-n && make test`),
  // function definitions, or bare shell variable assignments in a multi-segment chain.
  // Exception: a verified fail-fast `set -e` / `set -euo pipefail` header strictly at segment 0.
  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    if (segIdx === 0 && hasLeadingFailFastSet) continue;
    const seg = segments[segIdx];
    const meta = splitShellTokensWithMeta(seg);
    if (!meta || meta.length === 0) continue;
    const { envToks, cmdToks } = splitLeadingEnv(meta);
    if (cmdToks.length === 0) {
      if (envToks.length > 0 && segments.length > 1) return [];
      continue;
    }
    const head = cmdToks[0];
    if (SHELL_CONTROL_OR_STATE_BUILTINS.has(head)) {
      return [];
    }
  }

  const nonCdSegments = segments.filter((s, idx) => {
    if (idx === 0 && hasLeadingFailFastSet) return false;
    const t = splitShellTokensWithMeta(s);
    if (!t || t.length === 0) return false;
    return splitLeadingEnv(t).cmdToks[0] !== "cd";
  });

  // In a multi-segment chain that exits non-zero, only an optional leading fail-fast `set -e`
  // plus leading valid `cd` segments followed by a single final command unambiguously attribute
  // the failure to that final command.
  // Any other multi-segment failure (e.g. `false && make test`, `make test && cd /dev/null`,
  // `cd missing/.. && make test`) is ambiguous and MUST NOT record a false `fail`.
  if (!passed && segments.length > 1) {
    let probeDir = workdir;
    let probePrev: string | null = null;
    for (let i = 0; i < segments.length - 1; i++) {
      if (i === 0 && hasLeadingFailFastSet) continue;
      const t = splitShellTokensWithMeta(segments[i]);
      if (!t || splitLeadingEnv(t).cmdToks[0] !== "cd") {
        return [];
      }
      const nextDir = resolveCdTarget(probeDir, probePrev, t);
      if (!nextDir) {
        return [];
      }
      probePrev = probeDir;
      probeDir = nextDir;
    }
    const lastToks = splitShellTokensWithMeta(segments[segments.length - 1]);
    if (
      !lastToks ||
      lastToks.length === 0 ||
      splitLeadingEnv(lastToks).cmdToks[0] === "cd" ||
      (segments.length - 1 === 0 && hasLeadingFailFastSet)
    ) {
      return [];
    }
  }

  let sawVerification = false;
  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    if (segIdx === 0 && hasLeadingFailFastSet) continue;
    const seg = segments[segIdx];
    const metaToks = splitShellTokensWithMeta(seg);
    if (!metaToks || metaToks.length === 0) continue;
    const toks = metaToks.map((t) => t.value);
    // Shell pipeline negation (`! make test`) flips non-zero failures into exit 0 — reject entire command!
    if (toks[0] === "!" || toks[0] === "coproc") {
      return [];
    }
    if (splitLeadingEnv(metaToks).cmdToks[0] === "cd") {
      const nextDir = resolveCdTarget(curDir, prevDir, metaToks);
      if (!nextDir) return [];
      prevDir = curDir;
      curDir = nextDir;
      continue;
    }

    // 1. git commit
    const git = extractGitSubcommand(toks);
    if (git?.subcmd === "commit" && passed && !sawVerification) {
      const prefix = unwrapShellPrefix(toks);
      if (prefix.bin !== "git" || prefix.ambiguous || prefix.dirs.some((d) => /[$`]/.test(d))) continue;
      const baseDir = resolveGitDirFlags(curDir, prefix.dirs, true);
      if (!baseDir) continue;
      const targetDir = resolveGitDirFlags(baseDir, git.gitDirFlags, false) ?? baseDir;
      results.push({
        kind: "commit",
        status: "pass",
        summary: redactSecrets(seg).slice(0, 160),
        targetDir,
      });
      continue;
    }

    // 1b. gh pr create / gh pr new (standalone non-cd segment; unified pflag parser; verify PR URL & origin parity on pass!)
    const gh = extractGhPrSubcommand(toks);
    if (gh && (gh.subcmd === "create" || gh.subcmd === "new")) {
      if (gh.prefix.bin !== "gh" || gh.prefix.ambiguous || gh.prefix.dirs.some((dir) => /[$`]/.test(dir))) continue;
      const targetDir = resolveGitDirFlags(curDir, gh.prefix.dirs, true);
      if (!targetDir) continue;
      const parsedGh = parseGhPrCreateArgs(gh.subArgs);
      if (
        nonCdSegments.length > 1 ||
        parsedGh.parseError ||
        parsedGh.help ||
        parsedGh.dryRun ||
        parsedGh.web
      ) {
        continue;
      }
      // Per `gh pr create --help`:
      // - On exit 0, require an actual created PR URL in output (and verify its repo against origin).
      // - When `--attach` is used and some attachments fail to upload, `gh` STILL creates the PR,
      //   prints the new PR URL, and exits non-zero -> treat that as `pr/pass` (still verified via prUrlRepoSpec)!
      // Require a STANDALONE PR URL line so error messages mentioning a URL (e.g. `open https://.../pull/42: no such file`)
      // NEVER fabricate `pr/pass`!
      const urlMatch = outputText.match(
        /^[ \t]*https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/\d+[ \t\r]*$/im,
      );
      const prCreatedWithPartialAttachFail =
        !passed &&
        parsedGh.hasAttach &&
        Boolean(urlMatch) &&
        !/already exists/i.test(outputText);
      const prSucceeded = passed || prCreatedWithPartialAttachFail;

      let prUrlRepoSpec: string | null = null;
      if (prSucceeded) {
        if (!urlMatch) continue;
        prUrlRepoSpec = urlMatch[0].trim().replace(/\/pull\/\d+$/i, "");
      }

      const host = gh.prefix.effective("GH_HOST").toLowerCase();
      const spec = parsedGh.repo ?? (gh.prefix.effective("GH_REPO") || null);
      const targetRepoSpec = spec ? qualifyGhRepoSpec(spec, gh.prefix.effective, targetDir) : null;
      const prHead = parsedGh.head;
      let targetBranch: string | null = null;
      let targetOwner: string | null = null;
      if (prHead) {
        if (prHead.includes(":")) {
          const [owner, ...restParts] = prHead.split(":");
          targetOwner = owner || null;
          targetBranch = restParts.join(":").replace(/^refs\/heads\//, "") || null;
        } else {
          targetBranch = prHead.replace(/^refs\/heads\//, "");
        }
      }
      results.push({
        kind: "pr",
        status: prSucceeded ? "pass" : "fail",
        summary: prCreatedWithPartialAttachFail
          ? `${redactSecrets(seg).slice(0, 120)} (PR created; partial attachment failure)`
          : redactSecrets(seg).slice(0, 160),
        targetDir,
        targetBranch,
        targetOwner,
        targetRepoSpec,
        targetHost: targetRepoSpec ? null : host || null,
        prUrlRepoSpec,
      });
      continue;
    }

    // 2. review-agents CLI or codex review
    const { cmdToks: segCmdToks } = splitLeadingEnv(metaToks);
    const reviewCliMatch = segCmdToks[0]?.match(
      /(?:^|\/)(review-quality|review-performance|review-simplify|review-comments)$/,
    );
    const parsedCodexReview = !reviewCliMatch
      ? parseCodexReviewCommand(segCmdToks, curDir)
      : null;
    if (reviewCliMatch || parsedCodexReview) {
      // Never record status polling, help, version, or listing commands as review verdicts!
      if (
        reviewCliMatch &&
        segCmdToks.some(
          (t) =>
            t === "--status" ||
            t === "--help" ||
            t === "-h" ||
            t === "--version" ||
            t === "-V" ||
            t === "list",
        )
      ) {
        continue;
      }

      const role = normalizeReviewRole(reviewCliMatch ? reviewCliMatch[1] : "codex-review");
      const repoVal = reviewCliMatch ? extractCliFlagValue(segCmdToks, "--repo") : null;
      const outVal = reviewCliMatch ? extractCliFlagValue(segCmdToks, "--out") : null;
      const headVal = reviewCliMatch ? extractCliFlagValue(segCmdToks, "--head") : null;
      const commitVal = parsedCodexReview ? parsedCodexReview.commitVal : null;
      const targetDir = parsedCodexReview
        ? parsedCodexReview.targetDir
        : repoVal
          ? resolve(curDir, repoVal)
          : curDir;
      const outFilePath = outVal ? resolve(curDir, outVal) : undefined;
      const parsedJson = reviewCliMatch
        ? parseReviewJsonOutput(outputText, outFilePath)
        : null;

      if (reviewCliMatch) {
        // Ignore in-flight / polling JSON statuses completely
        if (
          parsedJson?.status === "running" ||
          parsedJson?.status === "in_progress" ||
          parsedJson?.status === "pending" ||
          parsedJson?.status === "queued"
        ) {
          continue;
        }
        // On exit 0, require terminal status === "completed" and passed !== false
        if (
          exitCode === 0 &&
          (parsedJson?.status !== "completed" || parsedJson?.passed === false)
        ) {
          continue;
        }
      } else if (parsedCodexReview) {
        // Require standalone codex review (no other non-cd commands chained) so HEAD cannot drift mid-command,
        // and ignore pre-execution CLI parse / flag / config / provider rejections where review never started.
        // Anchor checks to the start of output (after any startup WARNING lines) so embedded markers inside
        // diagnostic values (e.g. a multiline provider name containing `OpenAI Codex v1` or `session id: ...`)
        // cannot masquerade as a started session, while any started-session failure still records `review/fail`.
        const trimmedBody = outputText
          .replace(/^(?:\s*WARNING:[^\r\n]*(?:\r?\n|$))+/i, "")
          .trim();
        const isClapParseError =
          exitCode === 2 &&
          (/^error:\s+[\s\S]*For more information, try '--help'\.?$/i.test(trimmedBody) ||
            /^(?:error:\s+[\s\S]*?)?\bUsage:\s+codex\b/i.test(trimmedBody));
        const isPreExecutionCliRejection =
          exitCode === 1 &&
          (/^Error loading config\.toml:/.test(trimmedBody) ||
            /^Error parsing -c overrides:/.test(trimmedBody) ||
            /^Error:\s+Unknown feature flag:/.test(trimmedBody) ||
            /^Error:\s+Model provider\s+`[\s\S]*`\s+not found$/.test(trimmedBody) ||
            /^Error:\s+No default OSS provider configured\b/.test(trimmedBody) ||
            /^Error:\s+OSS setup failed:/.test(trimmedBody) ||
            /^Error:\s+(?:Configuration )?profile\s+`[\s\S]*`\s+not found$/i.test(trimmedBody) ||
            /^Error:\s+`--[\s\S]*?`\s+(?:is only supported for interactive TUI commands|supports new interactive sessions)/i.test(
              trimmedBody,
            ) ||
            /^No prompt provided via stdin\./.test(trimmedBody) ||
            /^Not inside a trusted directory and --skip-git-repo-check was not specified\./.test(
              trimmedBody,
            ));
        if (nonCdSegments.length > 1 || isClapParseError || isPreExecutionCliRejection) {
          continue;
        }
      }

      // Strict 3-condition machine check for credit_balance_exhausted!
      const creditExhausted =
        exitCode === 2 &&
        parsedJson?.status === "error" &&
        parsedJson?.errorCode === "credit_balance_exhausted";

      // Resolve pinned SHA / ref:
      // - For review-agents CLI: prefer parsedJson.head or explicit `--head <ref>` (requirePinnedSha = true).
      // - For `codex review --commit ...` (even empty `--commit=`!): ALWAYS set requirePinnedSha = true
      //   so an older or malformed `--commit` review NEVER falls back to live HEAD!
      const hasCommitFlag = parsedCodexReview ? parsedCodexReview.hasCommitFlag : false;
      const hasHeadFlag = reviewCliMatch ? hasCliFlag(segCmdToks, "--head") : false;
      const explicitHeadSha =
        headVal && /^[0-9a-f]{7,40}$/i.test(headVal) ? headVal : null;
      const pinnedSha = parsedJson?.head ?? explicitHeadSha;
      const pinnedRef = !pinnedSha ? (commitVal || headVal || null) : null;
      const requirePinnedSha = Boolean(reviewCliMatch) || hasCommitFlag || hasHeadFlag;

      const status: "pass" | "fail" = exitCode === 0 ? "pass" : "fail";
      results.push({
        kind: "review",
        status,
        summary: `${role} exited ${exitCode}${creditExhausted ? " (credit_balance_exhausted)" : ""}`,
        targetDir,
        pinnedSha,
        pinnedRef,
        requirePinnedSha,
        meta: {
          role,
          exit_code: exitCode,
          report_status: parsedJson?.status ?? null,
          error_code: parsedJson?.errorCode ?? null,
          credit_balance_exhausted: creditExhausted,
          base: parsedJson?.base ?? null,
          head: pinnedSha,
        },
      });
      continue;
    }

    // 3. Direct build / test / lint / hurl / lang-check execution (token-based; strips unquoted redirections so `> /dev/null` is never treated as a test path!)
    const strippedMetaToks = splitShellTokensWithMeta(stripUnquotedShellRedirections(seg)) ?? metaToks;
    const verifyHit = classifyVerifyCommand(strippedMetaToks);
    if (verifyHit) {
      sawVerification = true;
      // Suppress attribution if ANY later segment in the same shell invocation can mutate git checkout/HEAD
      // (e.g. `set -e\nnpm test\ngit switch other` or `npm test && git commit`), so the post-tool live SHA
      // never falsely credits an untested branch/commit!
      if (!safeTrailingSegments(segments.slice(segIdx + 1), curDir, 0, [], prevDir)) {
        continue;
      }
      const targetDir = resolveVerifyTargetDir(verifyHit.cmdToks, verifyHit.envToks, curDir);
      if (!targetDir) {
        continue;
      }
      // Never record `--help` / `--version` / `help` / dry-run / collect-only commands as passing verification!
      // Note: `tsc` handles its own `--help`/`--version` boolean values (e.g. `--help false` still typechecks).
      const isTscCmd = extractTscArgs(verifyHit.cmdToks) !== null;
      if (
        (!isTscCmd && hasInfoOnlyFlag(verifyHit.cmdToks)) ||
        hasNonExecutingVerifyFlag(verifyHit.cmdToks, verifyHit.envToks, targetDir, outputText, passed)
      ) {
        continue;
      }
      if (
        verifyHit.kind === "hurl" &&
        !isValidHurlExecution(verifyHit.cmdToks, curDir, outputText)
      ) {
        continue;
      }
      if (verifyHit.kind === "lang-check") {
        // Exit 2 means no applicable checks executed (fail-closed) -> never record pass/fail!
        if (exitCode === 2) continue;
        const parsedLc = parseLangCheckInvocation(verifyHit.cmdToks);
        if (!parsedLc) continue;
        // For `--mode all`, check JSON/text report if present to record per-phase outcomes accurately
        let phases: Array<{ kind: "lint" | "test"; status: "pass" | "fail" }> = [];
        if (parsedLc.mode === "static") {
          phases = [{ kind: "lint", status: passed ? "pass" : "fail" }];
        } else if (parsedLc.mode === "dynamic") {
          phases = [{ kind: "test", status: passed ? "pass" : "fail" }];
        } else {
          // mode === "all": requires standalone invocation (`nonCdSegments.length === 1`) so combined
          // output from chained `lang-check repoA && lang-check repoB` can never cross-credit phases!
          if (nonCdSegments.length > 1) continue;
          phases = parseLangCheckPhases(outputText, passed);
        }
        for (const ph of phases) {
          results.push({
            kind: ph.kind,
            status: ph.status,
            summary: `${redactSecrets(seg).slice(0, 140)} (exit=${exitCode})`,
            targetDir,
            meta: { exit_code: exitCode, mode: parsedLc.mode },
          });
        }
        continue;
      }
      results.push({
        kind: verifyHit.kind,
        status: passed ? "pass" : "fail",
        summary: `${redactSecrets(seg).slice(0, 140)} (exit=${exitCode})`,
        targetDir,
        meta: { exit_code: exitCode },
      });
    }
  }

  return results;
}

function formatRunbookScopeSummary(actions: RunbookActions): string {
  const parts: string[] = [];
  for (const t of actions.tags ?? []) {
    parts.push(`tag(${t.repo}:${t.tag}@${t.sha.slice(0, 8)})`);
  }
  for (const p of actions.prs ?? []) {
    parts.push(`pr(${p.repo}#${p.number})`);
  }
  for (const s of actions.sql_files ?? []) {
    parts.push(`sql(${s.host}:${s.path.split("/").pop()})`);
  }
  for (const k of actions.kubectl_commands ?? []) {
    parts.push(`kubectl(${k})`);
  }
  return parts.join(", ");
}

function handleUserPromptRunbookDirectives(
  workbenchRoot: string,
  input: CodexHookInput,
): string | undefined {
  // Only root-session human prompts may approve/revoke runbooks; ignore subagents.
  if (input.agent_id || input.agent_type) return undefined;
  const prompt = (input.prompt ?? "").trim();
  const sessionId = (input.session_id ?? "").trim();
  if (!prompt || !sessionId) return undefined;

  const revokeIds = new Set<string>();
  const revokeRe =
    /(?:撤销|取消|作废|撤回|revoke|cancel)\s*(?:发版|执行|runbook|release)?\s*[:：]?\s*(rb-[a-z0-9-]{4,32})\b/gi;
  for (const m of prompt.matchAll(revokeRe)) {
    if (m[1]) revokeIds.add(m[1].toLowerCase());
  }

  const approveIds = new Set<string>();
  const approveRe =
    /(?:批准(?:发版|执行|runbook)?|确认(?:发版|执行|runbook)|同意(?:发版|执行|runbook)|approve(?:\s+runbook|\s+release)?)\s*[:：]?\s*(rb-[a-z0-9-]{4,32})\b/gi;
  const negPrefixRe = /(?:不要|暂不|不|别|未|don't|do\s+not|not|never)\s*$/i;
  for (const m of prompt.matchAll(approveRe)) {
    const id = m[1]?.toLowerCase();
    if (!id || revokeIds.has(id)) continue;
    const before = prompt.slice(Math.max(0, (m.index ?? 0) - 16), m.index ?? 0);
    if (negPrefixRe.test(before)) continue;
    approveIds.add(id);
  }

  if (revokeIds.size === 0 && approveIds.size === 0) return undefined;

  const ledger = new Ledger(workbenchRoot);
  const notes: string[] = [];
  try {
    for (const id of revokeIds) {
      try {
        ledger.revokeRunbook(id);
        notes.push(`[Forge Runbook] 已撤销发版单 ${id}，相关放行立即失效。`);
      } catch (err) {
        notes.push(
          `[Forge Runbook] 撤销 ${id} 失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    for (const id of approveIds) {
      try {
        const { record, actions } = ledger.approveRunbookFromUserPrompt({
          runbook_id: id,
          session_id: sessionId,
        });
        notes.push(
          `[Forge Runbook] 用户已在主会话批准发版单 ${record.runbook_id}（有效至 ${record.expires_at}，绑定当前 session）。` +
            `底层 guard 将自动放行已登记项：${formatRunbookScopeSummary(actions)}。` +
            `请按 Runbook 自动推进执行，完成后运行 \`.workbench/bin/ledger runbook complete ${record.runbook_id}\`。`,
        );
      } catch (err) {
        notes.push(
          `[Forge Runbook] 批准 ${id} 未生效：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } finally {
    ledger.closeDb();
  }
  return notes.length > 0 ? notes.join("\n") : undefined;
}

export function handleLedgerHook(
  workbenchRoot: string,
  input: CodexHookInput,
): {
  sessionContext?: string;
  compactMessage?: string;
  userPromptContext?: string;
  recorded: number;
} {
  const evName = input.hook_event_name ?? "";
  if (evName === "UserPromptSubmit") {
    const userPromptContext = handleUserPromptRunbookDirectives(workbenchRoot, input);
    return { userPromptContext, recorded: 0 };
  }

  const cfg = loadWorkbenchConfig(workbenchRoot);
  if (!cfg.ledger.enabled) return { recorded: 0 };

  // FAST PATH for PostToolUse: do NOT open SQLite for non-shell or non-dev commands!
  if (evName === "PostToolUse") {
    const cmd = extractShellCommand(input);
    if (!cmd) return { recorded: 0 };
    const registeredRepos = new Set(cfg.repos);
    if (registeredRepos.size === 0) return { recorded: 0 };

    const exitCode = extractResponseExitCode(input.tool_response);
    const outputText = extractResponseText(input.tool_response);
    const workdir = extractToolWorkdir(input);
    const items = classifyPostToolEvidence(cmd, workdir, exitCode, outputText);
    if (items.length === 0) return { recorded: 0 };

    const ledger = new Ledger(workbenchRoot);
    try {
      let recorded = 0;
      for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        const loc = locateRepo(workbenchRoot, item.targetDir);
        if (!loc || !registeredRepos.has(loc.repo)) continue;

        // Verify explicit `-R` / `--repo` AND created PR URL repo match current repo's origin (host/owner/repo)
        if (item.targetRepoSpec || item.prUrlRepoSpec || item.targetHost) {
          const originUrl = runGit(loc.checkoutDir, ["remote", "get-url", "origin"], 3000).stdout.trim();
          const originId = parseGitRemoteRepo(originUrl);
          if (item.targetHost && item.targetHost !== originId?.host) continue;
          if (item.targetRepoSpec) {
            const targetId = parseGhRepoSpec(item.targetRepoSpec);
            if (
              !originId ||
              !targetId ||
              originId.host !== targetId.host ||
              originId.owner !== targetId.owner ||
              originId.repo !== targetId.repo
            ) {
              continue;
            }
          }
          if (item.prUrlRepoSpec) {
            const urlId = parseGhRepoSpec(item.prUrlRepoSpec);
            if (
              !originId ||
              !urlId ||
              originId.host !== urlId.host ||
              originId.owner !== urlId.owner ||
              originId.repo !== urlId.repo
            ) {
              continue;
            }
          }
        }

        // Resolve explicit target branch (e.g. `gh pr create --head feat/other`) instead of current checkout
        let effectiveBranch = loc.branch;
        let effectiveDetached = loc.isDetached;
        let resolvedPinnedSha = item.pinnedSha ?? null;
        if (!resolvedPinnedSha && item.pinnedRef) {
          const refRes = runGit(
            loc.checkoutDir,
            ["rev-parse", "--verify", `${item.pinnedRef}^{commit}`],
            3000,
          );
          if (refRes.code === 0 && refRes.stdout.trim()) {
            resolvedPinnedSha = refRes.stdout.trim();
          }
        }
        let effectiveSha = resolvedPinnedSha ?? loc.headSha;
        if (item.targetBranch) {
          if (item.targetOwner) {
            const originUrl = runGit(loc.checkoutDir, ["remote", "get-url", "origin"], 3000).stdout.trim();
            const originId = parseGitRemoteRepo(originUrl);
            if (!originId || originId.owner !== item.targetOwner.toLowerCase()) {
              // Cross-fork owner mismatch -> do not misattribute to local repo branch
              continue;
            }
          }
          const rev = runGit(
            loc.checkoutDir,
            ["rev-parse", "--verify", `refs/heads/${item.targetBranch}`],
            3000,
          );
          if (rev.code !== 0 || !rev.stdout.trim()) continue;
          const localBranchSha = rev.stdout.trim();
          // If origin/<branch> exists locally and has diverged from local branch, do not record PR pass on stale SHA
          const remoteRev = runGit(
            loc.checkoutDir,
            ["rev-parse", "--verify", `refs/remotes/origin/${item.targetBranch}`],
            3000,
          );
          if (remoteRev.code === 0 && remoteRev.stdout.trim() && remoteRev.stdout.trim() !== localBranchSha) {
            continue;
          }
          effectiveBranch = item.targetBranch;
          effectiveDetached = false;
          effectiveSha = localBranchSha;
        } else if (item.kind === "pr" && !effectiveDetached && effectiveSha) {
          const remoteRev = runGit(
            loc.checkoutDir,
            ["rev-parse", "--verify", `refs/remotes/origin/${effectiveBranch}`],
            3000,
          );
          if (remoteRev.code === 0 && remoteRev.stdout.trim() && remoteRev.stdout.trim() !== effectiveSha) {
            continue;
          }
        }

        // If committing on an exempted branch, bind resulting HEAD SHA to the exemption!
        if (item.kind === "commit" && !effectiveDetached && effectiveSha) {
          const ex = ledger.findActiveExemption(loc.repo, effectiveBranch);
          if (ex && !ex.head_sha) {
            ledger.bindExemptionHeadSha(ex.id, effectiveSha);
          }
        }

        const openTasks = effectiveDetached
          ? ledger.findOpenTasksByRepoCommits(loc.repo, getHeadAndParents(loc.checkoutDir))
          : ledger.findOpenTasksByRepoBranch(loc.repo, effectiveBranch);
        if (openTasks.length !== 1) continue;

        if (item.requirePinnedSha && !resolvedPinnedSha) {
          // Do not guess live checkout HEAD when pinned SHA/ref is required!
          continue;
        }
        const targetSha = effectiveSha;
        const toolUseKey = input.tool_use_id
          ? `${input.tool_use_id}:${idx}`
          : null;

        ledger.recordEvidence({
          task_id: openTasks[0].task_id,
          kind: item.kind,
          status: item.status,
          summary: item.summary,
          repo: loc.repo,
          branch: effectiveDetached ? null : effectiveBranch,
          sha: targetSha,
          meta:
            item.meta && resolvedPinnedSha
              ? { ...item.meta, head: resolvedPinnedSha }
              : item.meta,
          actor: "hook",
          session_id: input.session_id ?? null,
          tool_use_id: toolUseKey,
        });
        recorded++;
      }
      return { recorded };
    } finally {
      ledger.closeDb();
    }
  }

  if (evName === "SessionStart" || evName === "PostCompact") {
    const ledger = new Ledger(workbenchRoot);
    try {
      const summary = ledger.formatCompactContext(8);
      if (evName === "SessionStart") {
        return { sessionContext: summary || undefined, recorded: 0 };
      }
      return { compactMessage: summary || undefined, recorded: 0 };
    } finally {
      ledger.closeDb();
    }
  }

  return { recorded: 0 };
}

function logHookError(root: string, err: unknown): void {
  try {
    const logPath = join(root, ".workbench", "ledger", "hook-errors.log");
    mkdirSync(dirname(logPath), { recursive: true });
    const msg = redactSecrets(err instanceof Error ? err.message : String(err));
    appendFileSync(logPath, `${new Date().toISOString()} [ledger-hook] ${msg}\n`);
  } catch {
    // Ignore log failure
  }
}

export async function runLedgerHookCli(): Promise<void> {
  const parsed = await readHookStdinStrict();
  if (!parsed.ok || !parsed.input) return;

  const root = findWorkbenchRoot(parsed.input.cwd);
  try {
    const res = handleLedgerHook(root, parsed.input);
    if (res.sessionContext) emitSessionStartContext(res.sessionContext);
    if (res.compactMessage) emitPostCompactMessage(res.compactMessage);
    if (res.userPromptContext) emitUserPromptSubmitContext(res.userPromptContext);
  } catch (err) {
    // Telemetry hook never blocks user session, but records sanitized diagnostics!
    logHookError(root, err);
  }
}
