import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { executorFixture } from "./helpers/executor";
import { redactArguments } from "../src/shared/redact";
import { VerificationLog, verificationLogDirectory } from "../src/verification-log";

const f = executorFixture("0.5");
function freeze() {
  const dir = join(f.root, ".workbench/specs/task");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "scope.md"), "Exercise isolated verification diagnostics.");
  f.ledger.freezeSpec({ task_id: "task" });
}

test("attached and separate password arguments mask the entire value", () => {
  expect(redactArguments(["--password=two words", "--password", "two words"])).toEqual(["--password=***", "--password", "***"]);
});

test("a line without LF preserves ordinary bytes and masks credentials across chunks", () => {
  const log = new VerificationLog(f.root);
  const size = 8 * 1024 * 1024;
  const body = 'import {writeSync} from "node:fs"; const emit=s=>writeSync(1,s);' +
    'for(let i=0;i<128;i++)emit("x".repeat(65536));emit(" API_TO");emit("KEN=\\\"two ");emit("words\\\" ");' +
    'emit("https://"+ "a".repeat(100000)+"@host/ "+"eyJ"+"b".repeat(100000)+".cccccccccccc ");' +
    'emit("TAIL\\rsummary\\n");process.exitCode=3';
  let largestBatch = 0;
  try {
    expect(log.run([process.execPath, "-e", body], f.root, process.env, 5000, text => {
      largestBatch = Math.max(largestBatch, text.length);
    }).code).toBe(3);
    const meta = log.finish(true);
    const bytes = readFileSync(meta.log_path!);
    const expected = Buffer.from("x".repeat(size) + ' API_TOKEN=*** https://***@host/ *** TAIL\rsummary\n');
    expect(bytes.equals(expected)).toBe(true);
    expect(meta.output_sha256).toBe(new Bun.CryptoHasher("sha256").update(expected).digest("hex"));
    expect(largestBatch).toBeLessThanOrEqual(65536);
  } finally { log.dispose(); }
});

test("a zero-test explicit run leaves a failed receipt and its readable log", () => {
  writeFileSync(join(f.repo, "empty.test.ts"), "export {};\n");
  f.git("add", "--", "empty.test.ts");
  f.git("commit", "-m", "empty suite");
  freeze();
  const r = f.cli("verify", ["--kind", "test", "--", "bun", "test"]);
  expect(r.exitCode).toBe(1);
  const evidence = f.evidence().at(-1);
  expect(evidence).toMatchObject({kind: "test", status: "fail", meta: {exit_code: 1}});
  expect(evidence.meta.output_excerpt).toContain("No applicable checks");
  expect(readFileSync(evidence.meta.log_path, "utf8")).toContain("No applicable checks");
});

test("Git preparation keeps the tool diagnostic in the failure log after cleanup", () => {
  freeze();
  const bin = join(f.root, "tools");
  mkdirSync(bin);
  const git = Bun.which("git")!;
  writeFileSync(join(bin, "git"), '#!/bin/sh\ncase " $* " in *" core.hooksPath=/dev/null ls-tree "*) echo "git object diagnostic TOKEN=synthetic" >&2; exit 2;; esac\nexec "' + git + '" "$@"\n', {mode: 0o755});
  const r = f.cli("verify", ["--kind", "test", "--", "bun", "test"], {PATH: bin + ":" + process.env.PATH});
  expect(r.exitCode).toBe(1);
  const meta = f.evidence().at(-1).meta;
  expect(meta.output_excerpt).toContain("git object diagnostic TOKEN=***");
  expect(readFileSync(meta.log_path, "utf8")).toContain("Cannot enumerate gitlinks");
});

test("a completed stage with an inherited output pipe returns its timeout receipt", () => {
  const wb = join(f.root, ".workbench");
  for (const file of ["models.toml", "ship-policy.yaml"]) copyFileSync(join(import.meta.dir, "../templates", file), join(wb, file));
  const childPid = join(f.root, "sleep.pid");
  const code = 'import {spawn} from "node:child_process";import {writeFileSync} from "node:fs";' +
    'const p=spawn("/bin/sleep",["15"],{detached:true,stdio:"inherit"});writeFileSync(' +
    JSON.stringify(childPid) + ',String(p.pid));p.unref();console.log("stage finished");process.exit(0)';
  writeFileSync(join(wb, "workbench.yaml"), stringify({repos:["service"], extensions: {
    verification: {stages:["probe"], timeout_ms: 400}, stages:{probe:{action:"run"}},
    actions:{run:{purpose:"verify", cwd:".", argv:[process.execPath, "-e", code]}},
  }}));
  freeze();
  try {
    const start = Date.now();
    const r = f.cli("verify", []);
    expect(Date.now() - start).toBeLessThan(6000);
    expect(r.exitCode).toBe(1);
    const stage = f.evidence().at(-1).meta.stages[0];
    expect(stage.output_excerpt).toMatch(/timed out/i);
    expect(readFileSync(stage.log_path, "utf8")).toContain("stage finished");
  } finally {
    if (existsSync(childPid)) try { process.kill(Number(readFileSync(childPid, "utf8")), "SIGKILL"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
  }
}, 20_000);

test("rotation preserves a live writer and expires its abandoned log after a crash", async () => {
  const dir = verificationLogDirectory(f.root, 1);
  const module = join(import.meta.dir, "../src/verification-log.ts");
  const child = Bun.spawn([process.execPath, "-e", `import {VerificationLog} from ${JSON.stringify(module)};
    new VerificationLog(${JSON.stringify(dir)}); console.log("ready"); await Bun.sleep(30000)`],
    {stdout:"pipe", stderr:"ignore"});
  const reader = child.stdout.getReader();
  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
    const name = readdirSync(dir).find(name => name.endsWith(".active"))!;
    const path = join(dir, name), expired = new Date(Date.now() - 2 * 86400000);
    utimesSync(path, expired, expired);
    verificationLogDirectory(f.root, 1);
    expect(existsSync(path)).toBe(true);
    child.kill("SIGKILL");
    await child.exited;
    verificationLogDirectory(f.root, 1);
    expect(existsSync(path)).toBe(false);
  } finally { child.kill(); await child.exited; reader.releaseLock(); }
});
