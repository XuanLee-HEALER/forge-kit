const TSC_WATCH_ALWAYS_VALUE_OPTS = [
  "fallbackpolling",
  "watchdirectory",
  "watchfile",
];

const TSC_WATCH_LIST_OPTS = [
  "excludedirectories",
  "excludefiles",
];

export const TSC_BUILD_ALWAYS_VALUE_OPTS = new Set([
  "generatecpuprofile",
  "generatetrace",
  "locale",
  ...TSC_WATCH_ALWAYS_VALUE_OPTS,
]);

export const TSC_BUILD_LIST_OPTS = new Set(TSC_WATCH_LIST_OPTS);

export const TSC_NORMAL_ALWAYS_VALUE_OPTS = new Set([
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

export const TSC_NORMAL_LIST_OPTS = new Set([
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

export function hasNonExecutingTscFlags(tscArgs: string[]): boolean {
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

export function tscTargets(tscArgs: string[]) {
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
  return {isBuildMode, projectPath, sourceFiles, buildProjects};
}

// A package manager adds its local binaries to PATH before executing scripts. Observe the
// compiler process itself so nested scripts and changes of directory use the actual argv and cwd.
export const tscProjectPreload = String.raw`
const fs = require("node:fs");
const path = require("node:path");

function checkTypeScriptProject() {
  const entry = process.argv[1];
  if (!entry || !/^(?:_?tsc)(?:\.js)?$/.test(path.basename(entry))) return;
  const compiler = fs.realpathSync(entry);
  const packageDir = path.dirname(path.dirname(compiler));
  const manifest = path.join(packageDir, "package.json");
  if (!fs.existsSync(manifest) || JSON.parse(fs.readFileSync(manifest, "utf8")).name !== "typescript") return;

  const ts = require(packageDir);
  const args = process.argv.slice(2);
  const build = /^--?(?:b|build)$/i.test(args[0] || "");
  const parsed = build ? ts.parseBuildCommand(args.slice(1)) : ts.parseCommandLine(args);
  const options = build ? parsed.buildOptions : parsed.options;
  if (["help", "version", "showConfig", "listFilesOnly", "init", "all", "noCheck", "clean", "dry"].some(key => options[key])) {
    throw Error("TypeScript is not executing a verification");
  }
  let targets = build ? parsed.projects : options.project ? [options.project] : parsed.fileNames;
  if (!targets.length) {
    const config = ts.findConfigFile(process.cwd(), ts.sys.fileExists);
    if (!config) throw Error("TypeScript has no local project");
    targets = [config];
  }
  const root = process.env.FORGE_VERIFY_CHECKOUT;
  for (const target of targets) {
    const selected = fs.statSync(target).isDirectory() ? path.join(target, "tsconfig.json") : target;
    if (!fs.realpathSync.native(selected).startsWith(root + path.sep)) {
      throw Error("TypeScript project is outside the verified checkout");
    }
  }
}
checkTypeScriptProject();
`;
