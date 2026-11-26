import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { sandbox, type Sandbox } from "./v05-sandbox";

let s: Sandbox;
beforeEach(() => { s = sandbox(); });
afterEach(() => s.cleanup());

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
import {appendFileSync} from "node:fs";
const args = process.argv.slice(2);
const selector = args[2] ?? "";
const file = args[0] === "pr" && /(?:^|\\/)2$/.test(selector) ? process.env.PR_STATE+"-2" : process.env.PR_STATE;
const pr = await Bun.file(file).json();
const ref = (name) => Bun.spawnSync(["git", "-C", process.env.TARGET_GIT, "rev-parse", "refs/heads/"+name]).stdout.toString().trim();
if (args[0] === "api") console.log(ref("main"));
else if (args[0] === "pr" && args[1] === "list") console.log(JSON.stringify([pr]));
else if (args[0] === "pr" && args[1] === "view") console.log(JSON.stringify(pr));
else if (args[0] === "pr" && args[1] === "checks") console.log(JSON.stringify([{name:"fixture-ci",bucket:await Bun.file(process.env.CI_STATE).text()}]));
else if (args[0] === "pr" && args[1] === "merge") {
  if (process.env.MERGE_GATE) {
    await Bun.write(process.env.MERGE_GATE+".entered", "1");
    const end=Date.now()+10000;
    while (!await Bun.file(process.env.MERGE_GATE).exists() && Date.now()<end) await Bun.sleep(20);
    if (!await Bun.file(process.env.MERGE_GATE).exists()) process.exit(4);
  }
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

function delivery(localRollout?: "success" | "failure") {
  const prepared = preparePullRequest("full", false, localRollout ? "prod" : "pr");
  const {ledger} = prepared;
  const receipt = join(s.work, "stage-effects");
  const stageFile = join(s.work, "release-stage.ts");
  if (localRollout) {
    // The operator policy here belongs to the disposable instance created by sandbox().
    const policy = join(s.work, ".workbench/ship-policy.yaml");
    const policyDoc = parse(readFileSync(policy, "utf8"));
    Object.assign(policyDoc.fast_track, {allow_prod: true, max_endpoint: "prod"});
    writeFileSync(policy, stringify(policyDoc));
    const cfgPath = join(s.work, ".workbench/workbench.yaml");
    const cfg = parse(readFileSync(cfgPath, "utf8"));
    writeFileSync(stageFile, 'import {appendFileSync} from "node:fs";\nappendFileSync("stage-effects", process.argv[2]+"\\n");\nif (process.argv[3]==="failure") process.exit(3);\n');
    cfg.extensions = {actions: {rolloutAction: {purpose: "deliver", cwd: ".", argv: ["bun", "release-stage.ts", prepared.head, localRollout]}},
      stages: {rollout: {action: "rolloutAction"}}, delivery: {endpoint: "prod", stages: ["rollout"]}};
    writeFileSync(cfgPath, stringify(cfg));
  }
  const book = JSON.parse(ledger("runbook", "create", "--task", "ship-task", "--title", "local target", "--pr", "app:1",
    ...(localRollout ? ["--stage", "rollout"] : [])));
  const envelope = JSON.parse(ledger("fast-track", "prepare", "ship-task", "--to", localRollout ? "prod" : "pr", "--paths", "src/**", "--runbook", book.runbook_id)).envelope_id;
  const approve = () => {
    s.hook("UserPromptSubmit", {session_id: "operator", prompt: "快轨批准 " + envelope});
    expect(JSON.parse(ledger("fast-track", "status", envelope))[0].status).toBe("ACTIVE");
  };
  return {...prepared, approve, envelope, receipt, stageFile, shipArgs: [s.forge, "ship", "run", "--envelope", envelope]};
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
  const gate = join(s.root, "release");
  s.env.MERGE_GATE = gate;
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

for (const change of ["script", "arguments", "later-stage"]) {
  test(`T11 exact stage preflight stops all effects after ${change} changes`, () => {
    const f = delivery("success");
    f.approve();
    if (change === "script") writeFileSync(f.stageFile, "console.log('different content')\n");
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
