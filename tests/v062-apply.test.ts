import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, readdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { digest, releaseCLI } from "./helpers/historical-kit";
import { sandbox, type Sandbox } from "./v05-sandbox";

type Signal = { path: string; kind: string };
type TreeEntry = { path: string; type: string; [field: string]: unknown };
type Entry = { name: string; source: string; cwd: string; argv?: string[]; declared: boolean };
type Action = { cwd: string; argv: string[]; inputs: string[]; purpose: string };
type Ranked = { path: string; count: number };
type ScanRepo = {
  repo: string; head: string | null; warnings: string[];
  tree: TreeEntry[]; tree_truncated: boolean;
  stack: { name: string; sources: string[]; manager?: string }[];
  workspaces: unknown[];
  entrypoints: Entry[]; verification_actions: Action[];
  convention_files: Signal[]; style_samples: { path: string }[];
  entry_signals: Signal[]; persistence_signals: Signal[];
  workflows: Signal[]; forbidden_paths: string[];
  git_flow: {
    current_branch: string | null; detached: boolean; long_lived_branches: { name: string; source: string }[];
    tag_prefixes: string[]; hook_paths: string[]; codeowners_paths: string[];
  };
  history: { available: boolean; shallow: boolean | null; truncated: boolean; commits_in_window: number | null; has_older_commits: boolean | null };
  dir_hotspots: Ranked[]; hotspots: Ranked[]; cochanges: { paths: string[]; count: number }[]; cochange_neighbors: Ranked[];
};

const bodyMarker = "V062_BODY_MARKER_READ_BOUNDARY";
const shellProbe = 'printf ran >> "$PROBE_LOG"';
const source = "export const fixture = true;\n// " + bodyMarker + "\n";
const names = ["empty", "history", "ops", "packages", "quiet"];
const activeWorkflow = Array.from({ length: 25 }, (_, i) => `.github/workflows/ci-${i}.yml`);
const disabledWorkflow = Array.from({ length: 25 }, (_, i) => `.github/workflows/off-${i}.yaml.disabled`);
const activeSources = ["src/api/route.ts", "src/catalog/item.ts", "src/catalog/price.ts", "src/jobs/refresh.ts", "src/store/item.ts", "src/store/other.ts"];
const excluded = [".DS_Store", ".claude", ".codex", ".agents", ".env", ".env.production", "target", "node_modules", "vendor", "dist", "build", ".venv", ".workbench"];
const sourceControls = ["src/api/smoke.test.ts", "src/generated/api.generated.ts", "src/removed.ts", "src/unreadable.ts"];
const documentWords = ["convention", "guideline", "style", "architecture"];
const indexedDocs = Array.from({ length: 160 }, (_, i) => `docs/chapter-${i % 5}/section-${i % 3}/${documentWords[i % 4]}-${i}.md`);
const manyDirectories = Array.from({ length: 35 }, (_, i) => `ahead-${String(i).padStart(3, "0")}`);
const roots = new Set(["package.json", "pnpm-workspace.yaml", "go.mod", "go.work", "Cargo.toml", "pyproject.toml",
  "tsconfig.json", "justfile", "makefile", "README.md", "CONTRIBUTING.md", "AGENTS.md", "CLAUDE.md", ".gitmodules",
  ".golangci.yml", "biome.json", ".prettierrc", "eslint.config.js", "rustfmt.toml", ".editorconfig",
  "docker-compose.yml", "lefthook.yml"]);

const gitDate = (age: number) => new Date(epoch - age * 86_400_000).toISOString();
let epoch: number;
let s: Sandbox;
let network: string[];
let measured: { stdout: string; repos: ScanRepo[] };
let permissionPath: string;

function initialize() {
  s = sandbox();
  const cli = releaseCLI(s);
  s.ok([cli, "init", s.work]);
  s.env.GIT_OPTIONAL_LOCKS = "0";
  s.env.GIT_AUTHOR_NAME = s.env.GIT_COMMITTER_NAME = "Forge V062 Fixture";
  s.env.GIT_AUTHOR_EMAIL = s.env.GIT_COMMITTER_EMAIL = "fixture@example.invalid";
}

function git(name: string, ...args: string[]) {
  return s.git(join(s.work, name), ...args);
}

function repo(name: string, registered = true) {
  const path = join(s.work, name);
  mkdirSync(path, { recursive: true });
  git(name, "init", "-b", "main");
  if (registered) s.ok([s.forge, "add-repo", path, "--workbench", s.work]);
  return path;
}

function write(name: string, files: Record<string, string | null>) {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) rmSync(join(s.work, name, path));
    else s.privateFile(join(name, path), content);
  }
}

function commit(name: string, title: string, files: Record<string, string | null>, age: number) {
  write(name, files);
  git(name, "add", "-f", "--", ...Object.keys(files));
  s.ok(["env", `GIT_COMMITTER_DATE=${gitDate(age)}`, "git", "-C", join(s.work, name),
    "commit", "--date", gitDate(age), "-m", title]);
}

function scan(...args: string[]) {
  const result = s.run([...network, s.forge, "apply", ...args, "--json"]);
  expect(result.code, result.out + result.err).toBe(0);
  const parsed = JSON.parse(result.out) as { repos: ScanRepo[] };
  return { stdout: result.out, repos: parsed.repos };
}

