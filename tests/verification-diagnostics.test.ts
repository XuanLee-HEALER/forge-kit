import { expect, test } from "bun:test";
import { closeSync, openSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { stringify } from "yaml";
import { executorFixture } from "./helpers/executor";
import { redactArguments, redactSecrets } from "../src/shared/redact";
import { VerificationLog, verificationLogDirectory, verificationSupervisorSource } from "../src/verification-log";

const f = executorFixture("0.5");
function freeze() {
  const dir = join(f.root, ".workbench/specs/task");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "scope.md"), "Exercise isolated verification diagnostics.");
  f.ledger.freezeSpec({ task_id: "task" });
}

test("attached and separate password arguments mask the entire value", () => {
  expect(redactArguments(["env", "PGPASSWORD=alpha beta", "psql"])).toEqual(["env", "PGPASSWORD=***", "psql"]);
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

for (const scenario of ["drains normally", "same-group timeout", "independent-group timeout"]) {
  test("an inherited stage pipe " + scenario, async () => {
    const wb = join(f.root, ".workbench");
    for (const file of ["models.toml", "ship-policy.yaml"]) copyFileSync(join(import.meta.dir, "../templates", file), join(wb, file));
    const normal = scenario === "drains normally", detached = scenario === "independent-group timeout";
    const pidFile = join(f.root, "writer.pid"), release = join(f.root, "release-writer");
    const writer = normal ? 'await Bun.sleep(120);console.log("late output")'
      : 'const end=Date.now()+10000;while(Date.now()<end&&!require("fs").existsSync(' + JSON.stringify(release) + '))await Bun.sleep(25)';
    const code = 'console.log("stage finished");const p=require("child_process").spawn(process.execPath,["-e",' +
      JSON.stringify(writer) + '],{detached:' + detached + ',stdio:"inherit"});require("fs").writeFileSync(' +
      JSON.stringify(pidFile) + ',String(p.pid));p.unref();process.exit(0)';
    writeFileSync(join(wb, "workbench.yaml"), stringify({repos:["service"], extensions: {
      verification: {stages:["probe"], timeout_ms: normal ? 3000 : 600}, stages:{probe:{action:"run"}},
      actions:{run:{purpose:"verify", cwd:".", argv:[process.execPath, "-e", code]}},
    }}));
    freeze();
    const running = () => {
      const id = readFileSync(pidFile, "utf8");
      const ps = spawnSync("/bin/ps", ["-o", "stat=", "-p", id], {encoding:"utf8"});
      return ps.status === 0 && !ps.stdout.trim().startsWith("Z");
    };
    try {
      const start = Date.now(), r = f.cli("verify", []);
      expect(Date.now() - start).toBeLessThan(6000);
      expect(r.exitCode, r.stderr.toString() + r.stdout.toString()).toBe(normal ? 0 : 1);
      const stage = f.evidence().at(-1).meta.stages[0];
      if (normal) {
        expect(stage.output_sha256).toBe(new Bun.CryptoHasher("sha256").update("stage finished\nlate output\n").digest("hex"));
      } else {
        expect(stage.output_excerpt).toMatch(/output drain timed out/i);
        expect(readFileSync(stage.log_path, "utf8")).toContain("stage finished");
      }
      expect(running()).toBe(detached);
    } finally {
      // Release the independent fixture by its own marker, never a stale PID.
      writeFileSync(release, "");
      if (existsSync(pidFile)) {
        const end = Date.now() + 1500;
        while (running() && Date.now() < end) await Bun.sleep(25);
        expect(running()).toBe(false);
      }
    }
  }, 20_000);
}

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
    const stale = join(dir, "verify-" + crypto.randomUUID() + "." + child.pid + ".active");
    writeFileSync(stale, "previous writer");
    utimesSync(stale, expired, expired);
    verificationLogDirectory(f.root, 1);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(stale)).toBe(false);
    child.kill("SIGKILL");
    await child.exited;
    verificationLogDirectory(f.root, 1);
    expect(existsSync(path)).toBe(false);
  } finally { child.kill(); await child.exited; reader.releaseLock(); }
});

test("UTF-8 and apostrophes in credentials remain masked in both the receipt excerpt and the log", () => {
  const log = new VerificationLog(f.root);
  const data = `PGPASSWORD=pàssFixture https://user:p'assFixture@host.example/db TOKEN="multi word" \n`;
  const safe = "PGPASSWORD=*** https://***@host.example/db TOKEN=*** \n";
  expect(redactSecrets(data)).toBe(safe);
  try {
    const child = log.run([process.execPath, "-e", "process.stdout.write(" + JSON.stringify(data) + "); process.exitCode=1"], f.root, process.env);
    const receipt = log.finish(true);
    expect(child.code).toBe(1);
    expect(receipt.output_excerpt).toBe(safe.trim());
    expect(readFileSync(receipt.log_path!, "utf8")).toBe(safe);
  } finally { log.dispose(); }
});

