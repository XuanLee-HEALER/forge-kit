import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { runInstanceStage } from "../src/instance";
import { locateRepo } from "../src/git";
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

test("instance run dispatches built-ins by stage source even with same-name private actions", () => {
  s.fresh();
  const actions = Object.fromEntries(["verify", "ship"].map(id => [id, {
    purpose: "diagnose", argv: ["bun", "-e", "await Bun.write('" + id + "-ran', 'yes')"],
  }]));
  configure({actions});
  const direct = s.run([s.forge, "verify"]);
  const builtin = s.run([s.forge, "instance", "run", "verify"]);
  expect(builtin.code).not.toBe(0);
  expect(builtin.err).toBe(direct.err);
  expect(() => runInstanceStage(s.work, "verify")).toThrow("isolated core verification");
  expect(() => runInstanceStage(s.work, "ship")).toThrow("authorized forge ship");
  const ship = s.run([s.forge, "instance", "run", "ship"]);
  expect(ship.code).not.toBe(0);
  expect(ship.err).toContain("authorized forge ship");
  expect(existsSync(join(s.work, "ship-ran"))).toBe(false);
  expect(existsSync(join(s.work, "verify-ran"))).toBe(false);
  configure({actions, stages:{inspect:{action:"verify"}}});
  s.ok([s.forge, "instance", "run", "inspect"]);
  expect(s.read("verify-ran")).toBe("yes");
  unlinkSync(join(s.work, "verify-ran"));
  configure({actions:{...actions, verify:{...actions.verify, purpose:"verify"}}, stages:{verify:{action:"verify"}}});
  s.ok([s.forge, "instance", "run", "verify"]);
  expect(s.read("verify-ran")).toBe("yes");
});

test("sync projects referenced Unicode resources while enforcing the skill directory boundary", () => {
  s.fresh();
  const dir = ".workbench/overrides/ready";
  const resource = "references/验收（草案）.md";
  const header = "---\nname: ready\ndescription: 本地技能\n---\n";
  const skill = s.privateFile(dir + "/SKILL.md", header + [
    '[验收](' + resource + '#section "Usage")', "[Steps][guide]", "",
    "[guide]: <references/操作 指南.md> 'Guide'", "", "![示例](assets/流程%20图.png)",
    "[version](references/版本\\(1\\).md)", "`scripts/check.ts`", "`[Example](references/private.md)`",
  ].join("\n"));
  const source = s.privateFile(dir + "/" + resource, "验收内容");
  const supporting = ["references/操作 指南.md", "assets/流程 图.png", "references/版本(1).md", "scripts/check.ts"];
  for (const file of supporting) s.privateFile(dir + "/" + file, file);
  configure({skills:{ready:dir}});
  const sync = [s.forge, "sync", s.work];
  const projected = ".agents/skills/ready/" + resource;
  s.ok(sync);
  expect(s.read(projected)).toBe("验收内容");
  for (const file of supporting) expect(s.read(".agents/skills/ready/" + file)).toBe(file);
  expect(existsSync(join(s.work, ".agents/skills/ready/references/private.md"))).toBe(false);
  s.ok([s.forge, "doctor", s.work, "--json"]);
  writeFileSync(source, "修订");
  s.ok(sync);
  expect(s.read(projected)).toBe("修订");
  const external = s.privateFile(".workbench/验收.md", "private");
  const linked = join(s.work, dir, "references/链接.md");
  symlinkSync(external, linked);
  for (const [reference, reason] of [
    ["references/链接.md", "Symlink in managed path"],
    ["../../验收.md", "Expected a relative path"],
    ["%2e%2e/%2e%2e/验收.md", "Expected a relative path"],
    ["references", "Unreadable file"],
  ]) {
    writeFileSync(skill, header + '[验收][guide]\n\n[guide]: <' + reference + '> "Usage"');
    const result = s.run(sync);
    expect(result.code).not.toBe(0);
    expect(result.err + result.out).toContain(reason);
    expect(s.read(projected)).toBe("修订");
  }
  configure({});
  s.ok(sync);
  expect(existsSync(join(s.work, projected))).toBe(false);
  expect(readFileSync(source, "utf8")).toBe("修订");
}, 60_000);

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

