import { existsSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { interpreterScript } from "../shared/action-program";

export const RUNTIME_PRIMITIVES = ["status", "changes", "logs", "query", "metrics"] as const;
export type RuntimePrimitive = typeof RUNTIME_PRIMITIVES[number];

const guarantees = ["ro-credential", "ro-rbac", "ro-endpoint", "fixed-ro-subcommand", "unverified"] as const;
export type ReadOnlyGuarantee = typeof guarantees[number];

export const RUNTIME_DEFAULTS = { timeout_ms: 15_000, max_bytes: 32_768, max_lines: 200 };
const maximum = { timeout_ms: 60_000, max_bytes: 131_072, max_lines: 1_000 };
const limits = ["timeout_ms", "max_bytes", "max_lines"] as const;
const fields = ["action", "read_only_guarantee", ...limits];

export interface RuntimeBinding {
  action: string;
  argv: string[];
  cwd: string;
  read_only_guarantee: ReadOnlyGuarantee;
  timeout_ms: number;
  max_bytes: number;
  max_lines: number;
}

export class RuntimeConfigError extends Error {}

function mapping(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RuntimeConfigError(`${field} must be a mapping`);
  return value as Record<string, unknown>;
}

function runtimeEntrypoint(entry: string, cwd: string) {
  const path = resolve(cwd, entry);
  const isForge = (name: string) => {
    if (basename(name) === "forge") return true;
    const entry = /\/(?:src\/bin\/cli\.ts|dist\/cli\.js|\.workbench\/bin\/cli\.js)$/.exec(name);
    if (!entry) return false;
    if (name === Bun.main) return true;
    const root = name.slice(0, entry.index);
    return entry[0] === "/.workbench/bin/cli.js"
      ? existsSync(join(root, ".workbench/kit-lock.json"))
      : existsSync(join(root, "kit.toml")) && existsSync(join(root, "bin/forge"));
  };
  if (isForge(path)) return true;
  try {
    const executable = entry.includes("/") ? path : Bun.which(entry, { cwd }) ?? path;
    return isForge(realpathSync(executable));
  } catch { return false; }
}

function recursivelyInvokesRuntime({ argv, cwd }: Pick<RuntimeBinding, "argv" | "cwd">) {
  let command = basename(argv[0]) === "env" ? argv.slice(1) : argv;
  if (command.length < 2) return false;
  if (command[1] === "rt" && runtimeEntrypoint(command[0], cwd)) return true;
  if (basename(command[0]) === "bun") {
    let entry = command[1] === "--bun" ? 2 : 1;
    if (command[entry] === "run") entry++;
    if (command[entry] === "--") command = [...command.slice(0, entry), ...command.slice(entry + 1)];
  }
  const script = interpreterScript(command);
  return script !== undefined && command[command.indexOf(script, 1) + 1] === "rt" && runtimeEntrypoint(script, cwd);
}

export function decodeRuntime(
  value: unknown,
  resolveAction: (id: string, field: string) => Pick<RuntimeBinding, "argv" | "cwd">,
) {
  const runtime = new Map<RuntimePrimitive, RuntimeBinding>();
  if (value === undefined) return runtime;
  const section = mapping(value, "extensions.runtime");
  if (Object.keys(section).some(key => !RUNTIME_PRIMITIVES.some(name => name === key)))
    throw new RuntimeConfigError(`Unknown primitive in extensions.runtime. Use ${RUNTIME_PRIMITIVES.join(", ")}`);

  for (const primitive of RUNTIME_PRIMITIVES) {
    if (!Object.hasOwn(section, primitive)) continue;
    const path = `extensions.runtime.${primitive}`;
    const binding = mapping(section[primitive], path);
    if (Object.keys(binding).some(key => !fields.includes(key)))
      throw new RuntimeConfigError(`Unknown field in ${path}. Use ${fields.join(", ")}`);
    if (typeof binding.action !== "string" || !/^[a-zA-Z0-9][\w-]*$/.test(binding.action))
      throw new RuntimeConfigError(`${path}.action must name a registered extensions.actions entry`);
    const guarantee = binding.read_only_guarantee === undefined ? "unverified" : binding.read_only_guarantee;
    if (!guarantees.some(name => name === guarantee))
      throw new RuntimeConfigError(`${path}.read_only_guarantee must be one of ${guarantees.join(", ")}`);
    const budget = { ...RUNTIME_DEFAULTS };
    for (const key of limits) {
      const limit = binding[key];
      if (limit === undefined) continue;
      if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > maximum[key])
        throw new RuntimeConfigError(`${path}.${key} must be a positive integer up to ${maximum[key]}`);
      budget[key] = limit;
    }
    const adapter = resolveAction(binding.action, `${path}.action`);
    if (recursivelyInvokesRuntime(adapter))
      throw new RuntimeConfigError(`${path}.action recursively invokes forge rt. Configure the underlying read-only program`);
    runtime.set(primitive, {
      action: binding.action, ...adapter, read_only_guarantee: guarantee as ReadOnlyGuarantee, ...budget,
    });
  }
  return runtime;
}

export function runtimeList(runtime: Map<RuntimePrimitive, RuntimeBinding>) {
  return RUNTIME_PRIMITIVES.map(primitive => {
    const binding = runtime.get(primitive);
    const { timeout_ms, max_bytes, max_lines } = binding ?? RUNTIME_DEFAULTS;
    return {
      primitive,
      status: primitive === "changes" ? "builtin" : binding ? "configured" : "unconfigured",
      action: binding?.action ?? null,
      read_only_guarantee: binding?.read_only_guarantee ?? (primitive === "changes" ? "fixed-ro-subcommand" : null),
      timeout_ms, max_bytes, max_lines,
    };
  });
}

export function runtimeWarnings(runtime: Map<RuntimePrimitive, RuntimeBinding>) {
  return [...runtime].filter(([, binding]) => binding.read_only_guarantee === "unverified").map(([primitive]) =>
    `extensions.runtime.${primitive}.read_only_guarantee is unverified. The operator and adapter are responsible for write risk`,
  );
}
