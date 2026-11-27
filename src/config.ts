import { efforts, type Model } from "../review-agents/src/models";
import { roles, type Role } from "../review-agents/src/roles";
import { parse as parseStrictYaml } from "yaml";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export interface ProdDbTarget {
  name: string;
  engine?: "postgres" | "mysql" | "clickhouse" | string;
  host: string;
}

export interface LedgerConfig {
  enabled: boolean;
  retention_days: number;
  exempt_max_files: number;
  exempt_max_lines: number;
  exempt_allowed_globs: string[];
  protected_code_globs: string[];
}

export interface GuardConfig {
  prod_db_hosts: string[];
  prod_db_targets: ProdDbTarget[];
  require_prod_db_hosts: boolean;
  protected_branches: string[];
  allow_protected_ff: string[];
  prod_tag_patterns: string[];
  custom_block_patterns?: string[];
  block_shared_worktree_ops: boolean;
  block_ledger_direct_edits: boolean;
}

export interface WorkbenchConfig {
  name: string;
  git_org?: string;
  repos: string[];
  ledger: LedgerConfig;
  guard: GuardConfig;
}

export interface ModelsConfig {
  tiers: Record<string, {model:string; effort:Model["effort"]}>;
  review: { roles: Record<Role, string> };
}

export interface DbCredentialPair {
  user: string;
  password?: string;
}

export function normalizeDbHost(value: string): string {
  const host = value.trim().toLowerCase();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(host);
  return (bracketed ? bracketed[1] : host.replace(/^([^:]+):\d+$/, "$1")).replace(/\.+$/, "");
}

export function normalizeDbHosts(value: string): string[] {
  return value.split(",").map(normalizeDbHost);
}

export function isProductionDb(name: string, entry: DbEnvEntry, hosts: string[]) {
  return /prod/i.test(name) || normalizeDbHosts(entry.host ?? "").some(host => hosts.includes(host));
}

export interface DbEnvEntry {
  ro?: DbCredentialPair;
  rw?: DbCredentialPair;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  sslmode?: string;
  engine?: string;
}

const DEFAULT_LEDGER: LedgerConfig = {
  enabled: true,
  retention_days: 90,
  exempt_max_files: 3,
  exempt_max_lines: 40,
  exempt_allowed_globs: ["*.md", "*.txt", "docs/**", "*.example", ".gitignore"],
  protected_code_globs: [
    "*.go",
    "*.ts",
    "*.tsx",
    "*.js",
    "*.jsx",
    "*.svelte",
    "*.py",
    "*.sql",
    "*.proto",
  ],
};

const DEFAULT_GUARD: GuardConfig = {
  custom_block_patterns: [],
  prod_db_hosts: [],
  prod_db_targets: [],
  require_prod_db_hosts: false,
  protected_branches: ["main", "master"],
  allow_protected_ff: [],
  prod_tag_patterns: ["^release-v", "^v[0-9]+\\.[0-9]+\\.[0-9]+"],
  block_shared_worktree_ops: true,
  block_ledger_direct_edits: true,
};

export function findWorkbenchRoot(startDir?: string, explicitTarget = false): string {
  const explicit = process.env.FORGE_WORKBENCH_ROOT;
  if (!explicitTarget && explicit && existsSync(explicit)) {
    return realpathSync(explicit);
  }

  let cur = resolve(startDir ?? process.cwd());
  if (explicitTarget && !statSync(cur,{throwIfNoEntry:false})?.isDirectory())
    throw Error("Workbench target is not a directory: "+cur);
  if (existsSync(cur)) {
    try {
      cur = realpathSync(cur);
    } catch {
      // Keep resolved path when realpath fails.
    }
  }

  while (true) {
    if (
      existsSync(join(cur, ".workbench", "workbench.yaml")) ||
      existsSync(join(cur, ".workbench", "kit-lock.json"))
    ) {
      return cur;
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  // Fallback: script located at <workbench>/.workbench/bin/*.js
  const scriptDir = import.meta.dir;
  const candidate = resolve(scriptDir, "../..");
  if (!explicitTarget && (
    existsSync(join(candidate, ".workbench", "workbench.yaml")) ||
    existsSync(join(candidate, ".workbench", "kit-lock.json"))
  )) {
    return realpathSync(candidate);
  }

  return resolve(startDir ?? process.cwd());
}

export function parseYamlFile<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, "utf8");
  if (!raw.trim()) return null;
  return Bun.YAML.parse(raw) as T;
}

export function parseTomlFile<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, "utf8");
  if (!raw.trim()) return null;
  return Bun.TOML.parse(raw) as T;
}

