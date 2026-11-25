import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// npm environment settings take precedence over project, user and global npmrc files.
export const npmExecutionOptions = {
  npm_config_usage: "false",
  npm_config_version: "false",
  npm_config_versions: "false",
  npm_config_dry_run: "false",
};

export function hasNonExecutingNpmFlags(managerFlags: string[] = []): boolean {
  const active = new Set<string>();
  for (const [key, value] of Object.entries(process.env)) {
    const name = /^npm_config_(dry_run|usage|versions?)$/i.exec(key)?.[1];
    if (name && value && !/^(false|0)$/i.test(value)) active.add(name.toLowerCase().replace("_", "-"));
  }

  const booleans = ["usage", "version", "versions", "dry-run", "if-present", "global", "workspaces"];
  for (const arg of managerFlags) {
    const eq = arg.indexOf("=");
    const flag = eq < 0 ? arg : arg.slice(0, eq);
    const enabled = eq < 0 || arg.slice(eq + 1) !== "false";
    const negated = flag.startsWith("--no-");
    let key = flag.replace(/^--(?:no-)?/, "");
    if (flag === "-v") key = "version";
    else if (flag === "-g") key = "global";
    else if (["--help", "--hel", "-H", "-h", "-?"].includes(flag)) key = "usage";
    else if (!flag.startsWith("--")) {
      if (/^-[^-]*[hvV?H]/.test(flag)) return true;
      continue;
    }
    if (["workspace", "prefix", "script-shell"].some(name => name.startsWith(key)) && !booleans.includes(key)) return true;
    const name = booleans.includes(key) ? key : booleans.find(name => name.startsWith(key));
    if (!name) continue;
    if (negated ? !enabled : enabled) active.add(name);
    else active.delete(name);
  }
  return active.size > 0;
}

export interface ParsedPkgManager {
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

export function resolvePkgManagerEffectiveDir(pm: ParsedPkgManager, curDir: string): string | null {
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

export function parsePkgManagerInvocation(cmdToks: string[]): ParsedPkgManager | null {
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

export const BUN_BUILD_VALUE_FLAGS = new Set([
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
