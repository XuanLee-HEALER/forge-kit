import { openSync, closeSync, constants, fstatSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { byPath, hasRepositoryMarker, inspectApplyPath, scanExclusions, type ApplyRepo } from "./catalog";

const maxDepth = 4;
const maxPaths = 400;
const maxEntries = 3000;
const maxEntriesPerDirectory = 3000;
const maxManifestBytes = 256 * 1024;
const names = ["check", "lint", "typecheck", "test", "build", "generate"] as const;
type Task = typeof names[number];
type Entry = { name: Task; source: string; cwd: string; argv?: string[]; declared: boolean };
type Stack = { name: string; sources: string[]; manager?: string };
type TreeEntry = { path: string; type: "directory" | "file" | "symlink" };

const manifestNames = [
  "go.mod", "go.work", "package.json", "bun.lock", "bun.lockb", "package-lock.json",
  "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "tsconfig.json",
  "pyproject.toml", "requirements.txt", "Pipfile", "Pipfile.lock", "poetry.lock", "uv.lock", "pytest.ini",
  "Cargo.toml", "Cargo.lock", "pom.xml", "mvnw", "build.gradle", "build.gradle.kts", "gradlew",
  "Makefile", "makefile", "GNUmakefile", "justfile", ".justfile",
];
const fixedFiles = [
  ".gitlab-ci.yml", ".circleci/config.yml", "Jenkinsfile", "azure-pipelines.yml",
  "Dockerfile", "Containerfile", "compose.yml", "compose.yaml", "docker-compose.yml", "docker-compose.yaml", "Chart.yaml",
];
const deployDirs = new Set(["deploy", "deployment", "deployments", "helm", "charts", "k8s", "kubernetes", "terraform", "infra"]);
const riskDirs = new Set([...deployDirs, "migration", "migrations", "secrets", "security"]);

export const pathIsIn = (parent: string, path: string) => parent === "." || parent === path || path.startsWith(parent + "/");
export const scanExcluded = (path: string) => path.split("/").some(segment => scanExclusions.has(segment));

function childPath(dir: string, path: string) {
  return dir === "." ? path : dir + "/" + path;
}

export function readApplyManifest(repo: Pick<ApplyRepo, "dir" | "boundaries">, path: string) {
  const present = inspectApplyPath(repo.dir, path, repo.boundaries);
  if (scanExcluded(present.path.slice(repo.dir.length + 1)) || !present.stat?.isFile() || !(present.stat.mode & 0o444) || present.stat.size > maxManifestBytes)
    throw Error("Manifest is inaccessible or exceeds the read limit.");
  const fd = openSync(present.path, constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_RDONLY);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxManifestBytes) throw Error("Manifest changed before it could be read.");
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}