export function repoCardPath(root: string, repo: string): string {
  return repo === "." ? join(root, ".workbench/root-repo.md") : join(root, ".workbench/repos", repo + ".md");
}

export function canonicalRepoPath(root: string, repo: string): string {
  const path = resolve(root, repo);
  return existsSync(path) ? relative(realpathSync(root),realpathSync(path)) || "." : relative(resolve(root),path) || ".";
}

function validatePolicySection(file: string, section: "guard" | "ledger", fields: unknown) {
  if (fields === undefined) return;
  const location = file + " " + section;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw Error(location + " must be a mapping");
  const defaults = section === "guard" ? DEFAULT_GUARD : DEFAULT_LEDGER;
  const other = section === "guard" ? "ledger" : "guard";
  const otherDefaults = section === "guard" ? DEFAULT_LEDGER : DEFAULT_GUARD;
  for (const [key, value] of Object.entries(fields)) {
    const label = location + "." + key;
    if (!Object.hasOwn(defaults, key)) {
      const hint = Object.hasOwn(otherDefaults, key) ? "move it to " + other + "." + key : "supported fields: " + Object.keys(defaults).join(", ");
      throw Error("Unknown field " + label + "; " + hint);
    }
    if (key === "prod_db_targets") {
      if (!Array.isArray(value)) throw Error(label + " must be a list of database targets");
      for (const [index, target] of value.entries()) {
        const path = label + "[" + index + "]";
        if (!target || typeof target !== "object" || Array.isArray(target)) throw Error(path + " must be a mapping");
        if (typeof target.host !== "string" || !target.host.trim()) throw Error(path + ".host must be a nonempty string");
        for (const [field, setting] of Object.entries(target)) {
          if (!["host", "name", "engine"].includes(field)) throw Error("Unknown field " + path + "." + field);
          if (typeof setting !== "string") throw Error(path + "." + field + " must be a string");
        }
      }
      continue;
    }
    const defaultValue: unknown = Reflect.get(defaults, key);
    if (typeof defaultValue === "boolean" && typeof value !== "boolean") throw Error(label + " must be a boolean");
    if (typeof defaultValue === "number" && (!Number.isSafeInteger(value) || Number(value) < 0))
      throw Error(label + " must be a nonnegative integer");
    if (!Array.isArray(defaultValue)) continue;
    if (!Array.isArray(value) || !value.every(entry => typeof entry === "string")) throw Error(label + " must be a string list");
    if (key === "prod_tag_patterns" || key === "custom_block_patterns") {
      for (const [index, pattern] of value.entries()) {
        try { new RegExp(pattern); }
        catch { throw Error(label + "[" + index + "] contains an invalid regular expression"); }
      }
    }
  }
}

export function loadWorkbenchConfig(root: string): WorkbenchConfig {
  const file = join(root, ".workbench", "workbench.yaml");
  const raw = parseYamlFile<Partial<WorkbenchConfig>>(file);
  validatePolicySection(file, "guard", raw?.guard);
  validatePolicySection(file, "ledger", raw?.ledger);
  const ledgerRaw: Partial<LedgerConfig> = raw?.ledger ?? {};
  const guardRaw: Partial<GuardConfig> = raw?.guard ?? {};
  return {
    name: raw?.name || "workbench",
    git_org: raw?.git_org,
    repos: Array.isArray(raw?.repos) ? raw.repos.map(repo => canonicalRepoPath(root,String(repo))) : [],
    ledger: { ...DEFAULT_LEDGER, ...ledgerRaw },
    guard: {
      ...DEFAULT_GUARD,
      ...guardRaw,
      prod_db_targets: (guardRaw.prod_db_targets ?? []).map(target => ({
        name: target.name || target.host,
        engine: target.engine || undefined,
        host: target.host,
      })),
    },
  };
}

const dbEnvironmentFiles = [".workbench/env/environments.json", ".agents/skills/dbop/environments.json"];

function dbConfigPath(root: string, rel: string) {
  let path = root;
  const file = join(root, rel);
  for (const part of rel.split("/")) {
    path = join(path, part);
    const st = lstatSync(path, { throwIfNoEntry: false });
    if (!st) return undefined;
    if (st.isSymbolicLink())
      throw Error(`DB configuration at ${file} contains a symlink at ${path}; use a local regular file`);
    if (path !== file && (!st.isDirectory() || !(st.mode & 0o111)))
      throw Error(`Unreadable DB configuration directory ${path} for ${file}; check permissions`);
    if (path === file && (!st.isFile() || !(st.mode & 0o444)))
      throw Error(`Unreadable DB configuration file ${file}; check type and permissions`);
  }
  return file;
}

