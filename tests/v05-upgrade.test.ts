import { afterEach, beforeEach, expect, test } from "bun:test";
import { snapshot } from "./helpers/ledger-snapshot";
import { digest, historicalKit, releaseCLI } from "./helpers/historical-kit";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { kit, legacyRevision, sandbox, type Sandbox } from "./v05-sandbox";

let s: Sandbox;
beforeEach(() => { s = sandbox(); });
afterEach(() => s.cleanup());

function oldInstance() {
  const legacy = join(s.root, "legacy-kit");
  mkdirSync(legacy);
  const archive = join(s.root, "release.tar");
  const expected = "0fb9dc3bab1714fcdf54e514e46561e4ceca516784301bd98efb00e6e9355468";
  const supplied = process.env.FORGE_V04_TEST_ARCHIVE;
  if (supplied !== undefined) {
    // Verify and extract the same private copy even when the external fixture cache changes.
    writeFileSync(archive, readFileSync(supplied));
  } else {
    const built = s.run(["git", "-C", kit, "--no-replace-objects", "-c", "core.attributesFile=/dev/null",
      "-c", "tar.umask=0002", "archive", "--format=tar", "--output", archive, legacyRevision]);
    if (built.code !== 0) throw Error("T03/T06 require Git commit " + legacyRevision +
      " and its tree/blobs, or set FORGE_V04_TEST_ARCHIVE to its verified local tar (see README). " + built.err);
  }
  if (createHash("sha256").update(readFileSync(archive)).digest("hex") !== expected)
    throw Error("T03/T06 v0.4.1 archive SHA-256 mismatch; expected " + expected + " (see README)");
  s.ok(["tar", "-xf", archive, "-C", legacy]);
  symlinkSync(join(kit, "node_modules"), join(legacy, "node_modules"));
  s.ok(["bun", "run", "build"], legacy);
  for (const id of ["implementation-review", "simplicity-performance-review", "code-simplification-review", "comment-normalization-review"]) {
    const dir = join(legacy, "review-agents/skills", id);
    mkdirSync(dir, {recursive: true});
    writeFileSync(join(dir, "SKILL.md"), "legacy review material " + id);
  }
  writeFileSync(join(legacy, "review-agents/package.json"), JSON.stringify({name: "local-review-fixture", private: true, scripts: {build: "true"}}));
  s.privateFile(".workbench/models.toml", '[tiers.standard]\nmodel = "previous-standard"\neffort = "low"\n');
  const init = JSON.parse(s.ok([join(legacy, "bin/forge"), "init", s.work, "--packs", "dbop,comm-lark"]));
  expect(init.lock.kit_version).toBe("0.4.1");
  expect(s.read(".codex/config.toml")).toContain('model = "previous-standard"');
  // The private change has not gone through v0.4 sync yet.
  s.privateFile(".workbench/models.toml", '[tiers.standard]\nmodel = "fixture-standard"\neffort = "high"\n[tiers.mechanical]\nmodel = "private-scanner"\neffort = "low"\n');
  const ledger = (...args: string[]) => s.ok([join(s.work, ".workbench/bin/ledger"), ...args]);
  s.privateFile("app/tests/example.test.ts", 'import {expect,test} from "bun:test"; test("fixture", ()=>expect(2+2).toBe(4));\n');
  s.git(join(s.work, "app"), "init", "-b", "active");
  s.git(join(s.work, "app"), "add", "--", "tests/example.test.ts");
  s.git(join(s.work, "app"), "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture", "--", "tests/example.test.ts");
  const head = s.git(join(s.work, "app"), "rev-parse", "HEAD").trim();
  for (const task of ["archived", "active"]) {
    ledger("open", "--id", task, "--title", "synthetic upgrade witness", "--repo", "app", "--branch", task, "--endpoint", "pr", "--depth", "full", "--base", head, "--head", head);
    ledger("decide", task, "--key", "migration", "--summary", "portable witness");
    ledger("record", task, "--kind", "note", "--status", "info", "--summary", "upgrade rehearsal");
  }
  ledger("record","archived","--kind","fat","--status","pass","--summary","historical FAT acceptance","--repo","app","--branch","archived","--sha",head);
  ledger("close", "archived", "--force-incomplete", "--reason", "baseline lifecycle", "--no-archive");
  ledger("blocker", "active", "open", "--id", "hold", "--summary", "pending decision");
  const specs = join(s.work, ".workbench/specs/active");
  for (const name of ["ssot.md", "tech-spec.md", "test-spec.md"]) s.privateFile(`.workbench/specs/active/${name}`, "fixed contract\n");
  ledger("freeze", "active", "--spec-dir", specs, "--lock-tests", "tests/example.test.ts");
  s.privateFile("synthetic.sql", "select 1;\n");
  ledger("runbook", "create", "--title", "pending legacy item", "--sql", "isolated:synthetic.sql");
  const envelopes: string[] = [];
  for (const status of ["PENDING", "ACTIVE"]) {
    const id = JSON.parse(ledger("fast-track", "prepare", "active", "--to", "pr", "--paths", "src/**")).envelope_id;
    if (status === "ACTIVE") s.hook("UserPromptSubmit", { session_id: "fixture", prompt: "快轨批准 " + id });
    expect(JSON.parse(ledger("fast-track", "status", id))[0].status).toBe(status);
    envelopes.push(id);
  }
  const transfer = join(s.work, "app.worktrees/transfer");
  const app = join(s.work, "app");
  s.git(app, "remote", "add", "origin", "https://github.com/fixture/app.git");
  s.git(app, "worktree", "add", "-b", "transfer", transfer, head);
  writeFileSync(join(transfer, "delivery.md"), "transfer this revision");
  s.git(transfer, "add", "--", "delivery.md");
  s.git(transfer, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "transfer", "--", "delivery.md");
  const transferHead = s.git(transfer, "rev-parse", "HEAD").trim();
  ledger("open", "--id", "transfer", "--title", "transfer", "--repo", "app", "--branch", "transfer", "--worktree", transfer,
    "--endpoint", "pr", "--depth", "targeted", "--base", head, "--head", transferHead);
  ledger("exempt", "--repo", "app", "--branch", "transfer", "--sha", transferHead, "--reason", "documentation change");
  s.env.FORGE_WORKBENCH_ROOT = s.work;
  const tools = join(s.work, ".workbench/bin");
  const review = s.privateFile("review-agents/dist/review-quality.js", `
const args=process.argv.slice(2);
const get=flag=>args[args.indexOf(flag)+1];
await Bun.write(get("--out"),JSON.stringify({role:"quality",repo:get("--repo"),base:get("--base"),head:get("--head"),reviewTaskId:get("--task-id"),reviewFloorSeq:Number(get("--floor-seq")),status:"pass",findings:[]}));
`);
  expect(existsSync(review)).toBe(true);
  s.env.FORGE_REVIEW_AGENTS_DIR = join(s.work, "review-agents");
  s.ok([join(tools, "wb-verify"), "--task", "transfer", "--cwd", transfer, "--kind", "test", "--", "bun", "test"]);
  s.ok([join(tools, "forge-review"), "--task", "transfer", "--cwd", transfer, "--roles", "quality"]);
  const pr = {url: "https://github.com/fixture/app/pull/1",state:"OPEN",headRefName:"transfer",baseRefName:"main",headRefOid:transferHead,
    isCrossRepository:false,headRepository:{name:"app"},headRepositoryOwner:{login:"fixture"}};
  writeFileSync(join(s.bin, "gh"), `#!/usr/bin/env bun
const args=process.argv.slice(2);
if(args[0]==="pr" && args[1]==="list") console.log("[]");
else if(args[0]==="pr" && args[1]==="view") console.log(${JSON.stringify(JSON.stringify(pr))});
else process.exit(2);
`, {mode: 0o755});
  ledger("pr-sync", "transfer", "--repo", "app", "--branch", "transfer", "--pr", "1");
  ledger("handoff", "transfer", "--rollback", "isolated fallback");
  ledger("release", "create", "--title", "old batch", "--tasks", "transfer");
  const tips = ["archived", "active", "transfer"].map(id => ledger("tip", id).trim().replace(/^Ledger-Tip:\s*/, ""));
  for (const tip of tips) ledger("verify-tip", tip);
  const search = JSON.parse(ledger("query", "--q", "rehearsal", "--json"));
  expect(search.events.length).toBeGreaterThan(0);
  expect(JSON.parse(ledger("verify", "--json")).ok).toBe(true);
  return { tips, search, envelopes };
}