function listPaths(repo: ApplyRepo, focus: string[], warnings: string[]) {
  const tree = new Map<string, TreeEntry>();
  const files = new Set<string>();
  const dirs = new Set<string>();
  const visibleManifestNames = new Map<string, string[]>();
  let inspected = 0;
  let truncated = false;
  const kind = (path: string) => {
    if (scanExcluded(path)) return;
    const abs = join(repo.dir, path);
    if (repo.boundaries.includes(abs)) return;
    const st = lstatSync(abs, { throwIfNoEntry: false });
    if (st?.isDirectory()) return path === "." || !hasRepositoryMarker(abs) ? "directory" : undefined;
    if (st?.isFile()) return "file";
    if (st?.isSymbolicLink()) return "symlink";
  };
  const addFile = (path: string) => {
    if (scanExcluded(path)) return;
    try {
      const current = inspectApplyPath(repo.dir, path, repo.boundaries);
      if (!current.stat?.isFile() || scanExcluded(current.path.slice(repo.dir.length + 1))) return;
      files.add(path);
      if (!(current.stat.mode & 0o444)) warnings.push("Could not read metadata path: " + JSON.stringify(path));
    } catch { warnings.push("Skipped unsafe metadata path: " + JSON.stringify(path)); }
  };
  const entries = (parent: string) => {
    const scan = inspectApplyPath(repo.dir, parent, repo.boundaries);
    if (!scan.stat?.isDirectory()) return [];
    if (scan.path !== join(repo.dir, parent) && scanExcluded(scan.path.slice(repo.dir.length + 1))) return [];
    if (!(scan.stat.mode & 0o444) || !(scan.stat.mode & 0o111))
      throw Error("Directory permissions prevent scanning.");
    const found = readdirSync(scan.path).sort(byPath);
    if (found.length > maxEntriesPerDirectory) truncated = true;
    else visibleManifestNames.set(parent, found.filter(name => manifestNames.includes(name)));
    return found.slice(0, maxEntriesPerDirectory);
  };
  const checkedEntries = (path: string) => {
    try { return entries(path); }
    catch { warnings.push("Could not scan directory: " + JSON.stringify(path)); return []; }
  };
  const visit = (path: string, remaining: number, followed?: "directory" | "file") => {
    if (++inspected > maxEntries) { truncated = true; return; }
    let type: TreeEntry["type"] | undefined;
    try { type = followed ?? kind(path); }
    catch { warnings.push("Could not inspect path: " + JSON.stringify(path)); return; }
    if (!type) return;
    if (path !== "." && tree.size < maxPaths) tree.set(path, { path, type });
    else if (path !== ".") truncated = true;
    if (type === "file") files.add(path);
    if (type !== "directory") return;
    dirs.add(path);
    if (remaining === 0) { truncated = true; return; }
    const found = checkedEntries(path);
    for (const name of found) {
      if (inspected >= maxEntries) { truncated = true; break; }
      visit(childPath(path, name), remaining - 1);
    }
    return found.length;
  };
  const ancestors = new Set(["."]);
  for (const path of focus.length ? focus : ["."]) {
    if (scanExcluded(path)) {
      warnings.push("Focus is excluded from scanning: " + JSON.stringify(path));
      continue;
    }
    const inspectedPath = inspectApplyPath(repo.dir, path, repo.boundaries);
    const followed = inspectedPath.stat?.isDirectory() ? "directory" : inspectedPath.stat?.isFile() ? "file" : undefined;
    if (scanExcluded(inspectedPath.path.slice(repo.dir.length + 1))) {
      warnings.push("Focus resolves to an excluded path: " + JSON.stringify(path));
      continue;
    }
    const count = visit(path, maxDepth, followed);
    if (!inspectedPath.stat) warnings.push("Focus path is absent from the worktree: " + JSON.stringify(path));
    else if (count === 0 && (focus.length || path === ".")) warnings.push("Empty directory: " + JSON.stringify(path));
    for (let parent = dirname(path); parent !== "."; parent = dirname(parent)) ancestors.add(parent);
  }
  for (const dir of new Set([...dirs, ...ancestors]))
    for (const path of visibleManifestNames.get(dir) ?? manifestNames) addFile(childPath(dir, path));
  for (const path of fixedFiles) addFile(path);
  for (const path of checkedEntries(".github/workflows").filter(path => /\.ya?ml$/i.test(path)))
    addFile(".github/workflows/" + path);
  if (truncated) warnings.push("Directory skeleton was truncated at the scan depth or entry limit.");
  return { tree: [...tree.values()].sort((a, b) => byPath(a.path, b.path)), files: [...files].sort(byPath), dirs, truncated };
}

const managers = {
  bun: ["bun.lock", "bun.lockb"],
  npm: ["package-lock.json", "npm-shrinkwrap.json"],
  pnpm: ["pnpm-lock.yaml"],
  yarn: ["yarn.lock"],
} as const;
type Manager = keyof typeof managers;
const managerNames = Object.keys(managers) as Manager[];

function forbidPattern(path: string, directory: boolean) {
  // Ship policy consumes globs. A filename containing glob syntax cannot be copied literally.
  return /[*?\[\]{}\\]/.test(path) ? undefined : directory ? path + "/**" : path;
}

