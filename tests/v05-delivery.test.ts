import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { sandbox, type Sandbox } from "./v05-sandbox";

let s: Sandbox;
beforeEach(() => { s = sandbox(); });
afterEach(() => s.cleanup());

function localTransport(bare: string, calls: string) {
  const git = Bun.which("git", {PATH: s.env.PATH});
  if (!git) throw new Error("Git is required for the local transport fixture");
  const race = join(s.root, "external-update");
  const gate = join(s.root, "receive-gate");
  const shellGit = "'" + git.replaceAll("'", "'\\''") + "'";
  writeFileSync(join(s.bin, "git"), '#!/bin/sh\ncase " $* " in\n  *" push "*) exec "${0%/*}/fixture-push" "$@" ;;\n  *) exec ' + shellGit + ' "$@" ;;\nesac\n', {mode:0o755});
  writeFileSync(join(s.bin, "fixture-push"), `#!/usr/bin/env bun
const args = process.argv.slice(2);
const push = args.indexOf("push");
const remote = args.findIndex((arg, index) => index > push && ["origin", "https://github.com/fixture/app.git"].includes(arg));
const git = ${JSON.stringify(git)}, bare = ${JSON.stringify(bare)};
if (push >= 0 && remote > push) {
  args[remote] = bare;
  const race = Bun.file(${JSON.stringify(race)});
  if (await race.exists()) {
    const {when, base, other} = await race.json();
    if (when === "before-advertisement") {
      const update = Bun.spawnSync([git, "-C", bare, "update-ref", "refs/heads/main", other, base]);
      if (update.exitCode !== 0) process.exit(7);
    }
  }
}
const result = Bun.spawnSync([git, ...args], {stdin:"inherit", stdout:"inherit", stderr:"inherit"});
process.exit(result.exitCode);
`, {mode:0o755});
  writeFileSync(join(bare, "hooks/pre-receive"), `#!/usr/bin/env bun
const updates = await Bun.stdin.text();
if (!updates.includes("refs/heads/main")) process.exit(0);
const gate = ${JSON.stringify(gate)};
if (await Bun.file(gate+".armed").exists()) {
  await Bun.write(gate+".entered", "1");
  const deadline = Date.now()+15000;
  while (!await Bun.file(gate).exists() && Date.now()<deadline) await Bun.sleep(20);
  if (!await Bun.file(gate).exists()) process.exit(4);
}
const race = Bun.file(${JSON.stringify(race)});
if (await race.exists()) {
  const {when, base, other} = await race.json();
  if (when === "before-update") {
    // An independent target-side writer races after advertisement, outside receive-pack's quarantine.
    const env = {...process.env};
    for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
    const result = Bun.spawnSync([${JSON.stringify(git)}, "-C", ${JSON.stringify(bare)}, "update-ref", "refs/heads/main", other, base], {env});
    process.exit(result.exitCode);
  }
}
`, {mode:0o755});
  writeFileSync(join(bare, "hooks/post-receive"), `#!/usr/bin/env bun
import {appendFileSync} from "node:fs";
for (const update of (await Bun.stdin.text()).trim().split("\\n")) {
  const [, next, ref] = update.split(" ");
  if (ref === "refs/heads/main") appendFileSync(${JSON.stringify(calls)}, "merge "+next+"\\n");
}
`, {mode:0o755});
  return {race, gate};
}