function tree() {
  function entries(relative: string): unknown[] {
    const path = join(s.work, relative);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return [relative, stat.mode, readlinkSync(path)];
    if (stat.isFile()) return [relative, stat.mode, digest(path)];
    return [relative, stat.mode, readdirSync(path).sort().map(name => entries(join(relative,name)))];
  }
  return entries(".");
}

test("direct sync rejects the installed 0.4.1 lock before writing to the target", () => {
  oldInstance();
  const bootstrap = releaseCLI(s);
  const before = tree();
  const reject = () => {
    const result = s.run([bootstrap, "sync", s.work]);
    expect(result.code).not.toBe(0);
    expect(result.err + result.out).toMatch(/0\.4\.1/);
    expect(result.err + result.out).toMatch(/migrat|manually|手动|迁移/i);
  };
  reject();
  expect(tree()).toEqual(before);
  const modes = new Map<string, number>();
  function protect(path: string) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    modes.set(path, stat.mode);
    if (stat.isDirectory()) for (const name of readdirSync(path)) protect(join(path, name));
    chmodSync(path, stat.mode & ~0o222);
  }
  try {
    protect(s.work);
    const readOnly = tree();
    reject();
    expect(tree()).toEqual(readOnly);
  } finally {
    for (const [path, mode] of modes) chmodSync(path, mode);
  }
  expect(tree()).toEqual(before);
}, 120_000);

