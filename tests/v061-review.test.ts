import { expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { row, timestamp, withAudit } from "./helpers/audit-cli";
import { sandbox, type Sandbox } from "./v05-sandbox";

function commit(s: Sandbox, repo: string, subject: string, ...paths: string[]) {
  s.git(repo, "add", "--", ...paths);
  s.git(repo, "-c", "user.name=Forge Test", "-c", "user.email=forge-test@example.invalid",
    "commit", "-m", subject, "--", ...paths);
  return s.git(repo, "rev-parse", "HEAD").trim();
}

function apply(s: Sandbox, ...args: string[]) {
  return JSON.parse(s.ok([s.forge, "apply", ...args, "--json"]));
}

function names(scan: { repos: { repo: string }[] }) {
  return scan.repos.map(({ repo }) => repo);
}

test("review regression: close retains a long tool log failure and filters ordinary file bodies", () => withAudit(f => {
  const id = "review-tool-outputs";
  f.open(id, ["--session-id", id]);
  const rawFailure = [
    "Chunk ID: fixture-test",
    "Wall time: 0.152 seconds",
    "Process exited with code 1",
    "Warning: truncated output (original char count: 77910)",
    "Total output lines: 2020",
    "",
    "bun test v1.4.4",
    "FAIL: ran contract checks and received an invalid status",
    "Error: test result expected ready",
  ].join("\n");
  const document = (marker: string) => [
    "# Fixture operator notes",
    "",
    "These are copied notes for an imaginary project.",
    "Error: " + marker,
    "Keep this document in the example folder.",
  ].join("\n");
  const command = ["apply", "--days", "0"];
  const actual = f.s.run([f.s.forge, ...command]);
  expect(actual.code).not.toBe(0);
  expect(actual.err + actual.out).toMatch(/--days must be a positive integer/);
  const tap = [
    "TAP version 13",
    "# Subtest: formatting",
    "ok 1 - formatting",
    "# setup ready",
    "# Subtest: arithmetic",
    "not ok 2 - arithmetic",
    "1..2",
    "# fail 1",
  ];
  const inputs = [
    { name: "exec_command", args: { cmd: "bun run print-notes" }, output: document("PACKAGE_SCRIPT_BODY_MARKER") },
    { name: "read_file", args: { path: "notes.md" }, output: document("FILE_VIEWER_BODY_MARKER") },
    { name: "exec_command", args: { cmd: "bun test" }, output: rawFailure },
    { name: "exec_command", args: { cmd: "forge " + command.join(" ") },
      output: { exit_code: actual.code, stdout: actual.out, stderr: actual.err } },
    { name: "exec_command", args: { cmd: "node --test arithmetic.test.js" },
      output: { exit_code: 1, stdout: tap.join("\n") } },
  ];
  f.put(id, inputs.flatMap(({ name, args, output }, index) => [
    row(index * 2 + 1, "response_item", {
      type: "function_call", call_id: "fixture-" + index, name, arguments: JSON.stringify(args),
    }),
    row(index * 2 + 2, "response_item", { type: "function_call_output", call_id: "fixture-" + index, output }),
  ]));

  expect(f.json("close", id).task.status).toBe("CLOSED");
  const trace = f.read(id, "trace.jsonl");
  expect(trace).not.toContain("PACKAGE_SCRIPT_BODY_MARKER");
  expect(trace).not.toContain("FILE_VIEWER_BODY_MARKER");
  expect(trace).not.toContain("Keep this document in the example folder");
  const failure = f.trace(id).find(event => event.kind === "tool_output" && event.ts === timestamp(6));
  expect(failure?.output_summary).toContain("Exit code 1");
  expect(failure?.output_summary).toContain("FAIL: ran contract checks and received an invalid status");
  expect(failure?.output_summary).toContain("test result expected ready");
  expect(Buffer.byteLength(failure!.output_summary, "utf8")).toBeLessThanOrEqual(2048);
  const outputs = f.trace(id).filter(event => event.kind === "tool_output");
  const invalidDays = outputs.find(event => event.ts === timestamp(8));
  expect(invalidDays?.output_summary).toContain("Exit code " + actual.code);
  expect(invalidDays?.output_summary).toContain("--days must be a positive integer");
  const tapSummary = outputs.find(event => event.ts === timestamp(10))?.output_summary;
  for (const line of ["TAP version 13", "# Subtest: arithmetic", "not ok 2 - arithmetic", "# fail 1"])
    expect(tapSummary).toContain(line);
}), 30_000);

test("review regression: apply finds static Make, Python and just entrypoints", () => {
  const s = sandbox();
  try {
    s.fresh();
    s.git(s.work, "init", "-b", "main");
    s.privateFile("Makefile", [
      "check lint: dependencies",
      "\t@printf recipe-should-not-run > \"$$PROBE_LOG\"",
      "generate build: ; @false",
      "dependencies:",
      "typecheck := assignment, not a target",
    ].join("\n") + "\n");
    s.privateFile("pyproject.toml", [
      "[project]",
      'name = "fixture"',
      'version = "1.0.0"',
      "[project.scripts]",
      'test = "example:test_suite"',
      'typecheck = "example:typecheck"',
      "[project.optional-dependencies]",
      'generate = ["fixture"]',
    ].join("\n") + "\n");
    s.privateFile("uv.lock", "# fixture lock\n");
    s.privateFile("justfile", "test profile:\n    @echo {{profile}}\nbuild:\n    @echo build\n");
    const out = apply(s);
    expect(names(out)).toEqual(["."]);
    const declared = out.repos[0].entrypoints.filter((entry: { declared: boolean }) => entry.declared);
    expect(declared.filter((entry: { source: string }) => entry.source === "Makefile")
      .map((entry: { name: string }) => entry.name).sort()).toEqual(["build", "check", "generate", "lint"]);
    expect(declared.filter((entry: { source: string }) => entry.source === "pyproject.toml"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "test", argv: ["uv", "run", "test"] }),
        expect.objectContaining({ name: "typecheck", argv: ["uv", "run", "typecheck"] }),
      ]));
    expect(declared.filter((entry: { source: string }) => entry.source === "pyproject.toml")
      .map((entry: { name: string }) => entry.name).sort()).toEqual(["test", "typecheck"]);
    const recipes = declared.filter((entry: { source: string }) => entry.source === "justfile");
    expect(recipes).toContainEqual(expect.objectContaining({ name: "test", declared: true }));
    expect(recipes.find((entry: { name: string }) => entry.name === "test")?.argv).toBeUndefined();
    expect(out.repos[0].verification_actions).toContainEqual(expect.objectContaining({ argv: ["just", "build"] }));
    expect(out.repos[0].verification_actions).not.toContainEqual(expect.objectContaining({ argv: ["just", "test"] }));
    expect(existsSync(s.probeLog)).toBe(false);
  } finally { s.cleanup(); }
}, 30_000);