function linkWorkspaceDependencies(destination: string) {
  for (const workspace of [".", "review-agents"]) {
    const deps = join(workspace, "node_modules");
    if (existsSync(join(kit, deps))) symlinkSync(join(kit, deps), join(destination, deps));
  }
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
  linkWorkspaceDependencies(source);
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
  const release = join(s.root, "package");
  const uninitialized = s.run([forge, "add-repo", s.work], release);
  expect(uninitialized.code).not.toBe(0);
  expect(uninitialized.err + uninitialized.out).toContain("Not an initialized workbench");
  expect(existsSync(join(s.root, ".workbench"))).toBe(false);
  expect(existsSync(join(s.work, ".workbench"))).toBe(false);
  const parentConfig = join(s.root, ".workbench/workbench.yaml");
  mkdirSync(dirname(parentConfig));
  writeFileSync(parentConfig, "repos: []\n");
  const partial = s.run([forge, "add-repo", s.work], release);
  expect(partial.code).not.toBe(0);
  expect(partial.err + partial.out).toContain("kit-lock.json");
  expect(readFileSync(parentConfig, "utf8")).toBe("repos: []\n");
  expect(readdirSync(dirname(parentConfig))).toEqual(["workbench.yaml"]);
  s.ok([forge, "init", s.work], release);
  const linked = join(s.root, "worktree");
  s.git(s.work, "worktree", "add", "-b", "self-bootstrap", linked, "HEAD");
  for (const checkout of [s.work, linked]) expect(locateRepo(s.work, checkout)).toBeNull();
  const registered = JSON.parse(s.ok([forge, "add-repo", s.work], release));
  expect(registered).toMatchObject({repoName: ".", registered: true});
  expect(JSON.parse(s.ok([forge, "add-repo", s.work], release)).registered).toBe(false);
  expect(readdirSync(dirname(parentConfig))).toEqual(["workbench.yaml"]);
  expect(parse(s.read(".workbench/workbench.yaml")).repos).toEqual(["."]);
  for (const checkout of [s.work, linked]) expect(locateRepo(s.work, checkout)).toMatchObject({
    repo: ".", repoRoot: realpathSync(s.work), checkoutDir: realpathSync(checkout),
  });
  expect(s.read(".workbench/root-repo.md")).toContain("`.`");
  const doctor = JSON.parse(s.ok([forge, "doctor", ".", "--json"]));
  expect(doctor.ok).toBe(true);
  expect(doctor.issues.filter((issue: {check: string}) => issue.check === "repos")).toEqual([]);
  s.ok([s.forge, "doctor", "."]);
  expect(existsSync(s.probeLog)).toBe(false);
}, 60_000);

test("self-hosted root task routes commit, review and isolated verification evidence from a linked checkout", () => {
  s.git(s.work, "init", "-b", "main");
  s.git(s.work, "config", "user.name", "Fixture");
  s.git(s.work, "config", "user.email", "fixture@example.invalid");
  s.git(s.work, "commit", "--allow-empty", "-m", "base");
  const base = s.git(s.work, "rev-parse", "HEAD").trim();
  s.fresh();
  s.ok([s.forge, "add-repo", ".", "--workbench", "."]);
  const linked = join(s.root, "worktree");
  s.git(s.work, "worktree", "add", "-b", "root-task", linked, base);
  const ledger = (...args: string[]) => s.ok([s.forge, "ledger", ...args]);
  ledger("open", "--id", "root-task", "--title", "Root task", "--repo", ".", "--branch", "root-task",
    "--base", base, "--worktree", linked, "--depth", "targeted", "--endpoint", "local");
  s.privateFile(".workbench/specs/root-task/scope.md", "Exercise the registered root repository.");
  ledger("freeze", "root-task");
  writeFileSync(join(linked, "root.test.ts"), 'import { test, expect } from "bun:test"; test("root", () => expect(2+2).toBe(4));');
  s.git(linked, "add", "--", "root.test.ts");
  const args = ["git", "-C", linked, "commit", "-m", "root-test", "--", "root.test.ts"];
  const output = s.ok(args);
  const head = s.git(linked, "rev-parse", "HEAD").trim();
  const hook = s.hook("PostToolUse", {cwd: linked, session_id: "test", tool_use_id: "root-commit",
    tool_name: "Bash", tool_input: {command: args.join(" ")}, tool_response: {exit_code: 0, output}});
  for (const reply of hook) expect(reply.code, reply.text).toBe(0);
  const commits = JSON.parse(ledger("query", "--q", "commit", "--repo", ".", "--json")).events;
  expect(commits).toContainEqual(expect.objectContaining({task_id: "root-task", repo: ".", branch: "root-task", sha: head}));
  const verified = JSON.parse(s.ok([s.forge, "verify", "--task", "root-task", "--repo", ".", "--kind", "test",
    "--", "bun", "test", "./root.test.ts"], linked));
  expect(verified).toMatchObject({ok: true, task_id: "root-task", head, results: [{kind: "test", exit_code: 0}]});
  const codex = join(s.bin, "codex");
  writeFileSync(codex, '#!/usr/bin/env bun\nconst request = JSON.parse(await Bun.stdin.text()); await Bun.write(process.argv[process.argv.indexOf("-o")+1], JSON.stringify({status:"pass",summary:"Checked",role:request.role,checked:request.chunks.map(({id,path})=>({id,path,conclusion:"reviewed"})),limitations:[],findings:[]}));\n', {mode: 0o755});
  s.env.FORGE_CODEX_BIN = codex;
  s.ok([s.forge, "review", "--task", "root-task", "--repo", ".", "--roles", "quality"], linked);
  expect(JSON.parse(ledger("reviews", "root-task"))).toContainEqual(expect.objectContaining({role: "quality", status: "pass", base, head}));
}, 60_000);

test("installed skills use the delivered release across source changes, removal and override rollback", () => {
  const source = join(s.root, "source");
  mkdirSync(source);
  const checkout = join(s.root, "release-input");
  const revision = s.git(kit, "rev-parse", "HEAD").trim();
  s.git(s.root, "clone", "--local", "--no-checkout", "--", kit, checkout);
  s.git(checkout, "checkout", "--detach", revision);
  linkWorkspaceDependencies(checkout);
  for (const path of ["core", "templates", "kit.toml"]) cpSync(join(checkout, path), join(source, path), {recursive:true});
  s.ok(["bun", "build", "--target=bun", "src/bin/cli.ts", "--outfile", join(source, "dist/cli.js")], checkout);
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