const selected = (name: string, ...args: string[]) => scan("--repo", name, ...args).repos[0];
const initial = (name: string) => measured.repos.find(item => item.repo === name)!;
const paths = (entries: { path: string }[]) => entries.map(entry => entry.path);
const copies = (data: string, list: string[]) => Object.fromEntries(list.map(path => [path, data]));
const packageManifest = (manager: string, scripts: string[], workspaces?: string[]) =>
  JSON.stringify({ name: "v062-fixture", packageManager: manager, scripts: copies("./probe", scripts), workspaces });

function snapshots(root: string, relative = ""): string[] {
  const path = join(root, relative);
  const stat = lstatSync(path);
  const entry = `${relative} ${stat.mode} ${stat.mtimeMs} ${stat.ctimeMs}`;
  if (stat.isSymbolicLink()) return [entry + " " + readlinkSync(path)];
  if (stat.isFile()) return stat.mode & 0o444 ? [entry + " " + digest(path)] : [entry];
  if (!stat.isDirectory() || !(stat.mode & 0o444)) return [entry];
  return [entry, ...readdirSync(path).sort().flatMap(item => snapshots(root, join(relative, item)))];
}

function control(command: string[]) {
  return s.run(command).code;
}

function offline() {
  let isolation: string[];
  if (process.platform === "darwin") {
    isolation = ["/usr/bin/sandbox-exec", "-p", "(version 1) (allow default) (deny network*)"];
  } else {
    // The parent environment may already supply a network namespace on Linux.
    isolation = ["/usr/bin/unshare", "--user", "--map-root-user", "--net", "--"];
  }
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  try {
    const connect = ["bun", "-e", "const socket = await Bun.connect({hostname:'127.0.0.1',port:" + listener.port
      + ",socket:{data(){}}}); socket.end();"];
    expect(control(connect), "the unconfined process can reach the host loopback listener").toBe(0);
    expect(control([...isolation, "/bin/sh", "-c", ":"]), "the network wrapper executes a process").toBe(0);
    expect(control([...isolation, ...connect]), "the wrapped process cannot reach the same listener").not.toBe(0);
    console.log(`A01 offline_probe wrapper=${isolation[0]} host_connect=success isolated_connect=denied`);
  } finally {
    listener.stop(true);
  }
  return isolation;
}