test("review regression: a separate Git directory still identifies a primary checkout", () => {
  const s = sandbox();
  try {
    s.fresh();
    const project = join(s.work, "primary");
    const gitDirectory = join(realpathSync(s.work), "primary-git");
    mkdirSync(project);
    s.git(project, "init", "-b", "main", "--separate-git-dir", gitDirectory);
    expect(lstatSync(join(project, ".git")).isFile()).toBe(true);
    s.privateFile("primary/src/facts.ts", "export const facts = true;\n");
    const head = commit(s, project, "primary commit", "src/facts.ts");
    const linked = join(s.work, "linked");
    s.git(project, "worktree", "add", "-b", "linked", linked, head);
    expect(lstatSync(join(linked, ".git")).isFile()).toBe(true);

    const out = apply(s);
    expect(names(out)).toEqual(["primary"]);
    expect(out.repos[0]).toMatchObject({ head });
    expect(out.repos[0].tree).toContainEqual(expect.objectContaining({ path: "src/facts.ts" }));
  } finally { s.cleanup(); }
}, 30_000);

test("review regression: only fixed top-level gitlinks change root map ownership", () => {
  const s = sandbox();
  try {
    s.fresh();
    s.git(s.work, "init", "-b", "main");
    const origin = join(s.root, "module-origin");
    mkdirSync(origin);
    s.git(origin, "init", "-b", "main");
    s.privateFile("../module-origin/guide.md", "Fixture submodule.\n");
    commit(s, origin, "module fixture", "guide.md");
    s.privateFile("src/main.ts", "export {};\n");
    commit(s, s.work, "root fixture", "src/main.ts");
    s.git(s.work, "submodule", "add", "--", origin, "src/nested");
    commit(s, s.work, "only a nested gitlink", ".gitmodules", "src/nested");
    expect(names(apply(s))).toEqual(["."]);
    expect(apply(s, "--focus", "src/main.ts").repos[0].tree).toContainEqual(
      expect.objectContaining({ path: "src/main.ts" }));

    s.git(s.work, "submodule", "add", "--", origin, "top-project");
    expect(names(apply(s))).toEqual(["top-project"]);
    commit(s, s.work, "pin a direct gitlink", ".gitmodules", "top-project");
    s.git(s.work, "submodule", "deinit", "-f", "--", "top-project");
    s.git(s.work, "rm", "--cached", "--", "top-project");
    const uninitialized = apply(s);
    expect(names(uninitialized)).toEqual([]);
    expect(uninitialized.warnings.join("\n")).toMatch(/unavailable locally.*top-project/);
  } finally { s.cleanup(); }
}, 30_000);

