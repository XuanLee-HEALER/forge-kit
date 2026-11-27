import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import { canonicalJson, sha256String } from "../src/ledger/types";
import { pushFastForward } from "../src/conditional-merge";
import { resolveInstance } from "../src/instance";
import { initWorkbench } from "../src/cli";
import { Ledger } from "../src/ledger/store";
import { humanFastTrack } from "../src/ledger/fast-track";
import { cmd, feature, git, ledger, rejects, remote, root, useReleaseFixture, verifyFeature } from "./helpers/release";

useReleaseFixture();

function approve(id: string) {
  const approval = new Ledger(realpathSync(root));
  try { humanFastTrack(approval, id, "fixture", true); } finally { approval.closeDb(); }
}
async function ship(id: string, ...args: string[]) {
  const p = Bun.spawn([process.execPath, join(import.meta.dir,"../src/bin/cli.ts"), "ship", ...args, "--envelope", id], {
    cwd: root, stdout:"pipe", stderr:"pipe", env: {...process.env, FORGE_SESSION_ID:"fixture", CODEX_SESSION_ID:"fixture", FORGE_WORKBENCH_ROOT:root},
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  const result = JSON.parse(out);
  expect(code, err).toBe(result.ok ? 0 : 1);
  return result;
}


test("empty explicit runbook never becomes a frozen-scope approval", () => {
  initWorkbench({targetDir: root, kitRoot: join(import.meta.dir, "..")});
  const f = feature("api", 1);
  verifyFeature(f);
  expect(rejects("fast-track", "prepare", f.task, "--paths", "src/**", "--runbook", "")).toMatch(/exact runbook/);
  expect(cmd("fast-track", "status", "--task", f.task)).toEqual([]);
}, 30_000);

test("previews do not pin a baseline and PR evidence distinguishes the merge from the current tip", async () => {
  initWorkbench({targetDir: root, kitRoot: join(import.meta.dir, "..")});
  const configFile = join(root, ".workbench/workbench.yaml");
  const config = parse(readFileSync(configFile, "utf8"));
  config.extensions = {
    actions: {
      deploy: {purpose:"deliver", cwd:".", argv:[process.execPath,"submit.ts"], inputs:[]},
      observe: {purpose:"observe", cwd:".", argv:[process.execPath,"observe.ts"], inputs:[]},
    },
    stages: {rollout:{action:"deploy", observe:"observe"}},
    delivery: {endpoint:"prod", stages:["ship","rollout"]},
  };
  writeFileSync(configFile, stringify(config));
  writeFileSync(join(root,"submit.ts"), `import {appendFileSync} from "node:fs";
appendFileSync("submissions",process.env.FORGE_ACTION_ID+"\\n");
await Bun.write("target.json",JSON.stringify({state:"completed",endpoint:process.env.FORGE_ENDPOINT,
  action_id:process.env.FORGE_ACTION_ID,versions:JSON.parse(process.env.FORGE_APPROVED_HEADS)}));`);
  writeFileSync(join(root,"observe.ts"), `const target = Bun.file("target.json");
console.log(await target.exists() ? await target.text() : JSON.stringify({state:"absent",endpoint:process.env.FORGE_ENDPOINT,
  action_id:process.env.FORGE_ACTION_ID,versions:JSON.parse(process.env.FORGE_APPROVED_HEADS)}));`);
  const f = feature("api", 2);
  verifyFeature(f);
  const bare = join(root, "api.git");
  git(f.wt, "push", bare, f.branch);
  remote(2, {baseRefOid: f.base, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN"});
  const realGit = Bun.which("git")!;
  // Hosted reads resolve to the same bare repository updated by the simulated operator.
  writeFileSync(join(root, "bin/git"), `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args.includes("ls-remote") && args.includes("origin")) args[args.indexOf("origin")] = ${JSON.stringify(bare)};
const p = Bun.spawnSync([${JSON.stringify(realGit)}, ...args], {stdout:"inherit", stderr:"inherit"});
process.exit(p.exitCode ?? 1);`, {mode: 0o755});
  writeFileSync(join(root, "bin/gh"), `#!/usr/bin/env bun
import {Database} from "bun:sqlite";
import {appendFileSync} from "node:fs";
const [group, cmd, , path] = process.argv.slice(2);
const pr = await Bun.file(${JSON.stringify(join(root,"pr-2"))}).json();
function git(...args) {
  const p = Bun.spawnSync([${JSON.stringify(realGit)}, "--git-dir", ${JSON.stringify(bare)}, ...args]);
  if (p.exitCode) process.exit(1);
  return p.stdout.toString().trim();
}
if (group === "pr" && cmd === "list") console.log(JSON.stringify([{number:2, baseRefName:"main"}]));
else if (group === "pr" && cmd === "view") console.log(JSON.stringify(pr));
else if (group === "pr" && cmd === "merge") {
  appendFileSync(${JSON.stringify(join(root, "merge-attempts"))}, "refused\\n");
  process.exit(1);
}
else if (group === "pr" && cmd === "checks") console.log('[{"name":"CI","bucket":"pass"}]');
else if (group === "api" && path.endsWith("/git/ref/heads/main")) console.log(git("rev-parse","main"));
else if (group === "api" && path.includes("/git/commits/")) console.log(git("show","-s","--format=%T %P",path.split("/").pop()));
else if (group === "api" && path.includes("/compare/")) {
  // Remote observations cannot hold the writer lock needed by a revocation.
  const probe = new Database(${JSON.stringify(ledger.dbPath)});
  probe.exec("PRAGMA busy_timeout=100; BEGIN IMMEDIATE; COMMIT");
  probe.close();
  const [ancestor,tip] = path.split("/").pop().split("...");
  git("merge-base","--is-ancestor",ancestor,tip);
  console.log("ahead");
} else process.exit(1);`, {mode: 0o755});
  const id = cmd("fast-track", "prepare", f.task, "--paths", "src/**").envelope_id;
  approve(id);
  const audit = () => ({
    events: ledger.getTaskEvents(f.task), runbooks: ledger.db.query("SELECT * FROM runbooks").all(),
    bindings: ledger.db.query("SELECT * FROM exact_ship_envelopes").all(),
  });
  const initial = audit();
  for (const args of [["evaluate"], ["run","--dry-run"]]) {
    const preview = await ship(id,...args);
    expect(preview.status).toBe("ELIGIBLE");
    expect(preview.plan.ci).toMatchObject([{baseOid: f.base, head: f.head}]);
    expect(audit()).toEqual(initial);
  }
  git(f.dir, "commit", "--allow-empty", "-m", "advance base after preview");
  git(f.dir, "push", bare, "main");
  const base = git(f.dir, "rev-parse","HEAD");
  remote(2, {baseRefOid: base});
  for (let attempt = 0; attempt < 2; attempt++) {
    const pending = await ship(id, "run");
    expect(pending.status).toBe("ACTIVE");
    expect(pending.reason.message).toContain(base);
    expect(pending.receipts).toMatchObject([{status: "claimed"}]);
  }
  expect(readFileSync(join(root, "merge-attempts"), "utf8")).toBe("refused\n");
  expect(audit().bindings).toHaveLength(1);
  git(f.dir, "merge", "--no-ff", "-m", "operator merge", f.branch);
  const merge = git(f.dir, "rev-parse", "HEAD");
  expect(git(f.dir, "show", "-s", "--format=%P", merge).split(" ")).toEqual([base, f.head]);
  git(f.dir, "commit", "--allow-empty", "-m", "subsequent change");
  git(f.dir, "push", bare, "main");
  const tip = git(f.dir, "rev-parse", "HEAD");
  remote(2, {state:"MERGED", baseRefOid:base, mergeCommit:{oid:merge}});
  const [first, second] = await Promise.all([ship(id,"run"), ship(id,"run")]);
  const replay = await ship(id,"run");
  for (const result of [first,second,replay]) expect(result.status).toBe("REDEEMED");
  expect(second.receipts).toEqual(first.receipts);
  expect(replay.receipts).toEqual(first.receipts);
  const [book] = ledger.db.query<{actions_json:string}, []>("SELECT actions_json FROM runbooks").all();
  const actions = JSON.parse(book.actions_json).exact.actions;
  expect(actions.map((action:{kind:string}) => action.kind)).toEqual(["pr","stage"]);
  expect(first.receipts).toHaveLength(actions.length);
  for (const [index,action] of actions.entries()) expect(first.receipts[index]).toMatchObject({
    envelope_id:id, action_index:index, status:"confirmed", action_hash:sha256String(canonicalJson(action)),
  });
  expect(readFileSync(join(root,"submissions"),"utf8").trim().split("\n")).toEqual([id+"/1"]);
  const receipt = ledger.getTaskEvents(f.task).map(e => JSON.parse(e.payload_json)).find(e => e.kind === "pr");
  expect(receipt.meta).toMatchObject({pr_head_oid:f.head, merge_commit:merge, target_oid:tip});
}, 90_000);

test("a remote that returned to the old value after push confirmation cannot redeem the envelope", async () => {
  initWorkbench({targetDir:root, kitRoot:join(import.meta.dir,"..")});
  const f = feature("api",1);
  const bare = join(root,"api.git");
  git(f.dir,"remote","set-url","origin",bare);
  writeFileSync(join(root,".workbench/workbench.yaml"),"name: fixture\nrepos: [api]\nguard: {protected_branches: [main], allow_protected_ff: [main]}\nextensions: {delivery: {endpoint: push, stages: [ship]}}\n");
  ledger.updateEndpoint({task_id:f.task,endpoint:"push",reason:"Local exact fast-forward"});
  verifyFeature(f);
  const rb = cmd("runbook","create","--task",f.task,"--exact","--push","api:main","--title","Approved fast-forward");
  const id = cmd("fast-track","prepare",f.task,"--runbook",rb.runbook_id,"--paths","src/**").envelope_id;
  approve(id);
  // The simulated remote owner restores main between the confirmed action and the final observation.
  const realGit = Bun.which("git")!;
  writeFileSync(join(root,"bin/git"), `#!/usr/bin/env bun
import {Database} from "bun:sqlite";
const args=process.argv.slice(2);
if (args.includes("ls-remote")) {
  const db=new Database(${JSON.stringify(ledger.dbPath)},{readonly:true});
  const confirmed=db.query("SELECT 1 FROM ship_action_receipts WHERE envelope_id=? AND status='confirmed'").get(${JSON.stringify(id)});
  db.close();
  if (confirmed) {
    const result=Bun.spawnSync([${JSON.stringify(realGit)},"--git-dir",${JSON.stringify(bare)},"update-ref","refs/heads/main",${JSON.stringify(f.base)},${JSON.stringify(f.head)}]);
    if (result.exitCode) process.exit(1);
  }
}
const result=Bun.spawnSync([${JSON.stringify(realGit)},...args],{stdout:"inherit",stderr:"inherit"});
process.exit(result.exitCode ?? 1);`,{mode:0o755});
  const result = await ship(id,"run");
  expect(result.status).toBe("DEGRADED");
  expect(result.reason.message).toMatch(/Confirmed remote branch/);
  expect(result.receipts).toHaveLength(1);
  expect(result.receipts[0]).toMatchObject({status:"confirmed",observation:f.head});
  expect(git(bare,"rev-parse","main")).toBe(f.base);
  const events = ledger.getTaskEvents(f.task);
  expect(events.some(event => event.event_type === "FAST_TRACK_REDEEMED")).toBe(false);
  expect(events.some(event => JSON.parse(event.payload_json).meta?.delivery_endpoint === "push")).toBe(false);
}, 40_000);

test("platform merge waits for checks on every pinned PR before the first write", async () => {
  initWorkbench({targetDir:root, kitRoot:join(import.meta.dir,"..")});
  const first = feature("api",1), second = feature("web",3);
  cmd("cancel",second.task,"--reason","attach both repositories to the first task");
  cmd("attach",first.task,"--repo",second.repo,"--branch",second.branch,"--worktree",second.wt,"--base",second.base,"--head",second.head);
  verifyFeature(first);
  verifyFeature({...second, task:first.task});
  for (const f of [first,second]) remote(f.n,{baseRefOid:f.base, mergeable:"MERGEABLE", mergeStateStatus:"CLEAN"});
  const ci = join(root,"ci-state.json");
  const seen = join(root,"checked-requests");
  writeFileSync(join(root,"bin/gh"), `#!/usr/bin/env bun
import {appendFileSync} from "node:fs";
const [group,cmd,selector,path]=process.argv.slice(2);
const states=await Bun.file(${JSON.stringify(ci)}).json();
if (group==="pr" && cmd==="view") console.log(await Bun.file(${JSON.stringify(root)}+"/pr-"+selector.split("/").pop()).text());
else if (group==="pr" && cmd==="checks") {
  const number=selector.split("/").pop();
  appendFileSync(${JSON.stringify(seen)},number+"\\n");
  console.log(JSON.stringify([{name:"CI",bucket:states[number]}]));
} else if (group==="api" && path.endsWith("/git/ref/heads/main")) {
  console.log(path.includes("/api/") ? ${JSON.stringify(first.base)} : ${JSON.stringify(second.base)});
} else process.exit(1);`,{mode:0o755});
  writeFileSync(ci,JSON.stringify({1:"pass",3:"pass"}));
  const rb = cmd("runbook","create","--title","Two repositories","--task",first.task,"--exact","--pr","api:1","--pr","web:3");
  const id = cmd("fast-track","prepare",first.task,"--runbook",rb.runbook_id,"--paths","src/**").envelope_id;
  approve(id);
  const ready = await ship(id,"evaluate");
  expect(ready.status).toBe("ELIGIBLE");
  expect(ready.plan.ci.map((pr: {url: string}) => pr.url)).toEqual([first.url,second.url]);
  writeFileSync(ci,JSON.stringify({1:"pass",3:"pending"}));
  const pending = await ship(id,"run");
  expect(pending.reason.message).toMatch(/pending/);
  expect(pending.reason.message).not.toMatch(/Manual merge required/);
  writeFileSync(ci,JSON.stringify({1:"pass",3:"fail"}));
  const blocked = await ship(id,"run");
  expect(blocked.status).toBe("DEGRADED");
  expect(blocked.reason.message).toMatch(/CI/);
  expect(blocked.reason.message).not.toMatch(/Manual merge required/);
  expect(blocked.receipts).toEqual([]);
  expect(readFileSync(seen,"utf8").trim().split("\n")).toEqual(["1","3","1","3","1","3"]);
}, 60_000);

test("a concurrent update to the identical head does not count as the executor's fast-forward", () => {
  const f = feature("api", 1), bare = join(root, "api.git");
  git(f.dir, "remote", "set-url", "origin", bare);
  git(f.wt, "push", bare, f.branch);
  const action = {kind:"push" as const, repo:f.repo, remote:"origin" as const, ref:"refs/heads/main",
    baseOid:f.base, head:f.head, originHash:sha256String(canonicalJson([bare,bare]))};
  expect(() => pushFastForward(f.wt, action, () => git(bare, "update-ref", action.ref, f.head, f.base)))
    .toThrow("Git did not perform the approved fast-forward");
  expect(git(bare, "rev-parse", "main")).toBe(f.head);
}, 30_000);

test("PR delivery cannot register a standalone observer as a delivery stage", () => {
  initWorkbench({targetDir: root, kitRoot: join(import.meta.dir, "..")});
  const file = join(root, ".workbench/workbench.yaml");
  const config = parse(readFileSync(file, "utf8"));
  config.extensions = {
    actions: {readback:{purpose:"observe", cwd:".", argv:[process.execPath,"-v"], inputs:[]}},
    stages: {postcheck:{action:"readback"}},
    delivery: {endpoint:"pr", stages:["ship","postcheck"]},
  };
  writeFileSync(file, stringify(config));
  expect(() => resolveInstance(root)).toThrow("stage postcheck has purpose observe; select a delivery stage");
});
