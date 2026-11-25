import { Database } from "bun:sqlite";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  collectProdDbHosts,
  isProductionDb,
  resolveDbEnvironmentsPath,
  loadDbEnvironments,
  findWorkbenchRoot,
  loadModelsConfig,
  loadWorkbenchConfig,
  parseTomlFile,
} from "./config";
import { runGit, runProcess } from "./git";
import { Ledger } from "./ledger";

interface KitManifest {
  kit: { name: string; version: string; runtime: string };
  managed: {
    rendered_files: string[];
    copied_dirs: string[];
    copied_files: string[];
    bin_bundles: string[];
    bin_wrappers: string[];
  };
  private: { init_only: string[] };
  packs?: Record<string, { copied_dirs?: string[]; copied_files?: string[] }>;
}

interface KitLock {
  kit_name: string;
  kit_version: string;
  kit_root: string;
  kit_commit: string | null;
  workbench_name: string;
  packs: string[];
  review_agents_enabled: boolean;
  review_agents_commit: string | null;
  updated_at: string;
}

const REVIEW_SKILLS = [
  "implementation-review",
  "simplicity-performance-review",
  "code-simplification-review",
  "comment-normalization-review",
] as const;

const REVIEW_BINS = [
  "review-quality",
  "review-performance",
  "review-simplify",
  "review-comments",
] as const;

export function findKitRoot(): string {
  const fromEnv = process.env.FORGE_KIT_ROOT;
  if (fromEnv && existsSync(join(fromEnv, "kit.toml"))) {
    return realpathSync(fromEnv);
  }
  const candidate = resolve(import.meta.dir, "..");
  if (existsSync(join(candidate, "kit.toml"))) {
    return realpathSync(candidate);
  }
  throw new Error("Cannot locate forge-kit root (missing kit.toml)");
}

function loadKitManifest(kitRoot: string): KitManifest {
  const m = parseTomlFile<KitManifest>(join(kitRoot, "kit.toml"));
  if (!m) throw new Error(`Missing or invalid kit.toml in ${kitRoot}`);
  return m;
}

