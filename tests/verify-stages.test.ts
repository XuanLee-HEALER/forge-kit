import { expect, test } from "bun:test";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { executorFixture } from "./helpers/executor";

const f = executorFixture("0.5");

function configureInstance() {
  const configDir = join(f.root, ".workbench");
  for (const file of ["models.toml", "ship-policy.yaml"]) {
    copyFileSync(join(import.meta.dir, "../templates", file), join(configDir, file));
  }
  return configDir;
}

test("custom and core stages execute in declaration order against one isolated revision", () => {
  const configDir = configureInstance();
  const trace = join(f.root, "trace");
  const step = (id: string) => "import {appendFileSync} from 'node:fs'; appendFileSync(" +
    JSON.stringify(trace) + ", JSON.stringify([" + JSON.stringify(id) + ",process.cwd(),process.env.FIXTURE_CREDENTIAL ?? null])+'\\n');console.log(" + JSON.stringify(id) + ")";
  const builtin = (id: string) => {
    const filename = id + ".ts";
    writeFileSync(join(f.repo, filename), step(id));
    return "bun " + filename;
  };
  writeFileSync(join(f.repo, "package.json"), JSON.stringify({ scripts: { check: builtin("static"), test: builtin("dynamic") } }));
  f.git("add", "--", "package.json", "static.ts", "dynamic.ts"); f.git("commit", "-m", "checks");
  const file = join(configDir, "workbench.yaml");
  const config = parse(readFileSync(file, "utf8"));
  config.extensions = {
    actions: { first: { argv: ["bun", "-e", step("first")], purpose: "verify" },
      last: { argv: ["bun", "-e", step("last")], purpose: "verify" } },
    stages: { before: { action: "first" }, after: { action: "last" } },
    verification: { stages: ["before", "verify", "after"] },
  };
  writeFileSync(file, stringify(config));
  const docs = join(configDir, "specs/task");
  mkdirSync(docs, { recursive: true });
  writeFileSync(join(docs, "scope.md"), "Check the configured stages in order.");
  f.ledger.freezeSpec({ task_id: "task" });
  const result = f.cli("verify", [], { FIXTURE_CREDENTIAL: "synthetic" });
  expect(result.exitCode, result.stderr.toString() + result.stdout.toString()).toBe(0);
  const events = readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(events.map(row => row[0])).toEqual(["first", "static", "dynamic", "last"]);
  expect(events.every(row => row[1] === events[0][1] && row[2] === null)).toBe(true);
  expect(events[0][1]).not.toBe(f.repo);
  expect(existsSync(events[0][1])).toBe(false);
  const receipt = f.evidence().at(-1);
  expect(receipt).toMatchObject({ kind: "verify", source: "tool", status: "pass", meta: { mode: "all" } });
  expect(receipt.meta.stages.map((s: { kind: string }) => s.kind)).toEqual(["verify", "lint", "test", "verify"]);
  expect(receipt.meta.stages[0].output_sha256).toBe(new Bun.CryptoHasher("sha256").update("first\n").digest("hex"));

  const adapters = join(configDir, "actions");
  mkdirSync(adapters);
  const output = join(f.root, "adapter-result.json");
  writeFileSync(join(adapters, "check.ts"),
    "#!/usr/bin/env bun\nawait Bun.write(process.argv[2], JSON.stringify({cwd:process.cwd(), checkout:process.env.FORGE_VERIFY_CHECKOUT, environment:process.env.FORGE_VERIFY_ENVIRONMENT}));", {mode:0o755});
  writeFileSync(join(adapters, "rules.txt"), "fixture input\n");
  config.extensions.actions.first.cwd = "service";
  config.extensions.actions.last = { cwd: ".workbench/actions", argv: ["./check.ts", output], inputs: ["rules.txt"], purpose: "verify" };
  config.extensions.verification.environment = "fixture-lab";
  writeFileSync(file, stringify(config));
  const custom = f.cli("verify", []);
  expect(custom.exitCode, custom.stderr.toString() + custom.stdout.toString()).toBe(0);
  const adapter = JSON.parse(readFileSync(output, "utf8"));
  expect(adapter.cwd).toBe(adapters);
  expect(adapter.environment).toBe("fixture-lab");
  expect(f.evidence().at(-1)?.meta.environment).toBe(adapter.environment);
  const lastFirst = readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(row => row[0] === "first").at(-1);
  expect(lastFirst[1]).toBe(adapter.checkout);
  expect(existsSync(adapter.checkout)).toBe(false);

  const readiness = () => f.ledger.checkPushReadiness({ task_id: "task", repo: "service", branch: "feature", head_sha: f.git("rev-parse", "HEAD") }).missing;
  for (const file of ["check.ts", "rules.txt"]) {
    const old = f.evidence().at(-1).meta.policy_sha256;
    appendFileSync(join(adapters, file), "\n// local change\n");
    expect(readiness().join(" ")).toContain("Missing completed verification");
    expect(f.cli("verify", []).exitCode).toBe(0);
    expect(f.evidence().at(-1).meta.policy_sha256).not.toBe(old);
    expect(readiness().join(" ")).not.toContain("Missing completed verification");
  }
  const before = f.evidence().at(-1);
  const executable = join(adapters, "check.ts");
  renameSync(executable, executable + ".saved");
  const unavailable = f.cli("verify", []);
  expect(unavailable.exitCode).not.toBe(0);
  expect(f.evidence().at(-1)).toMatchObject({ kind: "verify", status: "fail", source: "tool", meta: {
    startup_failure: true, failed_phase: "instance configuration", freeze_seq: before.meta.freeze_seq,
  } });
  renameSync(executable + ".saved", executable);
  expect(readiness().join(" ")).toContain("latest verify failed");
  expect(f.cli("verify", []).exitCode).toBe(0);
  expect(readiness().join(" ")).not.toContain("latest verify failed");

  config.extensions.actions.last.argv = ["bun", "run", "./check.ts", output];
  writeFileSync(file, stringify(config));
  expect(f.cli("verify", []).exitCode).toBe(0);
  const pinnedScript = f.evidence().at(-1).meta.policy_sha256;
  appendFileSync(executable, "\n// update the verifier entry point");
  expect(readiness().join(" ")).toMatch(/verification|verify failed/);
  expect(f.cli("verify", []).exitCode).toBe(0);
  expect(f.evidence().at(-1).meta.policy_sha256).not.toBe(pinnedScript);

  config.extensions.actions.first.argv = ["bun", "-e", "process.exit(9)"];
  writeFileSync(file, stringify(config));
  expect(f.cli("verify", []).exitCode).toBe(1);
  expect(f.evidence().at(-1)).toMatchObject({ kind: "verify", status: "fail", meta: { stages: [{ stage: "before", exit_code: 9 }] } });
}, 30_000);

