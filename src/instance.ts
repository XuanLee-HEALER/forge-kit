import { accessSync, constants, lstatSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, normalize, relative } from "node:path";
import { parse } from "yaml";
import { loadShipPolicy, loadWorkbenchConfig } from "./config";

export const CORE_SKILLS = [
  "ready",
  "grill",
  "feature",
  "bugfix",
  "review",
  "verify",
  "pr-triage",
  "ship",
] as const;
const retired: Record<string, string> = {
  "business-analysis": "grill",
  wrapup: "review, verify, ship",
  "test-environment": "verify",
  "implementation-review": "review",
  "simplicity-performance-review": "review",
  "code-simplification-review": "review",
  "comment-normalization-review": "review",
  "form-ux": "an instance-installed skill",
  dbop: "an instance-installed skill",
  "work-communication": "an instance-installed skill",
};

export function localPath(root: string, rel: string): string {
  if (!rel || isAbsolute(rel) || rel.split(/[\\/]/).includes("..") || rel.includes("\0"))
    throw Error(`Expected a relative path inside ${root}: ${rel}`);
  let path = root;
  for (const segment of rel.split("/").filter((s) => s && s !== ".")) {
    path = join(path, segment);
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())
      throw Error(`Symlink in managed path: ${path}`);
  }
  return path;
}

export function readRequired(file: string): Buffer {
  const st = statSync(file, { throwIfNoEntry: false });
  if (!st) throw Error(`Missing file ${file}; restore it and retry`);
  if (!st.isFile() || !(st.mode & 0o444)) throw Error(`Unreadable file ${file}; check type and permissions`);
  return readFileSync(file);
}

function record(v: unknown, field: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw Error(`${field} must be a mapping`);
  return v as Record<string, unknown>;
}
function str(v: unknown, field: string): string {
  if (typeof v !== "string" || !v.trim()) throw Error(`${field} must be a nonempty string`);
  return v;
}
function strings(v: unknown, field: string): string[] {
  if (!Array.isArray(v) || !v.length) throw Error(`${field} must be a nonempty array`);
  return v.map((s, i) => str(s, `${field}[${i}]`));
}
function known(v: Record<string, unknown>, keys: string[], path: string) {
  for (const key of Object.keys(v))
    if (!keys.includes(key)) throw Error(`Unknown field ${path}.${key}; use ${keys.join(", ")}`);
}
function load<T>(file: string, fn: (bytes: Buffer) => T): T {
  try {
    return fn(readRequired(file));
  } catch (e) {
    throw Error(
      `Configuration load failed at ${file}; check the file and retry. ${e instanceof Error ? e.message : e}`,
    );
  }
}

interface Action {
  argv: string[];
  cwd: string;
  purpose: string;
  inputs?: string[];
}
interface Stage {
  action: string;
  options: string[];
  observe?: string;
}
const deliveryPurposes = new Set(["deliver", "delivery", "deploy", "deployment", "ship", "release", "prod-write"]);
interface Skill {
  description: string;
  body: string;
  path: string;
}
interface Effective<T> {
  kind: string;
  id: string;
  value: T;
  source: string;
}