beforeAll(() => {
  epoch = Date.now();
  initialize();
  names.forEach(name => repo(name));
  repo("unregistered", false);
  write("unregistered", { "not-selected.txt": "unregistered" });
  write("empty", { "pyproject.toml": '[project]\nname = "empty-v062"\n' });
  commit("quiet", "Old local history", { "src/silent/old.ts": source }, 120);

  const noise = Object.fromEntries(excluded.map(path => [
    path === ".DS_Store" || /^\.env(?:\.|$)/.test(path) ? path : path + "/NOISE_ONLY.ts",
    bodyMarker,
  ]));
  const environmentTemplates = [".env.example", ".env.test.example", "service.example.env", "service.example.yaml"];
  commit("packages", "Seed package and source evidence", {
    "package.json": packageManifest("npm@10.0.0", ["check", "lint", "test", "migrate", "e2e", "integration", "codegen"], ["modules/*", "absent-js"]),
    "pnpm-workspace.yaml": 'packages:\n  - "modules/*"\n  - "absent-pnpm"\n',
    "go.mod": "module example.invalid/fixture\ngo 1.22\n",
    "modules/real/package.json": packageManifest("npm@10.0.0", ["test"]),
    "unlisted/no-member.txt": "existing directory without a workspace declaration",
    "modules/unknown/package.json": packageManifest("alien@1.0.0", ["e2e"]),
    "modules/broken/package.json": "{malformed JSON!",
    "modules/arguments/justfile": `test target:\n  ${shellProbe}\n`,
    "modules/arguments/makefile": `test:\n\t${shellProbe}\n`,
    "justfile": `test mode='local':\n  ${shellProbe}\n`,
    "makefile": `include $(shell ${shellProbe})\n\ntest check:\n\t${shellProbe}\n`,
    "probe": "#!/bin/sh\n" + shellProbe + "\n",
    "tsconfig.json": "{}",
    ".golangci.yml": "version: '2'\n# " + bodyMarker,
    "biome.json": "{}",
    ".prettierrc": "{}",
    "eslint.config.js": "export default []; // " + bodyMarker,
    "pyproject.toml": '[project]\nname = "style-fixture"\n[tool.ruff]\nline-length = 100\n[tool.mypy]\nstrict = true\n',
    "rustfmt.toml": "edition = '2021'\n",
    ".editorconfig": "root = true\n",
    ...copies(bodyMarker, ["README.md", "CONTRIBUTING.md", "AGENTS.md", "CLAUDE.md", "docs/000-overview.md", "docs/deep/plain/overview.md"]),
    ...copies(bodyMarker, indexedDocs),
    ...copies(bodyMarker, environmentTemplates),
    ...copies(source, activeSources),
    ...copies(source, sourceControls),
    ...copies(bodyMarker, ["notes/active.md", "locks/Cargo.lock", "db/migrations/001_init.sql"]),
    ...noise,
  }, 6);
  commit("packages", "Cochange outside focus and noise controls", {
    "src/api/route.ts": source + "\n",
    "src/jobs/refresh.ts": source + "\n",
    "src/store/item.ts": source + "\n",
    ...Object.fromEntries(Object.keys(noise).map(path => [path, bodyMarker + "\n"])),
    ...copies(bodyMarker + "\n", ["notes/active.md", "locks/Cargo.lock", "db/migrations/001_init.sql"]),
  }, 5);
  commit("packages", "Repeat cochanges to show ranking and focus neighbors", {
    "src/api/route.ts": source + "\n\n",
    "src/jobs/refresh.ts": source + "\n\n",
    "src/store/item.ts": source + "\n\n",
    "src/api/smoke.test.ts": source + "/* tests */",
    "src/generated/api.generated.ts": source + "/* generated */",
    "src/removed.ts": source + "/* obsolete */",
    "src/unreadable.ts": source + "/* protected */",
  }, 4);
  for (const age of [3, 2]) {
    commit("packages", "More active non-business and inaccessible files", {
      ...copies(bodyMarker + "\n".repeat(age + 3), ["notes/active.md", "locks/Cargo.lock", "db/migrations/001_init.sql"]),
      ...copies(source + "\n".repeat(age), sourceControls),
      "eslint.config.js": "export default []; // " + bodyMarker + age,
    }, age);
  }
  write("packages", {
    "regular-root.txt": "ordinary root file",
    "src/removed.ts": null,
    "src/uncommitted.ts": source,
    "src/catalog/a/b/deep.ts": source,
    "src/catalog/a/tsconfig.json": "{}",
    "src/api/dirty.ts": source,
    ...copies(source, Array.from({ length: 445 }, (_, i) => `src/bulk/one/two/inner-${i}.ts`)),
  });
  for (const path of manyDirectories) mkdirSync(join(s.work, "packages", path));
  permissionPath = join(s.work, "packages/src/unreadable.ts");
  chmodSync(permissionPath, 0);
  chmodSync(join(s.work, "packages/probe"), 0o755);
  const nested = repo("packages/src/catalog/nested", false);
  write("packages/src/catalog/nested", { "NESTED_ONLY.ts": source });
  const origin = repo("module-origin", false);
  commit("module-origin", "Submodule content", { "SUBMODULE_ONLY.ts": source }, 5);
  git("packages", "-c", "protocol.file.allow=always", "submodule", "add", origin, "src/catalog/submodule");
  git("packages", "commit", "-m", "Pin local submodule");
  const external = join(s.root, "outside");
  mkdirSync(external);
  s.ok(["/bin/sh", "-c", 'printf "outside" > "$1"', "fixture", join(external, "EXTERNAL_ONLY.ts")]);
  symlinkSync(external, join(s.work, "packages/src/catalog/escaping"));
  expect(existsSync(nested)).toBe(true);

  commit("ops", "Tooling and delivery evidence", {
    "go.work": "go 1.22\nuse (\n   ./services/api\n   ./absent-go\n)\n",
    "services/api/go.mod": "module example.invalid/api\ngo 1.22\n",
    "Cargo.toml": '[workspace]\nmembers = ["crates/persist", "absent-cargo"]\n',
    "crates/persist/Cargo.toml": '[package]\nname = "persist"\nversion = "0.1.0"\n',
    ...copies("name: qualified fixture workflow\n", activeWorkflow.concat(disabledWorkflow)),
    "deploy/terraform/main.tf": "# deployment declaration",
    "deploy/helm/Chart.yaml": "name: fixture",
    "security/policy.yaml": "audit: true",
    "docker-compose.yml": "services:\n  database:\n    image: example.invalid/fixture\n",
    "prisma/schema.prisma": "// fixture schema",
    "src/orm/schema.ts": source,
    ".husky/pre-commit": "#!/bin/sh\n" + shellProbe + "\n",
    "scripts/hooks/pre-push": "#!/bin/sh\n" + shellProbe + "\n",
    "lefthook.yml": "pre-commit: {}\n",
    ".github/CODEOWNERS": "* @fixture-owner\n",
    ...copies(source, ["api/rest.ts", "proto/service.proto", "routes/api.ts", "handlers/request.ts",
      "controllers/item.ts", "openapi.yaml", "consumers/queue.ts", "workers/work.ts", "jobs/batch.ts", "cron/schedule.ts",
      "cmd/service/main.go", "bin/start", "server/index.ts"]),
    "ordinary.txt": "api routes migration prisma workers schema " + bodyMarker,
  }, 3);
  git("ops", "branch", "develop");
  const opsHead = git("ops", "rev-parse", "HEAD").trim();
  for (const branch of ["main", "release"]) git("ops", "update-ref", "refs/remotes/origin/" + branch, opsHead);
  for (const version of ["v2.1.0", "v2.2.0", "v2.3.0"]) {
    s.ok(["env", `GIT_COMMITTER_DATE=${gitDate(2)}`, "git", "-C", join(s.work, "ops"), "tag", "-a", version, "-m", version]);
  }
  git("ops", "remote", "add", "origin", "https://example.invalid/should-not-resolve");
  symlinkSync(external, join(s.work, "ops/api/external-ignored.ts"));
  git("ops", "config", "core.hooksPath", ".husky");
  chmodSync(join(s.work, "ops/.husky/pre-commit"), 0o755);
  const fsmonitor = s.privateFile("ops/scripts/hooks/fsmonitor", "#!/bin/sh\n" + shellProbe + "\nexit 1\n");
  chmodSync(fsmonitor, 0o755);
  git("ops", "config", "core.fsmonitor", "scripts/hooks/fsmonitor");

  commit("history", "Out of window commit", { "src/old/older.ts": source }, 35);
  commit("history", "Two files one directory, with neighbors", {
    "src/logic/a.ts": source, "src/logic/b.ts": source, "src/neighbor/friend.ts": source,
  }, 5);
  commit("history", "Update only one logic file and neighbor", {
    "src/logic/a.ts": source + "\n", "src/neighbor/friend.ts": source + "\n", "src/also/same.ts": source,
  }, 4);
  commit("history", "Rank tie and listed-then-truncated directories", copies(source,
    Array.from({ length: 25 }, (_, i) => `src/tie-${String(i).padStart(2, "0")}/fixture.ts`)), 3);
  commit("history", "Window count includes noise-only commits", copies(bodyMarker,
    ["documents/architecture.md", "migration/001.sql", "somewhere/bun.lock", "somewhere/generated.gen.ts", "elsewhere/fixture.spec.ts"]), 2);
  git("history", "switch", "-c", "unreachable-from-head");
  commit("history", "Exclude this branch from history", { "src/not-reachable/excluded.ts": source }, 1);
  git("history", "switch", "main");
  git("history", "switch", "-c", "merge-branch");
  commit("history", "Reachable through merge", { "src/merged/member.ts": source }, 1);
  git("history", "switch", "main");
  s.ok(["env", `GIT_COMMITTER_DATE=${gitDate(0.5)}`, "git", "-C", join(s.work, "history"),
    "merge", "--no-ff", "-m", "Merge excluded from counts", "merge-branch"]);
  write("history", { ".github/workflows/disabled.yml.disabled": "name: stopped\n" });

  for (const command of ["make", "just", "python", "go", "cargo", "pnpm", "yarn", "uv", "curl", "wget", "gh", "codex", "openai"]) {
    const probe = s.privateFile("../bin/" + command, "#!/bin/sh\n" + shellProbe + "\nexit 97\n");
    chmodSync(probe, 0o755);
  }
  network = offline();
  measured = scan();
}, 60_000);