test("the isolated Bun installer fills a cold cache online and reuses it on explicit offline runs", async () => {
  const pkg = join(f.root, "fixture-package");
  const cache = join(f.root, "dependency-cache");
  mkdirSync(pkg);
  const manifest = { name: "forge-fixture-parser", version: "1.0.0", main: "index.js" };
  writeFileSync(join(pkg, "package.json"), JSON.stringify(manifest));
  writeFileSync(join(pkg, "index.js"), "export default 17;");
  const archive = join(f.root, "fixture.tgz");
  const pack = Bun.spawnSync([process.execPath, "pm", "pack", "--ignore-scripts", "--filename", archive], {cwd: pkg});
  expect(pack.exitCode, pack.stderr.toString()).toBe(0);
  const tarball = readFileSync(archive);
  let fetches = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    ++fetches;
    expect(request.headers.get("authorization")).toBeNull();
    if (request.url.endsWith(".tgz")) return new Response(tarball);
    return Response.json({ name: manifest.name, "dist-tags": {latest: "1.0.0"}, versions: {"1.0.0": {
      ...manifest, dist: {tarball: new URL("/fixture.tgz", request.url).href},
    }}});
  }});
  try {
    writeFileSync(join(f.repo, "package.json"), JSON.stringify({ dependencies: { [manifest.name]: "1.0.0" } }));
    writeFileSync(join(f.repo, "bunfig.toml"), '[install]\nregistry = ' + JSON.stringify(server.url.href) + '\n');
    writeFileSync(join(f.repo, ".gitignore"), "node_modules/");
    writeFileSync(join(f.repo, "cached.test.ts"), [
      'import {test,expect} from "bun:test"; import value from "forge-fixture-parser";',
      'test("isolated dependency", () => { expect(value).toBe(17); expect(process.env.SYNTHETIC_OPERATOR_TOKEN).toBeUndefined(); expect(process.env.BUN_INSTALL_CACHE_DIR).toBeUndefined(); });',
    ].join("\n"));
    const install = Bun.spawn([process.execPath, "install", "--cache-dir", cache, "--ignore-scripts"], {cwd: f.repo, stdout: "ignore", stderr: "pipe"});
    const [code, text] = await Promise.all([install.exited, new Response(install.stderr).text()]);
    expect(code, text).toBe(0);
    f.git("add", "--", ".gitignore", "package.json", "bunfig.toml", "cached.test.ts", "bun.lock");
    f.git("commit", "-m", "offline fixture");
    const docs = join(f.root, ".workbench/specs/task");
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(docs, "scope.md"), "Exercise preloaded packages.");
    f.ledger.freezeSpec({ task_id: "task" });
    const args = ["--kind", "test", "--", "bun", "test"];
    const freshCache = join(f.root, "cold-cache");
    const before = fetches;
    const online = await f.cliAsync("verify", args, { BUN_INSTALL_CACHE_DIR: freshCache, SYNTHETIC_OPERATOR_TOKEN: "fixture" });
    expect(online.exitCode, online.stderr + online.stdout).toBe(0);
    expect(fetches).toBeGreaterThan(before);
    const after = fetches;
    const empty = await f.cliAsync("verify", ["--offline", ...args], { BUN_INSTALL_CACHE_DIR: join(f.root, "empty-cache") });
    expect(empty.exitCode).not.toBe(0);
    expect(empty.stderr).toContain("Cannot install locked verification dependencies");
    expect(fetches).toBe(after);
    server.stop(true);
    const offline = f.cli("verify", ["--offline", ...args], { BUN_INSTALL_CACHE_DIR: freshCache });
    expect(offline.exitCode, offline.stderr.toString() + offline.stdout.toString()).toBe(0);
  } finally { server.stop(true); }
});

