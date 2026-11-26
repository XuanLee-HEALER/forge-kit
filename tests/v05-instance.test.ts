import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { kit, sandbox, type Sandbox } from "./v05-sandbox";

let s: Sandbox;
beforeEach(() => { s = sandbox(); });
afterEach(() => s.cleanup());

function configure(extensions: object) {
  const path = join(s.work, ".workbench/workbench.yaml");
  writeFileSync(path, stringify({ ...parse(s.read(".workbench/workbench.yaml")), extensions }));
  return path;
}

test("T04/T05/T12 clean installation discovers exactly the core catalog under Bun", () => {
  s.fresh();
  const skills = ["bugfix", "feature", "grill", "pr-triage", "ready", "review", "ship", "verify"];
  expect(readdirSync(join(s.work, ".agents/skills")).sort()).toEqual(skills);
  expect(readdirSync(join(s.work, ".codex/agents")).sort()).toEqual(
    ["analyst", "implementer", "reviewer", "scanner"].map(name => name + ".toml"),
  );
  expect(statSync(join(s.work, "AGENTS.md")).size).toBeLessThan(8000);
  const list = JSON.parse(s.ok([s.forge, "instance", "list", "--json"]));
  for (const id of skills) expect(JSON.stringify(list)).toContain(id);
  for (const command of ["ledger", "wb-git", "wb-verify", "forge-ship", "forge-review"])
    expect(existsSync(join(s.work, ".workbench/bin", command))).toBe(false);
  s.ok([s.forge, "doctor", s.work, "--json"]);
  expect(existsSync(s.probeLog)).toBe(false);
}, 60_000);

test("T02 discovery, invocation and repeated sync preserve one effective skill", () => {
  s.fresh();
  const marker = "local-stage-receipt";
  configure({
    actions: { smokeCheck: { argv: ["bun", "-e", `await Bun.write('${marker}', 'complete')`], cwd: ".", purpose: "verify" } },
    stages: { smoke: { action: "smokeCheck" } }, verification: { environment: "isolated", stages: ["smoke"] },
    skills: { ready: ".workbench/overrides/ready" },
  });
  for (const revision of ["first", "second"]) {
    const description = `Synthetic discovery ${revision}`;
    const body = `Synthetic instruction ${revision}`;
    const bytes = `---\nname: ready\ndescription: ${description}\n---\n\n${body}\n`;
    const source = s.privateFile(".workbench/overrides/ready/SKILL.md", bytes);
    for (let iteration = 0; iteration < 2; iteration++) {
      s.ok([s.forge, "sync", s.work]);
      expect(readFileSync(source, "utf8")).toBe(bytes);
      const show = s.ok([s.forge, "instance", "show", "skill", "ready", "--json"]);
      expect(show).toContain(description);
      expect(s.read(".agents/skills/ready/SKILL.md")).toContain(body);
      expect(s.ok([s.forge, "instance", "list", "--json"])).toContain(description);
    }
  }
  s.ok([s.forge, "instance", "run", "smoke"]);
  expect(s.read(marker)).toBe("complete");

  const repo = join(s.work, "app");
  mkdirSync(repo);
  s.git(repo, "init", "-b", "feature");
  s.git(repo, "config", "user.name", "Fixture");
  s.git(repo, "config", "user.email", "fixture@example.invalid");
  const configFile = join(s.work, ".workbench/workbench.yaml");
  const config = parse(s.read(".workbench/workbench.yaml"));
  writeFileSync(configFile, stringify({...config, repos: ["app"]}));
  const ledger = (...args: string[]) => s.ok([s.forge, "ledger", ...args]);
  for (const branch of ["feature", "sibling"])
    ledger("open", "--id", branch, "--title", branch, "--repo", "app", "--branch", branch, "--endpoint", "local", "--depth", "targeted");
  writeFileSync(join(repo, "note.md"), "one isolated change");
  s.git(repo, "add", "--", "note.md");
  const args = ["git", "-C", repo, "commit", "-m", "fixture", "--", "note.md"];
  const output = s.ok(args);
  const sha = s.git(repo, "rev-parse", "HEAD").trim();
  const hook = s.hook("PostToolUse", {cwd: repo, session_id: "test", tool_use_id: "ordinary-commit",
    tool_name: "Bash", tool_input: {command: args.join(" ")}, tool_response: {exit_code: 0, output}});
  for (const reply of hook) expect(reply.code, reply.text).toBe(0);
  const events = JSON.parse(ledger("query", "--q", "commit", "--repo", "app", "--json")).events;
  const commit = events.filter((e: {sha: string}) => e.sha === sha);
  expect(commit, JSON.stringify({hook, events})).toHaveLength(1);
  expect(commit[0]).toMatchObject({task_id: "feature", repo: "app", branch: "feature", sha});
  expect(JSON.parse(commit[0].payload_json)).toMatchObject({kind: "commit", source: "hook"});
  const decision = s.hook("PreToolUse", {cwd: repo, tool_name: "Bash", session_id: "test",
    tool_input: {command: "gh pr merge 1"}});
  expect(decision.some(reply => reply.code === 2 || /"permissionDecision"\s*:\s*"deny"/.test(reply.text))).toBe(true);
}, 90_000);