afterAll(() => {
  if (permissionPath && existsSync(permissionPath)) chmodSync(permissionPath, 0o600);
  if (s) {
    s.cleanup();
    expect(existsSync(s.root)).toBe(false);
  }
});

test("A01 scans five selected repositories read-only with network and tool probes", () => {
  expect(measured.repos.map(repo => repo.repo)).toEqual(names);
  const before = snapshots(s.root);
  expect(scan(s.work).stdout).toBe(measured.stdout);
  expect(scan("--repo", "ops", "--repo", "packages").repos.map(repo => repo.repo)).toEqual(["ops", "packages"]);
  const warnings = initial("packages").warnings;
  expect(warnings.find(warning => /invalid|malformed/i.test(warning))).toContain("modules/broken/package.json");
  expect(initial("packages").stack.some(stack => stack.name === "Go")).toBe(true);
  for (const marker of ["NESTED_ONLY.ts", "SUBMODULE_ONLY.ts", "EXTERNAL_ONLY.ts", "not-selected.txt"]) {
    expect(measured.stdout).not.toContain(marker);
  }
  for (const args of [["--repo", "unknown"], ...[join(s.root, "outside"), "../outside", "src/catalog/escaping"]
    .map(path => ["--repo", "packages", "--focus", path])]) {
    const result = s.run([...network, s.forge, "apply", ...args, "--json"]);
    expect(result.code).not.toBe(0);
    expect(result.out + result.err).toMatch(/repo|unknown|path|relative|escape|outside|路径|越界/i);
    expect(result.out + result.err).not.toContain("EXTERNAL_ONLY.ts");
  }
  expect(existsSync(s.probeLog)).toBe(false);
  expect(snapshots(s.root)).toEqual(before);
}, 30_000);

test("A02 excludes early and frequent noise while preserving template evidence and stable order", () => {
  for (const repo of measured.repos) {
    const facts = [
      ...paths(repo.tree), ...paths(repo.hotspots), ...paths(repo.dir_hotspots), ...paths(repo.style_samples),
      ...paths(repo.cochange_neighbors), ...repo.cochanges.flatMap(pair => pair.paths), ...paths(repo.convention_files),
      ...paths(repo.entry_signals), ...paths(repo.persistence_signals), ...paths(repo.workflows), ...repo.forbidden_paths,
      ...repo.entrypoints.map(entry => entry.source), ...repo.stack.flatMap(stack => stack.sources),
    ];
    for (const fact of facts) for (const segment of fact.split("/")) {
      expect(excluded.includes(segment), fact).toBe(false);
    }
  }
  expect(measured.stdout).not.toContain("NOISE_ONLY.ts");
  expect(measured.stdout).not.toContain(bodyMarker);
  expect(paths(initial("packages").persistence_signals)).toEqual(expect.arrayContaining([".env.example", ".env.test.example"]));
  expect(scan().stdout).toBe(measured.stdout);
}, 30_000);

test("A03 five-repo pretty JSON is under 100 KiB and counts ordinary visible files by directory", () => {
  const bytes = Buffer.byteLength(measured.stdout);
  console.log(`A03 five repos stdout_bytes=${bytes} tree_entries=${measured.repos.map(repo => repo.repo + "=" + repo.tree.length).join(",")}`);
  expect(bytes).toBeLessThan(102400);
  expect(measured.stdout).toContain('\n  "repos": [\n');
  for (const repo of measured.repos) {
    const listedRoots = readdirSync(join(s.work, repo.repo));
    expect(new Set(paths(repo.tree)).size).toBe(repo.tree.length);
    for (const entry of repo.tree) {
      if (entry.type === "directory") expect(entry.path).toMatch(/^[^/]+(?:\/[^/]+)?$/);
      else {
        expect(entry.type).toBe("file");
        expect(roots.has(entry.path), entry.path).toBe(true);
        expect(listedRoots, entry.path).toContain(entry.path);
      }
    }
  }
  const pkg = initial("packages");
  expect(paths(pkg.tree)).toEqual(expect.arrayContaining(["package.json", "go.mod", "src", "src/catalog", "src/bulk"]));
  expect(paths(initial("ops").tree)).toContain("Cargo.toml");
  for (const omitted of ["regular-root.txt", "src/catalog/a", "src/catalog/a/tsconfig.json", "src/catalog/escaping"]) {
    expect(paths(pkg.tree)).not.toContain(omitted);
  }
  const catalog = pkg.tree.find(item => item.path === "src/catalog");
  // item.ts and price.ts are direct. The deep source and the nested tsconfig also contribute.
  expect(catalog).toMatchObject({ direct_files: 2, recursive_files: 4, counts_complete: true });
  expect(pkg.tree.find(item => item.path === "src/bulk")).toMatchObject({ direct_files: 0, recursive_files: 445, counts_complete: true });
  expect(pkg.tree.find(item => item.path === "src")).toMatchObject({ direct_files: 2, recursive_files: 458, counts_complete: true });
});