function renderTemplate(content: string, vars: Record<string, string>): string {
  let out = content;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{{${k}}}`, v);
  }
  return out;
}

function newestMtimeMs(dir: string): number {
  let latest = 0;
  if (!existsSync(dir)) return 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      latest = Math.max(latest, newestMtimeMs(full));
    } else if (entry.name.endsWith(".ts")) {
      latest = Math.max(latest, statSync(full).mtimeMs);
    }
  }
  return latest;
}

function ensureKitBuilt(kitRoot: string, bundles: string[]): void {
  const srcNewest = newestMtimeMs(join(kitRoot, "src"));
  const needsBuild = bundles.some((b) => {
    const p = join(kitRoot, "dist", b);
    if (!existsSync(p)) return true;
    return statSync(p).mtimeMs < srcNewest;
  });
  if (!needsBuild) return;
  const bunBin = process.execPath || "bun";
  const res = runProcess([bunBin, "run", "build"], {
    cwd: kitRoot,
    timeoutMs: 30_000,
  });
  if (res.code !== 0) {
    throw new Error(`Failed to build forge-kit bundles: ${res.stderr || res.stdout}`);
  }
}

function installManagedBins(kitRoot: string, targetRoot: string, manifest: KitManifest): void {
  ensureKitBuilt(kitRoot, manifest.managed.bin_bundles);
  const binDir = join(targetRoot, ".workbench", "bin");
  mkdirSync(binDir, { recursive: true });

  for (const bundle of manifest.managed.bin_bundles) {
    cpSync(join(kitRoot, "dist", bundle), join(binDir, bundle));
  }
  for (const wrapper of manifest.managed.bin_wrappers) {
    const wrapperPath = join(binDir, wrapper);
    const script = `#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
BUN="\${BUN_BIN:-$(command -v bun || echo "$HOME/.bun/bin/bun")}"
exec "$BUN" "$DIR/${wrapper}.js" "$@"
`;
    writeFileSync(wrapperPath, script, "utf8");
    chmodSync(wrapperPath, 0o755);
  }
}

function installReviewAgentLinks(targetRoot: string): string[] {
  const raRoot = join(targetRoot, "review-agents");
  if (!existsSync(join(raRoot, "skills"))) return [];
  const skillsRoot = join(targetRoot, ".agents", "skills");
  mkdirSync(skillsRoot, { recursive: true });
  const installed: string[] = [];

  for (const name of REVIEW_SKILLS) {
    const targetSkill = join(raRoot, "skills", name);
    if (!existsSync(targetSkill)) continue;
    const linkPath = join(skillsRoot, name);
    const relTarget = relative(skillsRoot, targetSkill);

    if (existsSync(linkPath)) {
      const st = lstatSync(linkPath);
      if (st.isSymbolicLink()) {
        if (readlinkSync(linkPath) === relTarget) {
          installed.push(name);
          continue;
        }
        unlinkSync(linkPath);
      } else {
        throw new Error(`Refusing to overwrite non-symlink skill at ${linkPath}`);
      }
    }
    symlinkSync(relTarget, linkPath);
    installed.push(name);
  }
  return installed;
}

function ensurePrivateGitignores(targetRoot: string): void {
  const envIgnore = join(targetRoot, ".workbench", "env", ".gitignore");
  if (!existsSync(envIgnore)) {
    mkdirSync(dirname(envIgnore), { recursive: true });
    writeFileSync(
      envIgnore,
      "# Never track real local credentials\nenvironments.json\n*.key\n*.pem\n*.env\n",
      "utf8",
    );
  }
  const ledgerIgnore = join(targetRoot, ".workbench", "ledger", ".gitignore");
  if (!existsSync(ledgerIgnore)) {
    mkdirSync(dirname(ledgerIgnore), { recursive: true });
    writeFileSync(
      ledgerIgnore,
      "# Runtime SQLite DB and hook diagnostics\n*.sqlite\n*.sqlite-wal\n*.sqlite-shm\nhook-errors.log\n",
      "utf8",
    );
  }
}

function renderCodexAgentsFromModels(
  kitRoot: string,
  targetRoot: string,
): void {
  const models = loadModelsConfig(targetRoot);
  const vars: Record<string, string> = {
    MECHANICAL_MODEL: models.tiers.mechanical.model,
    MECHANICAL_EFFORT: models.tiers.mechanical.effort,
    STANDARD_MODEL: models.tiers.standard.model,
    STANDARD_EFFORT: models.tiers.standard.effort,
    DEEP_MODEL: models.tiers.deep.model,
    DEEP_EFFORT: models.tiers.deep.effort,
  };
  const srcDir = join(kitRoot, "core", ".codex", "agents");
  const destDir = join(targetRoot, ".codex", "agents");
  mkdirSync(destDir, { recursive: true });
  for (const f of readdirSync(srcDir)) {
    if (!f.endsWith(".toml")) continue;
    const raw = readFileSync(join(srcDir, f), "utf8");
    writeFileSync(join(destDir, f), renderTemplate(raw, vars), "utf8");
  }
}

function syncManagedAssets(params: {
  kitRoot: string;
  targetRoot: string;
  workbenchName: string;
  packs: string[];
  manifest: KitManifest;
}): void {
  const { kitRoot, targetRoot, workbenchName, packs, manifest } = params;
  const models = loadModelsConfig(targetRoot);
  const vars: Record<string, string> = {
    WORKBENCH_NAME: workbenchName,
    WORKBENCH_ROOT: realpathSync(targetRoot),
    STANDARD_MODEL: models.tiers.standard.model,
    STANDARD_EFFORT: models.tiers.standard.effort,
  };

  for (const relPath of manifest.managed.rendered_files) {
    const src = join(kitRoot, "core", relPath);
    const dest = join(targetRoot, relPath);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, renderTemplate(readFileSync(src, "utf8"), vars), "utf8");
  }

  for (const relPath of manifest.managed.copied_files) {
    const src = join(kitRoot, "core", relPath);
    const dest = join(targetRoot, relPath);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, renderTemplate(readFileSync(src, "utf8"), vars), "utf8");
  }

  for (const relDir of manifest.managed.copied_dirs) {
    if (relDir === ".codex/agents") {
      renderCodexAgentsFromModels(kitRoot, targetRoot);
      continue;
    }
    const src = join(kitRoot, "core", relDir);
    const dest = join(targetRoot, relDir);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true, force: true });
  }

  for (const pack of packs) {
    const spec = manifest.packs?.[pack];
    if (!spec) throw new Error(`Unknown pack: ${pack}`);
    for (const relDir of spec.copied_dirs ?? []) {
      const src = join(kitRoot, "packs", pack, relDir);
      const dest = join(targetRoot, relDir);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(src, dest, { recursive: true, force: true });
    }
    for (const relFile of spec.copied_files ?? []) {
      const src = join(kitRoot, "packs", pack, relFile);
      const dest = join(targetRoot, relFile);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(src, dest);
    }
  }

  installManagedBins(kitRoot, targetRoot, manifest);
  ensurePrivateGitignores(targetRoot);
}

export function initWorkbench(opts: {
  targetDir: string;
  name?: string;
  gitOrg?: string;
  packs?: string[];
  skipReviewAgents?: boolean;
  force?: boolean;
  kitRoot?: string;
}): { root: string; lock: KitLock; reviewSkills: string[] } {
  const kitRoot = opts.kitRoot ?? findKitRoot();
  const manifest = loadKitManifest(kitRoot);

  mkdirSync(opts.targetDir, { recursive: true });
  const targetRoot = realpathSync(opts.targetDir);

  // Conflict protection: refuse to silently overwrite an existing unmanaged workbench without --force!
  const hasLock = existsSync(join(targetRoot, ".workbench", "kit-lock.json"));
  if (!hasLock && !opts.force) {
    const conflicts = ["AGENTS.md", ".codex/config.toml", ".codex/hooks.json"].filter(
      (rel) => existsSync(join(targetRoot, rel)),
    );
    if (conflicts.length > 0) {
      throw new Error(
        `Target directory already contains existing unmanaged files (${conflicts.join(", ")}). ` +
          `Inspect/backup first or pass --force to overwrite managed files.`,
      );
    }
  }

  const workbenchName = opts.name || basename(targetRoot);
  const packs = (opts.packs ?? []).filter(Boolean);

  // Create instance directories
  mkdirSync(join(targetRoot, ".workbench", "repos"), { recursive: true });
  mkdirSync(join(targetRoot, ".workbench", "env"), { recursive: true });
  mkdirSync(join(targetRoot, ".workbench", "ledger"), { recursive: true });
  mkdirSync(join(targetRoot, "one-off-scripts"), { recursive: true });

  // 1. Write instance-private skeletons FIRST (so models.toml is available for rendering agents!)
  const vars: Record<string, string> = {
    WORKBENCH_NAME: workbenchName,
    WORKBENCH_ROOT: targetRoot,
    GIT_ORG: opts.gitOrg ?? "",
  };
  const initMappings: Array<[string, string]> = [
    ["AGENTS.local.md", "AGENTS.local.md"],
    ["workbench.yaml", ".workbench/workbench.yaml"],
    ["models.toml", ".workbench/models.toml"],
    ["environments.example.json", ".workbench/env/environments.example.json"],
    ["one-off-scripts-README.md", "one-off-scripts/README.md"],
  ];
  for (const [tmpl, destRel] of initMappings) {
    const dest = join(targetRoot, destRel);
    if (!existsSync(dest)) {
      const src = join(kitRoot, "templates", tmpl);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, renderTemplate(readFileSync(src, "utf8"), vars), "utf8");
    }
  }

  // 2. Sync all managed files from kit (using models.toml)
  syncManagedAssets({
    kitRoot,
    targetRoot,
    workbenchName,
    packs,
    manifest,
  });

  // 3. Provision review-agents meta-project strictly unless --skip-review-agents
  let reviewEnabled = false;
  let reviewCommit: string | null = null;
  let reviewSkills: string[] = [];
  const kitRa = join(kitRoot, "review-agents");
  const targetRa = join(targetRoot, "review-agents");
  if (!opts.skipReviewAgents) {
    if (!existsSync(join(kitRa, "package.json"))) {
      throw new Error(
        `review-agents submodule is missing in ${kitRa}. Run 'git submodule update --init' or pass --skip-review-agents.`,
      );
    }
    reviewEnabled = true;

    if (!existsSync(targetRa)) {
      if (existsSync(join(kitRa, ".git"))) {
        const cloneRes = runProcess(["git", "clone", kitRa, targetRa], {
          timeoutMs: 60_000,
        });
        if (cloneRes.code !== 0) {
          throw new Error(`Failed to clone review-agents: ${cloneRes.stderr}`);
        }
        // Detach local kit origin so moving/deleting kit doesn't leave a stale local remote
        runGit(targetRa, ["remote", "remove", "origin"]);
      } else {
        cpSync(kitRa, targetRa, {
          recursive: true,
          filter: (p) => !p.includes("/.local") && !p.includes("/node_modules"),
        });
      }
    }
    // Always record the ACTUAL commit present in the instance's review-agents/, never kit's!
    const targetRaHead = runGit(targetRa, ["rev-parse", "HEAD"]);
    reviewCommit = targetRaHead.code === 0 ? targetRaHead.stdout.trim() : null;
    if (existsSync(join(kitRa, "dist")) && !existsSync(join(targetRa, "dist"))) {
      cpSync(join(kitRa, "dist"), join(targetRa, "dist"), { recursive: true });
    }
    if (
      existsSync(join(kitRa, "node_modules")) &&
      !existsSync(join(targetRa, "node_modules"))
    ) {
      cpSync(join(kitRa, "node_modules"), join(targetRa, "node_modules"), {
        recursive: true,
      });
    }
    for (const binName of REVIEW_BINS) {
      const p = join(targetRa, "bin", binName);
      if (existsSync(p)) chmodSync(p, 0o755);
    }
    if (!existsSync(join(targetRa, "dist", "quality.js"))) {
      const buildRes = runProcess([process.execPath || "bun", "run", "build"], {
        cwd: targetRa,
        timeoutMs: 30_000,
      });
      if (buildRes.code !== 0) {
        throw new Error(`Failed to build review-agents in instance: ${buildRes.stderr}`);
      }
    }
    reviewSkills = installReviewAgentLinks(targetRoot);
  }

  // Initialize empty ledger SQLite DB so schema & triggers are active from day 1
  const ledger = new Ledger(targetRoot);
  ledger.closeDb();

  // Write kit-lock.json
  const headRes = runGit(kitRoot, ["rev-parse", "HEAD"]);
  const lock: KitLock = {
    kit_name: manifest.kit.name,
    kit_version: manifest.kit.version,
    kit_root: kitRoot,
    kit_commit: headRes.code === 0 ? headRes.stdout.trim() : null,
    workbench_name: workbenchName,
    packs,
    review_agents_enabled: reviewEnabled,
    review_agents_commit: reviewCommit,
    updated_at: new Date().toISOString(),
  };
  writeFileSync(
    join(targetRoot, ".workbench", "kit-lock.json"),
    JSON.stringify(lock, null, 2) + "\n",
    "utf8",
  );

  return { root: targetRoot, lock, reviewSkills };
}

export function syncWorkbench(opts?: {
  targetDir?: string;
  kitRoot?: string;
}): { root: string; lock: KitLock } {
  const targetRoot = findWorkbenchRoot(opts?.targetDir);
  const lockPath = join(targetRoot, ".workbench", "kit-lock.json");
  if (!existsSync(lockPath)) {
    throw new Error(`Not a forge-kit workbench (missing ${lockPath})`);
  }
  const prevLock = JSON.parse(readFileSync(lockPath, "utf8")) as KitLock;
  const kitRoot =
    opts?.kitRoot ??
    (existsSync(prevLock.kit_root) ? prevLock.kit_root : findKitRoot());
  const manifest = loadKitManifest(kitRoot);
  const cfg = loadWorkbenchConfig(targetRoot);

  syncManagedAssets({
    kitRoot,
    targetRoot,
    workbenchName: cfg.name || prevLock.workbench_name,
    packs: prevLock.packs ?? [],
    manifest,
  });

  if (prevLock.review_agents_enabled) {
    installReviewAgentLinks(targetRoot);
  }

  const headRes = runGit(kitRoot, ["rev-parse", "HEAD"]);
  const nextLock: KitLock = {
    ...prevLock,
    kit_version: manifest.kit.version,
    kit_root: kitRoot,
    kit_commit: headRes.code === 0 ? headRes.stdout.trim() : prevLock.kit_commit,
    updated_at: new Date().toISOString(),
  };
  writeFileSync(lockPath, JSON.stringify(nextLock, null, 2) + "\n", "utf8");
  return { root: targetRoot, lock: nextLock };
}

function detectRepoCommands(repoDir: string): {
  stack: string[];
  commands: string[];
  workflows: string[];
} {
  const stack: string[] = [];
  const commands: string[] = [];
  const workflows: string[] = [];

  if (existsSync(join(repoDir, "go.mod"))) {
    stack.push("Go");
    commands.push("`go test ./...`");
  }
  if (existsSync(join(repoDir, "pyproject.toml"))) {
    stack.push("Python");
    commands.push("`pytest tests/ -q`");
  }
  if (existsSync(join(repoDir, "package.json"))) {
    const usesBun =
      existsSync(join(repoDir, "bun.lock")) || existsSync(join(repoDir, "bun.lockb"));
    stack.push(usesBun ? "TypeScript/Bun" : "Node/JS");
    try {
      const pkg = JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8")) as {
        scripts?: Record<string, string>;
      };
      const runner = usesBun ? "bun run" : "npm run";
      for (const key of ["check", "lint", "typecheck", "test", "build"]) {
        if (pkg.scripts?.[key]) commands.push(`\`${runner} ${key}\``);
      }
    } catch {
      // Ignore invalid package.json
    }
  }
  if (existsSync(join(repoDir, "justfile"))) {
    stack.push("just");
    commands.push("`just --list`");
  }
  if (existsSync(join(repoDir, "Makefile"))) {
    const mk = readFileSync(join(repoDir, "Makefile"), "utf8");
    const targets = ["build", "test", "lint", "generate", "api", "dal"].filter((t) =>
      new RegExp(`^${t}:`, "m").test(mk),
    );
    if (targets.length) {
      commands.push(...targets.map((t) => `\`make ${t}\``));
    }
  }
  const wfDir = join(repoDir, ".github", "workflows");
  if (existsSync(wfDir)) {
    for (const f of readdirSync(wfDir)) {
      if (f.endsWith(".yml") || f.endsWith(".yaml")) {
        workflows.push(`.github/workflows/${f}`);
      }
    }
  }
  return { stack, commands: [...new Set(commands)], workflows };
}