for (const error of ["yaml", "reference", "permissions"]) {
  test(`T03 doctor and sync diagnose ${error} and recover after repair`, () => {
    s.fresh();
    const file = join(s.work, ".workbench/workbench.yaml");
    const good = readFileSync(file);
    if (error === "reference") configure({ skills: { ready: ".workbench/no-such-override" } });
    if (error === "yaml") writeFileSync(file, "extensions: [\n");
    let run = (args: string[]) => s.run(args);
    if (error === "permissions") {
      // A root-owned CI process can read mode 000. Run the failure probes as the local nobody account.
      if (process.getuid?.() === 0) {
        const uid = Number(s.ok(["id", "-u", "nobody"]).trim());
        const gid = Number(s.ok(["id", "-g", "nobody"]).trim());
        const runtime = join(s.bin, "bun");
        unlinkSync(runtime);
        copyFileSync(process.execPath, runtime);
        chmodSync(s.root, 0o755);
        run = (args: string[]) => {
          const r = spawnSync(args[0]!, args.slice(1), { cwd: s.work, env: s.env, uid, gid, encoding: "utf8" });
          if (r.error || r.status === null) throw r.error ?? new Error("Unprivileged command failed to launch");
          return {code: r.status, out: r.stdout, err: r.stderr};
        };
      }
      chmodSync(file, 0);
    }
    try {
      if (error === "permissions") {
        const probe = run(["/bin/cat", file]);
        expect(probe.code).not.toBe(0);
        expect(probe.err).toMatch(/permission denied/i);
      }
      for (const args of [["doctor", s.work, "--json"], ["sync", s.work]]) {
        const result = run([s.forge, ...args]);
        expect(result.code).not.toBe(0);
        expect(result.out + result.err).toMatch(error === "reference" ? /no-such-override|skills\.ready/ : /workbench\.yaml/);
      }
    } finally {
      chmodSync(file, 0o600);
      writeFileSync(file, good);
    }
    s.ok([s.forge, "sync", s.work]);
    s.ok([s.forge, "doctor", s.work, "--json"]);
  }, 60_000);
}