test("A03 permission denial gives partial local counts, a path diagnostic and recovery", () => {
  write("packages", { "src/catalog/protected/secret.ts": source, "src/catalog/protected/package.json": packageManifest("npm@10.0.0", []),
    "src/catalog/a/secret.ts": source });
  const unreadableDirectory = join(s.work, "packages/src/catalog/protected");
  const unreadableManifest = join(s.work, "packages/modules/real/package.json");
  try {
    try {
      chmodSync(unreadableDirectory, 0);
      chmodSync(unreadableManifest, 0);
      expect(() => readdirSync(unreadableDirectory)).toThrow(/EACCES|EPERM/);
      expect(() => { const fd = openSync(unreadableManifest, "r"); closeSync(fd); }).toThrow(/EACCES|EPERM/);
      const blocked = selected("packages");
      expect(blocked.warnings.join("\n")).toContain("src/catalog/protected");
      expect(blocked.warnings.join("\n")).toContain("modules/real/package.json");
      expect(blocked.stack.map(item => item.name)).toContain("Go");
      expect(blocked.tree.find(item => item.path === "src/catalog")).toMatchObject({
        direct_files: 2, recursive_files: 5, counts_complete: false,
      });
      console.log(`A03 permission_probe uid=${process.geteuid?.()} chmod=000 open=denied readdir=denied`);
    } finally {
      chmodSync(unreadableDirectory, 0o755);
      chmodSync(unreadableManifest, 0o600);
    }
    const recovered = selected("packages");
    expect(recovered.tree.find(item => item.path === "src/catalog"))
      .toMatchObject({ direct_files: 2, recursive_files: 7, counts_complete: true });
    expect(paths(selected("packages", "--focus", "src/catalog/protected").tree)).toContain("src/catalog/protected/secret.ts");
    expect(recovered.warnings.join("\n")).not.toContain("src/catalog/protected");
    console.log("A03 permission_probe restored=true count=7 focus_secret=present");
  } finally {
    rmSync(unreadableDirectory, { recursive: true, force: true });
    rmSync(join(s.work, "packages/src/catalog/a/secret.ts"), { force: true });
  }
}, 30_000);

test("A03 entry pressure preserves src and marks exhausted counts separately from tree truncation", () => {
  const directory = join(s.work, "packages/000-000-entry-pressure");
  try {
    write("packages", copies(source, Array.from({ length: 3500 }, (_, i) => `000-000-entry-pressure/deep/file-${i}.ts`)));
    for (let i = 0; i < 430; i++) mkdirSync(join(directory, "..", "000-ahead-" + i));
    const pressured = selected("packages");
    expect(pressured.tree_truncated).toBe(true);
    expect(paths(pressured.tree)).toContain("src");
    const counts = pressured.tree.find(item => item.path === "000-000-entry-pressure");
    expect(counts).toMatchObject({ direct_files: 0, counts_complete: false });
    expect(counts?.recursive_files).toBeGreaterThan(0);
    expect(counts?.recursive_files).toBeLessThan(3500);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    for (let i = 0; i < 430; i++) rmSync(join(directory, "..", "000-ahead-" + i), { recursive: true, force: true });
  }
}, 30_000);

test("A04 multiple focus paths show file scope, repository facts and cochange neighbors", () => {
  const focus = selected("packages", "--focus", "src/api", "--focus", "src/catalog/a");
  expect(paths(focus.tree)).toEqual(expect.arrayContaining(["src/api/route.ts", "src/catalog/a/b/deep.ts"]));
  expect(paths(focus.tree)).not.toContain("src/store/item.ts");
  expect(paths(focus.tree)).not.toContain("src/jobs/refresh.ts");
  const rootStack = initial("packages").stack.filter(entry => entry.sources.every(path => !path.includes("/")));
  expect(rootStack.map(entry => entry.name)).toEqual(expect.arrayContaining(["Go", "JavaScript/TypeScript"]));
  expect(focus.stack).toEqual(expect.arrayContaining(rootStack));
  expect(focus.workspaces).toEqual(initial("packages").workspaces);
  expect(focus.cochange_neighbors).toContainEqual({ path: "src/store", count: 3 });
  expect(focus.cochange_neighbors).toContainEqual({ path: "src/jobs", count: 3 });
  const large = selected("packages", "--focus", "src/bulk");
  expect(large.tree_truncated).toBe(true);
  expect(large.tree.filter(item => item.type === "file").length).toBeGreaterThan(0);
  expect(large.tree.filter(item => item.type === "file").length).toBeLessThan(445);
}, 30_000);

