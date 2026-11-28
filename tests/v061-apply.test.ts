import { expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { digest } from "./helpers/historical-kit";
import { bootstrap, kit, sandbox, type Sandbox } from "./v05-sandbox";

function withWorkspace(run: (s: Sandbox) => void) {
  const s = sandbox();
  try {
    s.fresh();
    s.env.GIT_OPTIONAL_LOCKS = "0";
    run(s);
  } finally { s.cleanup(); }
}

function repo(s: Sandbox, name: string) {
  const path = join(s.work, name);
  mkdirSync(path, { recursive: true });
  s.git(path, "init", "-b", "main");
  s.git(path, "config", "user.name", "Forge Test");
  s.git(path, "config", "user.email", "forge-test@example.invalid");
  return path;
}

function commit(s: Sandbox, name: string, subject: string, files: Record<string, string | null>, ageDays = 0) {
  const path = join(s.work, name);
  for (const [file, content] of Object.entries(files)) {
    if (content === null) rmSync(join(path, file));
    else s.privateFile(join(name, file), content);
  }
  s.git(path, "add", "-f", "--", ...Object.keys(files));
  const date = new Date(Date.now() - ageDays * 86_400_000).toISOString();
  s.ok(["env", "GIT_COMMITTER_DATE=" + date, "git", "-C", path,
    "commit", "--date", date, "-m", subject, "--", ...Object.keys(files)]);
  return s.git(path, "rev-parse", "HEAD").trim();
}

function card(s: Sandbox, repo: string, domain: string, sha: string, paths: string[], fields: object = {}) {
  const slug = repo === "." ? "root" : repo;
  return s.privateFile(`.workbench/domains/${slug}/${domain}.md`, "---\n" + stringify({
    repo, domain, anchored_paths: paths, last_verified_sha: sha, ...fields,
  }) + "---\n# Fixture domain\n\nCatalog owner.\n");
}

function apply(s: Sandbox, ...args: string[]) {
  return JSON.parse(s.ok([s.forge, "apply", ...args, "--json"]));
}

function register(s: Sandbox, path: string) {
  return JSON.parse(s.ok([s.forge, "add-repo", path, "--workbench", s.work]));
}

function snapshots(root: string, relative = ""): string[] {
  const path = join(root, relative);
  const meta = lstatSync(path);
  const prefix = `${relative} ${meta.mode} ${meta.mtimeMs} ${meta.ctimeMs}`;
  if (meta.isSymbolicLink()) return [prefix + " " + readlinkSync(path)];
  if (meta.isFile()) return [prefix + " " + digest(path)];
  if (!meta.isDirectory() || !(meta.mode & 0o444)) return [prefix];
  return [prefix, ...readdirSync(path).sort().flatMap(item => snapshots(root, join(relative, item)))];
}

function contains(data: unknown, values: (RegExp | string)[]) {
  const json = JSON.stringify(data);
  for (const value of values) expect(json).toMatch(value);
}

function omits(data: unknown, values: string[]) {
  const json = JSON.stringify(data);
  for (const value of values) expect(json).not.toContain(value);
}

test("INV-01/02 apply reads only selected registered repositories and discovers toolchain facts", () => withWorkspace(s => {
  const api = repo(s, "api");
  const root = repo(s, "root");
  const ops = repo(s, "ops");
  repo(s, "unregistered");
  const apiHead = commit(s, "api", "fixture API seed", {
    "package.json": JSON.stringify({ packageManager: "pnpm@9.1.1", scripts: Object.fromEntries(
      ["check", "lint", "typecheck", "test", "build", "generate"].map(name => [name, "./fake-project-command"])) }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "fake-project-command": '#!/bin/sh\nprintf "%s\\n" ran >> "$PROBE_LOG"\n',
    "src/api-only.ts": "export const feature = true;\n",
    ".github/workflows/fixture-ci.yml": "name: fixture-ci\n",
    "Dockerfile": "FROM scratch\n",
  });
  chmodSync(join(api, "fake-project-command"), 0o755);
  commit(s, "root", "fixture Go seed", {
    "go.mod": "module fixture.invalid/root\n\ngo 1.22\n",
    "pyproject.toml": '[project]\nname = "fixture_python"\nversion = "1.0.0"\n',
    "src/root-only.go": "package root\n",
    "Makefile": "lint:\n\tfalse\n",
  });
  commit(s, "ops", "fixture other toolchains", {
    "Cargo.toml": '[package]\nname = "fixture_rust"\nversion = "0.1.0"\n',
    "pom.xml": "<project/>\n",
    "justfile": "build:\n  false\n",
    "extra-source/ops-only.java": "final class Fixture {}\n",
  });
  s.privateFile("unregistered/package.json", '{"name":"unregistered-only"}\n');
  s.git(api, "worktree", "add", "-b", "linked", join(s.work, "linked"), apiHead);
  [api, root, ops].forEach(path => register(s, path));

  const scan = apply(s, s.work);
  contains(scan, [/pnpm/i, /go\.mod/i, /python|pyproject/i, /rust|cargo/i, /java|pom\.xml/i,
    /makefile/i, /justfile/i, /fixture-ci/i, /dockerfile/i, /check/, /lint/, /typecheck/, /test/, /build/, /generate/,
    "api-only.ts", "root-only.go", "ops-only.java", "forbidden_paths"]);
  omits(scan, ["unregistered-only", '"repo":"linked"']);
  const manifest = join(ops, "Cargo.toml");
  const subtree = join(ops, "extra-source");
  chmodSync(manifest, 0);
  chmodSync(subtree, 0);
  try {
    // A scan that attempts the reads must report these deliberately inaccessible locations.
    const controlWarnings = apply(s, "--repo", "ops").repos[0].warnings;
    contains(controlWarnings, ["Cargo.toml", "extra-source"]);
    const subset = apply(s, "--repo", "api", "--repo", "root");
    expect(subset.repos.map((item: { repo: string }) => item.repo)).toEqual(["api", "root"]);
    contains(subset, ["api-only.ts", "root-only.go"]);
    omits(subset, ["ops-only.java", "Cargo.toml", "pom.xml", "extra-source", "unregistered-only"]);
  } finally {
    chmodSync(manifest, 0o600);
    chmodSync(subtree, 0o755);
  }
  expect(s.run([s.forge, "apply", "--repo", "unknown-fixture", "--json"]).code).not.toBe(0);
  expect(existsSync(s.probeLog)).toBe(false);
}), 30_000);

test("INV-01/02/03 single project focus is local and read-only, with correct Git history and safe paths", () => withWorkspace(s => {
  repo(s, ".");
  commit(s, ".", "expired fixture commit", { "src/service/expired-only.ts": "1;\n" }, 130);
  commit(s, ".", "ninety day fixture commit", { "src/service/ninety-day.ts": "1;\n" }, 35);
  commit(s, ".", "cross-focal baseline", { "src/service/current.ts": "1;\n", "src/friend.ts": "1;\n" }, 3);
  const excluded = Object.fromEntries(
    ["node_modules", "vendor", "dist", "build", "target", ".venv", ".workbench"]
      .map(dir => [dir + "/FILTERED_FILE", dir + "\n"]));
  commit(s, ".", "cross-focal fixture latest", {
    "src/service/current.ts": "1;\n2;\n", "src/friend.ts": "1;\n2;\n",
    ...excluded,
  }, 2);
  const head = commit(s, ".", "independent focus neighbor", { "src/outside-focus.ts": "3;\n" }, 1);
  s.privateFile(".git/FILTERED_FILE", "hidden repository metadata");
  mkdirSync(join(s.work, "src/empty"));
  const outside = join(s.root, "outside");
  mkdirSync(outside);
  const outsideMarker = "OUTSIDE_FILE_SHOULD_NOT_BE_READ.txt";
  s.ok(["/bin/sh", "-c", 'echo outside > "$1"', "fixture", join(outside, outsideMarker)]);
  symlinkSync(outside, join(s.work, "src/escaping"));
  const protectedSubtree = join(s.work, "src/private-subtree");
  mkdirSync(protectedSubtree, { mode: 0 });
  const before = snapshots(s.work);

  const full = apply(s);
  contains(full, ['"repo":"."', "src/service/current.ts", "src/outside-focus.ts"]);
  contains(full.repos[0].warnings, ["src/private-subtree"]);
  omits(full, ["FILTERED_FILE", outsideMarker]);
  const focus = apply(s, "--focus", "src/service", "--days", "7");
  expect(focus.repos[0].hotspots).toEqual([{ path: "src/service/current.ts", count: 2 }]);
  expect(focus.repos[0].cochanges).toEqual([{ paths: ["src/friend.ts", "src/service/current.ts"], count: 2 }]);
  expect(focus.repos[0].cochange_neighbors).toEqual([{ path: "src", count: 2 }]);
  contains(focus.repos[0].tree, ["src/service/current.ts"]);
  omits(focus.repos[0].tree, ["src/friend.ts", "src/outside-focus.ts", "src/private-subtree"]);
  omits(focus, ["src/outside-focus.ts", "src/private-subtree", outsideMarker, "FILTERED_FILE"]);
  // The older window facts and the stable order use committed Git history, independent of the skeleton.
  expect(s.git(s.work, "log", "--format=%s", "--since=7 days ago", "--", "src/service"))
    .toContain("cross-focal baseline");
  const ninety = apply(s, "--focus", "src/service", "--days", "90");
  expect(ninety.repos[0].hotspots).toEqual([
    { path: "src/service/current.ts", count: 2 }, { path: "src/service/ninety-day.ts", count: 1 },
  ]);
  const automatic = apply(s, "--focus", "src/service");
  expect(automatic).toEqual(ninety);
  expect(apply(s, "--focus", "src/service", "--days", "7")).toEqual(focus);
  contains(apply(s, "--focus", "src/service", "--focus", "src/outside-focus.ts"),
    ["src/service/current.ts", "src/outside-focus.ts"]);
  expect(apply(s, "--focus", "src/empty")).toBeDefined();

  for (const invalid of ["0", "-1", "1.5", "nope"]) {
    const result = s.run([s.forge, "apply", "--days", invalid, "--json"]);
    expect(result.code).not.toBe(0);
    expect(result.out + result.err).toMatch(/days|positive|整数/i);
  }
  for (const path of [outside, "../outside", "src/escaping"]) {
    for (const args of [["--focus", "src/service", "--focus", path], ["check", "--path", "src/service", "--path", path]]) {
      const result = s.run([s.forge, "apply", ...args, "--json"]);
      expect(result.code).not.toBe(0);
      expect(result.out + result.err).toMatch(/path|relative|escape|outside|路径|越界/i);
      expect(result.out + result.err).not.toContain(outsideMarker);
    }
  }
  expect(apply(s, "--focus", "src/service", "--days", "7")).toEqual(focus);
  contains(apply(s, "check", "--path", "src/service"), ["UNMAPPED"]);
  expect(apply(s, "status")).toBeDefined();
  expect(s.git(s.work, "rev-parse", "HEAD").trim()).toBe(head);
  expect(snapshots(s.work)).toEqual(before);
  chmodSync(protectedSubtree, 0o755);
  expect(existsSync(s.probeLog)).toBe(false);
}), 30_000);

test("INV-01/03/04 root child and Git submodule have their actual repository identities", () => withWorkspace(s => {
  const checkout = repo(s, ".");
  const top = commit(s, ".", "parent organizational marker", { "notes/parent-only.md": "Organization notes." });
  const namedRoot = repo(s, "root");
  const root = commit(s, "root", "project root marker", { "src/child-root-only.go": "package main\n" });

  const origin = join(s.root, "module-origin");
  mkdirSync(origin);
  s.git(origin, "init", "-b", "main");
  s.ok(["/bin/sh", "-c", 'echo module > "$1"', "fixture", join(origin, "submodule-only.md")]);
  s.git(origin, "add", "--", "submodule-only.md");
  s.git(origin, "-c", "user.name=Forge Test", "-c", "user.email=forge-test@example.invalid",
    "commit", "-m", "independent module content", "--", "submodule-only.md");
  s.git(checkout, "-c", "protocol.file.allow=always", "submodule", "add", "--", origin, "module");
  s.git(checkout, "commit", "-m", "pin Git submodule", "--", ".gitmodules", "module");
  const module = s.git(join(checkout, "module"), "rev-parse", "HEAD").trim();
  mkdirSync(join(checkout, "org"));
  repo(s, "org/deeper");
  commit(s, "org/deeper", "second-level marker", { "deeper-only.txt": "deeper" });
  s.git(namedRoot, "worktree", "add", "-b", "linked-child", join(checkout, "linked"), root);

  const found = apply(s, s.work);
  contains(found, ['"repo":"root"', '"repo":"module"', "child-root-only.go", "submodule-only.md"]);
  omits(found, ['"repo":"."', "parent-only.md", "deeper-only.txt", '"repo":"linked"']);
  card(s, "root", "same-domain", root, ["src/child-root-only.go"]);
  card(s, "module", "same-domain", module, ["submodule-only.md"]);
  contains(apply(s, "check", "--repo", "root", "--domain", "same-domain"), ['"repo":"root"', "UNCHANGED"]);
  contains(apply(s, "check", "--repo", "module", "--domain", "same-domain"), ['"repo":"module"', "UNCHANGED"]);
  expect(s.run([s.forge, "apply", "check", "--repo", ".", "--domain", "same-domain", "--json"]).code)
    .not.toBe(0);
  const total = apply(s, "status");
  contains(total, ['"repo":"root"', '"repo":"module"', "UNCHANGED"]);
  omits(total, [top, '"repo":"."', '"repo":"linked"']);
  register(s, namedRoot);
  const selected = apply(s, "--repo", "root");
  contains(selected, ['"repo":"root"', "child-root-only.go"]);
  omits(selected, ['"repo":"."', "submodule-only.md"]);
}), 30_000);

test("INV-02/04 shallow history and repositories with no first commit retain useful results", () => withWorkspace(s => {
  const empty = repo(s, "empty");
  s.privateFile("empty/pyproject.toml", "[project]\nname = 'unborn-fixture'\n");
  expect(s.git(empty, "symbolic-ref", "HEAD").trim()).toBe("refs/heads/main");
  expect(s.run(["git", "-C", empty, "rev-parse", "--verify", "HEAD"]).code).not.toBe(0);
  contains(apply(s, "--repo", "empty"), ['"repo":"empty"', /python|pyproject/i, /history|commit|历史|提交/i]);

  const full = repo(s, "source");
  const initial = commit(s, "source", "history below shallow boundary", { "src/shallow.ts": "1;\n" }, 4);
  const head = commit(s, "source", "visible shallow head", { "src/shallow.ts": "2;\n" }, 2);
  const shallow = join(s.work, "shallow");
  s.ok(["git", "clone", "--depth", "1", "file://" + full, shallow]);
  expect(s.git(shallow, "rev-parse", "--is-shallow-repository").trim()).toBe("true");
  expect(s.git(shallow, "rev-parse", "HEAD").trim()).toBe(head);
  card(s, "shallow", "shallow-domain", initial, ["src"]);
  contains(apply(s, "--repo", "shallow"), [/shallow|浅/i, "shallow.ts"]);
  contains(apply(s, "check", "--repo", "shallow", "--domain", "shallow-domain"), ["BROKEN"]);
  const shallowStatus = apply(s, "status", "--repo", "shallow");
  contains(shallowStatus, ["BROKEN", /shallow|history|unavailable|uncomputable|历史|不可计算/i]);
  s.git(shallow, "fetch", "--unshallow");
  expect(s.git(shallow, "rev-parse", "--is-shallow-repository").trim()).toBe("false");
  contains(apply(s, "check", "--repo", "shallow", "--domain", "shallow-domain"), ["CHANGED", "visible shallow head"]);
}), 30_000);

test("INV-03/04 probe distinguishes all four states and follows committed anchored changes", () => withWorkspace(s => {
  const checkout = repo(s, ".");
  const base = commit(s, ".", "initial files", {
    "src/api/changed.ts": "1;\n",
    "src/api/deleted.ts": "delete me\n",
    "src/api-extra/similar.ts": "different directory\n",
    "src/stable/index.ts": "stable\n",
    "src/gone/index.ts": "gone soon\n",
  });
  expect(register(s, checkout)).toMatchObject({ repoName: ".", registered: true });
  expect(s.read(".workbench/root-repo.md")).toContain("## Domain Index");
  const mappedPath = card(s, ".", "api", base, ["src/api"]);
  card(s, ".", "stable", base, ["src/stable", "old-partial-missing"]);
  card(s, ".", "gone", base, ["src/gone/index.ts"]);
  expect(s.git(checkout, "check-ignore", ".workbench/domains/root/api.md").trim())
    .toBe(".workbench/domains/root/api.md");
  expect(readFileSync(mappedPath, "utf8")).toContain("repo: .");

  s.git(checkout, "switch", "-c", "independent");
  const divergent = commit(s, ".", "unmerged branch", { "src/api/changed.ts": "divergent\n" });
  s.git(checkout, "switch", "main");
  card(s, ".", "divergent", divergent, ["src/api"]);
  card(s, ".", "missing-sha", "b".repeat(40), ["src/stable"]);
  const updated = commit(s, ".", "second anchored change", {
    "src/api/changed.ts": "1;\n2;\n",
    "src/api/deleted.ts": null,
    "src/api/new.ts": "export {};\n",
    "src/gone/index.ts": "committed mutation\n",
    "src/api-extra/similar.ts": "different changes\n",
  }, 1);
  s.privateFile("src/stable/index.ts", "dirty but uncommitted\n");
  rmSync(join(checkout, "src/gone/index.ts"));
  const changed = apply(s, "check", "--repo", ".", "--domain", "api");
  contains(changed, ["CHANGED", "second anchored change", "src/api/changed.ts", "src/api/deleted.ts", "src/api/new.ts"]);
  expect(changed.cards[0]).toMatchObject({
    repo: ".", domain: "api", status: "CHANGED", commit_count: 1, truncated: false,
    numstat: { files_changed: 3, insertions: 2, deletions: 1, binary_files: 0 },
    commits: [{ subject: "second anchored change" }],
  });
  omits(changed, ["src/api-extra/similar.ts", "unmerged branch", "dirty but uncommitted"]);
  const expectedStatus = s.git(checkout, "diff", "--name-status", base + ".." + updated, "--", "src/api");
  expect(expectedStatus.split("\n").filter(Boolean).sort()).toEqual(
    ["A\tsrc/api/new.ts", "D\tsrc/api/deleted.ts", "M\tsrc/api/changed.ts"]);
  expect(changed.cards[0].name_status.map(({ status, path }: { status: string; path: string }) => status + "\t" + path))
    .toEqual(expectedStatus.trim().split("\n"));
  expect(s.git(checkout, "diff", "--numstat", base + ".." + updated, "--", "src/api").trim().split("\n"))
    .toEqual(["1\t0\tsrc/api/changed.ts", "0\t1\tsrc/api/deleted.ts", "1\t0\tsrc/api/new.ts"]);
  for (const domain of ["gone", "divergent", "missing-sha"])
    contains(apply(s, "check", "--domain", domain), ["BROKEN"]);
  contains(apply(s, "check", "--domain", "stable"), ["UNCHANGED"]);

  const direct = apply(s, "check", "--path", "src/api/changed.ts", "--path", "src/api-extra", "--path", "other");
  expect(direct.unmapped).toEqual(["other", "src/api-extra"].map(path => ({
    repo: ".", path, status: "UNMAPPED", hint: "forge apply --repo . --focus " + path,
  })));
  expect(direct.cards.map(({ domain, status }: { domain: string; status: string }) => ({ domain, status })))
    .toEqual([{ domain: "api", status: "CHANGED" }, { domain: "divergent", status: "BROKEN" }]);
  const ancestor = apply(s, "check", "--path", "src");
  contains(ancestor, ["api", "stable", "CHANGED", "UNCHANGED"]);
  const total = apply(s, "status");
  expect(total.totals).toEqual({ CHANGED: 1, UNCHANGED: 1, BROKEN: 3 });
  expect(total.cards.find((entry: { domain: string }) => entry.domain === "api").commit_count).toBe(1);
  expect(total.cards.find((entry: { domain: string }) => entry.domain === "missing-sha").commit_count).toBeNull();

  card(s, ".", "api", updated, ["src/api"]);
  contains(apply(s, "check", "--domain", "api"), ["UNCHANGED"]);
  card(s, ".", "api", updated, ["src/api"], { status: "archived" });
  rmSync(join(checkout, ".workbench/domains/root/divergent.md"));
  contains(apply(s, "check", "--path", "src/api"), ["UNMAPPED"]);
  for (const domain of ["stable", "gone", "missing-sha"]) rmSync(join(checkout, ".workbench/domains/root", domain + ".md"));
  expect(apply(s, "status")).toMatchObject({ cards: [], totals: { UNCHANGED: 0, CHANGED: 0, BROKEN: 0 } });
}), 30_000);

test("INV-02/04 large committed change keeps full statistics and bounded ranked/details output", () => withWorkspace(s => {
  const checkout = repo(s, ".");
  const base = commit(s, ".", "baseline anchor", { "src/bulk/base.ts": "export {};\n" }, 2);
  card(s, ".", "bulk", base, ["src/bulk"]);
  const changedFiles = 80;
  const additions = Object.fromEntries(Array.from({ length: changedFiles }, (_, index) => [
    "src/bulk/file-" + String(index).padStart(2, "0") + ".ts", "export {};\n",
  ]));
  const head = commit(s, ".", "wide anchored change", additions, 1);
  const raw = s.git(checkout, "diff", "--name-status", base + ".." + head, "--", "src/bulk");
  expect(raw.trim().split("\n")).toHaveLength(changedFiles);

  const changed = apply(s, "check", "--domain", "bulk").cards[0];
  expect(changed).toMatchObject({ status: "CHANGED", commit_count: 1, truncated: true,
    numstat: { files_changed: changedFiles, insertions: changedFiles, deletions: 0 } });
  expect(changed.name_status.length).toBeGreaterThan(0);
  expect(changed.name_status.length).toBeLessThan(changedFiles);
  const scan = apply(s, "--focus", "src/bulk");
  const { hotspots, cochanges } = scan.repos[0];
  expect(hotspots.length).toBeGreaterThan(0);
  expect(hotspots.length).toBeLessThan(changedFiles);
  const names = hotspots.map((item: { path: string }) => item.path);
  expect(names).toEqual(names.slice().sort());
  expect(cochanges.length).toBeGreaterThan(0);
  expect(cochanges.length).toBeLessThan(changedFiles * (changedFiles - 1) / 2);
  expect(apply(s, "--focus", "src/bulk")).toEqual(scan);
}), 30_000);

test("INV-05 doctor diagnoses map structure without reporting ordinary Git drift", () => withWorkspace(s => {
  const checkout = repo(s, ".");
  const base = commit(s, ".", "initial tracked path", { "src/focus/a.ts": "1;\n" });
  register(s, checkout);
  const warehouse = ".workbench/root-repo.md";
  const initialCard = s.read(warehouse).split(/^## Domain Index/m)[0]!;
  const doctor = () => {
    const result = s.run([s.forge, "doctor", s.work, "--json"]);
    const data = JSON.parse(result.out) as { ok: boolean; issues: { level: "warn" | "error"; message: string }[] };
    return { code: result.code, ...data };
  };
  const issue = (result: ReturnType<typeof doctor>, level: "warn" | "error", marker: string) =>
    result.issues.some(item => item.level === level && JSON.stringify(item).includes(marker));

  s.privateFile(warehouse, initialCard);
  expect(doctor().code).toBe(0);
  card(s, ".", "focus", base, ["src/focus"]);
  commit(s, ".", "normal drift belongs to the probe", { "src/focus/a.ts": "2;\n" });
  contains(apply(s, "check", "--domain", "focus"), ["CHANGED"]);
  const validDoctor = doctor();
  expect(validDoctor.code).toBe(0);
  omits(validDoctor, ["CHANGED", "normal drift belongs to the probe"]);

  const outside = join(s.root, "outside-doctor");
  mkdirSync(outside);
  symlinkSync(outside, join(checkout, "src/escape"));
  const domainDirectory = ".workbench/domains/root/";
  for (const [name, data] of [
    ["bad-yaml", "repo: [\n"],
    ["missing-sha", stringify({ repo: ".", domain: "missing-sha", anchored_paths: ["src"] })],
    ["empty-anchors", stringify({ repo: ".", domain: "empty-anchors", anchored_paths: [], last_verified_sha: base })],
    ["bad-status", stringify({ repo: ".", domain: "bad-status", anchored_paths: ["src"], last_verified_sha: base, status: "unknown" })],
    ["wrong-repo", stringify({ repo: "alien", domain: "wrong-repo", anchored_paths: ["src"], last_verified_sha: base })],
    ["parent-path", stringify({ repo: ".", domain: "parent-path", anchored_paths: ["../outside-doctor"], last_verified_sha: base })],
    ["outside-link", stringify({ repo: ".", domain: "outside-link", anchored_paths: ["src/escape"], last_verified_sha: base })],
  ]) {
    const filename = name + ".md";
    const malformed = s.privateFile(domainDirectory + filename, "---\n" + data + "---\n");
    const before = digest(malformed);
    const result = doctor();
    expect(result.code).not.toBe(0);
    expect(issue(result, "error", filename), JSON.stringify(result)).toBe(true);
    expect(digest(malformed)).toBe(before);
    rmSync(malformed);
  }

  const styled = (count: number) => "# Map\n" + "contract entry\n".repeat(count - 1);
  s.privateFile(warehouse, styled(150));
  const path = card(s, ".", "border", base, ["src"]);
  const text = readFileSync(path, "utf8");
  const padding = "additional body\n".repeat(150 - text.trimEnd().split("\n").length);
  s.privateFile(domainDirectory + "border.md", text + padding);
  const atThreshold = doctor();
  expect(atThreshold.code).toBe(0);
  expect(issue(atThreshold, "warn", "root-repo.md")).toBe(false);
  expect(issue(atThreshold, "warn", "border.md")).toBe(false);
  s.privateFile(warehouse, styled(151));
  s.privateFile(domainDirectory + "border.md", text + padding + "one too many\n");
  const oversized = doctor();
  expect(oversized.code).toBe(0);
  expect(issue(oversized, "warn", "root-repo.md")).toBe(true);
  expect(issue(oversized, "warn", "border.md")).toBe(true);

  s.privateFile(warehouse, initialCard + "\n## Domain Index\n\n- [focus](domains/root/focus.md) — fixture coverage\n");
  expect(issue(doctor(), "warn", "focus.md")).toBe(false);
  rmSync(join(checkout, domainDirectory, "focus.md"));
  const stale = doctor();
  expect(stale.code).toBe(0);
  expect(issue(stale, "warn", "focus.md")).toBe(true);
}), 30_000);

test("INV-06/09 effective Skill and README expose the live-map commands", () => {
  const s = sandbox();
  try {
    const root = repo(s, ".");
    commit(s, ".", "fixture for the README", { "src/audit/receipt.ts": "export const receipt = true;\n" });
    const readme = readFileSync(join(kit, "README.md"), "utf8");
    expect(readme.trimEnd().split("\n").length).toBeGreaterThanOrEqual(130);
    expect(readme.trimEnd().split("\n").length).toBeLessThanOrEqual(180);
    expect(readme).toMatch(/```mermaid/);
    for (const label of ["L0", "L1", "L2"]) expect(readme).toContain(label);

    // Each public Forge example can run in this fixture without reaching an external endpoint.
    const examples = readme.split("\n").filter(line => line.startsWith("forge "))
      .map(line => line.split(/\s+/).slice(1));
    expect(examples.length).toBeGreaterThan(0);
    for (const [command, ...args] of examples) s.ok([command === "init" ? bootstrap : s.forge, command!, ...args]);
    expect(s.ok([s.forge, "--help"])).toContain("apply");
    s.ok([s.forge, "apply", "--focus", "src/audit", "--json"]);
    const effective = (name: string) => JSON.parse(s.ok([s.forge, "instance", "show", "skill", name, "--json"]));
    const original = effective("apply");
    expect(original.source).toBe("core");
    const body = original.value.body;
    for (const item of ["forge apply check", "forge apply status", "Domain Index", "anchored_paths", "last_verified_sha",
      "UNCHANGED", "CHANGED", "BROKEN", "UNMAPPED", "1~3", "1~3 行", "archived", "配置"]) expect(body).toContain(item);
    for (const name of ["grill", "bugfix"]) {
      const guidance = effective(name).value.body;
      expect(guidance).toMatch(/apply/);
      expect(guidance).toMatch(/(卡|文档棘轮)/);
    }
    const source = join(root, ".agents/skills");
    s.ok([s.forge, "sync", root]);
    s.ok([s.forge, "sync", root]);
    expect(readdirSync(source).filter(name => name === "apply")).toEqual(["apply"]);
    expect(effective("apply")).toEqual(original);
    expect(existsSync(join(root, "src", "domains"))).toBe(false);
  } finally { s.cleanup(); }
}, 30_000);