/**
 * Kernel-enforced exclusive lock using SQLite `BEGIN IMMEDIATE` (OS POSIX fcntl byte-range lock).
 * Eliminates userspace mkdir/PID stale-lock races completely: the OS automatically releases
 * the lock on process crash/SIGKILL and never steals a lock from a paused live holder.
 */
function withConfigWriteLock<T>(yamlPath: string, fn: () => T): T {
  const lockDbPath = join(dirname(yamlPath), "ledger", "config-lock.sqlite");
  mkdirSync(dirname(lockDbPath), { recursive: true });
  const db = new Database(lockDbPath, { create: true });
  try {
    db.exec("PRAGMA busy_timeout = 3000;");
    db.exec("BEGIN IMMEDIATE;");
    try {
      const result = fn();
      db.exec("COMMIT;");
      return result;
    } catch (e) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        // Ignore rollback failure
      }
      throw e;
    }
  } finally {
    db.close();
  }
}

function updateReposInWorkbenchYaml(yamlPath: string, repoName: string): boolean {
  return withConfigWriteLock(yamlPath, () => {
    const raw = readFileSync(yamlPath, "utf8");
    const parsed = (Bun.YAML.parse(raw) ?? {}) as Record<string, unknown>;
    const existing = Array.isArray(parsed.repos) ? parsed.repos.map(String) : [];
    if (existing.includes(repoName)) return false;

    const updatedRepos = [...existing, repoName];
    const block = `repos:\n${updatedRepos.map((r) => `  - ${JSON.stringify(r)}`).join("\n")}\n`;

    let next: string;
    if (/^repos:\s*\[[^\]]*\]\s*$/m.test(raw)) {
      next = raw.replace(/^repos:\s*\[[^\]]*\]\s*$/m, block.trimEnd());
    } else if (/^repos:\s*\n(?:[ \t]*-\s+.*\n)*/m.test(raw)) {
      next = raw.replace(/^repos:\s*\n(?:[ \t]*-\s+.*\n)*/m, block);
    } else if (/^repos:\s*$/m.test(raw)) {
      next = raw.replace(/^repos:\s*$/m, block.trimEnd());
    } else {
      next = `${raw.trimEnd()}\n\n${block}`;
    }

    const tmp = `${yamlPath}.${process.pid}.tmp`;
    writeFileSync(tmp, next, "utf8");
    renameSync(tmp, yamlPath);

    const verify = (Bun.YAML.parse(readFileSync(yamlPath, "utf8")) ?? {}) as Record<
      string,
      unknown
    >;
    const verifiedList = Array.isArray(verify.repos) ? verify.repos.map(String) : [];
    if (!verifiedList.includes(repoName)) {
      throw new Error(`Failed to persist repo "${repoName}" into ${yamlPath}`);
    }
    return true;
  });
}

