import { accessSync, constants, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { findWorkbenchRoot, isProductionDb, loadDbEnvironments, loadModelsConfig, loadWorkbenchConfig, productionHosts, repoCardPath } from "../config";
import { localPath, readRequired, resolveInstance, isProjectVerification } from "../instance";
import { Ledger } from "../ledger/store";
import { hash, checkMigration, missingLockRecovery, type InstallLock } from "../managed-assets";
import { visitSkillFiles } from "./install-plan";

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
  const issues: DoctorIssue[] = [];
  try {
    root = findWorkbenchRoot(targetDir, targetDir !== undefined);
    return inspectWorkbench(root, issues);
  } catch (e) {
    return {
      root,
      ok: false,
      issues: [...issues,
        {
          level: "error",
          check: "configuration",
          message: String(e) + "; repair the indicated path and retry",
        },
      ],
    };
  }
}

function inspectWorkbench(root: string, issues: DoctorIssue[]) {
  // The release launcher remains usable even when an installed entry point has changed.
  const releaseRepair = "From the forge-kit release directory, run ./bin/forge sync " + Bun.$.escape(root);
  for (const name of ["forge", "cli.js"]) {
    const path = localPath(root, ".workbench/bin/" + name);
    try {
      const st = statSync(path);
      const executable = name === "forge";
      if (!st.isFile() || !(st.mode & 0o444) || (executable && !(st.mode & 0o111))) throw Error("permissions");
      accessSync(path, constants.R_OK | (executable ? constants.X_OK : 0));
    } catch {
      issues.push({
        level: "error",
        check: "bins",
        message: "Missing or inaccessible " + path +
          ". If the file exists but cannot be read, restore read permission or move it aside. " +
          releaseRepair,
      });
    }
  }
  const agentsPath = localPath(root, "AGENTS.md");
  const agentsMissing = !existsSync(agentsPath);
  if (agentsMissing || readRequired(agentsPath).length >= 8000)
    issues.push({
      level: "error",
      check: "agents-md",
      message: agentsMissing
        ? "Missing " + agentsPath + ". " + releaseRepair
        : agentsPath + " must be under 8000 bytes; move the edited file aside. " + releaseRepair,
    });

  const lockPath = localPath(root, ".workbench/kit-lock.json");
  if (!existsSync(lockPath))
    issues.push({
      level: "error",
      check: "lock",
      message: missingLockRecovery(root, lockPath),
    });
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readRequired(lockPath).toString()) as InstallLock;
    for (const [path, expected] of Object.entries(lock.managed_files ?? {})) {
      const dest = localPath(root, path);
      const missing = !existsSync(dest);
      let matches = false;
      if (!missing) {
        try { matches = hash(readRequired(dest)) === expected; }
        catch (error) {
          issues.push({level: "error", check: "projection",
            message: String(error) + "; restore read permission or move the file aside. " + releaseRepair});
          continue;
        }
      }
      if (!matches)
        issues.push({
          level: "error",
          check: "projection",
          message: missing
            ? "Missing " + dest + ". " + releaseRepair
            : dest + " differs from the installed manifest; move the edited file aside. " + releaseRepair,
        });
    }
  }

  try {
    checkMigration(root);
    const effective = resolveInstance(root);
    const projectChecks = [...effective.actions.values()].filter(({value}) =>
      isProjectVerification(value, effective.repos) && (value.inputs?.length ||
        (value.argv[0].includes("/") && !isAbsolute(value.argv[0]))));
    if (projectChecks.length) issues.push({
      level: "warn", check: "verification",
      message: "forge verify checks repository-relative files at the selected commit for actions: " +
        projectChecks.map(action => action.id).join(", "),
    });
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

  if (cfg.guard.require_prod_db_hosts && hosts.length === 0) {
    issues.push({
      level: "error", check: "prod-guard",
      message: "guard.require_prod_db_hosts is true but no prod_db_hosts configured in workbench.yaml or environments.json",
    });
  }

  // 6. Registered repos have cards & exist on disk
  for (const repo of cfg.repos) {
    const card = repoCardPath(root, repo);
    if (!existsSync(card)) {
      issues.push({
        level: "warn",
        check: "repos",
        message: `Registered repo "${repo}" has no repo card at ${relative(root, card)}`,
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