test("project verification resolves inputs and programs from the selected linked worktree commit", () => {
  const configDir = configureInstance();
  const configFile = join(configDir, "workbench.yaml");
  const config = parse(readFileSync(configFile, "utf8"));
  const output = join(f.root, "verification-output");
  const action = { purpose: "verify", cwd: ".", argv: ["./checks/run"], inputs: ["checks/rules"] };
  config.extensions = { actions: { project: action }, stages: { check: { action: "project" } },
    verification: { stages: ["check"] } };
  writeFileSync(configFile, stringify(config));
  const docs = join(configDir, "specs/task");
  mkdirSync(docs, { recursive: true });
  writeFileSync(join(docs, "scope.md"), "Use files from the verified commit.");
  f.ledger.freezeSpec({ task_id: "task" });
  f.git("switch", "-c", "main");
  const linked = join(f.root, "service.worktrees/topic");
  f.git("worktree", "add", linked, "feature");
  mkdirSync(join(linked, "checks"));
  writeFileSync(join(linked, "checks/rules"), "selected commit");
  writeFileSync(join(linked, "checks/run"),
    '#!/usr/bin/env bun\nawait Bun.write(' + JSON.stringify(output) + ', await Bun.file(process.argv[2]).text());', { mode: 0o755 });
  f.git("-C", linked, "add", "--", "checks/run", "checks/rules");
  f.git("-C", linked, "commit", "-m", "add branch-local verifier");
  expect(existsSync(join(f.repo, "checks/run"))).toBe(false);
  for (const cwd of [".", "service/checks"]) {
    Object.assign(action, cwd === "."
      ? {cwd, argv: ["./checks/run", "checks/rules"], inputs: ["checks/rules"]}
      : {cwd, argv: ["./run", "rules"], inputs: ["rules"]});
    writeFileSync(configFile, stringify(config));
    const diagnosis = f.cli("doctor", [f.root, "--json"]);
    const issues = JSON.parse(diagnosis.stdout.toString()).issues;
    expect(issues.filter((issue: {check:string}) => issue.check === "configuration")).toEqual([]);
    expect(issues).toContainEqual(expect.objectContaining({check:"verification", message:expect.stringContaining("selected commit")}));
    const result = f.cli("verify", ["--task", "task", "--cwd", linked]);
    expect(result.exitCode, result.stderr.toString() + result.stdout.toString()).toBe(0);
    expect(readFileSync(output, "utf8")).toBe("selected commit");
    expect(f.ledger.getTaskEvents("task").filter(e => e.event_type === "EVIDENCE_CAPTURED").at(-1)?.sha).toBe(f.git("-C", linked, "rev-parse", "HEAD"));
  }

  action.inputs = ["missing"];
  writeFileSync(configFile, stringify(config));
  const missing = f.cli("verify", ["--task", "task", "--cwd", linked]);
  expect(missing.exitCode).not.toBe(0);
  expect(missing.stderr.toString() + missing.stdout.toString()).toContain("Missing verification file at selected commit");
  action.inputs = [];
  action.argv = ["./rules"];
  writeFileSync(configFile, stringify(config));
  const mode = f.cli("verify", ["--task", "task", "--cwd", linked]);
  expect(mode.exitCode).not.toBe(0);
  expect(mode.stderr.toString() + mode.stdout.toString()).toContain("not executable at selected commit");
}, 30_000);
