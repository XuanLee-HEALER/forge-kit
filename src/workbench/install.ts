import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { findWorkbenchRoot, loadDbEnvironments, parseYamlFile } from "../config";
import { localPath, readRequired } from "../instance";
import { findKitRoot } from "../kit-root";
import { Ledger } from "../ledger/store";
import { recoverInstall, checkInstallSource, type InstallLock } from "../managed-assets";
import { withConfigWriteLock } from "./config-lock";
import { renderTemplate, install } from "./install-plan";

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
  checkInstallSource(targetRoot, "init");

  return withConfigWriteLock(localPath(targetRoot, ".workbench/workbench.yaml"), () => {
    checkInstallSource(targetRoot, "init", true);
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
  lock: InstallLock;
  preserved: string[];
  diagnostics?: string[];
} {
  const root = findWorkbenchRoot(opts?.targetDir, opts?.targetDir !== undefined);
  const path = localPath(root, ".workbench/kit-lock.json");
  checkInstallSource(root, "sync");
  const kitRoot = opts?.kitRoot ?? findKitRoot();
  return withConfigWriteLock(localPath(root, ".workbench/workbench.yaml"), () => {
    checkInstallSource(root, "sync", true);
    loadDbEnvironments(root, { strict: true, validateShadowed: true });
    recoverInstall(root);
    const previous = JSON.parse(readRequired(path).toString()) as InstallLock;
    const result = install(root, kitRoot, previous);
    const config = parseYamlFile<{extensions?: {delivery?: Record<string, unknown>; skills?: Record<string, unknown>}}>(localPath(root, ".workbench/workbench.yaml"));
    const diagnostics: string[] = [];
    if (config?.extensions?.skills?.ship && previous.kit_version !== result.lock.kit_version)
      diagnostics.push("Preserved private ship skill. Review the updated node approval and target receipt workflow in core/.agents/skills/ship/SKILL.md.");
    return diagnostics.length ? {...result, diagnostics} : result;
  });
}
