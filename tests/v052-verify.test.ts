import { expect, test } from "bun:test";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { sandbox, type Sandbox } from "./v05-sandbox";

function verificationInstance(s: Sandbox, days: number) {
  s.fresh();
  const repo = join(s.work, "app");
  s.privateFile("app/sample.txt", "contract\n");
  s.git(repo, "init", "-b", "main");
  s.git(repo, "add", "--", "sample.txt");
  s.git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base");
  const sha = s.git(repo, "rev-parse", "HEAD").trim();
  const config = join(s.work, ".workbench/workbench.yaml");
  const initial = parse(readFileSync(config, "utf8"));
  function configure(code: string, timeout = 2000) {
    writeFileSync(config, stringify({
      ...initial, repos: ["app"], extensions: {
        verification: { stages: ["probe"], timeout_ms: timeout, failure_log_retention_days: days },
        stages: { probe: { action: "measure" } }, actions: { measure: { purpose: "verify", cwd: ".", argv: ["bun", "-e", code] } },
      }
    }));
  }
  configure('console.log("INITIAL")');
  const ledger = (...args: string[]) => s.ok([s.forge, "ledger", ...args]);
  ledger("open", "--id", "probe", "--title", "Fixture log", "--endpoint", "local", "--depth", "targeted", "--repo", "app", "--branch", "main", "--base", sha, "--head", sha);
  s.privateFile(".workbench/specs/probe/scope.md", "Exercise a verification subprocess.\n");
  ledger("freeze", "probe");
  const verify = [s.forge, "verify", "--task", "probe", "--cwd", repo, "--mode", "all", "--offline"];
  return { sha, configure, verify, ledger, run: () => s.run(verify) };
}

test("stage failures and timeouts retain redacted full logs and readable receipts under independent retention periods", () => {
  const one = sandbox(), seven = sandbox();
  try {
    for (const [s, days] of [[one, 1], [seven, 7]] as const) {
      const f = verificationInstance(s, days);
      const old = Date.now() - 2 * 86400000;
      const records: string[] = [];
      for (const timed of [false, true]) {
        const cwdPath = join(s.root, "checkout");
        const code = 'await Bun.write(' + JSON.stringify(cwdPath) + ',process.cwd());' +
          'console.log("LOG_START");console.log("API_TOKEN=syntheticFixture"+"Only");console.log("detail".repeat(2000));console.error("LOG_TAIL");' +
          (timed ? 'await Bun.sleep(30000);' : 'process.exit(23);');
        f.configure(code, timed ? 500 : 4000);
        const result = f.run();
        expect(result.code).not.toBe(0);
        const human = result.out + result.err;
        expect(human).toContain("LOG_TAIL");
        if (timed) expect(human).toMatch(/timed out|timeout/i);
        expect(human).not.toContain("syntheticFixtureOnly");
        const history = JSON.parse(f.ledger("query", "--q", "verify", "--json"));
        const payloads = history.events.map((e: { payload_json: string }) => JSON.parse(e.payload_json));
        const aggregate = payloads.find((e: { kind: string; meta?: { stages?: unknown[] } }) => e.kind === "verify" && e.meta?.stages?.some((stage: unknown) => JSON.stringify(stage).includes("LOG_TAIL") && !records.includes((stage as { log_path: string }).log_path)));
        expect(aggregate).toBeDefined();
        expect(JSON.stringify(aggregate)).not.toContain("syntheticFixtureOnly");
        const stage = aggregate.meta.stages.find((x: { log_path?: string }) => x.log_path && !records.includes(x.log_path));
        expect(stage).toBeDefined();
        expect(stage.output_excerpt).toContain("LOG_TAIL");
        expect(human).toContain(stage.log_path);
        expect(existsSync(readFileSync(cwdPath, "utf8"))).toBe(false);
        const log = readFileSync(stage.log_path, "utf8");
        expect(log).toContain("LOG_START");
        expect(log).toContain("LOG_TAIL");
        expect(log).not.toContain("syntheticFixtureOnly");
        records.push(stage.log_path);
      }
      for (const path of records) utimesSync(path, new Date(old), new Date(old));
      f.configure('console.log("cleaning old failed stages")');
      expect(f.run().code).toBe(0);
      for (const path of records) expect(existsSync(path)).toBe(days === 7);
      expect(f.ledger("query", "--q", "verify", "--json")).toContain("LOG_TAIL");
      for (const bad of [0, -1, Infinity]) {
        f.configure("process.exit(0)", bad);
        const doctor = s.run([s.forge, "doctor", s.work, "--json"]);
        expect(doctor.out + doctor.err).toContain("timeout_ms");
        expect(doctor.code).not.toBe(0);
      }
    }
  } finally { one.cleanup(); seven.cleanup(); }
}, 90_000);

test("inherited verification scope permits an independent instance and rejects the same active verification", () => {
  const parent = sandbox(), child = sandbox();
  try {
    const outer = verificationInstance(parent, 1), inner = verificationInstance(child, 1);
    inner.configure('console.log("CHILD_EXECUTED")');
    for (const same of [false, true]) {
      const s = same ? parent : child, target = same ? outer : inner;
      const trace = join(parent.root, "nested.json");
      const code = 'const r=Bun.spawnSync(' + JSON.stringify(target.verify) + ',{cwd:' + JSON.stringify(s.work) +
        ',env:{...process.env,FORGE_WORKBENCH_ROOT:' + JSON.stringify(s.work) + '}});' +
        'await Bun.write(' + JSON.stringify(trace) + ',JSON.stringify({code:r.exitCode,out:r.stdout.toString(),err:r.stderr.toString()}));' +
        'process.exit(r.exitCode);';
      outer.configure(code, 5000);
      const run = outer.run(), observed = JSON.parse(readFileSync(trace, "utf8"));
      if (same) {
        expect(run.code).not.toBe(0);
        expect(observed.out + observed.err).toMatch(/recurs/i);
      } else {
        expect(run.code, run.out + run.err).toBe(0);
        expect(observed.code).toBe(0);
        expect(JSON.parse(observed.out)).toMatchObject({ ok: true, head: inner.sha });
        expect(inner.ledger("query", "--q", "verify", "--json")).toContain(inner.sha);
      }
    }
  } finally { parent.cleanup(); child.cleanup(); }
}, 60_000);
