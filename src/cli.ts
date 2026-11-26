import { findKitRoot } from "./kit-root";
export { findKitRoot };
import {
  checkMigration,
  hash,
  installAssets,
  recoverInstall,
  wrapper,
  type Asset,
  type InstallLock,
} from "./managed-assets";
import { localPath, readRequired, resolveInstance, runInstanceStage } from "./instance";
import { Database } from "bun:sqlite";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  productionHosts,
  isProductionDb,
  loadDbEnvironments,
  findWorkbenchRoot,
  loadModelsConfig,
  loadWorkbenchConfig,
  parseTomlFile,
} from "./config";
import { runGit } from "./git";
import { Ledger } from "./ledger";

interface KitManifest {
  kit: { name: string; version: string; runtime: string };
  managed: {
    rendered_files: string[];
    agent_files: string[];
    copied_files: string[];
    bin_bundles: string[];
    bin_wrappers: string[];
  };
  private: { init_only: string[] };
}

type KitLock = InstallLock;

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

function loadBundle(kitRoot: string, name: string): Buffer {
  // A checkout can have an arbitrarily stale dist file. Build the running source directly, leaving the checkout untouched.
  if (name === "cli.js" && existsSync(join(kitRoot, "src/bin/cli.ts"))) {
    const result = Bun.spawnSync([process.execPath, "build", "--target=bun", "src/bin/cli.ts"], {
      cwd: kitRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) throw Error("Cannot build current forge entry: " + result.stderr.toString());
    return result.stdout;
  }
  return readRequired(localPath(kitRoot, "dist/" + name));
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

function visitSkillFiles(
  effective: ReturnType<typeof resolveInstance>,
  visit: (dest: string, src: string) => void,
) {
  for (const skill of effective.skills.values()) {
    const base = dirname(skill.value.path);
    const dest = ".agents/skills/" + skill.id + "/";
    visit(dest + "SKILL.md", skill.value.path);
    // Skill authors explicitly reference supporting files; adjacent private materials are never projected.
    const resources = new Set<string>();
    for (const m of skill.value.body.matchAll(
      /\]\(([^)# ]+)(?:#[^) ]*)?\)|`((?:references|assets|scripts)\/[^\s`]+)`/g,
    )) {
      const path = m[1] ?? m[2];
      if (/^[a-z]+:/i.test(path) || path.startsWith("#")) continue;
      resources.add(path.replace(/^\.\//, ""));
    }
    for (const rel of resources) {
      const src = localPath(base, rel);
      visit(dest + rel, src);
    }
  }
}

function managedPlan(kitRoot: string, root: string, manifest: KitManifest) {
  const effective = resolveInstance(root, kitRoot);
  const cfg = loadWorkbenchConfig(root),
    models = loadModelsConfig(root);
  const vars: Record<string, string> = { WORKBENCH_NAME: cfg.name, WORKBENCH_ROOT: root };
  for (const [key, tier] of Object.entries(models.tiers)) {
    vars[key.toUpperCase() + "_MODEL"] = tier.model;
    vars[key.toUpperCase() + "_EFFORT"] = tier.effort;
  }
  const assets = new Map<string, Asset>();
  function put(path: string, bytes: string | Buffer, mode = 0o644) {
    assets.set(path, { bytes: Buffer.from(bytes), mode });
  }
  const files = [
    ...manifest.managed.rendered_files,
    ...manifest.managed.copied_files,
    ...manifest.managed.agent_files.map((f) => ".codex/agents/" + f),
  ];
  for (const rel of files)
    put(rel, renderTemplate(readRequired(localPath(kitRoot, "core/" + rel)).toString(), vars));
  visitSkillFiles(effective, (path, src) => put(path, readRequired(src), statSync(src).mode & 0o777));
  if ((assets.get("AGENTS.md")?.bytes.length ?? 0) >= 8000)
    throw Error(
      "Rendered AGENTS.md must be under 8000 bytes; shorten the workbench name or core instructions",
    );
  for (const b of manifest.managed.bin_bundles) put(".workbench/bin/" + b, loadBundle(kitRoot, b));
  for (const b of manifest.managed.bin_wrappers) put(".workbench/bin/" + b, wrapper(b), 0o755);
  return { assets, vars };
}

function install(root: string, kitRoot: string, previous?: KitLock, force = false) {
  const manifest = loadKitManifest(kitRoot);
  const { assets, vars } = managedPlan(kitRoot, root, manifest);
  const head = runGit(kitRoot, ["rev-parse", "HEAD"]);
  const lock: KitLock = {
    kit_name: manifest.kit.name,
    kit_version: manifest.kit.version,
    kit_root: kitRoot,
    kit_commit: head.code === 0 ? head.stdout.trim() : null,
    workbench_name: vars.WORKBENCH_NAME,
    updated_at: new Date().toISOString(),
  };
  const preserved = installAssets(root, assets, lock, previous, vars, force);
  return { root, lock, preserved };
}

export function initWorkbench(opts: {
  targetDir: string;
  name?: string;
  gitOrg?: string;
  force?: boolean;
  kitRoot?: string;
}) {
  const kitRoot = opts.kitRoot ?? findKitRoot();
  mkdirSync(opts.targetDir, { recursive: true });
  const targetRoot = realpathSync(opts.targetDir);

  return withConfigWriteLock(localPath(targetRoot, ".workbench/workbench.yaml"), () => {
    loadDbEnvironments(targetRoot, { strict: true, validateShadowed: true });
    recoverInstall(targetRoot);
    // Conflict protection: refuse to silently overwrite an existing unmanaged workbench without --force!
    const hasLock = existsSync(join(targetRoot, ".workbench", "kit-lock.json"));
    if (hasLock)
      return install(
        targetRoot,
        kitRoot,
        JSON.parse(readRequired(localPath(targetRoot, ".workbench/kit-lock.json")).toString()),
      );
    if (!opts.force) {
      const conflicts = ["AGENTS.md", ".codex/config.toml", ".codex/hooks.json"].filter((rel) =>
        existsSync(join(targetRoot, rel)),
      );
      if (conflicts.length > 0) {
        throw new Error(
          `Target directory already contains existing unmanaged files (${conflicts.join(", ")}). ` +
            `Inspect/backup first or pass --force to overwrite managed files.`,
        );
      }
    }

    for (const path of [
      ".workbench/repos",
      ".workbench/env/.gitignore",
      ".workbench/ledger/.gitignore",
      "one-off-scripts/README.md",
    ])
      localPath(targetRoot, path);
    const workbenchName = opts.name || basename(targetRoot);

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
      ["ship-policy.yaml", ".workbench/ship-policy.yaml"],
      ["environments.example.json", ".workbench/env/environments.example.json"],
      ["one-off-scripts-README.md", "one-off-scripts/README.md"],
    ];
    for (const [tmpl, destRel] of initMappings) {
      const dest = localPath(targetRoot, destRel);
      if (!existsSync(dest)) {
        const src = join(kitRoot, "templates", tmpl);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, renderTemplate(readFileSync(src, "utf8"), vars), "utf8");
      }
    }

    ensurePrivateGitignores(targetRoot);
    const result = install(targetRoot, kitRoot, undefined, opts.force);
    const ledger = new Ledger(targetRoot);
    ledger.closeDb();
    return result;
  });
}

export function syncWorkbench(opts?: { targetDir?: string; kitRoot?: string }): {
  root: string;
  lock: KitLock;
  preserved: string[];
} {
  const root = findWorkbenchRoot(opts?.targetDir, opts?.targetDir !== undefined);
  const kitRoot = opts?.kitRoot ?? findKitRoot();
  const path = localPath(root, ".workbench/kit-lock.json");
  if (!existsSync(path) && !existsSync(localPath(root,".workbench/sync-journal")))
    throw Error("Not an initialized workbench: missing "+path+"; use forge init");
  return withConfigWriteLock(localPath(root, ".workbench/workbench.yaml"), () => {
    loadDbEnvironments(root, { strict: true, validateShadowed: true });
    recoverInstall(root);
    const previous = JSON.parse(readRequired(path).toString()) as KitLock;
    return install(root, kitRoot, previous);
  });
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
    stack.push("JavaScript/TypeScript (Bun)");
    try {
      const pkg = JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8")) as {
        scripts?: Record<string, string>;
      };
      const runner = "bun run";
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
  const lockDbPath = localPath(dirname(yamlPath), "ledger/config-lock.sqlite");
  mkdirSync(dirname(lockDbPath), { recursive: true });
  const db = new Database(lockDbPath, { create: true });
  try {
    db.exec("PRAGMA busy_timeout = 60000;");
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

    const verify = (Bun.YAML.parse(readFileSync(yamlPath, "utf8")) ?? {}) as Record<string, unknown>;
    const verifiedList = Array.isArray(verify.repos) ? verify.repos.map(String) : [];
    if (!verifiedList.includes(repoName)) {
      throw new Error(`Failed to persist repo "${repoName}" into ${yamlPath}`);
    }
    return true;
  });
}

export function addRepo(opts: { repoPath: string; workbenchDir?: string; force?: boolean }): {
  repoName: string;
  cardPath: string;
  registered: boolean;
} {
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
  const root = findWorkbenchRoot(opts.workbenchDir ?? dirname(absRepo), opts.workbenchDir !== undefined);
  checkMigration(root);
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
      ...(info.commands.length ? info.commands.map((c) => `- ${c}`) : ["- 待补充构建、测试与生成命令"]),
      "",
      "## CI / 部署",
      "",
      ...(info.workflows.length ? info.workflows.map((w) => `- \`${w}\``) : ["- 暂无 `.github/workflows`"]),
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
  const registered = existsSync(yamlPath) ? updateReposInWorkbenchYaml(yamlPath, repoName) : false;

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
  let root = resolve(targetDir ?? process.cwd());
  try {
    root = findWorkbenchRoot(targetDir, targetDir !== undefined);
    return inspectWorkbench(root);
  } catch (e) {
    return {
      root,
      ok: false,
      issues: [
        {
          level: "error",
          check: "configuration",
          message: String(e) + "; repair the indicated path and retry",
        },
      ],
    };
  }
}

function inspectWorkbench(root: string) {
  const issues: DoctorIssue[] = [];

  for (const [name, mode] of [
    ["forge", constants.X_OK],
    ["cli.js", constants.R_OK],
  ] as const) {
    const path = localPath(root, ".workbench/bin/" + name);
    try {
      const st = statSync(path);
      if (!st.isFile() || !(st.mode & (mode === constants.X_OK ? 0o111 : 0o444))) throw Error("permissions");
      accessSync(path, mode);
    } catch {
      issues.push({
        level: "error",
        check: "bins",
        message: "Missing or inaccessible " + path +
          ". If the file exists but cannot be read, restore read permission or move it aside. " +
          "From the forge-kit release directory, run ./bin/forge sync " + Bun.$.escape(root),
      });
    }
  }
  try {
    checkMigration(root);
    const effective = resolveInstance(root, findKitRoot());
    for (const id of effective.delivery.value.stages) {
      const stage = effective.stages.get(id)!;
      if (stage.source==="core") continue;
      const missing: string[] = [];
      const action = effective.actions.get(stage.value.action)!;
      if (!action.value.inputs) missing.push("extensions.actions."+action.id+".inputs");
      const observe = stage.value.observe;
      if (!observe) missing.push("extensions.stages."+id+".observe");
      else if (!effective.actions.get(observe)!.value.inputs) missing.push("extensions.actions."+observe+".inputs");
      if (missing.length) issues.push({
        level:"warn", check:"delivery",
        message:stage.source+" stage "+id+" requires "+missing.join(", ")+" before a protected run can be registered",
      });
    }
    visitSkillFiles(effective, (path, src) => {
      const dest = localPath(root, path);
      if (!existsSync(dest) || !readRequired(dest).equals(readRequired(src))) {
        issues.push({
          level: "error",
          check: "skills",
          message: dest + " differs from " + src + "; move any local edits to a private copy, then run forge sync",
        });
      }
    });
  } catch (err) {
    issues.push({
      level: "error",
      check: String(err).includes("ship-policy") ? "ship-policy" : "configuration",
      message: String(err),
    });
    return { ok: false, root, issues };
  }
  const agentsPath = localPath(root, "AGENTS.md");
  if (!existsSync(agentsPath) || readRequired(agentsPath).length >= 8000)
    issues.push({
      level: "error",
      check: "agents-md",
      message: agentsPath + " must exist and be under 8000 bytes; run forge sync",
    });

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
    "implementer.toml": models.tiers.standard,
    "scanner.toml": models.tiers.mechanical,
    "analyst.toml": models.tiers.deep,
    "reviewer.toml": models.tiers.deep,
  };
  const agentsDir = join(root, ".codex", "agents");
  if (existsSync(agentsDir)) {
    for (const f of readdirSync(agentsDir)) {
      if (!f.endsWith(".toml")) continue;
      try {
        const parsed = Bun.TOML.parse(readFileSync(join(agentsDir, f), "utf8")) as Record<string, unknown>;
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

  const dbEnvironments = loadDbEnvironments(root, { strict: true, validateShadowed: true });
  const cfg = loadWorkbenchConfig(root);
  const hosts = productionHosts(cfg, dbEnvironments);
  for (const [name, entry] of Object.entries(dbEnvironments)) {
    if (isProductionDb(name, entry, hosts) && (!entry.ro?.user || !entry.rw?.user))
      issues.push({
        level: "warn", check: "db-credentials", message: "Migrate production credentials to split ro/rw accounts.",
      });
  }

  const lockPath = localPath(root, ".workbench/kit-lock.json");
  if (!existsSync(lockPath))
    issues.push({
      level: "error",
      check: "lock",
      message: "Missing " + lockPath + "; initialize the workbench",
    });
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readRequired(lockPath).toString()) as KitLock;
    for (const [path, expected] of Object.entries(lock.managed_files ?? {})) {
      const dest = localPath(root, path);
      if (!existsSync(dest) || hash(readRequired(dest)) !== expected)
        issues.push({
          level: "error",
          check: "projection",
          message: dest + " differs from the installed manifest; move the edited file aside, then run forge sync to recreate it",
        });
    }
  }

  if (cfg.guard.require_prod_db_hosts && hosts.length === 0) {
    issues.push({
      level: "error", check: "prod-guard",
      message: "guard.require_prod_db_hosts is true but no prod_db_hosts configured in workbench.yaml or environments.json",
    });
  }

  // 6. Registered repos have cards & exist on disk
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
  forge init <dir> [--name <name>] [--git-org <org>] [--force]
  forge add-repo <repo-path> [--workbench <dir>] [--force]
  forge sync [<dir>]
  forge doctor [<dir>] [--json]
  forge instance list [--json]
  forge instance show <kind> <id> [--json]
  forge instance run <stage-id>
  forge verify | review | ship | ledger | git | guard | ledger-hook | dbcred | cmdfmt | lang-check`);
    return;
  }

  if (cmd === "instance") {
    const [verb, ...args] = rest.filter((a) => a !== "--json");
    const root = findWorkbenchRoot(),
      kit = findKitRoot();
    checkMigration(root);
    const c = resolveInstance(root, kit);
    if (verb === "run" && args.length === 1) {
      const id=args[0];
      if (id==="verify" && c.stages.get(id)?.source==="core" && !c.delivery.value.stages.includes(id)) {
        const {verifyCli}=await import("./wb-verify");
        const result=verifyCli([]);
        console.log(JSON.stringify(result));
        process.exitCode=result.ok?0:1;
      } else {
        process.exitCode = runInstanceStage(root, kit, id);
      }
      return;
    }
    const items = [
      c.verification,
      c.delivery,
      ...c.actions.values(),
      ...c.stages.values(),
      ...c.skills.values(),
    ];
    if (verb === "list" && !args.length) {
      console.log(JSON.stringify(items, null, 2));
      return;
    }
    const found = items.find((i) => i.kind === args[0] && i.id === args[1]);
    if (verb === "show" && args.length === 2 && found) {
      console.log(JSON.stringify(found, null, 2));
      return;
    }
    throw Error(
      "Expected forge instance list, show <kind> <id>, or run <stage-id>; check IDs with forge instance list",
    );
  }
  if (cmd === "init") {
    const targetDir = rest[0];
    if (!targetDir) throw new Error("Usage: forge init <dir>");
    const { values } = parseArgs({
      args: rest.slice(1),
      options: {
        name: { type: "string" },
        "git-org": { type: "string" },
        force: { type: "boolean", default: false },
      },
    });
    const res = initWorkbench({
      targetDir,
      name: values.name,
      gitOrg: values["git-org"],
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