export function resolveInstance(root: string, kitRoot: string) {
  const file = localPath(root, ".workbench/workbench.yaml");
  const cfg = load(file, (bytes) => record(parse(bytes.toString(), {prettyErrors:false}), "workbench"));
  if ("name" in cfg) str(cfg.name, file + " name");
  if ("git_org" in cfg && typeof cfg.git_org !== "string") throw Error(file + " git_org must be a string");
  if ("repos" in cfg && (!Array.isArray(cfg.repos) || !cfg.repos.every((r) => typeof r === "string")))
    throw Error(`${file} repos must be a string list`);
  for (const section of ["guard", "ledger"]) {
    if (!(section in cfg)) continue;
    const fields = record(cfg[section], `${file} ${section}`);
    for (const [key, value] of Object.entries(fields)) {
      const label = `${file} ${section}.${key}`;
      if (["enabled","require_prod_db_hosts","block_shared_worktree_ops","block_ledger_direct_edits"].includes(key) && typeof value !== "boolean") throw Error(label+" must be a boolean");
      if (["retention_days","exempt_max_files","exempt_max_lines"].includes(key) && (!Number.isSafeInteger(value) || Number(value)<0)) throw Error(label+" must be a nonnegative integer");
      if (["prod_db_hosts","protected_branches","prod_tag_patterns","custom_block_patterns","exempt_allowed_globs","protected_code_globs"].includes(key)) {
        if (!Array.isArray(value) || !value.every(s=>typeof s==="string")) throw Error(label+" must be a string list");
        if (["prod_tag_patterns","custom_block_patterns"].includes(key)) for (const pattern of value) {
          try { new RegExp(pattern); } catch { throw Error(label+" contains an invalid regular expression"); }
        }
      }
      if (key==="prod_db_targets") {
        if (!Array.isArray(value)) throw Error(label+" must be a list of database targets");
        for (const target of value) str(record(target,label).host,label+".host");
      }
    }
  }
  const modelFile = process.env.FORGE_MODELS_TOML || localPath(root, ".workbench/models.toml");
  load(modelFile, (bytes) => {
    const tiers = record(record(Bun.TOML.parse(bytes.toString()), "models").tiers, "tiers");
    for (const name of ["mechanical", "standard", "deep"]) {
      // v0.4 instances may override individual tiers and inherit defaults for the rest.
      if (!Object.hasOwn(tiers, name)) continue;
      const tier = record(tiers[name], `tiers.${name}`);
      str(tier.model, `tiers.${name}.model`);
      if (!["low", "medium", "high", "xhigh"].includes(String(tier.effort)))
        throw Error(`Invalid tiers.${name}.effort`);
    }
  });
  load(localPath(root, ".workbench/ship-policy.yaml"), () => loadShipPolicy(root));
  const { repos } = load(file, () => loadWorkbenchConfig(root));
  const loc = `${file} extensions`;
  const ext = record(cfg.extensions === undefined ? {} : cfg.extensions, loc);
  known(ext, ["actions", "stages", "verification", "delivery", "skills"], loc);
  function section(name: string) {
    return record(ext[name] === undefined ? {} : ext[name], loc + "." + name);
  }
  function values<T>(name: string, decode: (v: unknown, id: string) => T) {
    const map = new Map<string, Effective<T>>();
    for (const [id, v] of Object.entries(section(name))) {
      if (!/^[a-zA-Z0-9][\w-]*$/.test(id)) throw Error(`Invalid ID ${loc}.${name}.${id}`);
      map.set(id, { kind: name.slice(0, -1), id, value: decode(v, id), source: file });
    }
    return map;
  }
  const actions = values<Action>("actions", (v, id) => {
    const path = `${loc}.actions.${id}`,
      a = record(v, path);
    known(a, ["argv", "cwd", "purpose", "inputs"], path);
    const argv = strings(a.argv, path + ".argv");
    const cwd = str(a.cwd ?? ".", path + ".cwd");
    const dir = localPath(root, cwd);
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory())
      throw Error(`${path}.cwd directory missing: ${cwd}`);
    const executable = Bun.which(argv[0], { cwd: dir });
    const mode = executable && statSync(executable, { throwIfNoEntry: false });
    if (!mode || !mode.isFile() || !(mode.mode & 0o111))
      throw Error(`${path}.argv[0] is not executable: ${argv[0]}; install the program or correct its path`);
    if (basename(argv[0]) === "forge" && ["instance", "verify", "ship"].includes(argv[1]))
      throw Error(`${path}.argv recursively invokes a workflow; configure the underlying program`);
    const action: Action = { argv, cwd, purpose: str(a.purpose, path + ".purpose") };
    if (a.inputs !== undefined) {
      if (!Array.isArray(a.inputs)) throw Error(path + ".inputs must be a list of relative files");
      action.inputs = a.inputs.map((value, index) => {
        const field = path + ".inputs[" + index + "]";
        const input = str(value, field);
        try {
          const path = localPath(dir, input),
            st = statSync(path);
          if (!st.isFile() || !(st.mode & 0o444)) throw Error("Expected a readable regular file: " + path);
          accessSync(path, constants.R_OK);
        } catch (error) {
          throw Error(field + ": " + String(error));
        }
        return normalize(input);
      });
      if (new Set(action.inputs).size !== action.inputs.length) throw Error(path + ".inputs repeats a file");
    }
    return action;
  });
  const stages = values<Stage>("stages", (v, id) => {
    const path = `${loc}.stages.${id}`,
      s = record(v, path);
    known(s, ["action", "options", "observe"], path);
    const action = str(s.action, path + ".action");
    if (!actions.has(action))
      throw Error(`${path}.action references unknown action ${action}; define it under actions`);
    const options =
      s.options === undefined || (Array.isArray(s.options) && !s.options.length)
        ? []
        : strings(s.options, path + ".options");
    if (s.observe === undefined) return { action, options };
    const observe = str(s.observe, path + ".observe");
    const observer = actions.get(observe)?.value;
    if (observe === action || observer?.purpose !== "observe")
      throw Error(path + ".observe must name a distinct read-only action with purpose observe");
    const write = actions.get(action)!.value;
    if (!deliveryPurposes.has(write.purpose))
      throw Error(path + ".observe is only valid for a delivery action");
    if (
      normalize(observer.cwd) === normalize(write.cwd) &&
      JSON.stringify(observer.argv) === JSON.stringify([...write.argv, ...options])
    )
      throw Error(path + ".observe must use a different command from the delivery action");
    return { action, options, observe };
  });
  for (const id of ["verify", "ship"])
    if (!stages.has(id))
      stages.set(id, { kind: "stage", id, source: "core", value: { action: id, options: [] } });
  function stageRefs(v: unknown, fallback: string[], name: string) {
    const refs = v === undefined ? fallback : strings(v, loc + "." + name + ".stages");
    for (const id of refs) {
      const stage = stages.get(id);
      if (!stage) throw Error(`${loc}.${name}.stages references unknown stage ${id}; define it under stages`);
      const purpose = stage.source === "core" ? id : actions.get(stage.value.action)!.value.purpose;
      const compatible = name === "verification" ? purpose === "verify" : deliveryPurposes.has(purpose);
      if (!compatible)
        throw Error(`${loc}.${name}.stages: stage ${id} has purpose ${purpose}; select a ${name} stage`);
    }
    return refs;
  }
  const v = section("verification"),
    d = section("delivery");
  known(v, ["environment", "stages"], loc + ".verification");
  known(d, ["endpoint", "stages"], loc + ".delivery");
  const verification = {
    kind: "verification",
    id: "default",
    source: ext.verification === undefined ? "core" : file,
    value: {
      environment: str(v.environment ?? "isolated", loc + ".verification.environment"),
      stages: stageRefs(v.stages, ["verify"], "verification"),
    },
  };
  const delivery = {
    kind: "delivery",
    id: "default",
    source: ext.delivery === undefined ? "core" : file,
    value: {
      endpoint: str(d.endpoint ?? "pr", loc + ".delivery.endpoint"),
      stages: stageRefs(d.stages, ["ship"], "delivery"),
    },
  };
  const overrides = section("skills");
  for (const id of Object.keys(overrides))
    if (!CORE_SKILLS.some((name) => name === id))
      throw Error(`${loc}.skills.${id}: unknown core skill; use ${retired[id] ?? CORE_SKILLS.join(", ")}`);
  const skills = new Map<string, Effective<Skill>>();
  for (const id of CORE_SKILLS) {
    const custom = Object.hasOwn(overrides, id);
    const dir = custom
      ? localPath(root, str(overrides[id], loc + ".skills." + id))
      : localPath(kitRoot, `core/.agents/skills/${id}`);
    if (custom && (relative(root, dir).startsWith(".agents/") || relative(root, dir).startsWith(".codex/")))
      throw Error(`${loc}.skills.${id}: keep private skill sources outside managed discovery directories`);
    const path = localPath(dir, "SKILL.md");
    const value = load(path, (bytes) => {
      const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(bytes.toString());
      if (!m) throw Error("Missing YAML front matter");
      const header = record(parse(m[1]), "front matter");
      if (header.name !== id) throw Error(`Expected stable skill name ${id}`);
      return { description: str(header.description, "description"), body: str(m[2], "body"), path };
    });
    skills.set(id, { kind: "skill", id, source: custom ? path : "core", value });
  }
  return { actions, stages, skills, verification, delivery, repos };
}