function preparePullRequest(track: "full" | "targeted" = "full", defect = false, endpoint = "pr") {
  s.fresh();
  const repo = join(s.work, "app");
  const bare = join(s.root, "remote.git");
  mkdirSync(join(repo, "src"), {recursive: true});
  s.git(repo, "init", "-b", "main");
  const git = (...args: string[]) => s.git(repo, ...args).trim();
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  function commit(path: string, value: string) {
    writeFileSync(join(repo, path), value);
    git("add", "--", path);
    git("commit", "-m", "fixture change", "--", path);
    return git("rev-parse", "HEAD");
  }
  commit("package.json", JSON.stringify({scripts: {check: "bun build --no-bundle --target=bun src/feature.ts"}}));
  commit("src/feature.ts", 'export const message = "Ready";\n');
  const base = commit("example.test.ts", 'import {expect,test} from "bun:test"; import {message} from "./src/feature"; test("ready output", ()=>expect(message.toLowerCase()).toBe("ready"));\n');
  s.git(s.root, "init", "--bare", "-b", "main", bare);
  // Preserve hosted identity for the forge CLI while restricting every Git push to the bare fixture.
  git("remote", "add", "origin", "https://github.com/fixture/app.git");
  git("push", bare, "main");
  git("switch", "-c", "feature-fixture");
  const config = join(s.work, ".workbench/workbench.yaml");
  const doc = parse(readFileSync(config, "utf8"));
  writeFileSync(config, stringify({...doc, repos: ["app"]}));
  if (endpoint === "blue-rollout") configureStage("success", base, base, endpoint, "publish");
  const ledger = (...args: string[]) => s.ok([s.forge, "ledger", ...args]);
  ledger("open", "--id", "ship-task", "--title", "isolated local merge", "--endpoint", endpoint, "--depth", track,
    "--repo", "app", "--branch", "feature-fixture", "--worktree", repo, "--base", base, "--head", base);
  const files = track === "targeted" ? ["scope.md"] : ["ssot.md", "tech-spec.md", "test-spec.md"];
  for (const file of files)
    s.privateFile(".workbench/specs/ship-task/" + file, "Return the lowercase ready message. Verify actual CLI output and the existing contract.\n");
  ledger("decide", "ship-task", "--key", "operator-confirmed", "--summary", "fixture operator confirms the scope and test cases");
  ledger("freeze", "ship-task", "--lock-tests", "example.test.ts");
  if (defect) {
    ledger("amend", "ship-task", "--scope", "invariant", "--reason", "confirmed exact case requirement");
    const key = ".workbench/specs/ship-task/" + files[0];
    s.privateFile(key, s.read(key) + "INV-1: preserve the exact lowercase spelling ready.\n");
    ledger("freeze", "ship-task", "--lock-tests", "example.test.ts");
  }
  const head = commit("src/feature.ts", 'export const message = "ready";\n');
  git("push", bare, "feature-fixture");
  if (endpoint === "blue-rollout") configureStage("success", head, base, endpoint, "publish");
  const pr = { url: "https://github.com/fixture/app/pull/1", number: 1, state: "OPEN", baseRefName: "main",
    headRefName: "feature-fixture", headRefOid: head, baseRefOid: base, isCrossRepository: false,
    headRepository: {name: "app"}, headRepositoryOwner: {login: "fixture"}, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" };
  const state = join(s.root, "host-pr.json");
  const ci = join(s.root, "ci-result");
  const calls = join(s.root, "host-effects");
  writeFileSync(calls, "");
  writeFileSync(state, JSON.stringify(pr));
  writeFileSync(ci, "pass");
  Object.assign(s.env, {FORGE_SESSION_ID: "operator", FORGE_WORKBENCH_ROOT: s.work, PR_STATE: state, CI_STATE: ci,
    TARGET_GIT: bare, TARGET_LOG: calls});
  writeFileSync(join(s.bin, "gh"), `#!/usr/bin/env bun
import {appendFileSync,readFileSync} from "node:fs";
const args = process.argv.slice(2);
const selector = args[2] ?? "";
const file = args[0] === "pr" && /(?:^|\\/)2$/.test(selector) ? process.env.PR_STATE+"-2" : process.env.PR_STATE;
const pr = await Bun.file(file).json();
const ref = (name) => Bun.spawnSync(["git", "-C", process.env.TARGET_GIT, "rev-parse", "refs/heads/"+name]).stdout.toString().trim();
if (args[0] === "api") console.log(ref("main"));
else if (args[0] === "pr" && args[1] === "list") console.log(JSON.stringify([pr]));
else if (args[0] === "pr" && args[1] === "view") {
  const main = ref("main");
  const updated = readFileSync(process.env.TARGET_LOG, "utf8").split("\\n").includes("merge "+main);
  const contains = oid => Bun.spawnSync(["git", "-C", process.env.TARGET_GIT, "merge-base", "--is-ancestor", oid, main]).exitCode===0;
  if (!process.env.WITHHOLD_PR_RECEIPT && pr.state === "OPEN" && updated && contains(pr.headRefOid) && contains(pr.baseRefOid)) {
    Object.assign(pr,{state:"MERGED",mergedAt:new Date().toISOString(),mergeCommit:{oid:main}});
    await Bun.write(file,JSON.stringify(pr));
  }
  console.log(JSON.stringify(pr));
}
else if (args[0] === "pr" && args[1] === "checks") console.log(JSON.stringify([{name:"fixture-ci",bucket:await Bun.file(process.env.CI_STATE).text()}]));
else if (args[0] === "pr" && args[1] === "merge") {
  if (process.env.FIXTURE_HUMAN_MERGE !== "1") process.exit(2);
  const i=args.indexOf("--match-head-commit");
  if (i<0 || args[i+1]!==pr.headRefOid) process.exit(2);
  const result=Bun.spawnSync(["git","-C",process.env.TARGET_GIT,"update-ref","refs/heads/main",pr.headRefOid,pr.baseRefOid]);
  if(result.exitCode!==0) process.exit(3);
  appendFileSync(process.env.TARGET_LOG, "merge "+pr.headRefOid+"\\n");
  await Bun.write(file, JSON.stringify({...pr,state:"MERGED",mergedAt:new Date().toISOString(),mergeCommit:{oid:pr.headRefOid}}));
} else { console.error("unexpected host operation "+JSON.stringify(args)); process.exit(2); }
`, {mode: 0o755});
  const codex = join(s.bin, "codex");
  writeFileSync(codex, `#!/usr/bin/env bun
const args=process.argv.slice(2); await Bun.stdin.text();
await Bun.write(args[args.indexOf("-o")+1],JSON.stringify({status:"pass",summary:"contract checked",findings:[],checked:["src/feature.ts"],limitations:[]}));
`, {mode: 0o755});
  s.env.FORGE_CODEX_BIN = codex;
  for (const kind of ["lint", "test"]) s.ok([s.forge, "verify", "--task", "ship-task", "--cwd", repo, "--kind", kind,
    "--", "bun", ...(kind === "test" ? ["test"] : ["run", "check"])]);
  s.ok([s.forge, "review", "--task", "ship-task", "--repo", "app", "--cwd", repo, "--base", base, "--head", head,
    "--roles", "quality", "--mode", "serial", "--backend", "codex"]);
  ledger("pr-sync", "ship-task", "--repo", "app", "--branch", "feature-fixture", "--pr", "1");
  return {ledger, repo, head, base, bare, state, ci, calls};
}

type RolloutMode = "success" | "failure" | "pending" | "wrong-version" | "rejected";

function configureStage(localRollout: RolloutMode, head: string, base: string, endpoint: string, stage: string) {
  const cfgPath = join(s.work, ".workbench/workbench.yaml");
  const cfg = parse(readFileSync(cfgPath, "utf8"));
  writeFileSync(join(s.work, "release-plan.json"), JSON.stringify({repo:"app", head:head, target:"worker-a"}));
  writeFileSync(join(s.work, "release-stage.ts"), `import {appendFileSync} from "node:fs";
const plan = await Bun.file("release-plan.json").json();
const mode = process.argv[3];
appendFileSync("stage-effects", plan.head+"\\n");
if (mode==="rejected") process.exit(17);
const ticket = {action_id:process.env.FORGE_ACTION_ID, endpoint:process.env.FORGE_ENDPOINT,
  state:mode==="pending"?"pending":mode==="failure"?"failed":"completed",
  versions:[{repo:plan.repo,head:mode==="wrong-version"?process.argv[4]:plan.head}]};
await Bun.write("deployment-target.json", JSON.stringify(ticket));
// The submitter can acknowledge the request before the target has applied the revision.
console.log(JSON.stringify({state:"completed",action_id:ticket.action_id,endpoint:ticket.endpoint,versions:JSON.parse(process.env.FORGE_APPROVED_HEADS)}));
if(mode==="failure") process.exit(3);
`);
  writeFileSync(join(s.work, "observe-target.ts"), `import {appendFileSync} from "node:fs";
const target = Bun.file("deployment-target.json");
const observation = await target.exists() ? await target.json() : {state:"absent",action_id:process.env.FORGE_ACTION_ID,
  endpoint:process.env.FORGE_ENDPOINT,versions:JSON.parse(process.env.FORGE_APPROVED_HEADS)};
appendFileSync("target-reads", JSON.stringify(observation)+"\\n");
console.log(JSON.stringify(observation));
`);
  cfg.extensions = {actions: {
    rolloutAction: {purpose: "deliver", cwd: ".", argv: ["bun", "release-stage.ts", head, localRollout, base], inputs:["release-plan.json"]},
    actualState: {purpose:"observe",cwd:".",argv:["bun","observe-target.ts"],inputs:[]}},
    stages: {[stage]: {action: "rolloutAction", observe:"actualState"}}, delivery: {endpoint, stages: [stage]}};
  writeFileSync(cfgPath, stringify(cfg));
}

function delivery(localRollout?: RolloutMode) {
  const prepared = preparePullRequest("full", false, localRollout ? "prod" : "pr");
  const {ledger} = prepared;
  const receipt = join(s.work, "stage-effects");
  const stageFile = join(s.work, "release-stage.ts");
  const manifest = join(s.work, "release-plan.json");
  const targetState = join(s.work, "deployment-target.json");
  const observations = join(s.work, "target-reads");
  if (localRollout) {
    // The operator policy here belongs to the disposable instance created by sandbox().
    const policy = join(s.work, ".workbench/ship-policy.yaml");
    const policyDoc = parse(readFileSync(policy, "utf8"));
    Object.assign(policyDoc.fast_track, {allow_prod: true, max_endpoint: "prod"});
    writeFileSync(policy, stringify(policyDoc));
    configureStage(localRollout, prepared.head, prepared.base, "prod", "rollout");
  }
  const book = JSON.parse(ledger("runbook", "create", "--task", "ship-task", "--title", "local target", "--pr", "app:1",
    ...(localRollout ? ["--stage", "rollout"] : [])));
  const envelope = JSON.parse(ledger("fast-track", "prepare", "ship-task", "--to", localRollout ? "prod" : "pr", "--paths", "src/**", "--runbook", book.runbook_id)).envelope_id;
  const transport = localTransport(prepared.bare, prepared.calls);
  const approve = () => {
    const approval = s.hook("UserPromptSubmit", {session_id: "operator", prompt: "快轨批准 " + envelope});
    expect(JSON.parse(ledger("fast-track", "status", envelope))[0].status, JSON.stringify(approval)).toBe("ACTIVE");
  };
  return {...prepared, ...transport, approve, envelope, receipt, stageFile, manifest, targetState, observations, shipArgs: [s.forge, "ship", "run", "--envelope", envelope]};
}

for (const fault of ["unapproved", "session", "ci", "remote-head", "success"]) {
  test(`T11 exact PR authorization against local bare target: ${fault}`, () => {
    const f = delivery();
    if (fault !== "unapproved") f.approve();
    if (fault === "session") s.env.FORGE_SESSION_ID = "different-root";
    if (fault === "ci") writeFileSync(f.ci, "fail");
    if (fault === "remote-head") {
      const pr = JSON.parse(readFileSync(f.state, "utf8"));
      writeFileSync(f.state, JSON.stringify({...pr, headRefOid: f.base}));
    }
    const r = s.run(f.shipArgs);
    if (fault === "success") {
      expect(r.code, r.err + r.out).toBe(0);
      expect(s.git(f.bare, "rev-parse", "refs/heads/main").trim()).toBe(f.head);
      expect(s.run(f.shipArgs).code).toBe(0);
      expect(readFileSync(f.calls, "utf8")).toBe(`merge ${f.head}\n`);
    } else {
      expect(r.code).not.toBe(0);
      expect(readFileSync(f.calls, "utf8")).toBe("");
      expect(s.git(f.bare, "rev-parse", "refs/heads/main").trim()).toBe(f.base);
    }
  }, 90_000);
}

test("T11 simultaneous and restarted requests preserve one local effect and one receipt", async () => {
  const f = delivery();
  f.approve();
  const gate = f.gate;
  writeFileSync(gate + ".armed", "1");
  const run = () => Bun.spawn(f.shipArgs, { cwd: s.work, env: s.env, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  const first = run();
  let second: ReturnType<typeof run> | undefined;
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(gate + ".entered") && Date.now() < deadline) await Bun.sleep(20);
    expect(existsSync(gate + ".entered")).toBe(true);
    second = run();
    writeFileSync(gate, "1");
    const results = await Promise.all([first, second].map(async proc => {
      const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      expect(code, out + err).toBe(0);
      return JSON.parse(out);
    }));
    const replay = JSON.parse(s.ok(f.shipArgs));
    for (const result of [...results, replay]) {
      expect(result.ok).toBe(true);
      expect(result.receipts).toHaveLength(1);
      expect(result.receipts[0].status).toBe("confirmed");
      expect(result.receipts[0].envelope_id).toBe(f.envelope);
      expect(result.receipts[0].action_hash).toBe(replay.receipts[0].action_hash);
    }
    expect(readFileSync(f.calls, "utf8")).toBe(`merge ${f.head}\n`);
  } finally {
    writeFileSync(gate, "1");
    for (const proc of [first, second]) if (proc && proc.exitCode === null) proc.kill();
    await Promise.all([first.exited, second?.exited]);
  }
}, 90_000);

for (const track of ["full", "targeted"] as const) {
  test(`T01/T09 isolated ${track} workflow reaches a human-merged PR on main`, () => {
    const f = preparePullRequest(track, track === "targeted");
    expect(s.run([s.forge, "ledger", "close", "ship-task", "--summary", "open PR"]).code).not.toBe(0);
    expect(s.ok(["bun", "-e", "import {message} from './src/feature'; console.log(message)"], f.repo).trim()).toBe("ready");
    s.env.FIXTURE_HUMAN_MERGE = "1";
    s.ok(["gh", "pr", "merge", "1", "--merge", "--match-head-commit", f.head]);
    expect(s.git(f.bare, "rev-parse", "refs/heads/main").trim()).toBe(f.head);
    f.ledger("pr-sync", "ship-task", "--repo", "app", "--branch", "feature-fixture", "--pr", "1");
    const closed = JSON.parse(f.ledger("close", "ship-task", "--summary", "isolated host confirms main", "--no-archive"));
    expect(closed.task.status).toBe("CLOSED");
    expect(JSON.parse(f.ledger("verify", "--task", "ship-task", "--json")).ok).toBe(true);
  }, 90_000);
}

test("T13 release keeps both handoff identities across stale-head rejection and batch completion", () => {
  const first = preparePullRequest();
  const ledger = first.ledger;
  ledger("handoff", "ship-task");
  const repo = join(s.work, "app.worktrees/second");
  s.git(first.repo, "worktree", "add", "-b", "followup", repo, first.head);
  writeFileSync(join(repo, "src/format.ts"), 'export const format = "plain";\n');
  s.git(repo, "add", "--", "src/format.ts");
  s.git(repo, "commit", "-m", "second task", "--", "src/format.ts");
  const sha = s.git(repo, "rev-parse", "HEAD").trim();
  s.git(repo, "push", first.bare, "followup");
  ledger("open", "--id", "second", "--title", "second task", "--endpoint", "pr", "--depth", "targeted", "--repo", "app",
    "--branch", "followup", "--worktree", repo, "--base", first.head, "--head", sha);
  s.privateFile(".workbench/specs/second/scope.md", "Add the plain output format and verify the existing CLI contract.\n");
  ledger("freeze", "second", "--lock-tests", "example.test.ts");
  for (const [kind, args] of [["lint", ["run", "check"]], ["test", ["test"]]] as const)
    s.ok([s.forge, "verify", "--task", "second", "--cwd", repo, "--kind", kind, "--", "bun", ...args]);
  s.ok([s.forge, "review", "--task", "second", "--repo", "app", "--cwd", repo, "--base", first.head, "--head", sha,
    "--roles", "quality", "--mode", "serial", "--backend", "codex"]);
  const secondState = first.state + "-2";
  const record = {...JSON.parse(readFileSync(first.state, "utf8")), url:"https://github.com/fixture/app/pull/2",
    number:2, headRefName:"followup",headRefOid:sha,baseRefOid:first.head};
  writeFileSync(secondState, JSON.stringify(record));
  ledger("pr-sync", "second", "--repo", "app", "--branch", "followup", "--pr", "2");
  ledger("handoff", "second");
  const batch = JSON.parse(ledger("release", "create", "--title", "isolated batch", "--tasks", "ship-task,second"));
  expect(batch.items.map((i: {task_id: string}) => i.task_id).sort()).toEqual(["second", "ship-task"]);
  writeFileSync(secondState, JSON.stringify({...record, headRefOid:first.head}));
  const drift = s.run([s.forge, "ledger", "release", "verify", batch.release_id]);
  expect(drift.code).not.toBe(0);
  expect(drift.out + drift.err).toMatch(/STALE_PR|drift|changed/i);
  writeFileSync(secondState, JSON.stringify(record));
  ledger("release", "verify", batch.release_id);
  const book = JSON.parse(ledger("release", "runbook", batch.release_id)).runbook_id;
  s.hook("UserPromptSubmit", {session_id:"operator", prompt: "批准 " + book});
  s.env.FIXTURE_HUMAN_MERGE = "1";
  for (const [num, head] of [["1", first.head], ["2", sha]]) {
    s.ok(["gh", "pr", "merge", num!, "--merge", "--match-head-commit", head!]);
    s.git(first.repo, "fetch", first.bare, "+refs/heads/main:refs/remotes/origin/main");
  }
  ledger("runbook", "complete", book);
  const result = JSON.parse(ledger("release", "complete", batch.release_id, "--summary", "accepted"));
  expect(result.task_ids.sort()).toEqual(["second", "ship-task"]);
  for (const name of result.task_ids) expect(JSON.parse(ledger("verify", "--task", name, "--json")).ok).toBe(true);
  expect(s.git(first.bare, "rev-parse", "refs/heads/main").trim()).toBe(sha);
}, 90_000);

for (const mode of ["success", "failure"] as const) {
  test(`T11 custom local delivery stage retains completed steps across restart: ${mode}`, () => {
    const f = delivery(mode);
    f.approve();
    const denied = s.run([s.forge, "instance", "run", "rollout"]);
    expect(denied.code, denied.err + denied.out).not.toBe(0);
    expect(existsSync(f.receipt)).toBe(false);
    const first = s.run(f.shipArgs);
    expect(first.code === 0, first.out + first.err).toBe(mode === "success");
    expect(readFileSync(f.calls, "utf8")).toBe("merge " + f.head + "\n");
    expect(readFileSync(f.receipt, "utf8")).toBe(f.head + "\n");
    const report = JSON.parse(first.out || first.err);
    expect(report.receipts.filter((r: {status: string}) => r.status === "confirmed")).toHaveLength(mode === "success" ? 2 : 1);
    const second = s.run(f.shipArgs);
    expect(second.code === 0, second.out + second.err).toBe(mode === "success");
    expect(readFileSync(f.calls, "utf8")).toBe("merge " + f.head + "\n");
    expect(readFileSync(f.receipt, "utf8")).toBe(f.head + "\n");
    const after = JSON.parse(second.out || second.err);
    expect(after.receipts).toEqual(report.receipts);
  }, 90_000);
}

test("T11 rejected submission with absent target degrades immediately and cannot replay", () => {
  const f = delivery("rejected");
  f.approve();
  for (let attempt = 0; attempt < 2; attempt++) {
    const run = s.run(f.shipArgs);
    expect(run.code, run.out + run.err).not.toBe(0);
    const report = JSON.parse(run.out || run.err);
    expect(report.status).toBe("DEGRADED");
    expect(report.reason.message).toContain("rollout submission exited with code 17");
    expect(report.reason.message).toContain(f.envelope + "/1 absent");
    expect(report.receipts.map((item: {status:string}) => item.status)).toEqual(["confirmed", "claimed"]);
    expect(existsSync(f.targetState)).toBe(false);
    expect(readFileSync(f.receipt, "utf8")).toBe(f.head + "\n");
  }
}, 90_000);

for (const change of ["script", "arguments", "later-stage", "declared-input"]) {
  test(`T11 exact stage preflight stops all effects after ${change} changes`, () => {
    const f = delivery("success");
    f.approve();
    if (change === "script") writeFileSync(f.stageFile, "console.log('different content')\n");
    else if (change === "declared-input") {
      const changedPlan = {...JSON.parse(readFileSync(f.manifest, "utf8")), target:"worker-b"};
      writeFileSync(f.manifest, JSON.stringify(changedPlan));
    }
    else {
      const path = join(s.work, ".workbench/workbench.yaml");
      const doc = parse(readFileSync(path, "utf8"));
      if (change === "arguments") doc.extensions.actions.rolloutAction.argv[2] = f.base;
      else {
        doc.extensions.stages.late = {action: "rolloutAction"};
        doc.extensions.delivery.stages.push("late");
      }
      writeFileSync(path, stringify(doc));
    }
    const denied = s.run(f.shipArgs);
    expect(denied.code, denied.out + denied.err).not.toBe(0);
    expect(denied.out + denied.err).toMatch(/drift|scope|changed|stage|runbook/i);
    expect(readFileSync(f.calls, "utf8")).toBe("");
    expect(existsSync(f.receipt)).toBe(false);
    expect(s.git(f.bare, "rev-parse", "refs/heads/main").trim()).toBe(f.base);
  }, 90_000);
}

for (const when of ["before-advertisement", "before-update"]) {
  test(`T11 conditional write rejects a main race ${when}`, () => {
    const f = delivery();
    f.approve();
    // Rewinding to this ancestor would still allow an ordinary fast-forward to the approved head.
    const other = s.git(f.bare, "rev-parse", f.base + "^").trim();
    writeFileSync(f.race, JSON.stringify({when, base: f.base, other}));
    const denied = s.run(f.shipArgs);
    expect(denied.code, denied.out + denied.err).not.toBe(0);
    expect(s.git(f.bare, "rev-parse", "refs/heads/main").trim()).toBe(other);
    expect(readFileSync(f.calls, "utf8")).toBe("");
    expect(JSON.parse(readFileSync(f.state, "utf8")).state).toBe("OPEN");
  }, 90_000);
}

test("T11 a completed Git write cannot supply a withheld PR receipt", () => {
  const f = delivery();
  f.approve();
  s.env.WITHHOLD_PR_RECEIPT = "1";
  const result = s.run(f.shipArgs);
  expect(s.git(f.bare, "rev-parse", "refs/heads/main").trim()).toBe(f.head);
  expect(readFileSync(f.calls, "utf8")).toBe("merge " + f.head + "\n");
  expect(result.code).not.toBe(0);
  const report = JSON.parse(result.out || result.err);
  expect(report.ok).toBe(false);
  expect(report.receipts.filter((item: {status: string}) => item.status === "confirmed")).toEqual([]);
  expect(JSON.parse(readFileSync(f.state, "utf8")).state).toBe("OPEN");
}, 90_000);

test("T11 a FAT-only envelope cannot merge main", () => {
  const f = preparePullRequest();
  localTransport(f.bare, f.calls);
  const book = JSON.parse(f.ledger("runbook", "create", "--task", "ship-task", "--title", "PR target", "--pr", "app:1"));
  const prepare = s.run([s.forge, "ledger", "fast-track", "prepare", "ship-task", "--to", "fat", "--paths", "src/**", "--runbook", book.runbook_id]);
  if (prepare.code === 0) {
    const envelope = JSON.parse(prepare.out).envelope_id;
    s.hook("UserPromptSubmit", {session_id:"operator", prompt:"快轨批准 " + envelope});
    const run = s.run([s.forge, "ship", "run", "--envelope", envelope]);
    expect(run.code, run.out + run.err).not.toBe(0);
  } else expect(prepare.out + prepare.err).toMatch(/fat|scope|endpoint/i);
  expect(s.git(f.bare, "rev-parse", "refs/heads/main").trim()).toBe(f.base);
  expect(readFileSync(f.calls, "utf8")).toBe("");
}, 90_000);

for (const outcome of ["completed", "disappeared", "wrong-version"]) {
  test(`T11 read back the deployment target after accepting a job: ${outcome}`, () => {
    const f = delivery(outcome === "wrong-version" ? "wrong-version" : "pending");
    f.approve();
    const first = s.run(f.shipArgs);
    expect(first.code, first.out + first.err).not.toBe(0);
    const submitted = JSON.parse(first.out || first.err);
    expect(submitted.ok).toBe(false);
    expect(submitted.receipts.filter((row: {status: string}) => row.status === "confirmed")).toHaveLength(1);
    expect(existsSync(f.targetState), first.out + first.err).toBe(true);
    const target = JSON.parse(readFileSync(f.targetState, "utf8"));
    expect(target.action_id).toBeTruthy();
    expect(target.endpoint).toBeTruthy();
    expect(target.versions).toEqual([{repo:"app", head:outcome === "wrong-version" ? f.base : f.head}]);
    expect(readFileSync(f.receipt, "utf8")).toBe(f.head + "\n");
    const reads = () => readFileSync(f.observations, "utf8").trim().split("\n").map(row => JSON.parse(row));
    expect(reads()[0].state).toBe("absent");
    expect(reads()).toContainEqual(target);

    if (outcome === "completed") writeFileSync(f.targetState, JSON.stringify({...target, state:"completed"}));
    if (outcome === "disappeared") unlinkSync(f.targetState);
    const resumed = s.run(f.shipArgs);
    expect(resumed.code === 0, resumed.out + resumed.err).toBe(outcome === "completed");
    const final = JSON.parse(resumed.out || resumed.err);
    expect(final.receipts.filter((row: {status: string}) => row.status === "confirmed")).toHaveLength(outcome === "completed" ? 2 : 1);
    if (outcome === "completed") expect(reads()).toContainEqual({...target, state:"completed"});
    expect(readFileSync(f.receipt, "utf8")).toBe(f.head + "\n");
    expect(readFileSync(f.calls, "utf8")).toBe("merge " + f.head + "\n");
  }, 90_000);
}

test("T13 delegated rollout observation belongs to the handed-off task, stage and revision", () => {
  const f = preparePullRequest("full", false, "blue-rollout");
  const ledger = f.ledger;
  ledger("open", "--id", "sibling", "--title", "other rollout", "--repo", "app", "--branch", "sibling", "--endpoint", "blue-rollout", "--depth", "targeted");
  ledger("handoff", "ship-task");
  const batch = JSON.parse(ledger("release", "create", "--title", "isolated named deployment", "--tasks", "ship-task"));
  ledger("release", "verify", batch.release_id);
  const book = JSON.parse(ledger("release", "runbook", batch.release_id));
  const observers = book.actions.release_observers;
  expect(observers).toHaveLength(1);
  const observer = observers[0];
  expect(observer.endpoint).toBe("blue-rollout");
  expect(JSON.stringify(observer.stage)).toContain("publish");
  expect(observer.versions).toContainEqual({repo:"app",head:f.head});
  s.hook("UserPromptSubmit", {session_id:"operator", prompt:"批准 " + book.runbook_id});
  s.env.FIXTURE_HUMAN_MERGE = "1";
  s.ok(["gh", "pr", "merge", "1", "--merge", "--match-head-commit", f.head]);
  s.git(f.repo, "fetch", f.bare, "+refs/heads/main:refs/remotes/origin/main");
  const targetState = join(s.work, "deployment-target.json");
  const observe = [s.forge, "ledger", "release", "observe", batch.release_id];
  const record = {action_id:observer.action_id, endpoint:"blue-rollout", state:"completed",versions:[{repo:"app",head:f.head}]};
  for (const imported of [
    {...record, versions:[{repo:"app",head:f.base}]},
    {...record, action_id:"other-batch/publish"},
  ]) {
    writeFileSync(targetState, JSON.stringify(imported));
    const wrong = s.run(observe);
    expect(wrong.code, wrong.out + wrong.err).not.toBe(0);
  }
  expect(s.run([s.forge, "ledger", "release", "complete", batch.release_id]).code).not.toBe(0);
  writeFileSync(targetState, JSON.stringify(record));
  s.ok(observe);
  const events = JSON.parse(ledger("query", "--q", "prod", "--repo", "app", "--json")).events;
  const evidence = events.filter((row: {payload_json:string}) => {
    const payload = JSON.parse(row.payload_json);
    return payload.kind === "prod" && payload.source === "tool";
  });
  expect(evidence).toHaveLength(1);
  expect(evidence[0]).toMatchObject({task_id:"ship-task", repo:"app", branch:"feature-fixture", sha:f.head});
  expect(evidence[0].payload_json).toContain(batch.release_id);
  expect(evidence[0].payload_json).toContain(book.runbook_id);
  const meta = JSON.parse(evidence[0].payload_json).meta;
  expect(meta.delivery_endpoint).toBe("blue-rollout");
  expect(meta.observation_ids).toEqual([observer.action_id]);
  ledger("runbook", "complete", book.runbook_id);
  const accepted = JSON.parse(ledger("release", "complete", batch.release_id, "--summary", "local target reports deployed revision"));
  expect(accepted.task_ids).toEqual(["ship-task"]);
  const open = JSON.parse(ledger("query", "--status", "OPEN", "--json")).tasks;
  expect(open.map((task: {task_id:string}) => task.task_id)).toEqual(["sibling"]);
}, 90_000);

test("T11 recheck a pinned rollout input after the preceding PR operation", async () => {
  const f = delivery("success");
  f.approve();
  writeFileSync(f.gate + ".armed", "1");
  const proc = Bun.spawn(f.shipArgs, {cwd: s.work, env: s.env, stdout:"pipe", stderr:"pipe", timeout:45_000});
  try {
    const deadline = Date.now() + 15_000;
    while (!existsSync(f.gate + ".entered") && Date.now() < deadline) await Bun.sleep(20);
    expect(existsSync(f.gate + ".entered")).toBe(true);
    const changed = {...JSON.parse(readFileSync(f.manifest, "utf8")), target:"another-worker"};
    writeFileSync(f.manifest, JSON.stringify(changed));
    writeFileSync(f.gate, "1");
    const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(code, out + err).not.toBe(0);
    const report = JSON.parse(out || err);
    expect(report.receipts.filter((row: {status: string}) => row.status === "confirmed")).toHaveLength(1);
    expect(readFileSync(f.calls, "utf8")).toBe("merge " + f.head + "\n");
    expect(existsSync(f.receipt)).toBe(false);
    expect(existsSync(f.targetState)).toBe(false);
  } finally {
    writeFileSync(f.gate, "1");
    if (proc.exitCode === null) proc.kill();
    await proc.exited;
  }
}, 90_000);
