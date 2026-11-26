import { parse as parseStrictYaml } from "yaml";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
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

export interface ModelTier {
  model: string;
  effort: "medium" | "high";
}

export interface ModelsConfig {
  tiers: {
    mechanical: ModelTier;
    standard: ModelTier;
    deep: ModelTier;
  };
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
  prod_db_hosts: [],
  prod_db_targets: [],
  require_prod_db_hosts: false,
  protected_branches: ["main", "master"],
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

export function canonicalRepoPath(root: string, repo: string): string {
  const path = resolve(root, repo);
  return existsSync(path) ? relative(realpathSync(root),realpathSync(path)) || "." : relative(resolve(root),path) || ".";
}

export function loadWorkbenchConfig(root: string): WorkbenchConfig {
  const raw = parseYamlFile<Partial<WorkbenchConfig>>(
    join(root, ".workbench", "workbench.yaml"),
  );
  const ledgerRaw = (raw?.ledger ?? {}) as Partial<LedgerConfig>;
  const guardRaw = (raw?.guard ?? {}) as Partial<GuardConfig>;
  if (guardRaw.custom_block_patterns !== undefined && (!Array.isArray(guardRaw.custom_block_patterns) ||
      !guardRaw.custom_block_patterns.every(pattern => typeof pattern === "string"))) {
    throw new Error("guard.custom_block_patterns must be an array of regex strings");
  }

  return {
    name: raw?.name || "workbench",
    git_org: raw?.git_org,
    repos: Array.isArray(raw?.repos) ? raw.repos.map(repo => canonicalRepoPath(root,String(repo))) : [],
    ledger: {
      enabled: ledgerRaw.enabled ?? DEFAULT_LEDGER.enabled,
      retention_days:
        typeof ledgerRaw.retention_days === "number"
          ? ledgerRaw.retention_days
          : DEFAULT_LEDGER.retention_days,
      exempt_max_files:
        typeof ledgerRaw.exempt_max_files === "number"
          ? ledgerRaw.exempt_max_files
          : DEFAULT_LEDGER.exempt_max_files,
      exempt_max_lines:
        typeof ledgerRaw.exempt_max_lines === "number"
          ? ledgerRaw.exempt_max_lines
          : DEFAULT_LEDGER.exempt_max_lines,
      exempt_allowed_globs: Array.isArray(ledgerRaw.exempt_allowed_globs)
        ? ledgerRaw.exempt_allowed_globs.map(String)
        : DEFAULT_LEDGER.exempt_allowed_globs,
      protected_code_globs: Array.isArray(ledgerRaw.protected_code_globs)
        ? ledgerRaw.protected_code_globs.map(String)
        : DEFAULT_LEDGER.protected_code_globs,
    },
    guard: {
      prod_db_hosts: Array.isArray(guardRaw.prod_db_hosts)
        ? guardRaw.prod_db_hosts.map(String)
        : DEFAULT_GUARD.prod_db_hosts,
      prod_db_targets: Array.isArray(guardRaw.prod_db_targets)
        ? guardRaw.prod_db_targets
            .filter((t) => t && typeof t.host === "string" && t.host.trim())
            .map((t) => ({
              name: String(t.name || t.host),
              engine: t.engine ? String(t.engine) : undefined,
              host: String(t.host),
            }))
        : DEFAULT_GUARD.prod_db_targets,
      require_prod_db_hosts:
        guardRaw.require_prod_db_hosts ?? DEFAULT_GUARD.require_prod_db_hosts,
      custom_block_patterns: guardRaw.custom_block_patterns ?? [],
      protected_branches: Array.isArray(guardRaw.protected_branches)
        ? guardRaw.protected_branches.map(String)
        : DEFAULT_GUARD.protected_branches,
      prod_tag_patterns: Array.isArray(guardRaw.prod_tag_patterns)
        ? guardRaw.prod_tag_patterns.map(String)
        : DEFAULT_GUARD.prod_tag_patterns,
      block_shared_worktree_ops:
        guardRaw.block_shared_worktree_ops ??
        DEFAULT_GUARD.block_shared_worktree_ops,
      block_ledger_direct_edits:
        guardRaw.block_ledger_direct_edits ??
        DEFAULT_GUARD.block_ledger_direct_edits,
    },
  };
}

export function resolveDbEnvironmentsPath(root: string) {
  return [join(root, ".workbench/env/environments.json"), join(root, ".agents/skills/dbop/environments.json")].find(p => existsSync(p));
}

export function loadDbEnvironments(
  root: string,
  opts?: { strict?: boolean },
): Record<string, DbEnvEntry> {
  const p = resolveDbEnvironmentsPath(root);
  if (p) {
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, DbEnvEntry>;
      }
      if (opts?.strict) {
        throw new Error(`Invalid DB environments JSON object in ${p}`);
      }
    } catch (err) {
      if (opts?.strict) {
        throw new Error(
          `Failed to parse DB environments file ${p}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  return {};
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

export function loadModelsConfig(root: string): ModelsConfig {
  const parsed = parseTomlFile<Partial<ModelsConfig>>(
    process.env.FORGE_MODELS_TOML || join(root, ".workbench", "models.toml"),
  );
  return {
    tiers: {
      mechanical: parsed?.tiers?.mechanical ?? {
        model: "gpt-6.1-terra",
        effort: "medium",
      },
      standard: parsed?.tiers?.standard ?? {
        model: "gpt-6.2-astra",
        effort: "medium",
      },
      deep: parsed?.tiers?.deep ?? {
        model: "gpt-6.2-astra",
        effort: "high",
      },
    },
  };
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
