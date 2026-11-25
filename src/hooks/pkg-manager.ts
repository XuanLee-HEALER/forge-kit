import { type ScriptKind, type VerificationHit } from "./types";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { ParsedPkgManager } from "../shared/pkg-manager";
export { type ParsedPkgManager, BUN_BUILD_VALUE_FLAGS, parsePkgManagerInvocation, resolvePkgManagerEffectiveDir } from "../shared/pkg-manager";

export function isScriptNameKind(script: string, kind: "test" | "lint" | "build"): boolean {
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

export function findNearestPackageDir(startDir: string, npm: boolean): string | null {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir || (npm ? existsSync(join(dir, "node_modules")) : existsSync(join(dir, ".git")))) return null;
    dir = parent;
  }
}

export function getScriptKind(name: string): ScriptKind | undefined {
  return (["test", "lint", "build"] as const).find(kind => isScriptNameKind(name, kind));
}

export function delegatesToScript(pm: ParsedPkgManager | null, hit: VerificationHit | null): boolean {
  if (!pm) return false;
  if (pm.bunScript || pm.subcmd === "run" || (pm.manager === "npm" && pm.subcmd === "test")) return true;
  return (pm.manager === "pnpm" || pm.manager === "yarn") && (!hit || !!getScriptKind(pm.scriptName));
}

export function parseBoolVal(value: string): boolean {
  return !["false", "0", ""].includes(value.toLowerCase());
}

export function npmCliBoolean(arg: string, key: string): boolean | undefined {
  const eq = arg.indexOf("=");
  const name = eq < 0 ? arg : arg.slice(0, eq);
  const value = eq < 0 || arg.slice(eq + 1) !== "false";
  if (name === "--" + key) return value;
  if (name === "--no-" + key) return !value;
  return undefined;
}

export function ignoresLifecycleScripts(pm: ParsedPkgManager, envToks: string[]): boolean {
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

// Options that consume a separate argument. Bare --sourcemap and --metafile
// leave the following token as an entry point on Bun 1.4.4.