export function resolveDbEnvironmentsPath(root: string) {
  for (const rel of dbEnvironmentFiles) {
    const path = dbConfigPath(root, rel);
    if (path) return path;
  }
}

function readDbEnvironmentFile(path: string): Record<string, DbEnvEntry> {
  // Parser excerpts and arbitrary JSON keys can both contain credentials. Only report schema fields and ordinal.
  const bytes = readFileSync(path, "utf8");
  let data: unknown;
  try {
    data = JSON.parse(bytes);
  } catch {
    throw Error(`Failed to parse DB environments file ${path}; correct the JSON syntax`);
  }
  const object = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  if (!object(data))
    throw Error(`Invalid DB configuration ${path}; expected an object of named environments`);
  for (const [index, [name, entry]] of Object.entries(data).entries()) {
    const label = `${path} entry ${index + 1}`;
    if (!name.trim() || !object(entry))
      throw Error(`Invalid DB configuration at ${label}; expected a named object`);
    for (const field of ["host", "database", "sslmode", "engine", "user", "password"]) {
      if (Object.hasOwn(entry, field) && typeof entry[field] !== "string")
        throw Error(`Invalid DB configuration at ${label}.${field}; expected a string`);
    }
    if (!["host", "user", "ro", "rw"].some((field) => Object.hasOwn(entry, field)))
      throw Error(`Invalid DB configuration at ${label}; provide a database host or account`);
    for (const field of ["host", "user"]) {
      if (typeof entry[field] === "string" && !entry[field].trim())
        throw Error(`Invalid DB configuration at ${label}.${field}; expected a nonempty string`);
    }
    if (
      Object.hasOwn(entry, "port") &&
      (typeof entry.port !== "number" ||
        !Number.isInteger(entry.port) ||
        entry.port < 1 ||
        entry.port > 65535)
    )
      throw Error(`Invalid DB configuration at ${label}.port; expected a valid numeric port`);
    for (const field of ["ro", "rw"]) {
      if (!Object.hasOwn(entry, field)) continue;
      const pair = entry[field];
      if (
        !object(pair) ||
        typeof pair.user !== "string" ||
        !pair.user.trim() ||
        (Object.hasOwn(pair, "password") && typeof pair.password !== "string")
      )
        throw Error(
          `Invalid DB configuration at ${label}.${field}; provide a user and an optional string password`,
        );
    }
  }
  return data as Record<string, DbEnvEntry>;
}

export function loadDbEnvironments(
  root: string,
  opts?: { strict?: boolean; validateShadowed?: boolean },
): Record<string, DbEnvEntry> {
  let effective: Record<string, DbEnvEntry> | undefined;
  try {
    for (const rel of dbEnvironmentFiles) {
      const path = dbConfigPath(root, rel);
      if (!path) continue;
      const entries = readDbEnvironmentFile(path);
      effective ??= entries;
      if (!opts?.validateShadowed) break;
    }
  } catch (error) {
    if (opts?.strict) throw error;
  }
  return effective ?? {};
}

export function collectProdDbHosts(
  root: string,
  cfg: WorkbenchConfig,
  opts?: { strict?: boolean },
): string[] {
  return productionHosts(cfg,loadDbEnvironments(root,opts));
}

export function productionHosts(cfg: WorkbenchConfig, envs: Record<string,DbEnvEntry>) {
  const values = [...cfg.guard.prod_db_hosts, ...cfg.guard.prod_db_targets.map(t => t.host)];
  for (const [key, entry] of Object.entries(envs)) {
    if (/prod/i.test(key) && entry?.host) values.push(entry.host);
  }
  return [...new Set(values.flatMap(normalizeDbHosts).filter(Boolean))];
}

