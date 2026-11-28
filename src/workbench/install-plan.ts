import { existsSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { loadModelsConfig, loadWorkbenchConfig, parseTomlFile, reviewRoleModel, reviewRoles } from "../config";
import { ensureAuditIgnored } from "../shared/audit-ignore";
import { runGit } from "../git";
import { localPath, readRequired, resolveInstance } from "../instance";
import { installAssets, wrapper, type Asset, type InstallLock } from "../managed-assets";

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

function loadKitManifest(kitRoot: string): KitManifest {
  const m = parseTomlFile<KitManifest>(join(kitRoot, "kit.toml"));
  if (!m) throw new Error(`Missing or invalid kit.toml in ${kitRoot}`);
  return m;
}

export function renderTemplate(content: string, vars: Record<string, string>): string {
  return content.replace(/\{\{([A-Z0-9_-]+)\}\}/g, (placeholder, key) => vars[key] ?? placeholder);
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

export function visitSkillFiles(
  effective: ReturnType<typeof resolveInstance>,
  visit: (dest: string, src: string) => void,
) {
  for (const skill of effective.skills.values()) {
    const source = skill.source === "core" ? skill.value.path : skill.source;
    const base = dirname(source);
    const dest = ".agents/skills/" + skill.id + "/";
    visit(dest + "SKILL.md", source);
    // Skill authors explicitly reference supporting files; adjacent private materials are never projected.
    const resources = new Set<string>();
    function link(href: string) {
      const path = href.split("#", 1)[0];
      if (path && !/^[a-z][a-z0-9+.-]*:/i.test(path)) {
        const unescaped = path.replace(/\\([!-/:-@\[-`{-~])/g, "$1");
        resources.add(decodeURIComponent(unescaped).replace(/^\.\//, ""));
      }
      return "";
    }
    Bun.markdown.render(skill.value.body, {
      link: (_, {href}) => link(href),
      image: (_, {src}) => link(src),
      codespan: path => {
        if (/^(references|assets|scripts)\/\S+$/.test(path)) resources.add(path);
        return "";
      },
    });
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
  function modelVars(prefix: string, tier: { model: string; effort: string }) {
    // Model placeholders occur inside TOML basic strings.
    vars[prefix + "_MODEL"] = JSON.stringify(tier.model).slice(1, -1);
    vars[prefix + "_EFFORT"] = tier.effort;
  }
  for (const [key, tier] of Object.entries(models.tiers))
    modelVars(key.toUpperCase(), tier);
  for (const role of reviewRoles)
    modelVars("REVIEW_" + role.toUpperCase(), reviewRoleModel(models, role));
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
  const skill_overrides = Object.fromEntries([...effective.skills.values()]
    .filter(skill => skill.source !== "core")
    .map(skill => [skill.id, relative(root, dirname(skill.source))]));
  return { assets, vars, skill_overrides };
}

export function install(root: string, kitRoot: string, previous?: InstallLock, force = false) {
  const manifest = loadKitManifest(kitRoot);
  const { assets, vars, skill_overrides } = managedPlan(kitRoot, root, manifest);
  const head = runGit(kitRoot, ["rev-parse", "HEAD"]);
  const lock: InstallLock = {
    kit_name: manifest.kit.name,
    kit_version: manifest.kit.version,
    kit_root: kitRoot,
    kit_commit: head.code === 0 ? head.stdout.trim() : null,
    workbench_name: vars.WORKBENCH_NAME,
    skill_overrides,
    updated_at: new Date().toISOString(),
  };
  ensureAuditIgnored(root);
  const preserved = installAssets(root, assets, lock, previous, force);
  return { root, lock, preserved };
}
