import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandbox, type Sandbox } from "./v05-sandbox";

type Entry = { name: string; source: string; cwd: string; argv?: string[] };
type Action = { cwd: string; argv: string[]; inputs: string[] };

function withRepo(run: (fixture: Sandbox) => void) {
  const s = sandbox();
  try {
    s.fresh();
    s.git(s.work, "init", "-b", "main");
    s.git(s.work, "config", "user.name", "Forge Fixture");
    s.git(s.work, "config", "user.email", "fixture@example.invalid");
    run(s);
    expect(existsSync(s.probeLog)).toBe(false);
  } finally {
    s.cleanup();
  }
}

function apply(s: Sandbox, ...args: string[]) {
  return JSON.parse(s.ok([s.forge, "apply", ...args, "--json"])).repos[0];
}

test("INV-03 quiet and optional exported-rest just recipes precede Make", () => withRepo(s => {
  s.privateFile("justfile", '@test:\n  printf "ran" >> "$PROBE_LOG"\n\ne2e *$args:\n  printf "ran" >> "$PROBE_LOG"\n');
  s.privateFile("Makefile", 'test e2e:\n\tprintf "ran" >> "$$PROBE_LOG"\n');
  const report = apply(s);
  const entrypoints: Entry[] = report.entrypoints;
  const actions: Action[] = report.verification_actions;

  for (const name of ["test", "e2e"]) {
    expect(entrypoints).toContainEqual(expect.objectContaining({ name, cwd: ".", source: "justfile", argv: ["just", name] }));
    expect(entrypoints).toContainEqual(expect.objectContaining({ name, cwd: ".", source: "Makefile", argv: ["make", name] }));
    expect(actions.filter(action => action.cwd === "." && action.argv.includes(name)))
      .toEqual([expect.objectContaining({ argv: ["just", name], inputs: ["justfile"] })]);
  }
}));

test("INV-03 Gradle comments and string literals add no entries or suggestions", () => withRepo(s => {
  s.privateFile("build.gradle.kts", [
    '// tasks.register("lint") {}',
    '/* tasks.register("e2e") {} */',
    '/*',
    'tasks.register("integration") {}',
    '*/',
    'val inlineExample = """tasks.register("typecheck") {}"""',
    'val multilineExample = """',
    'tasks.register("generate") {}',
    '"""',
    'tasks.register("codegen") {} // tasks.register("migrate") {}',
    "",
  ].join("\n"));
  const report = apply(s);
  const entrypoints: Entry[] = report.entrypoints;
  const actions: Action[] = report.verification_actions;

  expect(entrypoints).toContainEqual(expect.objectContaining({ name: "codegen", cwd: ".", source: "build.gradle.kts", argv: ["gradle", "codegen"] }));
  expect(actions).toContainEqual(expect.objectContaining({ cwd: ".", argv: ["gradle", "codegen"], inputs: ["build.gradle.kts"] }));
  for (const name of ["lint", "e2e", "integration", "typecheck", "generate", "migrate"]) {
    expect(entrypoints.some(entry => entry.name === name), name).toBe(false);
    expect(actions.some(action => action.argv.includes(name)), name).toBe(false);
  }
}));

for (const [manifest, disabled] of [
  ["build.gradle.kts", [
    "/*",
    "/* TODO */",
    'tasks.register("integration") {}',
    "*/",
    "/*",
    "/* CI 说明 */",
    'tasks.register("e2e") {}',
    "*/",
  ]],
  ["build.gradle", [
    'def usage = /tasks.register("integration")/',
    'def dollarSlashyUsage = $/tasks.register("e2e")/$',
  ]],
] as const) {
  test(`INV-03 ${manifest} only offers the real task after disabled declarations`, () => withRepo(s => {
    s.privateFile(manifest, [...disabled, 'tasks.register("codegen") {}', ""].join("\n"));
    const report = apply(s);
    const entrypoints: Entry[] = report.entrypoints;
    const actions: Action[] = report.verification_actions;

    expect(entrypoints).toContainEqual(expect.objectContaining({ name: "codegen", source: manifest, argv: ["gradle", "codegen"] }));
    expect(actions).toContainEqual(expect.objectContaining({ cwd: ".", argv: ["gradle", "codegen"], inputs: [manifest] }));
    for (const name of ["integration", "e2e"]) {
      expect(entrypoints.some(entry => entry.name === name), name).toBe(false);
      expect(actions.some(action => action.argv.includes(name)), name).toBe(false);
    }
  }));
}