test("a rejected write to the log terminates the active verification child", () => {
  const active = join(f.root, "verify-" + crypto.randomUUID() + "." + process.pid + ".active");
  writeFileSync(active, "");
  const descriptor = openSync(active, "r");
  const marker = join(f.root, "child.pid");
  const code = 'const fs=require("fs");fs.writeFileSync(' + JSON.stringify(marker) +
    ',String(process.pid));fs.writeSync(1,"data".repeat(8192));await Bun.sleep(10000)';
  try {
    const r = spawnSync(process.execPath, ["-e", verificationSupervisorSource], {
      input: JSON.stringify({argv:[process.execPath, "-e", code], cwd: f.root, env: process.env, timeout: 8000, active}),
      stdio: ["pipe", "ignore", "pipe", descriptor], encoding: "utf8", timeout: 4000, killSignal: "SIGKILL",
    });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Cannot write verification log");
    const pid = Number(readFileSync(marker, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally { closeSync(descriptor); }
});

test("a rejected ledger transaction retains the original diagnostic and readable log path", () => {
  freeze();
  f.ledger.db.exec("CREATE TRIGGER fixture_receipt BEFORE INSERT ON events WHEN NEW.event_type='EVIDENCE_CAPTURED' BEGIN SELECT RAISE(ABORT,'receipt fixture rejected'); END");
  const result = f.cli("verify", ["--kind", "test", "--", "unsupported-runner"]);
  expect(result.exitCode).toBe(1);
  const diagnostic = result.stderr.toString();
  expect(diagnostic).toContain("Expected an executable verification runner");
  expect(diagnostic).toContain("receipt fixture rejected");
  const path = diagnostic.split("\n").find(line => line.endsWith(".log"));
  expect(path).toBeDefined();
  expect(readFileSync(path!, "utf8")).toContain("Expected an executable verification runner");
  expect(f.evidence()).toEqual([]);
});

test("Bearer whitespace matches the text rule and preserves the original separator bytes", () => {
  const log = new VerificationLog(f.root);
  const spaces = [" ", "\t", "\r\n", "\u00a0", "\u1680", ...Array.from({length:11}, (_, i) => String.fromCharCode(0x2000 + i)),
    "\u2028", "\u2029", "\u202f", "\u205f", "\u3000", "\ufeff"];
  const separators = [...spaces.map(s => Buffer.from(s)), Buffer.from([0xa0]), Buffer.from([32,0xa0,9])];
  const token = "private-token-fixture";
  const output = (value: string) => Buffer.concat(separators.flatMap(space => [Buffer.from("Bearer"), space, Buffer.from(value + "!\n")]));
  try {
    for (const space of spaces) expect(redactSecrets("Bearer" + space + token)).toBe("Bearer" + space + "***");
    const code = 'process.stdout.write(Buffer.from(' + JSON.stringify(output(token).toString("base64")) + ',"base64"));process.exitCode=1;';
    expect(log.run([process.execPath,"-e",code], f.root, process.env).code).toBe(1);
    const receipt = log.finish(true);
    expect(readFileSync(receipt.log_path!).equals(output("***"))).toBe(true);
    expect(receipt.output_excerpt).not.toContain(token);
  } finally { log.dispose(); }
});

test("numbered credential names and short Bearer tokens are masked across writes", () => {
  const chunks = ["OAUTH2_TO", "KEN=first UTF8_TOKEN2_V2='two words' 2_TOKEN=public\nAuthorization: Bea",
    "rer abc", "123,next\nBearer Z!\nBearer ,unchanged\n"];
  const safe = "OAUTH2_TOKEN=*** UTF8_TOKEN2_V2=*** 2_TOKEN=public\nAuthorization: Bearer ***,next\nBearer ***!\nBearer ,unchanged\n";
  expect(redactSecrets(chunks.join(""))).toBe(safe);
  expect(redactArguments(["env","OAUTH2_TOKEN=first second","TOKEN2=third fourth","2_TOKEN=public","service"]))
    .toEqual(["env","OAUTH2_TOKEN=***","TOKEN2=***","2_TOKEN=public","service"]);
  const log = new VerificationLog(f.root);
  try {
    const code = "for(const chunk of " + JSON.stringify(chunks) +
      "){require('fs').writeSync(1,chunk);await Bun.sleep(10)}process.exitCode=1";
    expect(log.run([process.execPath,"-e",code], f.root, process.env).code).toBe(1);
    const receipt = log.finish(true);
    expect(readFileSync(receipt.log_path!, "utf8")).toBe(safe);
    expect(receipt.output_excerpt).toBe(safe.trim());
  } finally { log.dispose(); }
});
