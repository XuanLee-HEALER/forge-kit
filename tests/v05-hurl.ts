import { strict as assert } from "node:assert";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { kit, sandbox } from "./v05-sandbox";

// This program is committed into the fixture repository and runs inside forge verify's checkout.
const stage = `
import {appendFileSync, realpathSync} from "node:fs";
const [hurl, expected, trace] = process.argv.slice(2);
const checkout = realpathSync(process.cwd());
const requests = [];
const server = Bun.serve({hostname:"127.0.0.1", port:0, fetch(request) {
  const path = new URL(request.url).pathname;
  if (path !== "/version") return new Response(null, {status:404});
  const git = Bun.spawnSync(["git", "-C", checkout, "rev-parse", "HEAD"]);
  if (git.exitCode !== 0) return new Response(git.stderr.toString(), {status:500});
  const commit = git.stdout.toString().trim();
  requests.push({path,commit});
  return Response.json({commit});
}});
try {
  const proc = Bun.spawn([hurl, "--test", "--variable", "service="+server.url.origin,
    "--variable", "revision="+expected, "version.hurl"], {stdout:"inherit", stderr:"inherit", timeout:10000});
  const code = await proc.exited;
  appendFileSync(trace, JSON.stringify({checkout, requests, port:server.port, code})+"\\n");
  process.exitCode = code;
} finally { await server.stop(true); }
`;

const hurl = Bun.which("hurl");
if (!hurl) throw new Error("Install Hurl to run this loopback integration check.");
const s = sandbox();
try {
  s.fresh();
  const repo = join(s.work, "service");
  mkdirSync(repo);
  s.git(repo, "init", "-b", "fixture");
  writeFileSync(join(repo, "check-version.ts"), stage);
  copyFileSync(join(kit, "tests/v05-version.hurl"), join(repo, "version.hurl"));
  s.git(repo, "add", "--", "check-version.ts", "version.hurl");
  s.git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "commit", "-m", "version service and Hurl contract", "--", "check-version.ts", "version.hurl");
  const revision = s.git(repo, "rev-parse", "HEAD").trim();
  const trace = join(s.root, "requests.jsonl");
  const path = join(s.work, ".workbench/workbench.yaml");
  const config = {...parse(readFileSync(path, "utf8")), repos:["service"]};
  function configure(expected: string) {
    writeFileSync(path, stringify({...config, extensions: {
      actions:{version:{purpose:"verify",cwd:".",argv:["bun","check-version.ts",hurl,expected,trace]}},
      stages:{isolation:{action:"version"}}, verification:{environment:"isolated",stages:["isolation"]},
    }}));
  }
  configure(revision);
  const ledger = (...args: string[]) => s.ok([s.forge, "ledger", ...args]);
  ledger("open", "--id", "hurl-fixture", "--title", "Read the checked-out service version", "--endpoint", "local",
    "--depth", "targeted", "--repo", "service", "--branch", "fixture", "--worktree", repo, "--base", revision, "--head", revision);
  s.privateFile(".workbench/specs/hurl-fixture/scope.md", "The HTTP response must identify the pinned revision.\n");
  ledger("freeze", "hurl-fixture", "--lock-tests", "version.hurl");

  const statuses = [];
  for (const expected of [revision, "0".repeat(40)]) {
    configure(expected);
    const result = s.run([s.forge, "verify", "--task", "hurl-fixture", "--cwd", repo, "--mode", "all"]);
    const pass = expected === revision;
    assert.equal(result.code === 0, pass, result.out + result.err);
    const report = JSON.parse(result.out);
    assert.equal(report.ok, pass);
    assert.equal(report.head, revision);
    statuses.push(result.code);
  }
  const events = JSON.parse(ledger("query", "--q", "verify", "--repo", "service", "--json")).events;
  const evidence = events.map((event: {sha: string; task_id: string; payload_json: string}) => ({
    ...JSON.parse(event.payload_json), sha:event.sha, task:event.task_id,
  })).filter((entry: {kind: string; meta?: {mode?: string}}) => entry.kind === "verify" && entry.meta?.mode === "all");
  assert.deepEqual(evidence.map((entry: {status: string}) => entry.status).sort(), ["fail", "pass"]);
  for (const record of evidence) {
    assert.equal(record.sha, revision);
    assert.equal(record.task, "hurl-fixture");
    assert.equal(record.source, "tool");
  }
  const observations = readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(observations.length, 2);
  assert.deepEqual(observations.map(row => row.code), [0, 4]);
  for (const run of observations) {
    assert.notEqual(run.checkout, realpathSync(repo));
    assert.deepEqual(run.requests, [{path:"/version",commit:revision}]);
    assert.equal(existsSync(run.checkout), false, "forge verify must remove its temporary checkout");
    const freed = Bun.serve({hostname:"127.0.0.1", port:run.port, fetch:() => new Response()});
    await freed.stop(true);
  }
  console.log(JSON.stringify({revision, verifyExit:statuses, hurlExit:observations.map(row => row.code), httpRequests:2}));
} finally {
  s.cleanup();
  assert.equal(existsSync(s.root), false);
}