test("INV-03 Gradle recognizes explicitly qualified tasks on the current project", () => withRepo(s => {
  const manifest = "build.gradle";
  s.privateFile(manifest, [
    'this.tasks.register("e2e") {}',
    'other.tasks.register("integration") {}',
    'project.tasks.register("codegen") {}',
    "",
  ].join("\n"));
  const report = apply(s);
  const entrypoints: Entry[] = report.entrypoints;
  const actions: Action[] = report.verification_actions;

  for (const name of ["e2e", "codegen"]) {
    expect(entrypoints).toContainEqual(expect.objectContaining({ name, cwd: ".", source: manifest, argv: ["gradle", name] }));
    expect(actions).toContainEqual(expect.objectContaining({ cwd: ".", argv: ["gradle", name], inputs: [manifest] }));
  }
  expect(entrypoints.some(entry => entry.name === "integration")).toBe(false);
  expect(actions.some(action => action.argv.includes("integration"))).toBe(false);
}));

test("INV-03 Gradle dynamic arguments with inline comments leave both following literal registrations visible", () => withRepo(s => {
  const manifest = "build.gradle.kts";
  s.privateFile(manifest, [
    'val taskName = "buildExample"',
    'tasks.register(/* explanation */ taskName) {}',
    'tasks.register("lint") {}',
    'tasks.register(/* verified */ "codegen" /* retained */) {}',
    "",
  ].join("\n"));
  const report = apply(s);
  const entrypoints: Entry[] = report.entrypoints;
  const actions: Action[] = report.verification_actions;

  for (const name of ["lint", "codegen"]) {
    expect(entrypoints).toContainEqual(expect.objectContaining({ name, source: manifest, argv: ["gradle", name] }));
    expect(actions).toContainEqual(expect.objectContaining({ cwd: ".", argv: ["gradle", name], inputs: [manifest] }));
  }
  expect(entrypoints.some(entry => entry.name === "buildExample")).toBe(false);
  expect(actions.some(action => action.argv.includes("buildExample"))).toBe(false);
}));

test("INV-03 Gradle scanning completes on comment-heavy dynamic calls and finds a following static task", () => withRepo(s => {
  const manifest = "build.gradle.kts";
  const gap = "/* gap */ ".repeat(300);
  const dynamic = "tasks.register(" + gap + "dynamicTaskName) {}\n";
  // A bounded manifest with 9000 short comments exercises the dynamic-argument path.
  const text = 'val dynamicTaskName = "integration"\n' + dynamic.repeat(30)
    + 'tasks.register(/* verified */ "codegen" /* retained */) {}\n';
  s.privateFile(manifest, text);
  const report = apply(s);
  const entrypoints: Entry[] = report.entrypoints;
  const actions: Action[] = report.verification_actions;

  expect(entrypoints).toContainEqual(expect.objectContaining({ name: "codegen", source: manifest, argv: ["gradle", "codegen"] }));
  expect(actions).toContainEqual(expect.objectContaining({ cwd: ".", argv: ["gradle", "codegen"], inputs: [manifest] }));
  expect(entrypoints.some(entry => entry.name === "integration")).toBe(false);
  expect(actions.some(action => action.argv.includes("integration"))).toBe(false);
}), 60_000);

test("INV-02 Go workspace accepts UTF-8 byte escapes and adjacent comments in use declarations", () => withRepo(s => {
  s.privateFile("go.work", 'go 1.22\nuse (\n  ' + String.raw`"./caf\xc3\xa9"` + '\n  ./src//checkout\n)\n');
  s.privateFile("café/go.mod", "module example.invalid/cafe\ngo 1.22\n");
  s.privateFile("src/go.mod", "module example.invalid/source\ngo 1.22\n");
  const report = apply(s);
  expect(report.workspaces).toHaveLength(1);
  const declaration = report.workspaces[0];
  expect(declaration).toMatchObject({ source: "go.work", kind: "go-work" });
  expect(declaration.members).toHaveLength(2);
  expect(declaration.members).toContainEqual({ path: "café", role: "include", directory_present: true });
  expect(declaration.members).toContainEqual({ path: "src", role: "include", directory_present: true });
}));