test("A04 workspace declarations retain sources and declared member paths or patterns", () => {
  for (const [repo, sourcePath, members] of [
    ["packages", "package.json", ["modules/*", "absent-js"]],
    ["packages", "pnpm-workspace.yaml", ["modules/*", "absent-pnpm"]],
    ["ops", "go.work", ["services/api", "absent-go"]],
    ["ops", "Cargo.toml", ["crates/persist", "absent-cargo"]],
  ] as const) {
    const record = initial(repo).workspaces.find(item => JSON.stringify(item).includes(`"${sourcePath}"`));
    expect(record, sourcePath).toBeDefined();
    for (const member of members) expect(JSON.stringify(record)).toMatch(new RegExp(member.replace(/\*/g, "\\*")));
    expect(JSON.stringify(record)).not.toContain("unlisted");
  }
  expect(paths(initial("packages").tree)).toContain("unlisted");
});

test("A05 verification suggestions rank executable sources by task and cwd", () => {
  const { entrypoints, verification_actions: actions } = initial("packages");
  const rootTests = entrypoints.filter(entry => entry.name === "test" && entry.cwd === "packages");
  expect(rootTests).toEqual(expect.arrayContaining([
    { name: "test", source: "justfile", cwd: "packages", declared: true, argv: ["just", "test"] },
    { name: "test", source: "makefile", cwd: "packages", declared: true, argv: ["make", "test"] },
    { name: "test", source: "package.json", cwd: "packages", declared: true, argv: ["npm", "run", "test"] },
    { name: "test", source: "go.mod", cwd: "packages", declared: false, argv: ["go", "test", "./..."] },
  ].map(entry => expect.objectContaining(entry))));
  expect(actions.filter(action => action.cwd === "packages" && action.argv.includes("test")))
    .toEqual([expect.objectContaining({ argv: ["just", "test"], inputs: ["justfile"], purpose: "verify" })]);
  for (const [cwd, argv, input] of [
    ["packages", ["make", "check"], "makefile"],
    ["packages", ["npm", "run", "lint"], "package.json"],
    ["packages", ["go", "build", "./..."], "go.mod"],
    ["packages/modules/real", ["npm", "run", "test"], "package.json"],
    ["packages/modules/arguments", ["make", "test"], "makefile"],
    ...["e2e", "integration", "codegen"].map(task => ["packages", ["npm", "run", task], "package.json"]),
  ]) expect(actions).toContainEqual(expect.objectContaining({ cwd, argv, inputs: [input], purpose: "verify" }));
  for (const task of ["migrate", "e2e", "integration", "codegen"]) {
    expect(entrypoints).toContainEqual(expect.objectContaining({ name: task, cwd: "packages", source: "package.json", argv: ["npm", "run", task] }));
  }
  expect(actions.some(action => action.argv.includes("migrate"))).toBe(false);
  for (const [cwd, task, source] of [
    ["packages/modules/arguments", "test", "modules/arguments/justfile"],
    ["packages/modules/unknown", "e2e", "modules/unknown/package.json"],
  ]) {
    const entry = entrypoints.find(entry => entry.cwd === cwd && entry.name === task && entry.source === source);
    expect(entry).toBeDefined();
    expect(entry?.argv).toBeUndefined();
    expect(actions.some(action => action.cwd === cwd && action.inputs.includes(source.split("/").at(-1)!))).toBe(false);
  }
  expect(existsSync(s.probeLog)).toBe(false);
});

function expectSignal(entries: Signal[], path: string, kind: RegExp) {
  const candidates = entries.filter(row => row.path === path || row.path + "/" === path.slice(0, row.path.length + 1));
  expect(candidates.some(row => kind.test(row.kind)), JSON.stringify({ path, candidates })).toBe(true);
}

test("A06 convention index is bounded and recent readable business samples span modules", () => {
  const { convention_files: conventions, style_samples: samples } = initial("packages");
  for (const [path, kind] of [
    [".golangci.yml", /golangci/], ["biome.json", /biome/], [".prettierrc", /prettier/],
    ["eslint.config.js", /eslint/], ["tsconfig.json", /typescript|tsconfig/], ["pyproject.toml", /ruff/],
    ["pyproject.toml", /mypy/], ["rustfmt.toml", /rustfmt/], [".editorconfig", /editorconfig/],
    ...["README.md", "CONTRIBUTING.md", "AGENTS.md", "CLAUDE.md", "docs/000-overview.md"]
      .map(path => [path, /doc|guide|instruction/] as const),
  ] as const) expectSignal(conventions, path, kind);
  for (const file of conventions) expect(Object.keys(file).sort()).toEqual(["kind", "path"]);
  expect(initial("empty").convention_files.some(file => file.path === "pyproject.toml" && /ruff|mypy/.test(file.kind))).toBe(false);
  expect(paths(conventions)).not.toContain("docs/deep/plain/overview.md");
  const selectedDocs = conventions.filter(item => indexedDocs.includes(item.path));
  expect(selectedDocs.length).toBeGreaterThan(0);
  expect(selectedDocs.length).toBeLessThan(indexedDocs.length);
  expect(initial("packages").warnings.join("\n")).toMatch(/convention[^\n]*limit/i);
  console.log(`A06 convention_index matched_docs=${indexedDocs.length} shown_docs=${selectedDocs.length}`);
  for (const file of selectedDocs) expect(file.kind).toMatch(/doc|guide|instruction/);
  expect(selected("packages").convention_files).toEqual(conventions);

  const sampled = paths(samples);
  expect(sampled.length).toBeGreaterThanOrEqual(3);
  expect(sampled.length).toBeLessThanOrEqual(5);
  expect(new Set(sampled).size).toBe(sampled.length);
  expect(new Set(sampled.map(path => path.split("/").slice(0, -1).join("/"))).size).toBeGreaterThanOrEqual(3);
  for (const path of sampled) expect(activeSources, path).toContain(path);
  for (const path of sourceControls) expect(sampled).not.toContain(path);
  expect(paths(selected("packages").style_samples)).toEqual(sampled);
  expect(paths(selected("quiet", "--days", "180").style_samples)).toEqual(["src/silent/old.ts"]);
  expect(measured.stdout).not.toContain(bodyMarker);
}, 30_000);