// Configured paths use the workbench namespace. Only paths belonging to the
// target repository are projected into its isolated checkout.
export function verificationStageCwd(root: string, repo: string, checkout: string, cwd: string, repos: string[]) {
  const configured = localPath(root, cwd);
  if (configured === root) return checkout;
  const path = relative(root, configured);
  const owner = [repo, ...repos].map(r => relative(root, localPath(root, r)))
    .filter(r => r && (path === r || path.startsWith(r + "/")))
    .sort((a, b) => b.length - a.length)[0];
  const target = relative(root, localPath(root, repo));
  if (owner && owner !== target) throw Error("Verification cwd belongs to another repository: " + cwd);
  if (!owner && (target || path === ".workbench" || path.startsWith(".workbench/"))) return configured;
  const subdir = relative(localPath(root, repo), configured);
  const mapped = subdir ? localPath(checkout, subdir) : checkout;
  if (!statSync(mapped, { throwIfNoEntry: false })?.isDirectory())
    throw Error("Verification cwd missing from the selected commit: " + cwd);
  return mapped;
}

export function runInstanceStage(
  root: string,
  kitRoot: string,
  id: string,
  verification?: { checkout: string; head: string; repo: string; config?: ReturnType<typeof resolveInstance> },
  onOutput?: (stdout: Uint8Array, stderr: Uint8Array) => void,
) {
  const cfg = verification?.config ?? resolveInstance(root, kitRoot),
    stage = cfg.stages.get(id);
  if (!stage) throw Error(`Unknown stage ${id}`);
  const action = cfg.actions.get(stage.value.action);
  if (
    (stage.source === "core" && id === "ship") ||
    cfg.delivery.value.stages.includes(id) ||
    (action && (deliveryPurposes.has(action.value.purpose) || /ship|deploy|deliver|release|prod.write/i.test(action.value.purpose)))
  )
    throw Error(`Stage ${id} requires the authorized forge ship executor`);
  if (!action) throw Error(`Use forge verify --task <task-id> to run the isolated core verification stage`);
  if (process.env.FORGE_ACTIVE_STAGE)
    throw Error(`Recursive stage invocation: ${process.env.FORGE_ACTIVE_STAGE} -> ${id}`);
  const { argv, cwd } = action.value;
  const proc = Bun.spawnSync([...argv, ...stage.value.options], {
    cwd: verification ? verificationStageCwd(root, verification.repo, verification.checkout, cwd, cfg.repos) : localPath(root, cwd),
    stdin: "ignore",
    stdout: onOutput ? "pipe" : "inherit",
    stderr: onOutput ? "pipe" : "inherit",
    env: {
      PATH: process.env.PATH,
      LANG: process.env.LANG,
      FORGE_ACTIVE_STAGE: id,
      ...(cfg.verification.value.stages.includes(id) ? {FORGE_VERIFY_ENVIRONMENT:cfg.verification.value.environment}:{}),
      ...(verification ? { FORGE_VERIFY_HEAD: verification.head } : {}),
      ...(verification && {
        FORGE_VERIFY_CHECKOUT: verification.checkout,
        FORGE_VERIFY_SHA: verification.head,
      }),
    },
  });
  if (onOutput) onOutput(proc.stdout ?? new Uint8Array(), proc.stderr ?? new Uint8Array());
  return proc.exitCode ?? 1;
}