function caseInsensitiveFixtureFilesystem() {
  const root = mkdtempSync(join(tmpdir(), "forge-case-probe-"));
  try {
    writeFileSync(join(root, "MixedCase"), "");
    return existsSync(join(root, "mixedcase"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test.skipIf(!caseInsensitiveFixtureFilesystem())("INV-01/02 focus aliases use the checked-out Git path for history", () => withRepo(s => {
  const stored = "src/MixedCase/Feature.ts";
  const alias = "src/mixedcase/feature.ts";
  const neighbor = "src/neighbor/Shared.ts";
  for (const path of [stored, neighbor]) s.privateFile(path, "export {};\n");
  s.git(s.work, "add", "--", stored, neighbor);
  s.git(s.work, "commit", "-m", "Seed tracked files that changed together");
  for (const path of [stored, neighbor]) s.privateFile(path, "export const fixture = true;\n");
  s.git(s.work, "commit", "-am", "Update both tracked files together");
  expect(statSync(join(s.work, alias)).ino).toBe(statSync(join(s.work, stored)).ino);

  const exact = apply(s, "--focus", stored, "--days", "7");
  const alternate = apply(s, "--focus", alias, "--days", "7");
  expect(exact.history.commits_in_window).toBe(2);
  expect(exact.hotspots).toEqual([{ path: stored, count: 2 }]);
  expect(exact.cochange_neighbors).toEqual([{ path: "src/neighbor", count: 2 }]);
  expect(alternate.history).toEqual(exact.history);
  expect(alternate.hotspots).toEqual(exact.hotspots);
  expect(alternate.cochanges).toEqual(exact.cochanges);
  expect(alternate.cochange_neighbors).toEqual(exact.cochange_neighbors);
}));


test("INV-06/08 the new card summarizes the same valid workflows as apply", () => withRepo(s => {
  const active = [".github/workflows/verify-project.yml", ".github/workflows/publish-project.yaml"];
  const disabled = ".github/workflows/previous-verify.yml.disabled";
  const privateEnv = ".github/workflows/.env.production.yaml";

  for (const name of ["blocked", "recovered"]) {
    s.privateFile(name + "/go.mod", "module example.invalid/mapped\ngo 1.22\n");
    for (const path of [...active, disabled, privateEnv]) s.privateFile(name + "/" + path, "name: Fixture workflow\n");
    const checkout = join(s.work, name);
    s.git(checkout, "init", "-b", "main");
    const workflowDir = join(checkout, ".github/workflows");
    const register = () => s.ok([s.forge, "add-repo", checkout, "--workbench", s.work]);
    chmodSync(workflowDir, 0);
    try {
      expect(() => readdirSync(workflowDir)).toThrow(/EACCES|EPERM/);
      if (name === "blocked") register();
    } finally {
      chmodSync(workflowDir, 0o755);
    }
    if (name === "recovered") register();

    const card = s.read(".workbench/repos/" + name + ".md");
    const ci = card.split(/^## /m).find(section => /^(?:CI|协作)[^\n]*分支/i.test(section));
    expect(ci).toBeDefined();
    expect(card).not.toContain(disabled);
    expect(card).not.toContain(privateEnv);
    if (name === "blocked") {
      const summary = ci?.split("\n").find(line => /workflow|GitHub Actions|CI 文件|工作流/i.test(line));
      expect(summary ?? "", ci).toMatch(/待核实|unverified|workflow[^\d\n]*0(?:\D|$)/i);
      continue;
    }
    const workflows: { path: string }[] = apply(s, "--repo", name).workflows;
    expect(workflows.map(workflow => workflow.path).sort()).toEqual([...active].sort());
    expect(ci).toMatch(new RegExp("workflow[^0-9\\n]*" + workflows.length + "(?:\\D|$)", "i"));
    expect(ci).toContain("forge apply --json");
  }
}));
