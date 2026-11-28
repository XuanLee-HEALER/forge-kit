import { basename, dirname } from "node:path";
import { byPath, inspectScanPath, type ApplyRepo } from "./catalog";
import { childPath, focusApplyTree, inventoryApplyRepo, readApplyManifest, skeletonApplyTree } from "./inventory";
import { compactForbiddenPaths, scanSignals } from "./signals";
import { collectWorkspaces } from "./workspaces";

export { scanExcluded } from "./catalog";
export { pathIsIn, readApplyManifest } from "./inventory";

const names = ["check", "lint", "typecheck", "test", "build", "generate", "migrate", "e2e", "integration", "codegen"] as const;
type Task = typeof names[number];
type Entry = { name: Task; source: string; cwd: string; argv?: string[]; declared: boolean };
type RankedEntry = Entry & { priority: number };
type Stack = { name: string; sources: string[]; manager?: string };

const manifestNames = [
  "go.mod", "go.work", "package.json", "bun.lock", "bun.lockb", "package-lock.json",
  "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "pnpm-workspace.yaml", "tsconfig.json",
  "pyproject.toml", "requirements.txt", "Pipfile", "Pipfile.lock", "poetry.lock", "uv.lock", "pytest.ini",
  "Cargo.toml", "Cargo.lock", "pom.xml", "mvnw", "build.gradle", "build.gradle.kts", "gradlew",
  "Makefile", "makefile", "GNUmakefile", "justfile", ".justfile",
];
const fixedCi = [".gitlab-ci.yml", ".circleci/config.yml", "Jenkinsfile", "azure-pipelines.yml"];
const recognizedMetadata = new Set(manifestNames);
const rootFiles = new Set([
  ...manifestNames, ...fixedCi.filter(path => !path.includes("/")),
  "Dockerfile", "Containerfile", "compose.yml", "compose.yaml", "docker-compose.yml", "docker-compose.yaml", "Chart.yaml",
  "README", "README.md", "README.rst", "README.txt", "CONTRIBUTING", "CONTRIBUTING.md", "AGENTS.md", "CLAUDE.md",
  ".golangci.yml", ".golangci.yaml", ".golangci.toml", ".golangci.json", "biome.json", "biome.jsonc",
  ".prettierrc", ".prettierrc.json", ".prettierrc.yml", ".prettierrc.yaml", "prettier.config.js", "prettier.config.mjs",
  ".eslintrc", ".eslintrc.json", "eslint.config.js", "eslint.config.mjs", "ruff.toml", ".ruff.toml",
  "mypy.ini", ".mypy.ini", "setup.cfg", "rustfmt.toml", ".rustfmt.toml", ".editorconfig",
]);
const deployDirs = new Set(["deploy", "deployment", "deployments", "helm", "charts", "k8s", "kubernetes", "terraform", "infra"]);
const riskDirs = new Set([...deployDirs, "migration", "migrations", "secrets", "security"]);
const managers = {
  bun: ["bun.lock", "bun.lockb"],
  npm: ["package-lock.json", "npm-shrinkwrap.json"],
  pnpm: ["pnpm-lock.yaml"],
  yarn: ["yarn.lock"],
} as const;
type Manager = keyof typeof managers;
const managerNames = Object.keys(managers) as Manager[];
const packageScripts: [Task, string][] = [...names.map((name): [Task, string] => [name, name]),
  ["migrate", "db:migrate"], ["e2e", "test:e2e"], ["integration", "test:integration"]];

function forbidPattern(path: string, directory: boolean) {
  // Ship policy consumes globs. A filename containing glob syntax cannot be copied literally.
  return /[*?\[\]{}\\]/.test(path) ? undefined : directory ? path + "/**" : path;
}