test("a migrated 0.5.3 instance preserves 0.4 archives, in-flight tasks and bound history", () => {
  const bootstrap = releaseCLI(s);
  const {tips, envelopes} = oldInstance();
  const app = join(s.work, "app");
  const base = s.git(app, "rev-parse", "HEAD").trim();
  s.privateFile("app/change.ts", "export const answer = 42;\n");
  s.git(app, "add", "--", "change.ts");
  s.git(app, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "legacy review scope", "--", "change.ts");
  const head = s.git(app, "rev-parse", "HEAD").trim();
  // The old tool API authenticates tool-written evidence and maintains the v0.4 chain.
  s.ok(["bun", "-e", `
    import { Ledger } from ${JSON.stringify(join(s.root, "legacy-kit/src/ledger/store.ts"))};
    const [root, base, head] = process.argv.slice(1);
    const ledger = new Ledger(root);
    const floor = ledger.getSpecState("active").evidence_floor_seq.review;
    ledger.recordEvidence({task_id:"active", repo:"app", branch:"active", sha:head, kind:"review", source:"tool",
      actor:"tool", status:"fail", summary:"performance review interrupted",
      meta:{role:"performance", base, head, review_task_id:"active", review_floor_seq:floor, exit_code:2, report_status:"error"}});
    ledger.closeDb();
  `, s.work, base, head]);
  const old = historicalKit(s, "0.5.3");
  s.ok([join(old, "bin/forge"), "sync", s.work]);
  const ledger = (...args: string[]) => s.ok([s.forge, "ledger", ...args]);
  const search = JSON.parse(ledger("query", "--q", "rehearsal", "--json"));
  const initial = snapshot(s.work);
  const sameSource = join(s.root, "before-baseline-executions");
  cpSync(s.work, sameSource, {recursive:true, verbatimSymlinks:true});
  const trace = join(s.root, "backend-calls.jsonl");
  const codex = join(s.bin, "codex");
  writeFileSync(codex, `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const native = args.includes("--output-schema") && args.includes("review");
const request = native ? null : JSON.parse(await Bun.stdin.text());
const head = Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim();
appendFileSync(${JSON.stringify(trace)}, JSON.stringify({args, request, head})+"\\n");
await Bun.write(args[args.indexOf("-o")+1], JSON.stringify(native ? {passed:true, report:"checked diff"} :
  {role:request.role, status:"pass", summary:"checked diff", findings:[], limitations:[],
    checked:request.chunks.map(({id,path})=>({id,path,conclusion:"reviewed"}))}));
`, {mode:0o755});
  s.env.FORGE_CODEX_BIN = codex;
  const native = [s.forge, "ledger", "review-native", "--task", "active", "--repo", "app", "--base", base];
  const retry = [s.forge, "review", "--task", "active", "--repo", "app", "--base", base, "--head", head, "--roles", "performance"];
  s.ok(native, app);
  s.ok(retry, app);
  const calls = readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(calls).toHaveLength(2);
  expect(calls[0].head).toBe(head);
  expect(calls[0].args).toContain(base);
  expect(calls[0].args.join(" ")).toContain("synthetic upgrade witness");
  expect(calls[1].request).toMatchObject({role:"performance", base, head});
  renameSync(s.work, join(s.root, "baseline-executions"));
  renameSync(sameSource, s.work);
  s.ok([bootstrap, "sync", s.work]);
  expect(snapshot(s.work, initial.schema)).toEqual(initial);
  const originalCalls = readFileSync(trace);
  for (const args of [native, retry]) {
    const refused = s.run(args, app);
    expect(refused.code).not.toBe(0);
    expect(readFileSync(trace)).toEqual(originalCalls);
    expect(snapshot(s.work, initial.schema)).toEqual(initial);
  }
  for (const tip of tips) ledger("verify-tip", tip);
  expect(JSON.parse(ledger("verify", "--json")).ok).toBe(true);
  expect(JSON.parse(ledger("query", "--q", "rehearsal", "--json"))).toEqual(search);
  const historical = JSON.parse(ledger("query", "--q", "historical", "--json"));
  expect(historical.events.some((e:{payload_json:string})=>JSON.parse(e.payload_json).kind==="fat")).toBe(true);
  for (const id of envelopes) {
    const result = s.run([s.forge, "ship", "run", "--envelope", id]);
    expect(result.code).not.toBe(0);
    expect(result.out + result.err).toMatch(/re.?register|re.?approv|register a new plan|new.*runbook|重新登记|重新批准/i);
  }
}, 120_000);
