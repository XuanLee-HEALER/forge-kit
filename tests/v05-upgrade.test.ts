import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, unlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootstrap, kit, legacyRevision, sandbox, type Sandbox } from "./v05-sandbox";

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

function sqlIdentifier(name: string) { return '"' + name.replaceAll('"', '""') + '"'; }
type Table = { name: string; columns: string[] };
function snapshot(tables?: Table[]) {
  const db = new Database(join(s.work, ".workbench/ledger/ledger.sqlite"), { readonly: true });
  try {
    const names = db.query("SELECT name FROM pragma_table_list WHERE schema='main' AND type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name: string}[];
    const schema = tables ?? names.map(({name}) => ({
      name, columns: (db.query("SELECT name FROM pragma_table_info(?) ORDER BY cid").all(name) as {name: string}[]).map(c => c.name),
    }));
    const rows = schema.map(({name, columns}) => {
      const fields = columns.map(sqlIdentifier).join(", ");
      return db.query(`SELECT ${fields} FROM ${sqlIdentifier(name)} ORDER BY ${fields}`).values();
    });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    return { schema, rows };
  } finally { db.close(); }
}
function privateState(paths: string[]) {
  return paths.map(file => {
    const stat = lstatSync(file);
    return [file, stat.mode, stat.isFile(), createHash("sha256").update(readFileSync(file)).digest("hex")];
  });
}

for (const invalid of [false, true]) {
  test(`T03/T06 v0.4.1 upgrade preserves business rows, tips and private files; invalid=${invalid}`, () => {
    const { tips, search, envelopes } = oldInstance();
    const originalLink = join(s.work, ".agents/skills/implementation-review");
    const changedLink = join(s.work, ".agents/skills/simplicity-performance-review");
    expect(lstatSync(originalLink).isSymbolicLink()).toBe(true);
    expect(lstatSync(changedLink).isSymbolicLink()).toBe(true);
    const originalTarget = join(s.work, "review-agents/skills/implementation-review/SKILL.md");
    const privateTarget = s.privateFile(".workbench/overrides/legacy/SKILL.md", "private redirected specialization");
    const privateLinkText = "../../.workbench/overrides/legacy";
    unlinkSync(changedLink);
    symlinkSync(privateLinkText, changedLink);
    const privateFiles = [originalTarget, privateTarget,
      join(s.work, ".workbench/models.toml"),
      s.privateFile("AGENTS.local.md", "local instance instruction\n"),
      s.privateFile(".workbench/env/synthetic.key", "TEST-CREDENTIAL-MARKER\n"),
      s.privateFile(".agents/skills/form-ux/SKILL.md", "user-modified retired skill\n"),
      s.privateFile(".agents/skills/custom/SKILL.md", "private specialization\n"),
      s.privateFile("original-request.md", "initial task\n"),
      s.privateFile("private-script", "#!/bin/sh\n.workbench/bin/ledger status\n"),
    ];
    chmodSync(privateFiles.at(-1)!, 0o750);
    const file = join(s.work, ".workbench/workbench.yaml");
    const good = readFileSync(file);
    const old = snapshot();
    const preserved = privateState(privateFiles);
    if (invalid) {
      const config = join(s.work, ".codex/config.toml");
      const original = readFileSync(config, "utf8");
      const oldLock = readFileSync(join(s.work, ".workbench/kit-lock.json"));
      for (const edited of [original.replace("previous-standard", "manual-model"), original + "# local change\n"]) {
        writeFileSync(config, edited);
        const conflict = s.run([bootstrap, "sync", s.work]);
        expect(conflict.code).not.toBe(0);
        expect(conflict.err + conflict.out).toContain("Ownership conflict");
        expect(readFileSync(config, "utf8")).toBe(edited);
        expect(readFileSync(join(s.work, ".workbench/kit-lock.json"))).toEqual(oldLock);
      }
      writeFileSync(config, original);
      const scanner = join(s.work, ".codex/agents/scanner.toml");
      const stock = readFileSync(scanner, "utf8");
      const editedScanner = stock.replace("gpt-6.1-terra", "hand-edited-scanner");
      expect(editedScanner).not.toBe(stock);
      writeFileSync(scanner, editedScanner);
      const conflict = s.run([bootstrap, "sync", s.work]);
      expect(conflict.code).not.toBe(0);
      expect(conflict.err + conflict.out).toContain("Ownership conflict at " + realpathSync(scanner));
      expect(readFileSync(scanner, "utf8")).toBe(editedScanner);
      expect(readFileSync(join(s.work, ".workbench/kit-lock.json"))).toEqual(oldLock);
      writeFileSync(scanner, stock);
      writeFileSync(file, "extensions: [\n");
      const broken = privateState([file]);
      const result = s.run([bootstrap, "sync", s.work]);
      expect(result.code).not.toBe(0);
      expect(result.out + result.err).toMatch(/workbench\.yaml/);
      expect(privateState([file])).toEqual(broken);
      expect(snapshot(old.schema)).toEqual(old);
      expect(privateState(privateFiles)).toEqual(preserved);
      writeFileSync(file, good);
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const applied = s.run([bootstrap, "sync", s.work]);
      const result = applied.out + applied.err;
      expect(applied.code, result).toBe(0);
      expect(result).not.toContain("TEST-CREDENTIAL-MARKER");
      expect(() => lstatSync(originalLink)).toThrow(/ENOENT/);
      expect(readlinkSync(changedLink)).toBe(privateLinkText);
      if (attempt === 0) expect(result).toMatch(/simplicity-performance-review/);
      expect(snapshot(old.schema)).toEqual(old);
      expect(privateState(privateFiles)).toEqual(preserved);
      expect(readFileSync(file)).toEqual(good);
      expect(Bun.TOML.parse(s.read(".codex/config.toml"))).toMatchObject({model: "fixture-standard", model_reasoning_effort: "high"});
      for (const [agent, model, effort] of [
        ["implementer", "fixture-standard", "high"],
        ["scanner", "private-scanner", "low"],
        ["analyst", "gpt-6.2-astra", "high"],
        ["reviewer", "gpt-6.2-astra", "high"],
      ]) {
        const rendered = readFileSync(join(s.work, `.codex/agents/${agent}.toml`), "utf8");
        expect(Bun.TOML.parse(rendered)).toMatchObject({ model, model_reasoning_effort: effort });
      }
      s.ok([s.forge, "doctor", s.work, "--json"]);
      for (const tip of tips) s.ok([s.forge, "ledger", "verify-tip", tip]);
      expect(JSON.parse(s.ok([s.forge, "ledger", "query", "--q", "rehearsal", "--json"]))).toEqual(search);
      for (const name of ["ledger", "wb-git", "wb-verify", "forge-ship", "forge-review"])
        expect(existsSync(join(s.work, ".workbench/bin", name))).toBe(false);
    }
    for (const id of envelopes) {
      const result = s.run([s.forge, "ship", "run", "--envelope", id]);
      expect(result.code).not.toBe(0);
      expect(result.out + result.err).toMatch(/re.?register|re.?approv|new.*runbook|重新登记|重新批准/i);
    }
    const beforeAppend = s.ok([s.forge, "ledger", "tip", "active"]).trim();
    s.ok([s.forge, "ledger", "record", "active", "--kind", "note", "--status", "info", "--summary", "after-upgrade"]);
    const previous = beforeAppend.split("@")[1]!;
    const event = JSON.parse(s.ok([s.forge, "ledger", "query", "--q", "after", "--json"])).events.find((e: {prev_hash: string}) => e.prev_hash === previous);
    expect(event).toBeDefined();
    expect(JSON.parse(s.ok([s.forge, "ledger", "verify", "--json"])).ok).toBe(true);
  }, 120_000);
}