function declaredTargets(text: string, runner: "just" | "make") {
  const targets = new Map<string, boolean>();
  for (const line of text.split("\n")) {
    const declaration = runner === "make"
      ? /^ *([\w./-]+(?:[ \t]+[\w./-]+)*)[ \t]*:(?![:]*=)/.exec(line)
      : /^([\w-]+)(?:[ \t]+((?:"(?:[^"\\]|\\.)*"|'[^']*'|[^:#"'\r\n])+?))?[ \t]*:(?!=)/.exec(line);
    if (!declaration) continue;
    // Accept clear defaults and zero-or-more rest parameters in a just recipe.
    const optional = /^(?:(?:\*[\w-]+|\$?[\w-]+=(?:"(?:[^"\\]|\\.)*"|'[^']*'|[\w./-]+))(?:[ \t]+|$))+$/;
    const requiresArgs = Boolean(declaration[2]?.trim() && !optional.test(declaration[2].trim()));
    for (const target of declaration[1].split(/[ \t]+/))
      targets.set(target, Boolean(targets.get(target)) || requiresArgs);
  }
  return targets;
}

export function scanFacts(repo: ApplyRepo, focus: string[], options = { focusRequested: focus.length > 0 }) {
  const warnings: string[] = [];
  const inventory = inventoryApplyRepo(repo, rootFiles, warnings, !options.focusRequested);
  const { files, dirs, boundaries } = inventory;
  const scope = { ...repo, boundaries: [...boundaries].sort(byPath) };
  let tree;
  if (options.focusRequested) {
    const { tree: entries, tree_truncated, ...observed } =
      focusApplyTree(scope, focus, boundaries, recognizedMetadata, warnings);
    for (const key of ["files", "dirs", "symlinks", "unreadableFiles"] as const)
      for (const path of observed[key]) inventory[key].add(path);
    tree = { tree: entries, tree_truncated };
  } else tree = skeletonApplyTree(inventory, rootFiles, warnings);
  const scopedRepo = { ...scope, boundaries: [...boundaries].sort(byPath) };
  const byDir = new Map<string, Set<string>>();
  for (const path of [...files].sort(byPath)) {
    const dir = dirname(path);
    const names = byDir.get(dir) ?? new Set<string>();
    names.add(basename(path));
    byDir.set(dir, names);
  }
  const stack: Stack[] = [];
  const ranked: RankedEntry[] = [];
  const workflows: { path: string; kind: string }[] = [];
  const deployment_signals: { path: string; kind: string }[] = [];
  const forbidden = new Set<string>();
  const packageDirs = new Set<string>();
  const workspace = collectWorkspaces(scopedRepo, dirs, warnings);
  for (const path of inventory.unreadableFiles)
    if (recognizedMetadata.has(basename(path))) warnings.push("Could not safely read " + JSON.stringify(path));
  const readManifest = (path: string) => readApplyManifest(scopedRepo, path);
  const parse = <T>(source: string, parseText: (text: string) => T): T | undefined => {
    let text: string;
    try { text = readManifest(source); }
    catch { warnings.push("Could not safely read " + JSON.stringify(source)); return; }
    try { return parseText(text); }
    catch { warnings.push("Invalid manifest: " + JSON.stringify(source)); }
  };

  for (const [dir, present] of byDir) {
    const first = (...names: string[]) => names.find(name => present.has(name));
    const sources = (...names: string[]) => names.filter(name => present.has(name)).map(name => childPath(dir, name)).sort(byPath);
    const language = (name: string, ...files: string[]) => {
      const evidence = sources(...files);
      if (evidence.length) stack.push({ name, sources: evidence });
    };
    const add = (name: Task, source: string, argv: string[] | undefined, declared = false, priority = 3) => {
      const cwd = dir === "." ? repo.repo : childPath(repo.repo, dir);
      ranked.push({ name, source: childPath(dir, source), cwd, ...(argv && { argv }), declared, priority });
    };
    const read = <T>(path: string, parseText: (text: string) => T) => parse(childPath(dir, path), parseText);
    const runner = (wrapper: string, command: string) => {
      const path = childPath(dir, wrapper);
      if (!present.has(wrapper) && !inventory.symlinks.has(path)) return command;
      try {
        const stat = inspectScanPath(scopedRepo, path).stat;
        if (stat?.isFile() && (stat.mode & 0o111)) return "./" + wrapper;
      } catch { /* The unverified wrapper leaves the command unavailable. */ }
      warnings.push("Could not verify executable wrapper: " + JSON.stringify(path));
    };

    const go = first("go.mod", "go.work");
    if (go) {
      language("Go", "go.mod", "go.work");
      add("test", go, ["go", "test", "./..."]);
      add("build", go, ["go", "build", "./..."]);
      add("generate", go, ["go", "generate", "./..."]);
      if (present.has("go.mod")) packageDirs.add(dir);
      if (present.has("go.work")) read("go.work", text => workspace.go(childPath(dir, "go.work"), text));
    }

    if (present.has("package.json")) {
      packageDirs.add(dir);
      const evidence = sources("package.json", "tsconfig.json");
      const pkg = read("package.json", text => {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw Error();
        return parsed as { packageManager?: unknown; scripts?: Record<string, unknown>; workspaces?: unknown };
      });
      workspace.packageJson(childPath(dir, "package.json"), pkg?.workspaces);
      const explicit = typeof pkg?.packageManager === "string" ? pkg.packageManager.split("@")[0] : undefined;
      let lockEvidence: string[] = [];
      for (let parent = dir; ; parent = dirname(parent)) {
        const present = byDir.get(parent);
        const found = Object.values(managers).flat().filter(file => present?.has(file)).map(file => childPath(parent, file));
        if (found.length || parent === ".") { lockEvidence = found; break; }
      }
      const locked = managerNames.filter(manager => lockEvidence.some(file => (managers[manager] as readonly string[]).includes(basename(file))));
      const known = explicit && managerNames.find(manager => manager === explicit);
      const conflicted = locked.length > 1 || Boolean(explicit && (locked.length > 0 && locked[0] !== explicit));
      const manager = conflicted ? undefined : explicit ? known || undefined : locked[0];
      if (!manager) warnings.push((conflicted ? "Conflicting" : "Unknown") + " package manager: " + JSON.stringify(childPath(dir, "package.json")));
      stack.push({ name: "JavaScript/TypeScript", sources: [...evidence, ...lockEvidence].sort(byPath), ...(manager && { manager }) });
      for (const [name, script] of packageScripts)
        if (pkg?.scripts && Object.hasOwn(pkg.scripts, script) && typeof pkg.scripts[script] === "string")
          add(name, "package.json", manager ? [manager, "run", script] : undefined, true, 2);
    }
    if (present.has("pnpm-workspace.yaml"))
      read("pnpm-workspace.yaml", text => workspace.pnpm(childPath(dir, "pnpm-workspace.yaml"), text));

    const python = first("pyproject.toml", "requirements.txt", "Pipfile", "pytest.ini", "uv.lock", "poetry.lock", "Pipfile.lock");
    if (python) {
      language("Python", "pyproject.toml", "requirements.txt", "Pipfile", "pytest.ini", "uv.lock", "poetry.lock", "Pipfile.lock");
      if (present.has("pyproject.toml")) {
        packageDirs.add(dir);
        const manifest = read("pyproject.toml", text =>
          Bun.TOML.parse(text) as { project?: { scripts?: Record<string, unknown> } });
        for (const [name, script] of packageScripts)
          if (typeof manifest?.project?.scripts?.[script] === "string")
            add(name, "pyproject.toml", present.has("uv.lock") ? ["uv", "run", script] : undefined, true, 2);
      }
      add("test", python, ["python", "-m", "pytest"], present.has("pytest.ini"));
    }

    if (present.has("Cargo.toml")) {
      packageDirs.add(dir);
      language("Rust", "Cargo.toml", "Cargo.lock");
      read("Cargo.toml", text => workspace.cargo(childPath(dir, "Cargo.toml"), text));
      for (const name of ["check", "test", "build"] as const) add(name, "Cargo.toml", ["cargo", name]);
    }

    if (present.has("pom.xml")) {
      packageDirs.add(dir);
      language("Java", "pom.xml", "mvnw");
      const command = runner("mvnw", "mvn");
      add("test", "pom.xml", command ? [command, "test"] : undefined);
      add("build", "pom.xml", command ? [command, "package"] : undefined);
    }
    const gradle = first("build.gradle", "build.gradle.kts");
    if (gradle) {
      packageDirs.add(dir);
      language("Java", gradle, "gradlew");
      const command = runner("gradlew", "gradle");
      for (const name of ["check", "test", "build"] as const) add(name, gradle, command ? [command, name] : undefined);
      const text = read(gradle, value => value);
      for (const name of ["lint", "typecheck", "generate", "migrate", "e2e", "integration", "codegen"] as const)
        if (text && new RegExp("(?:tasks\\.(?:register|create)\\s*\\(\\s*['\"]" + name + "['\"]|^\\s*task\\s+" + name + "\\b)", "m").test(text))
          add(name, gradle, command ? [command, name] : undefined, true, 2);
    }

    for (const [name, file, command, priority] of [
      ["Make", first("GNUmakefile", "makefile", "Makefile"), "make", 1],
      ["just", first("justfile", ".justfile"), "just", 0],
    ] as const) {
      if (!file) continue;
      language(name, file);
      const text = read(file, value => value);
      if (!text) continue;
      const targets = declaredTargets(text, command);
      for (const task of names) {
        const parameterized = targets.get(task);
        if (parameterized === undefined) continue;
        add(task, file, parameterized ? undefined : [command, task], true, priority);
        if (parameterized) warnings.push("Check recipe arguments before running " + childPath(dir, file) + ": " + task);
      }
      if (/^ *(?:-?include|sinclude|import|mod)\s|\$[({]|\{\{/m.test(text))
        warnings.push("Dynamic build definitions were not evaluated: " + JSON.stringify(childPath(dir, file)));
    }

    for (const filename of present) {
      const path = childPath(dir, filename);
      if (/^(?:Dockerfile|Containerfile)(?:\.|$)/.test(filename))
        deployment_signals.push({ path, kind: "container" });
      else if (/^(?:docker-)?compose\.ya?ml$/.test(filename)) deployment_signals.push({ path, kind: "compose" });
      else if (filename === "Chart.yaml") deployment_signals.push({ path, kind: "helm" });
      else if (/\.(?:tf|tfvars)$/.test(filename)) deployment_signals.push({ path, kind: "terraform" });
    }
  }
  for (const path of fixedCi) {
    try {
      const item = inspectScanPath(scopedRepo, path);
      if (item.inaccessible) throw Error();
      if (!item.stat?.isFile()) continue;
      workflows.push({ path, kind: "ci" });
      if (path === ".gitlab-ci.yml" || path === ".circleci/config.yml") forbidden.add(path);
    } catch { warnings.push("Could not inspect CI path: " + JSON.stringify(path)); }
  }
  for (const path of dirs) {
    const name = basename(path);
    if (deployDirs.has(name)) deployment_signals.push({ path, kind: "deployment-directory" });
    if (riskDirs.has(name)) {
      const pattern = forbidPattern(path, true);
      if (pattern) forbidden.add(pattern);
    }
  }

  const { workflows: githubWorkflows, ...signals } = scanSignals(scopedRepo, { files, dirs }, focus, warnings, readManifest, options.focusRequested);
  if (githubWorkflows.length) forbidden.add(".github/workflows/**");

  const sortSource = (a: Entry, b: Entry) => byPath(a.source, b.source) || byPath(a.name, b.name) ||
    byPath(a.argv?.join("\0") ?? "", b.argv?.join("\0") ?? "");
  const best = new Map<string, RankedEntry>();
  for (const entry of ranked.sort(sortSource)) {
    if (!entry.argv || entry.name === "migrate") continue;
    const key = entry.cwd + "\0" + entry.name;
    const previous = best.get(key);
    if (!previous || entry.priority < previous.priority) best.set(key, entry);
  }
  const verification_actions = [...best.values()].sort(sortSource)
    .map(({ argv, cwd, source }) => ({ cwd, argv: argv!, purpose: "verify" as const, inputs: [basename(source)] }));
  const sortSignal = (a: { path: string }, b: { path: string }) => byPath(a.path, b.path);
  return { ...tree, ...signals,
    stack: stack.sort((a, b) => byPath(a.sources[0], b.sources[0]) || byPath(a.name, b.name)),
    entrypoints: ranked.map(({ priority: _, ...entry }) => entry),
    workflows: [...workflows, ...githubWorkflows].sort(sortSignal),
    workspaces: workspace.workspaces.sort((a, b) => byPath(a.source, b.source)),
    deployment_signals: deployment_signals.sort(sortSignal),
    verification_actions, forbidden_paths: compactForbiddenPaths(forbidden),
    warnings: [...new Set(warnings)].sort(byPath),
    packageDirs: [...packageDirs].sort(byPath),
    discoveredBoundaries: [...boundaries].sort(byPath),
  };
}
