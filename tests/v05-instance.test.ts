import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  s.ok(["bun", "pm", "pack", "--quiet", "--ignore-scripts", "--filename", archive], kit);
  const files = s.ok(["tar", "-tzf", archive], s.root).trim().split("\n");
  for (const path of files) {
    expect(path).not.toMatch(/^package\/(?:\.workbench|\.codex|\.agents|packs)(?:\/|$)/);
    expect(path).not.toMatch(/(?:^package\/AGENTS\.local\.md|v0\.5-requirements\.md|work-communication|form-ux\/|qa-polling)/);
  }
  s.ok(["tar", "-xzf", archive], s.root);
  s.ok([join(s.root, "package/bin/forge"), "init", s.work], s.root);
  s.ok([s.forge, "doctor", s.work, "--json"]);
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