export function addRepo(opts: {
  repoPath: string;
  workbenchDir?: string;
  force?: boolean;
}): { repoName: string; cardPath: string; registered: boolean } {
  const absRepo = realpathSync(opts.repoPath);
  const gitEntry = join(absRepo, ".git");
  if (!existsSync(gitEntry)) {
    throw new Error(`Not a git repository: ${absRepo}`);
  }
  if (!statSync(gitEntry).isDirectory()) {
    throw new Error(
      `${absRepo} is a linked git worktree (.git is a file, not a directory). Register the primary repository instead.`,
    );
  }
  const root = findWorkbenchRoot(opts.workbenchDir ?? dirname(absRepo));
  const rel = relative(root, absRepo);
  if (rel === "" || rel.startsWith("..") || rel.includes("/")) {
    throw new Error(
      `Repository ${absRepo} must be a direct subdirectory inside workbench root ${root} so guard/ledger/wb-git can track it consistently.`,
    );
  }

  const repoName = basename(absRepo);
  const cardPath = join(root, ".workbench", "repos", `${repoName}.md`);

  if (!existsSync(cardPath) || opts.force) {
    const info = detectRepoCommands(absRepo);
    const md = [
      `# ${repoName}`,
      "",
      `- **技术栈**：${info.stack.join(" / ") || "待补充"}`,
      `- **仓库路径**：\`${rel || repoName}\``,
      "",
      "## 本地命令",
      "",
      ...(info.commands.length
        ? info.commands.map((c) => `- ${c}`)
        : ["- 待补充构建、测试与生成命令"]),
      "",
      "## CI / 部署",
      "",
      ...(info.workflows.length
        ? info.workflows.map((w) => `- \`${w}\``)
        : ["- 暂无 `.github/workflows`"]),
      "",
      "## 仓库专属边界与约定",
      "",
      "- 遵循工作台 `AGENTS.md`；如本仓有更严格的分支、数据库或发布限制，补充于此。",
      "",
    ].join("\n");
    mkdirSync(dirname(cardPath), { recursive: true });
    writeFileSync(cardPath, md, "utf8");
  }

  const yamlPath = join(root, ".workbench", "workbench.yaml");
  const registered = existsSync(yamlPath)
    ? updateReposInWorkbenchYaml(yamlPath, repoName)
    : false;

  return { repoName, cardPath, registered };
}