test("review regression: apply strips inherited Git traces and disables signature display", () => {
  const s = sandbox();
  try {
    s.fresh();
    s.git(s.work, "init", "-b", "main");
    s.privateFile("src/app.ts", "export const n = 1;\n");
    const base = commit(s, s.work, "baseline", "src/app.ts");
    s.privateFile("src/app.ts", "export const n = 2;\n");
    commit(s, s.work, "verified feature change", "src/app.ts");
    s.privateFile(".workbench/domains/root/app.md",
      "---\nrepo: .\ndomain: app\nanchored_paths: [src]\nlast_verified_sha: " + base + "\n---\n");

    const git = s.ok(["/bin/sh", "-c", "command -v git"]).trim();
    const witness = join(s.root, "git-child-invocations");
    const traceVariables = ["GIT_TRACE", "GIT_TRACE_SETUP", "GIT_TRACE2_EVENT", "GIT_TRACE2_PERF"];
    const traceDestination = join(s.root, "fixture-trace-output");
    for (const name of traceVariables) s.env[name] = traceDestination;
    const wrapper = s.privateFile("../bin/git", `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const env = { ...process.env };
const names = ${JSON.stringify(traceVariables)};
appendFileSync(${JSON.stringify(witness)}, JSON.stringify({ args, trace: names.filter(name => name in env) }) + "\\n");
for (const name of names) delete env[name];
const result = Bun.spawnSync([${JSON.stringify(git)}, ...args], { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
process.exit(result.exitCode ?? 1);
`);
    chmodSync(wrapper, 0o755);
    expect(names(apply(s))).toEqual(["."]);
    const check = apply(s, "check", "--domain", "app");
    expect(check.cards[0]).toMatchObject({ status: "CHANGED", commits: [{ subject: "verified feature change" }] });

    const invocations = readFileSync(witness, "utf8").trimEnd().split("\n")
      .map(line => JSON.parse(line) as { args: string[]; trace: string[] });
    const logs = invocations.filter(({ args }) => args.includes("log"));
    expect(logs.length).toBeGreaterThanOrEqual(2);
    for (const { args } of logs) expect(args).toContain("--no-show-signature");
    for (const { trace } of invocations) expect(trace).toEqual([]);
    expect(existsSync(traceDestination)).toBe(false);
  } finally { s.cleanup(); }
}, 30_000);