test("T05/T12 portable distribution self-bootstraps outside the checkout", () => {
  const archive = join(s.root, "distribution.tgz");
  const source = join(s.root, "distribution-source");
  // Build the working sources in isolation so neither package can reuse a previous bundle.
  const paths = s.git(kit, "ls-files", "--cached", "--others", "--exclude-standard", "-z");
  for (const path of paths.split("\0").filter(Boolean)) {
    const input = join(kit, path);
    if (!existsSync(input) || statSync(input).isDirectory()) continue;
    const output = join(source, path);
    mkdirSync(dirname(output), {recursive: true});
    cpSync(input, output, {verbatimSymlinks: true});
  }
  for (const workspace of [".", "review-agents"]) {
    const deps = join(workspace, "node_modules");
    if (existsSync(join(kit, deps))) symlinkSync(join(kit, deps), join(source, deps));
  }
  mkdirSync(join(source, ".workbench"));
  writeFileSync(join(source, ".workbench/private-marker"), "synthetic instance file");
  s.ok(["bun", "run", "build"], source);
  s.ok(["bun", "pm", "pack", "--quiet", "--ignore-scripts", "--filename", archive], source);
  const files = s.ok(["tar", "-tzf", archive], s.root).trim().split("\n");
  expect(files).toContain("package/dist/cli.js");
  expect(files).toContain("package/review-agents/dist/review.js");
  for (const path of files) {
    expect(path).not.toMatch(/^package\/(?:\.workbench|\.codex|\.agents|packs)(?:\/|$)/);
    expect(path).not.toMatch(/(?:^package\/AGENTS\.local\.md|v0\.5-requirements\.md|work-communication|form-ux\/|qa-polling)/);
  }
  s.ok(["tar", "-xzf", archive], s.root);
  s.git(s.root, "clone", "--local", "--", kit, s.work);
  expect(s.git(s.work, "status", "--porcelain")).toBe("");
  const forge = join(s.root, "package/bin/forge");
  s.ok([forge, "init", "."]);
  s.ok([forge, "add-repo", ".", "--workbench", "."]);
  s.ok([forge, "add-repo", ".", "--workbench", "."]);
  expect(parse(s.read(".workbench/workbench.yaml")).repos).toEqual(["."]);
  expect(s.read(".workbench/root-repo.md")).toContain("`.`");
  const doctor = JSON.parse(s.ok([forge, "doctor", ".", "--json"]));
  expect(doctor.ok).toBe(true);
  expect(doctor.issues.filter((issue: {check: string}) => issue.check === "repos")).toEqual([]);
  s.ok([s.forge, "doctor", "."]);
  expect(existsSync(s.probeLog)).toBe(false);
}, 60_000);

for (const incident of [
  {source: "qa defect", environment: "qa"},
  {source: "production defect", environment: "live"},
  {source: "alert", environment: "live"},
]) {
  test(`T10 ${incident.source} diagnostics query only the reporting environment`, async () => {
    s.fresh();
    const requests: {path: string; method: string}[] = [];
    const server = Bun.serve({hostname: "127.0.0.1", port: 0, fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push({path, method: request.method});
      return Response.json({environment: path.slice(1), incident: incident.source});
    }});
    try {
      const actions = Object.fromEntries(["qa", "live"].map(environment => [environment, {
        argv: ["bun", "-e", "console.log(await (await fetch(process.argv[1])).text())", server.url.origin + "/" + environment],
        cwd: ".", purpose: "diagnose",
      }]));
      configure({ actions, stages: {reportQA: {action: "qa"}, reportLive: {action: "live"}} });
      const stage = incident.environment === "qa" ? "reportQA" : "reportLive";
      expect(s.ok([s.forge, "instance", "list", "--json"])).toContain(stage);
      const proc = Bun.spawn([s.forge, "instance", "run", stage], {cwd: s.work, env: s.env, stdout: "pipe", stderr: "pipe", timeout: 12_000});
      const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      expect(code, out + err).toBe(0);
      expect(out).toContain(incident.source);
      expect(requests).toEqual([{path: "/" + incident.environment, method: "GET"}]);
      expect(JSON.parse(s.ok([s.forge, "ledger", "query", "--json"])).tasks).toEqual([]);
    } finally { await server.stop(true); }
  }, 30_000);
}

