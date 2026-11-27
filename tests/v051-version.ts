import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { kit, sandbox } from "./v05-sandbox";

// This check runs in the working directory selected by the configured forge verify stage.
const check = `
import { realpathSync, symlinkSync, writeFileSync } from "node:fs";
const [expected, trace] = process.argv.slice(1);
const checkout = realpathSync(process.cwd());
const git = Bun.spawnSync(["git", "rev-parse", "HEAD"]);
if (git.exitCode !== 0) throw Error(git.stderr.toString());
const actual = git.stdout.toString().trim();
const exitCode = Number(actual !== expected);
const observation = {checkout, expected, actual, exitCode};
writeFileSync(trace, JSON.stringify(observation));
console.log(JSON.stringify(observation));
process.exit(exitCode);
`;
const s = sandbox();
try {
  s.fresh();
  assert.doesNotMatch(s.read("AGENTS.md"), /hurl/i);
  const catalog = JSON.parse(s.ok([s.forge, "instance", "list", "--json"]));
  const skills = catalog.filter((entry: {kind: string}) => entry.kind === "skill");
  assert.ok(skills.length > 0);
  for (const {id} of skills) assert.doesNotMatch(s.read(`.agents/skills/${id}/SKILL.md`), /hurl/i);
  for (const command of ["bash", "dirname", "git"]) symlinkSync(Bun.which(command)!, join(s.bin, command));
  s.env.PATH = s.bin;
  assert.equal(Bun.which("hurl", {PATH: s.env.PATH}), null);
  const target = s.git(kit, "rev-parse", "HEAD").trim();
  const repo = join(s.work, "forge-kit");
  mkdirSync(repo);
  s.git(repo, "init", "-b", "empty");
  s.git(repo, "fetch", "--depth=1", kit, target);
  s.git(repo, "switch", "-c", "fixture", "FETCH_HEAD");
  assert.equal(s.git(repo, "rev-parse", "HEAD").trim(), target);
  assert.equal(s.git(repo, "status", "--porcelain"), "");
  // Pre-create the future commit without changing this checkout until both observations are complete.
  const next = s.git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "Next version for receipt lookup").trim();
  assert.notEqual(next, target);

  const task = "forge-version";
  const configPath = join(s.work, ".workbench/workbench.yaml");
  const config = parse(s.read(".workbench/workbench.yaml"));
  function configure(expected: string, trace: string) {
    writeFileSync(configPath, stringify({...config, repos: ["forge-kit"], extensions: {
      actions: { revision: { purpose: "verify", cwd: ".", argv: ["bun", "-e", check, expected, trace] } },
      stages: { version: { action: "revision" } }, verification: { environment: "isolated", stages: ["version"] },
    }}));
  }
  const trace = join(s.root, "version.json");
  configure(target, trace);
  const ledger = (...args: string[]) => s.ok([s.forge, "ledger", ...args]);
  ledger("open", "--id", task, "--title", "Verify forge-kit HEAD", "--endpoint", "local", "--depth", "targeted",
    "--repo", "forge-kit", "--branch", "fixture", "--worktree", repo, "--base", target, "--head", target);
  s.privateFile(`.workbench/specs/${task}/scope.md`, "The checkout must report the specified forge-kit commit.\n");
  ledger("freeze", task);
  type Receipt = {seq: number; sha: string; task: string; source: string; status: string; meta: {stages: {exit_code: number}[]}};
  const receipts = (): Receipt[] => {
    const data = JSON.parse(ledger("query", "--q", "verify", "--repo", "forge-kit", "--json"));
    return data.events.map((event: {seq: number; sha: string; task_id: string; payload_json: string}) =>
      ({...JSON.parse(event.payload_json), sha: event.sha, task: event.task_id, seq: event.seq})
    ).filter((record: {kind: string; meta?: {mode: string}}) => record.kind === "verify" && record.meta?.mode === "all");
  };
  assert.deepEqual(receipts(), []);
  const worktrees = () => s.git(repo, "worktree", "list", "--porcelain");
  const initialWorktrees = worktrees();
  const cache = process.env.BUN_INSTALL_CACHE_DIR;
  if (cache) s.env.BUN_INSTALL_CACHE_DIR = cache;
  const verify = [s.forge, "verify", "--task", task, "--cwd", repo, "--mode", "all", ...(cache ? ["--offline"] : [])];
  const history: Receipt[] = [];
  for (const expected of [target, next]) {
    configure(expected, trace);
    const result = s.run(verify);
    const exitCode = Number(expected !== target);
    assert.equal(result.code, exitCode, result.out + result.err);
    const report = JSON.parse(result.out);
    assert.equal(report.ok, exitCode === 0);
    assert.equal(report.head, target);
    const observed = JSON.parse(readFileSync(trace, "utf8"));
    assert.deepEqual(observed, { checkout: observed.checkout, actual: target, expected, exitCode });
    assert.notEqual(observed.checkout, realpathSync(repo));
    assert.ok(observed.checkout.startsWith(realpathSync(s.root) + "/"));
    assert.equal(existsSync(observed.checkout), false);
    assert.equal(worktrees(), initialWorktrees);

    const records = receipts().sort((a, b) => a.seq - b.seq);
    assert.deepEqual(records.slice(0, -1), history);
    const record = records.at(-1)!;
    assert.equal(record.task, task);
    assert.equal(record.sha, target);
    assert.equal(record.source, "tool");
    assert.equal(record.status, exitCode === 0 ? "pass" : "fail");
    assert.equal(record.meta.stages.length, 1);
    assert.equal(record.meta.stages[0].exit_code, exitCode);
    history.push(record);
    console.log(JSON.stringify({command: verify, cwd: s.work, outerCheckout: repo, ...observed, verifyExit: result.code,
      receipt: {seq: record.seq, sha: record.sha, status: record.status}, cleaned: true}));
  }
  s.git(repo, "merge", "--ff-only", next);
  configure(target, trace);
  ledger("record", task, "--kind", "manual", "--status", "pass", "--summary", "Operator approved the next revision",
    "--repo", "forge-kit", "--branch", "fixture", "--sha", next);
  const build = s.run([s.forge, "verify", "--task", task, "--cwd", repo, ...(cache ? ["--offline"] : []),
    "--kind", "build", "--", "bun", "run", "build"]);
  assert.equal(build.code, 0, build.out + build.err);
  assert.equal(JSON.parse(build.out).head, next);
  const close = s.run([s.forge, "ledger", "close", task]);
  assert.notEqual(close.code, 0);
  assert.match(close.err + close.out, /Missing completed verification/i);
  assert.deepEqual(receipts().sort((a, b) => a.seq - b.seq), history);
} finally {
  s.cleanup();
  assert.equal(existsSync(s.root), false);
}