export function scanFacts(repo: ApplyRepo, focus: string[]) {
  const warnings: string[] = [];
  const { tree, files, dirs, truncated } = listPaths(repo, focus, warnings);
  const byDir = new Map<string, Set<string>>();
  for (const path of files) {
    const dir = dirname(path);
    const names = byDir.get(dir) ?? new Set<string>();
    names.add(basename(path));
    byDir.set(dir, names);
  }
  const stack: Stack[] = [];
  const entrypoints: Entry[] = [];
  const workflows: { path: string; kind: string }[] = [];
  const deployment_signals: { path: string; kind: string }[] = [];
  const forbidden = new Set<string>();

  for (const [dir, present] of byDir) {
    const first = (...names: string[]) => names.find(name => present.has(name));
    const sources = (...names: string[]) => names.filter(name => present.has(name)).map(name => childPath(dir, name)).sort(byPath);
    const language = (name: string, ...files: string[]) => {
      const evidence = sources(...files);
      if (evidence.length) stack.push({ name, sources: evidence });
    };
    const add = (name: Task, source: string, argv: string[] | undefined, declared = false) => {
      entrypoints.push({ name, source: childPath(dir, source), cwd: dir === "." ? repo.repo : childPath(repo.repo, dir), ...(argv && { argv }), declared });
    };
    const read = (path: string) => {
      try { return readApplyManifest(repo, childPath(dir, path)); }
      catch { warnings.push("Could not safely read " + JSON.stringify(childPath(dir, path))); return ""; }
    };

    const go = first("go.mod", "go.work");
    if (go) {
      language("Go", "go.mod", "go.work");
      add("test", go, ["go", "test", "./..."]);
      add("build", go, ["go", "build", "./..."]);
      add("generate", go, ["go", "generate", "./..."]);
    }

    if (present.has("package.json")) {
      const evidence = sources("package.json", "tsconfig.json");
      let pkg: { packageManager?: unknown; scripts?: Record<string, unknown> } = {};
      try {
        const parsed = JSON.parse(read("package.json"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw Error();
        pkg = parsed;
      } catch { warnings.push("Invalid package.json: " + JSON.stringify(childPath(dir, "package.json"))); }
      const explicit = typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : undefined;
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
      for (const name of names)
        if (pkg.scripts && Object.hasOwn(pkg.scripts, name) && typeof pkg.scripts[name] === "string")
          add(name, "package.json", manager ? [manager, "run", name] : undefined, true);
    }

    const python = first("pyproject.toml", "requirements.txt", "Pipfile", "pytest.ini", "uv.lock", "poetry.lock", "Pipfile.lock");
    if (python) {
      language("Python", "pyproject.toml", "requirements.txt", "Pipfile", "pytest.ini", "uv.lock", "poetry.lock", "Pipfile.lock");
      if (present.has("pyproject.toml")) {
        try {
          const manifest = Bun.TOML.parse(read("pyproject.toml")) as { project?: { scripts?: Record<string, unknown> } };
          for (const name of names) {
            if (typeof manifest.project?.scripts?.[name] === "string")
              add(name, "pyproject.toml", present.has("uv.lock") ? ["uv", "run", name] : undefined, true);
          }
        } catch { warnings.push("Invalid pyproject.toml: " + JSON.stringify(childPath(dir, "pyproject.toml"))); }
      }
      add("test", python, ["python", "-m", "pytest"], present.has("pytest.ini"));
    }

    if (present.has("Cargo.toml")) {
      language("Rust", "Cargo.toml", "Cargo.lock");
      for (const name of ["check", "test", "build"] as const) add(name, "Cargo.toml", ["cargo", name]);
    }

    if (present.has("pom.xml")) {
      language("Java", "pom.xml", "mvnw");
      const runner = present.has("mvnw") ? "./mvnw" : "mvn";
      add("test", "pom.xml", [runner, "test"]);
      add("build", "pom.xml", [runner, "package"]);
    }
    const gradle = first("build.gradle", "build.gradle.kts");
    if (gradle) {
      language("Java", gradle, "gradlew");
      const runner = present.has("gradlew") ? "./gradlew" : "gradle";
      for (const name of ["check", "test", "build"] as const) add(name, gradle, [runner, name]);
      const text = read(gradle);
      for (const name of ["lint", "typecheck", "generate"] as const)
        if (new RegExp("(?:tasks\\.(?:register|create)\\s*\\(\\s*['\"]" + name + "['\"]|^\\s*task\\s+" + name + "\\b)", "m").test(text))
          add(name, gradle, [runner, name], true);
    }

    for (const [name, file, runner] of [
      ["Make", first("GNUmakefile", "makefile", "Makefile"), "make"],
      ["just", first("justfile", ".justfile"), "just"],
    ] as const) {
      if (!file) continue;
      language(name, file);
      const text = read(file);
      const targets = new Set<string>();
      for (const line of text.split("\n")) {
        const declaration = runner === "make"
          ? /^ *([\w./-]+(?:[ \t]+[\w./-]+)*)[ \t]*:(?![:]*=)/.exec(line)
          : /^([\w-]+)(?:[ \t]+[^:#]+)?[ \t]*:(?!=)/.exec(line);
        for (const target of declaration?.[1].split(/[ \t]+/) ?? []) targets.add(target);
      }
      for (const task of names)
        if (targets.has(task)) add(task, file, [runner, task], true);
      if (/^ *(?:-?include|sinclude|import|mod)\s|\$[({]|\{\{/m.test(text))
        warnings.push("Dynamic build definitions were not evaluated: " + JSON.stringify(childPath(dir, file)));
    }

    for (const filename of present) {
      const path = childPath(dir, filename);
      if (/^\.github\/workflows\/[^/]+\.ya?ml$/i.test(path))
        workflows.push({ path, kind: "github-actions" });
      else if ([".gitlab-ci.yml", ".circleci/config.yml", "Jenkinsfile", "azure-pipelines.yml"].includes(path))
        workflows.push({ path, kind: "ci" });
      if (/^(?:Dockerfile|Containerfile)(?:\.|$)/.test(filename))
        deployment_signals.push({ path, kind: "container" });
      else if (/^(?:docker-)?compose\.ya?ml$/.test(filename)) deployment_signals.push({ path, kind: "compose" });
      else if (filename === "Chart.yaml") deployment_signals.push({ path, kind: "helm" });
      else if (/\.(?:tf|tfvars)$/.test(filename)) deployment_signals.push({ path, kind: "terraform" });
      if (/^(?:\.github\/workflows\/|\.gitlab-ci\.yml$|\.circleci\/config\.yml$)/.test(path)) {
        const pattern = forbidPattern(path, false);
        if (pattern) forbidden.add(pattern);
      }
    }
  }
  for (const path of dirs) {
    const name = basename(path);
    if (deployDirs.has(name)) deployment_signals.push({ path, kind: "deployment-directory" });
    if (riskDirs.has(name)) {
      const pattern = forbidPattern(path, true);
      if (pattern) forbidden.add(pattern);
    }
  }
  const sortSource = (a: Entry, b: Entry) => byPath(a.source, b.source) || byPath(a.name, b.name);
  const sortSignal = (a: { path: string }, b: { path: string }) => byPath(a.path, b.path);
  entrypoints.sort(sortSource);
  const verification_actions = entrypoints.flatMap(({ argv, cwd, source }) =>
    argv ? [{ cwd, argv, purpose: "verify" as const, inputs: [basename(source)] }] : []);
  return { stack: stack.sort((a, b) => byPath(a.sources[0], b.sources[0]) || byPath(a.name, b.name)),
    entrypoints, workflows: workflows.sort(sortSignal), deployment_signals: deployment_signals.sort(sortSignal),
    tree, tree_truncated: truncated, verification_actions, forbidden_paths: [...forbidden].sort(byPath), warnings: [...new Set(warnings)].sort(byPath) };
}
