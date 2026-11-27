import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import { canonicalJson, sha256String } from "../src/ledger/types";
import { initWorkbench } from "../src/cli";
import { Ledger } from "../src/ledger/store";
import { humanFastTrack } from "../src/ledger/fast-track";
import { cmd, feature, git, ledger, rejects, remote, root, useReleaseFixture, verifyFeature } from "./helpers/release";

useReleaseFixture();

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
const [group, cmd, , path] = process.argv.slice(2);
const pr = await Bun.file(${JSON.stringify(join(root,"pr-2"))}).json();
function git(...args) {
  const p = Bun.spawnSync([${JSON.stringify(realGit)}, "--git-dir", ${JSON.stringify(bare)}, ...args]);
  if (p.exitCode) process.exit(1);
  return p.stdout.toString().trim();
}
if (group === "pr" && cmd === "list") console.log(JSON.stringify([{number:2, baseRefName:"main"}]));
else if (group === "pr" && cmd === "view") console.log(JSON.stringify(pr));
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
  const approval = new Ledger(realpathSync(root));
  try { humanFastTrack(approval, id, "fixture", true); } finally { approval.closeDb(); }
  const ship = async (...args: string[]) => {
    const p = Bun.spawn([process.execPath, join(import.meta.dir,"../src/bin/cli.ts"), "ship", ...args, "--envelope", id], {
      cwd: root, stdout:"pipe", stderr:"pipe", env: {...process.env, FORGE_SESSION_ID:"fixture", CODEX_SESSION_ID:"fixture", FORGE_WORKBENCH_ROOT:root},
    });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    const result = JSON.parse(out);
    expect(code, err).toBe(result.ok ? 0 : 1);
    return result;
  };
  const audit = () => ({
    events: ledger.getTaskEvents(f.task), runbooks: ledger.db.query("SELECT * FROM runbooks").all(),
    bindings: ledger.db.query("SELECT * FROM exact_ship_envelopes").all(),
  });
  const initial = audit();
  for (const args of [["evaluate"], ["run","--dry-run"]]) {
    expect((await ship(...args)).reason.message).toMatch(/Manual merge required/);
    expect(audit()).toEqual(initial);
  }
  git(f.dir, "commit", "--allow-empty", "-m", "advance base after preview");
  git(f.dir, "push", bare, "main");
  const base = git(f.dir, "rev-parse","HEAD");
  remote(2, {baseRefOid: base});
  expect((await ship("run")).reason.message).toContain(base);
  expect(audit().bindings).toHaveLength(1);
  git(f.dir, "merge", "--no-ff", "-m", "operator merge", f.branch);
  const merge = git(f.dir, "rev-parse", "HEAD");
  git(f.dir, "commit", "--allow-empty", "-m", "subsequent change");
  git(f.dir, "push", bare, "main");
  const tip = git(f.dir, "rev-parse", "HEAD");
  remote(2, {state:"MERGED", baseRefOid:base, mergeCommit:{oid:merge}});
  const [first, second] = await Promise.all([ship("run"), ship("run")]);
  const replay = await ship("run");
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