test("installed skills use the delivered release across source changes, removal and override rollback", () => {
  const source = join(s.root, "source");
  mkdirSync(source);
  for (const path of ["core", "templates", "kit.toml", "dist"]) cpSync(join(kit,path), join(source,path), {recursive:true});
  const release = ["bun", join(source, "dist/cli.js")];
  s.ok([...release, "init", s.work]);
  const show = [s.forge, "instance", "show", "skill", "ready", "--json"];
  const projection = ".agents/skills/ready/SKILL.md";
  const original = JSON.parse(s.ok(show));
  expect(original.value.path).toBe(join(realpathSync(s.work), projection));
  const sourceSkill = join(source, "core", projection);
  const next = '---\nname: ready\ndescription: Second release\n---\nSecond release body\n';
  writeFileSync(sourceSkill, next);
  expect(JSON.parse(s.ok(show))).toEqual(original);
  s.ok([s.forge, "doctor", s.work, "--json"]);
  const relocated = join(s.root, "relocated");
  renameSync(source, relocated);
  expect(JSON.parse(s.ok(show))).toEqual(original);
  s.ok([s.forge, "doctor", s.work, "--json"]);
  const sync = ["bun", join(relocated, "dist/cli.js"), "sync", s.work];
  const lockFile = ".workbench/kit-lock.json";
  const before = s.read(lockFile);
  const previousFormat = JSON.parse(before);
  delete previousFormat.skill_overrides;
  writeFileSync(join(s.work, lockFile), JSON.stringify(previousFormat));
  expect(JSON.parse(s.ok(show))).toMatchObject({source:original.value.path,value:original.value});
  writeFileSync(join(s.work, lockFile), before);
  configure({verification: {environment: null}});
  expect(s.run(sync).code).not.toBe(0);
  expect(s.read(lockFile)).toBe(before);
  expect(s.read(projection)).toContain(original.value.description);
  configure({});
  s.ok(sync);
  expect(JSON.parse(s.ok(show)).value.description).toBe("Second release");
  const override = ".workbench/private-ready";
  const privateFile = s.privateFile(override + "/SKILL.md", next.replaceAll("Second release","Private override"));
  configure({skills:{ready:override}});
  expect(s.run(show).code).not.toBe(0);
  s.ok(sync);
  expect(JSON.parse(s.ok(show))).toMatchObject({source:realpathSync(privateFile), value:{description:"Private override",path:join(realpathSync(s.work),projection)}});
  const privateBytes = readFileSync(privateFile);
  configure({});
  expect(s.run(show).code).not.toBe(0);
  expect(s.run([s.forge, "doctor", s.work, "--json"]).code).not.toBe(0);
  s.ok(sync);
  expect(JSON.parse(s.ok(show))).toMatchObject({source:"core",value:{description:"Second release",path:join(realpathSync(s.work),projection)}});
  expect(readFileSync(privateFile)).toEqual(privateBytes);
  writeFileSync(join(realpathSync(s.work), projection), next.replaceAll("Second release","Local edit"));
  expect(s.run(show).code).not.toBe(0);
  expect(s.run([s.forge, "doctor", s.work, "--json"]).out).toContain("move the edited file aside");
  expect(s.run(sync).code).not.toBe(0);
}, 60_000);

test("explicit null is invalid for extension fields with defaults", () => {
  s.fresh();
  const before = s.read(".workbench/kit-lock.json");
  for (const [extensions,field] of [
    [{ actions: { inspect: { argv:["bun","--version"], purpose:"diagnose", cwd:null } } }, "actions.inspect.cwd"],
    [{ verification: {environment:null} }, "verification.environment"],
    [{ delivery: {endpoint:null} }, "delivery.endpoint"],
  ] as const) {
    configure(extensions);
    for (const args of [["doctor",s.work,"--json"], ["sync",s.work], ["instance","list","--json"]]) {
      const result = s.run([s.forge,...args]);
      expect(result.code).not.toBe(0);
      expect(result.err + result.out).toContain(field);
    }
    expect(s.read(".workbench/kit-lock.json")).toEqual(before);
  }
});