export interface DoctorIssue {
  level: "error" | "warn";
  check: string;
  message: string;
}

export function doctorWorkbench(targetDir?: string): {
  ok: boolean;
  root: string;
  issues: DoctorIssue[];
} {
  const root = findWorkbenchRoot(targetDir);
  const issues: DoctorIssue[] = [];

  // 1. AGENTS.md size check (Codex default project_doc_max_bytes = 32768)
  const agentsPath = join(root, "AGENTS.md");
  if (!existsSync(agentsPath)) {
    issues.push({ level: "error", check: "agents-md", message: "Missing AGENTS.md" });
  } else {
    const bytes = readFileSync(agentsPath).byteLength;
    if (bytes > 32_768) {
      issues.push({
        level: "error",
        check: "agents-md",
        message: `AGENTS.md is ${bytes} bytes (> 32 KiB Codex default cap)`,
      });
    } else if (bytes > 12_288) {
      issues.push({
        level: "warn",
        check: "agents-md",
        message: `AGENTS.md is ${bytes} bytes (> 12 KiB recommended budget)`,
      });
    }
  }

  // 2. Codex config / hooks / agents parse + models.toml consistency checks
  for (const tomlRel of [".codex/config.toml", ".workbench/models.toml"]) {
    const p = join(root, tomlRel);
    if (!existsSync(p)) {
      issues.push({ level: "error", check: "config", message: `Missing ${tomlRel}` });
      continue;
    }
    try {
      Bun.TOML.parse(readFileSync(p, "utf8"));
    } catch (e) {
      issues.push({
        level: "error",
        check: "config",
        message: `Invalid TOML in ${tomlRel}: ${String(e)}`,
      });
    }
  }

  const hooksPath = join(root, ".codex", "hooks.json");
  if (!existsSync(hooksPath)) {
    issues.push({ level: "error", check: "hooks", message: "Missing .codex/hooks.json" });
  } else {
    try {
      const h = JSON.parse(readFileSync(hooksPath, "utf8")) as { hooks?: Record<string, unknown> };
      for (const reqEv of ["PreToolUse", "PostToolUse", "SessionStart", "PostCompact", "UserPromptSubmit"]) {
        if (!h.hooks?.[reqEv]) {
          issues.push({
            level: "warn",
            check: "hooks",
            message: `.codex/hooks.json missing ${reqEv} hook`,
          });
        }
      }
    } catch (e) {
      issues.push({
        level: "error",
        check: "hooks",
        message: `Invalid JSON in .codex/hooks.json: ${String(e)}`,
      });
    }
  }

  const models = loadModelsConfig(root);
  const expectedAgentModel: Record<string, { model: string; effort: string }> = {
    "dev.toml": models.tiers.standard,
    "scanner.toml": models.tiers.mechanical,
    "analyst.toml": models.tiers.deep,
    "spec-reviewer.toml": models.tiers.deep,
  };
  const agentsDir = join(root, ".codex", "agents");
  if (existsSync(agentsDir)) {
    for (const f of readdirSync(agentsDir)) {
      if (!f.endsWith(".toml")) continue;
      try {
        const parsed = Bun.TOML.parse(readFileSync(join(agentsDir, f), "utf8")) as Record<
          string,
          unknown
        >;
        if (!parsed.name || !parsed.description || !parsed.developer_instructions) {
          issues.push({
            level: "error",
            check: "agents",
            message: `.codex/agents/${f} missing required fields (name/description/developer_instructions)`,
          });
        }
        const exp = expectedAgentModel[f];
        if (exp && (parsed.model !== exp.model || parsed.model_reasoning_effort !== exp.effort)) {
          issues.push({
            level: "warn",
            check: "models",
            message: `.codex/agents/${f} (${parsed.model}/${parsed.model_reasoning_effort}) out of sync with models.toml (${exp.model}/${exp.effort}); run 'forge sync'`,
          });
        }
      } catch (e) {
        issues.push({
          level: "error",
          check: "agents",
          message: `Invalid TOML in .codex/agents/${f}: ${String(e)}`,
        });
      }
    }
  }

  // 3. Skills & relative symlinks check
  const skillsDir = join(root, ".agents", "skills");
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir)) {
      const full = join(skillsDir, entry);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        const linkTarget = readlinkSync(full);
        if (isAbsolute(linkTarget)) {
          issues.push({
            level: "error",
            check: "symlinks",
            message: `.agents/skills/${entry} uses non-portable absolute symlink: ${linkTarget}`,
          });
        }
        if (!existsSync(join(full, "SKILL.md"))) {
          issues.push({
            level: "error",
            check: "symlinks",
            message: `.agents/skills/${entry} is a broken symlink (missing SKILL.md)`,
          });
        }
      }
    }
  }

  // 4. Plaintext secret scan + private .gitignore protection
  const secretChecks = [
    "AGENTS.md",
    "AGENTS.local.md",
    ".codex/config.toml",
    ".codex/hooks.json",
    ".workbench/workbench.yaml",
    ".workbench/models.toml",
  ];
  const secretRe =
    /(sk-[A-Za-z0-9_-]{20,}|ANTHROPIC_AUTH_TOKEN\s*[:=]\s*["']?sk-|OPENAI_API_KEY\s*[:=]\s*["']?sk-)/;
  for (const rel of secretChecks) {
    const p = join(root, rel);
    if (!existsSync(p)) continue;
    if (secretRe.test(readFileSync(p, "utf8"))) {
      issues.push({
        level: "error",
        check: "secrets",
        message: `Potential plaintext API key detected in ${rel}`,
      });
    }
  }
  if (!existsSync(join(root, ".workbench", "env", ".gitignore"))) {
    issues.push({
      level: "warn",
      check: "secrets",
      message: "Missing .workbench/env/.gitignore to guard local credentials",
    });
  }

  if (resolveDbEnvironmentsPath(root)) {
    const hosts = collectProdDbHosts(root,loadWorkbenchConfig(root));
    for (const [name, entry] of Object.entries(loadDbEnvironments(root))) {
      if (entry && isProductionDb(name, entry, hosts) && (!entry.ro?.user || !entry.rw?.user))
        issues.push({ level: "warn", check: "db-credentials", message: "Migrate production credentials to split ro/rw accounts." });
    }
  }

  // 5. Binaries & review-agents launchers check
  for (const binName of ["ledger", "guard", "ledger-hook", "wb-git", "dbcred", "cmdfmt", "lang-check", "wb-verify", "forge-review"]) {
    const p = join(root, ".workbench", "bin", binName);
    if (!existsSync(p)) {
      issues.push({
        level: "error",
        check: "bins",
        message: `Missing workbench binary: .workbench/bin/${binName}`,
      });
    }
  }
  const lockPath = join(root, ".workbench", "kit-lock.json");
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath, "utf8")) as KitLock;
    if (lock.review_agents_enabled) {
      for (const rb of REVIEW_BINS) {
        const bp = join(root, "review-agents", "bin", rb);
        if (!existsSync(bp)) {
          issues.push({
            level: "error",
            check: "review-agents",
            message: `Missing review-agents launcher: review-agents/bin/${rb}`,
          });
        } else {
          const r = runProcess([bp, "--help"], { cwd: root, timeoutMs: 5000 });
          if (r.code !== 0) {
            issues.push({
              level: "error",
              check: "review-agents",
              message: `review-agents/bin/${rb} --help failed (code ${r.code})`,
            });
          }
        }
      }
    }
    const cfg = loadWorkbenchConfig(root);
    try {
      const hosts = collectProdDbHosts(root, cfg, { strict: true });
      if (cfg.guard.require_prod_db_hosts && hosts.length === 0) {
        issues.push({
          level: "error",
          check: "prod-guard",
          message:
            "guard.require_prod_db_hosts is true but no prod_db_hosts configured in workbench.yaml or environments.json",
        });
      } else if (lock.packs?.includes("dbop") && hosts.length === 0) {
        issues.push({
          level: "warn",
          check: "prod-guard",
          message:
            "dbop pack is installed but no prod_db_hosts configured in workbench.yaml or environments.json",
        });
      }
    } catch (e) {
      issues.push({
        level: "error",
        check: "prod-guard",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // 6. Registered repos have cards & exist on disk
  const cfg = loadWorkbenchConfig(root);
  for (const repo of cfg.repos) {
    if (!existsSync(join(root, ".workbench", "repos", `${repo}.md`))) {
      issues.push({
        level: "warn",
        check: "repos",
        message: `Registered repo "${repo}" has no repo card at .workbench/repos/${repo}.md`,
      });
    }
  }

  // 7. Ledger hash-chain integrity
  try {
    const ledger = new Ledger(root);
    const v = ledger.verify();
    ledger.closeDb();
    if (!v.ok) {
      for (const err of v.errors) {
        issues.push({ level: "error", check: "ledger", message: err });
      }
    }
  } catch (e) {
    issues.push({
      level: "error",
      check: "ledger",
      message: `Ledger check failed: ${String(e)}`,
    });
  }

  return {
    ok: !issues.some((i) => i.level === "error"),
    root,
    issues,
  };
}

export function checkCodexHooksTrust(
  workbenchRoot: string,
  codexHome?: string,
): { checked: boolean; trustedCount: number; totalCount: number; hooksPath: string } {
  const hooksPath = join(workbenchRoot, ".codex", "hooks.json");
  const resolvedHooksPath = existsSync(hooksPath) ? realpathSync(hooksPath) : hooksPath;
  const homeDir = codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const configPath = join(homeDir, "config.toml");

  if (!existsSync(resolvedHooksPath) || !existsSync(configPath)) {
    return { checked: false, trustedCount: 0, totalCount: 0, hooksPath: resolvedHooksPath };
  }

  try {
    const hooksJson = JSON.parse(readFileSync(resolvedHooksPath, "utf8")) as {
      hooks?: Record<string, Array<{ hooks?: unknown[] }>>;
    };
    let totalCount = 0;
    for (const groups of Object.values(hooksJson.hooks ?? {})) {
      if (!Array.isArray(groups)) continue;
      for (const g of groups) {
        if (Array.isArray(g?.hooks)) totalCount += g.hooks.length;
      }
    }
    if (totalCount === 0) {
      return { checked: true, trustedCount: 0, totalCount: 0, hooksPath: resolvedHooksPath };
    }

    const parsedConfig = Bun.TOML.parse(readFileSync(configPath, "utf8")) as {
      hooks?: {
        state?: Record<string, { enabled?: boolean; trusted_hash?: string }>;
      };
    };
    const stateMap = parsedConfig.hooks?.state ?? {};
    let trustedCount = 0;
    for (const [key, state] of Object.entries(stateMap)) {
      if (
        (key.startsWith(`${resolvedHooksPath}:`) ||
          key.startsWith(`file:${resolvedHooksPath}:`) ||
          key.startsWith(`${hooksPath}:`) ||
          key.startsWith(`file:${hooksPath}:`)) &&
        state?.enabled !== false &&
        typeof state?.trusted_hash === "string" &&
        state.trusted_hash.length > 0
      ) {
        trustedCount++;
      }
    }
    return { checked: true, trustedCount, totalCount, hooksPath: resolvedHooksPath };
  } catch {
    return { checked: false, trustedCount: 0, totalCount: 0, hooksPath: resolvedHooksPath };
  }
}

export async function runForgeCli(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(`forge-kit CLI

Usage:
  forge init <dir> [--name <name>] [--git-org <org>] [--packs dbop,comm-lark] [--skip-review-agents] [--force]
  forge add-repo <repo-path> [--workbench <dir>] [--force]
  forge sync [<dir>]
  forge doctor [<dir>] [--json]`);
    return;
  }

  if (cmd === "init") {
    const targetDir = rest[0];
    if (!targetDir) throw new Error("Usage: forge init <dir>");
    const { values } = parseArgs({
      args: rest.slice(1),
      options: {
        name: { type: "string" },
        "git-org": { type: "string" },
        packs: { type: "string" },
        "skip-review-agents": { type: "boolean", default: false },
        force: { type: "boolean", default: false },
      },
    });
    const res = initWorkbench({
      targetDir,
      name: values.name,
      gitOrg: values["git-org"],
      packs: values.packs ? values.packs.split(",").map((s) => s.trim()) : [],
      skipReviewAgents: Boolean(values["skip-review-agents"]),
      force: Boolean(values.force),
    });
    console.log(JSON.stringify(res, null, 2));
  } else if (cmd === "add-repo") {
    const repoPath = rest[0];
    if (!repoPath) throw new Error("Usage: forge add-repo <repo-path>");
    const { values } = parseArgs({
      args: rest.slice(1),
      options: {
        workbench: { type: "string" },
        force: { type: "boolean", default: false },
      },
    });
    const res = addRepo({
      repoPath,
      workbenchDir: values.workbench,
      force: Boolean(values.force),
    });
    console.log(JSON.stringify(res, null, 2));
  } else if (cmd === "sync") {
    const targetDir = rest[0];
    const res = syncWorkbench({ targetDir });
    console.log(JSON.stringify(res, null, 2));
  } else if (cmd === "doctor") {
    const targetDir = rest[0] && !rest[0].startsWith("-") ? rest[0] : undefined;
    const jsonMode = rest.includes("--json");
    const res = doctorWorkbench(targetDir);
    if (jsonMode) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(`forge doctor (${res.root}): ${res.ok ? "OK" : "FAILED"}`);
      for (const issue of res.issues) {
        console.log(`  [${issue.level.toUpperCase()}] (${issue.check}) ${issue.message}`);
      }
      if (res.issues.length === 0) console.log("  All checks passed.");
      const trust = checkCodexHooksTrust(res.root);
      if (trust.checked && trust.totalCount > 0 && trust.trustedCount < trust.totalCount) {
        console.log(
          `  [HINT] (hooks-trust) Codex hooks in ${trust.hooksPath} have ${trust.trustedCount}/${trust.totalCount} trusted handler(s) in ~/.codex/config.toml. Open Codex in this workbench and approve via /hooks (or Codex Desktop Settings -> Hooks) to activate guard & ledger hooks.`,
        );
      }
    }
    if (!res.ok) process.exitCode = 1;
  } else {
    throw new Error(`Unknown command: ${cmd}`);
  }
}