test("A07 entry and persistence signals report visible paths and categories", () => {
  const ops = initial("ops");
  for (const path of ["api/rest.ts", "proto/service.proto", "routes/api.ts", "handlers/request.ts", "controllers/item.ts", "openapi.yaml"])
    expectSignal(ops.entry_signals, path, /http|rpc/);
  for (const path of ["consumers/queue.ts", "workers/work.ts", "jobs/batch.ts", "cron/schedule.ts"])
    expectSignal(ops.entry_signals, path, /async/);
  for (const path of ["cmd/service/main.go", "bin/start", "server/index.ts"])
    expectSignal(ops.entry_signals, path, /executable/);
  for (const [path, kind] of [
    ["docker-compose.yml", /compose/], ["prisma/schema.prisma", /prisma|schema/], ["src/orm/schema.ts", /orm|schema/],
  ] as const) expectSignal(ops.persistence_signals, path, kind);
  const packages = initial("packages");
  expectSignal(packages.persistence_signals, "db/migrations/001_init.sql", /migration/);
  for (const path of [".env.example", ".env.test.example", "service.example.env", "service.example.yaml"])
    expectSignal(packages.persistence_signals, path, /env|template|example/);
  expect(initial("empty").entry_signals).toEqual([]);
  expect(initial("empty").persistence_signals).toEqual([]);
  for (const signals of [ops.entry_signals, ops.persistence_signals, packages.persistence_signals]) {
    for (const { path, kind, ...extra } of signals) {
      expect(typeof path).toBe("string");
      expect(typeof kind).toBe("string");
      expect(extra).toEqual({});
    }
    for (const absent of ["EXTERNAL_ONLY.ts", "external-ignored.ts", "ordinary.txt", ".env.production", bodyMarker])
      expect(JSON.stringify(signals)).not.toContain(absent);
  }
});

test("A08 local refs, tags, hooks and workflows yield bounded collaboration and protection facts", () => {
  const ops = initial("ops");
  const branch = git("ops", "branch", "--show-current").trim();
  expect(branch).toBe("main");
  expect(ops.git_flow).toMatchObject({ current_branch: branch, detached: false });
  expect(ops.git_flow.long_lived_branches.map(ref => ref.name).sort())
    .toEqual(["develop", "main", "origin/main", "origin/release"]);
  for (const name of [".husky", "scripts/hooks", "lefthook.yml"])
    expect(ops.git_flow.hook_paths).toContain(name);
  expect(ops.git_flow.codeowners_paths).toEqual([".github/CODEOWNERS"]);
  const facts = JSON.stringify(ops.git_flow);
  expect(git("ops", "tag", "--list").trim().split("\n")).toEqual(["v2.1.0", "v2.2.0", "v2.3.0"]);
  expect(facts).toMatch(/"v(?:2\.)?"/);
  expect(paths(ops.workflows).sort()).toEqual([...activeWorkflow].sort());
  expect(ops.workflows.every(workflow => workflow.kind === "github-actions")).toBe(true);
  expect(ops.forbidden_paths.filter(path => path.startsWith(".github/workflows"))).toEqual([".github/workflows/**"]);
  expect(ops.forbidden_paths.filter(path => path.startsWith("deploy"))).toEqual(["deploy/**"]);
  expect(ops.forbidden_paths).toContain("security/**");
  for (const path of disabledWorkflow) expect(JSON.stringify(ops)).not.toContain(path);
  expect(initial("history").workflows).toEqual([]);
  expect(initial("history").forbidden_paths.some(path => path.startsWith(".github/workflows"))).toBe(false);
  expect(facts).not.toMatch(/production[_ -]?permissions|example\.invalid/);
  git("quiet", "switch", "--detach");
  try {
    const detached = selected("quiet");
    expect(detached.head).toBe(git("quiet", "rev-parse", "HEAD").trim());
    expect(detached.git_flow).toMatchObject({ current_branch: null, detached: true, tag_prefixes: [], hook_paths: [] });
  } finally {
    git("quiet", "switch", "main");
  }
  expect(existsSync(s.probeLog)).toBe(false);
});

function gitWindow(name: string, days: number, ...focus: string[]) {
  const since = Math.floor((epoch - days * 86_400_000) / 1000);
  return Number(git(name, "rev-list", "--count", "--no-merges", "--full-history", "--since-as-filter=@" + since, "HEAD", "--", ...focus));
}