export function decodeModelsConfig(parsed: object, file: string): ModelsConfig {
  const tiers: ModelsConfig["tiers"] = {
    mechanical: { model: "gpt-6.1-terra", effort: "medium" },
    standard: { model: "gpt-6.2-sol", effort: "medium" },
    deep: { model: "gpt-6.2-astra", effort: "high" },
  };
  for (const key of Object.keys(parsed))
    if (key !== "tiers" && key !== "review") throw Error(file + ": Unknown field " + key);
  const overrides = "tiers" in parsed ? parsed.tiers : {};
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides))
    throw Error(file + ": tiers must be a mapping");
  // A v0.4 instance may override one tier and inherit every other default.
  for (const [name, tier] of Object.entries(overrides)) {
    const field = "tiers." + name;
    if (!/^[a-z][a-z0-9_-]*$/.test(name) || name in Object.prototype) throw Error(file + ": Invalid " + field);
    if (!tier || typeof tier !== "object" || Array.isArray(tier)) throw Error(file + ": " + field + " must be a mapping");
    for (const key of Object.keys(tier))
      if (key !== "model" && key !== "effort") throw Error(file + ": Unknown field " + field + "." + key);
    const { model, effort } = tier as Record<string, unknown>;
    if (typeof model !== "string" || !model.trim()) throw Error(file + ": Invalid " + field + ".model");
    if (!efforts.some(e => e === effort)) throw Error(file + ": Invalid " + field + ".effort");
    tiers[name] = {model, effort: effort as Model["effort"]};
  }
  const mapping: Record<Role, string> = { business: "deep", quality: "deep", simplify: "standard", comments: "mechanical", performance: "deep" };
  if ("review" in parsed) {
    const review = parsed.review;
    if (!review || typeof review !== "object" || Array.isArray(review) || Object.keys(review).some(k => k !== "roles"))
      throw Error(file + ": Invalid review mapping");
    if ("roles" in review) {
      if (!review.roles || typeof review.roles !== "object" || Array.isArray(review.roles)) throw Error(file + ": Invalid review.roles");
      for (const [role, tier] of Object.entries(review.roles)) {
        if (!roles.some(r => r === role) || typeof tier !== "string" || !Object.hasOwn(tiers, tier))
          throw Error(file + ": Invalid review.roles." + role);
        mapping[role as Role] = tier;
      }
    }
  }
  return { tiers, review: { roles: mapping } };
}

export function loadModelsConfig(root: string): ModelsConfig {
  const file = process.env.FORGE_MODELS_TOML || join(root, ".workbench", "models.toml");
  const parsed = existsSync(file) ? Bun.TOML.parse(readFileSync(file, "utf8")) : { tiers: {} };
  return decodeModelsConfig(parsed, file);
}

export interface ShipPolicy {
  enabled: boolean;
  max_endpoint: "fat" | "pr" | "prod";
  allow_prod: boolean;
  forbid_db_rw: boolean;
  max_files_changed: number;
  max_lines_changed: number;
  max_steward_rounds: number;
  default_ttl_minutes: number;
  require_independent_review: boolean;
  require_ci_green_for_prod: boolean;
  forbidden_paths: string[];
}
export function shipGlob(input: unknown): string {
  if (typeof input !== "string") throw Error("Expected a relative path glob");
  const glob = input.trim().replace(/^\.\//, "");
  if (!glob || /[\\:\x00-\x1f\[\]{}]/.test(glob) || glob.split("/").some((s) => !s || s === "." || s === ".."))
    throw Error("Invalid relative path glob: " + input);
  return input.trim().startsWith("./") ? "./" + glob : glob;
}

export function loadShipPolicy(root: string) {
  const bytes = readFileSync(join(root, ".workbench/ship-policy.yaml"));
  const doc = parseStrictYaml(bytes.toString("utf8"), { uniqueKeys: true }) as {
    fast_track?: Record<string, unknown>;
  } | null;
  const policy = doc?.fast_track;
  if (!policy || typeof policy !== "object" || Object.keys(doc).length !== 1)
    throw Error("Invalid fast_track policy");
  const bools = [
    "enabled",
    "allow_prod",
    "forbid_db_rw",
    "require_independent_review",
    "require_ci_green_for_prod",
  ];
  const limits = ["max_files_changed", "max_lines_changed", "max_steward_rounds", "default_ttl_minutes"];
  const keys = [...bools, ...limits, "max_endpoint", "forbidden_paths"];
  if (
    Object.keys(policy).some((k) => !keys.includes(k)) ||
    bools.some((k) => typeof policy[k] !== "boolean") ||
    limits.some(
      (k) => typeof policy[k] !== "number" || !Number.isSafeInteger(policy[k]) || Number(policy[k]) <= 0,
    ) ||
    !["fat", "pr", "prod"].includes(String(policy.max_endpoint)) ||
    !Array.isArray(policy.forbidden_paths)
  )
    throw Error("Invalid or missing fast_track policy fields");
  if (policy.allow_prod && !policy.require_ci_green_for_prod) throw Error("Production fast-track requires green CI");
  return {
    policy: { ...policy, forbidden_paths: policy.forbidden_paths.map(shipGlob) } as ShipPolicy,
    hash: createHash("sha256").update(bytes).digest("hex"),
  };
}
export function computeShipPolicyHash(root: string) {
  return loadShipPolicy(root).hash;
}