test("A09 directory hotspot counts distinct commits and applies the local reachable history window", () => {
  const history = selected("history", "--days", "7");
  expect(gitWindow("history", 7)).toBe(5);
  expect(history.history).toMatchObject({ commits_in_window: gitWindow("history", 7), has_older_commits: true });
  expect(history.dir_hotspots.slice(0, 2)).toEqual([{ path: "src/logic", count: 2 }, { path: "src/neighbor", count: 2 }]);
  expect(history.dir_hotspots).toContainEqual({ path: "src/also", count: 1 });
  expect(history.dir_hotspots).toContainEqual({ path: "src/tie-00", count: 1 });
  expect(history.dir_hotspots.length).toBeLessThan(29);
  const ties = paths(history.dir_hotspots.filter(entry => entry.path.startsWith("src/tie-")));
  expect(ties).toEqual([...ties].sort());
  expect(paths(history.dir_hotspots)).not.toContain("src/tie-24");
  for (const ignored of ["documents", "migration", "somewhere", "elsewhere", "src/old", "src/not-reachable"])
    expect(paths(history.dir_hotspots)).not.toContain(ignored);
  expect(history.hotspots).toContainEqual({ path: "src/logic/a.ts", count: 2 });
  expect(history.cochanges).toContainEqual({ paths: ["src/logic/a.ts", "src/neighbor/friend.ts"], count: 2 });
  expect(selected("history", "--days", "7").dir_hotspots).toEqual(history.dir_hotspots);
  const focus = selected("history", "--focus", "src/logic", "--days", "7");
  expect(gitWindow("history", 7, "src/logic")).toBe(2);
  expect(focus.history.commits_in_window).toBe(gitWindow("history", 7, "src/logic"));
  expect(focus.cochange_neighbors).toContainEqual({ path: "src/neighbor", count: 2 });
}, 30_000);

test("A09 exact commit total stays independent of bounded history detail beyond 800 commits", () => {
  const cwd = repo("dense-history");
  const count = 807;
  const stamp = Math.floor((epoch - 3 * 86400_000) / 1000);
  const commits = Array.from({ length: count }, (_, i) => {
    const summary = "Fixture commit " + i;
    const blob = "export const version = " + i + ";";
    return ["commit refs/heads/main", `committer Forge <fixture@example.invalid> ${stamp + i} +0000`,
      "data " + summary.length, summary, "M 100644 inline src/count/tick.ts", "data " + blob.length, blob, ""].join("\n");
  });
  const imported = Bun.spawnSync(["git", "-C", cwd, "fast-import", "--quiet"], { env: s.env, stdin: Buffer.from(commits.join("\n")) });
  expect(imported.exitCode, imported.stderr.toString()).toBe(0);
  git("dense-history", "read-tree", "--reset", "-u", "HEAD");
  const dense = selected("dense-history", "--days", "7");
  expect(gitWindow("dense-history", 7)).toBe(count);
  expect(dense.history).toMatchObject({ commits_in_window: count, truncated: true, has_older_commits: false });
  expect(dense.dir_hotspots).toEqual([{ path: "src/count", count: 800 }]);
  expect(dense.hotspots).toEqual([{ path: "src/count/tick.ts", count: 800 }]);
}, 30_000);

test("A10 quiet and unborn histories have distinct known zeroes and a usable wider-window hint", () => {
  const quiet = selected("quiet", "--days", "7");
  expect(quiet.history).toMatchObject({ available: true, commits_in_window: 0, has_older_commits: true });
  const human = s.run([...network, s.forge, "apply", "--repo", "quiet", "--days", "7"]);
  expect(human.code, human.err).toBe(0);
  expect(human.out).toMatch(/(?:increase|larger|widen|extend|增大|扩大|加大)[^\n]*--days/i);
  expect(selected("quiet", "--days", "180").history)
    .toMatchObject({ available: true, commits_in_window: gitWindow("quiet", 180), has_older_commits: false });
  expect(initial("empty").history).toMatchObject({ available: true, commits_in_window: 0, has_older_commits: false });
  expect(initial("empty").stack.map(entry => entry.name)).toContain("Python");
});

test("A10 shallow and unreadable local history declare uncertainty then recover", () => {
  const shallow = join(s.work, "shallow-history");
  s.ok(["git", "clone", "--depth", "1", "file://" + join(s.work, "history"), shallow]);
  s.ok([s.forge, "add-repo", shallow, "--workbench", s.work]);
  expect(git("shallow-history", "rev-parse", "--is-shallow-repository").trim()).toBe("true");
  const shallowScan = selected("shallow-history", "--days", "7");
  expect(shallowScan.history).toMatchObject({ shallow: true, has_older_commits: null });
  expect(shallowScan.warnings.join("\n")).toMatch(/shallow|浅/i);
  git("shallow-history", "fetch", "--unshallow");
  expect(selected("shallow-history", "--days", "7").history)
    .toMatchObject({ shallow: false, available: true, commits_in_window: gitWindow("history", 7), has_older_commits: true });

  const parent = git("history", "rev-parse", "HEAD~1").trim();
  const object = join(s.work, "history", ".git", "objects", parent.slice(0, 2), parent.slice(2));
  const moved = join(s.root, "temporarily-unavailable-object");
  s.ok(["mv", object, moved]);
  try {
    const control = s.run(["git", "-C", join(s.work, "history"), "rev-list", "--count", "HEAD"]);
    expect(control.code, control.out + control.err).not.toBe(0);
    const failed = selected("history", "--days", "7");
    expect(failed.head).toBe(git("history", "rev-parse", "HEAD").trim());
    expect(failed.history).toMatchObject({ shallow: false, available: false, commits_in_window: null, has_older_commits: null });
    expect(failed.warnings.join("\n")).toMatch(/history|commit window|local Git|历史|提交/i);
  } finally {
    s.ok(["mv", moved, object]);
  }
  expect(selected("history", "--days", "7").history)
    .toMatchObject({ available: true, commits_in_window: gitWindow("history", 7), has_older_commits: true });
}, 30_000);
