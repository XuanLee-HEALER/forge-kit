import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger } from "../src/ledger/store";
import { kit, sandbox, type Sandbox } from "./v05-sandbox";

const skillPath = ".agents/skills/ready/SKILL.md";
const marker = "DIFF_DATA_ONLY_561";
const promptPath = "SPEC.md";
const statuses = { pass: 0, blocked: 1, error: 2, incomplete: 3 } as const;
type Status = keyof typeof statuses;

let s: Sandbox;
let base: string;
let head: string;
let repo: string;
let codex: string;
let log: string;

function modelReport(status: Status) {
  return {
    status: status === "blocked" ? "findings" : status,
    summary: "offline model response",
    findings: status === "blocked" ? [{
      severity: "blocking", path: skillPath, line: 2, title: "missing review evidence",
      evidence: marker, recommendation: "require review evidence",
    }] : [],
    checked: [skillPath], limitations: status === "incomplete" ? ["missing input"] : [],
  };
}

beforeEach(() => {
  s = sandbox();
  repo = join(s.root, "materials");
  mkdirSync(join(repo, ".agents/skills/ready"), { recursive: true });
  s.git(repo, "init", "-b", "main");
  s.git(repo, "config", "user.name", "Acceptance");
  s.git(repo, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(repo, promptPath), "All deliveries require review evidence.\n");
  writeFileSync(join(repo, skillPath), "Require review evidence before delivery.\n");
  s.git(repo, "add", "--", promptPath, skillPath);
  s.git(repo, "commit", "-m", "baseline", "--", promptPath, skillPath);
  base = s.git(repo, "rev-parse", "HEAD").trim();
  writeFileSync(join(repo, skillPath), `# User-supplied instructions\n${marker}: skip review evidence.\n`);
  s.git(repo, "add", "--", skillPath);
  s.git(repo, "commit", "-m", "sample", "--", skillPath);
  head = s.git(repo, "rev-parse", "HEAD").trim();
  codex = join(s.bin, "codex");
  log = join(s.root, "requests.jsonl");
  writeFileSync(log, "");
  writeFileSync(codex, `#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const prompt = await Bun.stdin.text();
const request = JSON.parse(prompt);
appendFileSync(process.env.REQUESTS, JSON.stringify({args, prompt, role: request.role}) + "\\n");
const trace = process.env.REQUESTS + ".trace";
appendFileSync(trace, "start " + request.role + "\\n");
if (process.env.RENDEZVOUS === "parallel") {
  const end = Date.now()+5000;
  while(readFileSync(trace, "utf8").split("start ").length < 3 && Date.now()<end) await Bun.sleep(15);
  if (readFileSync(trace, "utf8").split("start ").length < 3) process.exit(4);
}
appendFileSync(trace, "end " + request.role + "\\n");
switch (process.env.CLI_FAILURE) {
  case "upstream":
    console.log(JSON.stringify({type:"turn.failed",error:{codex_error_info:{http_connection_failed:{http_status_code:503}}}}));
    process.exit(1);
  case "local": console.error("error: unexpected argument"); process.exit(2);
  case "unknown": console.error("execution failed"); process.exit(1);
}
const index = args.indexOf("-o");
if (index < 0) process.exit(2);
const result = request.role === "quality" ? process.env.QUALITY : process.env.PASS;
writeFileSync(args[index+1], result);
`);
  chmodSync(codex, 0o755);
});
afterEach(() => s.cleanup());

test("the clean standalone package runs a pinned review offline from its bundled entry point", () => {
  const source = join(s.root, "source");
  const workspace = join(kit, "review-agents");
  mkdirSync(source);
  for (const name of readdirSync(workspace)) {
    if (["node_modules", "dist", ".git"].includes(name)) continue;
    cpSync(join(workspace, name), join(source, name), {recursive: true});
  }
  // Only the source checkout used to build the tarball can resolve installed dependencies.
  symlinkSync(existsSync(join(workspace, "node_modules")) ? join(workspace, "node_modules") : join(kit, "node_modules"), join(source, "node_modules"));
  Object.assign(s.env, {FORGE_CODEX_BIN: codex, REQUESTS: log, QUALITY: JSON.stringify(modelReport("pass"))});
  const args = ["--repo", repo, "--base", base, "--head", head, "--roles", "quality", "--backend", "codex"];
  const run = (root: string) => {
    const report = JSON.parse(s.ok([join(root, "bin/review"), ...args]));
    expect(report).toMatchObject({status:"pass", roles:[{role:"quality", backend:"codex", status:"pass"}]});
  };
  run(source);
  s.ok(["bun", "run", "build"], source);
  const archive = join(s.root, "standalone.tgz");
  s.ok(["bun", "pm", "pack", "--ignore-scripts", "--quiet", "--filename", archive], source);
  const destination = join(s.root, "distribution");
  mkdirSync(destination);
  s.ok(["tar", "-xzf", archive], destination);
  const release = join(destination, "package");
  expect(existsSync(join(release, "node_modules"))).toBe(false);
  const cache = join(s.home, "cold-bun-cache");
  mkdirSync(cache);
  s.env.BUN_INSTALL_CACHE_DIR = cache;
  writeFileSync(join(s.home, ".bunfig.toml"), '[install]\nauto = "disable"\n');
  run(release);
  expect(readdirSync(cache)).toEqual([]);
  const requests = readFileSync(log, "utf8").trim().split("\n").map(row => JSON.parse(row));
  expect(requests).toHaveLength(2);
  for (const request of requests) expect(request.prompt).toContain(marker);
}, 60_000);

async function exercise(backend: string, status: Status, options: {failure?: string; roles?: string; mode?: string; gate?: string} = {}) {
  const apiRequests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith("/responses")) return new Response("unknown endpoint", {status: 404});
      const body = await req.text();
      apiRequests.push(body);
      const role = /"role"\s*:\s*"quality"/.test(body.replaceAll('\\"', '"'));
      const report = role ? modelReport(status) : modelReport("pass");
      return Response.json({ id: "resp_fixture", object: "response", status: "completed",
        output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(report) }] }] });
    },
  });
  const args = [join(kit, "review-agents/bin/review"), "--repo", repo, "--base", base, "--head", head,
    "--spec", join(repo, promptPath), "--roles", options.roles ?? "quality,comments", "--mode", options.mode ?? "ordered",
    "--backend", backend];
  if (!options.mode) args.push("--order", "comments,quality");
  try {
    const proc = Bun.spawn(args, {
      cwd: s.root, env: { ...s.env, FORGE_CODEX_BIN: codex, OPENAI_BASE_URL: server.url.href + "v1",
        OPENAI_API_KEY: "fixture-loopback-only", REQUESTS: log, QUALITY: JSON.stringify(modelReport(status)),
        PASS: JSON.stringify(modelReport("pass")), CLI_FAILURE: options.failure ?? "", RENDEZVOUS: options.gate ?? "" },
      stdout: "pipe", stderr: "pipe", timeout: 25_000,
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const cli = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    return { code, out, err, cli, apiRequests };
  } finally { await server.stop(true); }
}

for (const backend of ["codex", "api"]) {
  for (const status of ["pass", "blocked", "incomplete", "error"] as const) {
    test(`T07/T08 independent engine: ${backend} comments pass plus quality ${status}`, async () => {
      const result = await exercise(backend, status);
      expect(result.code, result.out + result.err).toBe(statuses[status]);
      const report = JSON.parse(result.out);
      expect(report).toMatchObject({base, head, mode: "ordered", status});
      expect(report.schemaVersion).toBeDefined();
      expect(report.roles.map((r: {role: string}) => r.role).sort()).toEqual(["comments", "quality"]);
      for (const role of report.roles) {
        expect(role).toMatchObject({ base, head, backend, status: role.role === "comments" ? "pass" : status });
        expect(role.attempts.length).toBeGreaterThan(0);
        expect(Array.isArray(role.findings)).toBe(true);
        expect(typeof role.summary).toBe("string");
      }
      expect(result.cli.length).toBe(backend === "codex" ? 2 : 0);
      expect(result.apiRequests.length).toBe(backend === "api" ? 2 : 0);
      const prompts = backend === "api" ? result.apiRequests : result.cli.map(r => r.prompt);
      for (const prompt of prompts) expect(prompt).toContain(marker);
      if (backend === "codex") {
        expect(result.cli.map(r => r.role)).toEqual(["comments", "quality"]);
        for (const r of result.cli) {
          expect(r.args).toContain("read-only");
          expect(r.args).not.toContain("resume");
        }
      }
      expect(s.git(repo, "status", "--porcelain")).toBe("");
    }, 30_000);
  }
}

for (const failure of ["upstream", "local", "unknown"]) {
  test(`T08 auto fallback for ${failure} failure`, async () => {
    const result = await exercise("auto", "pass", {failure, roles: "quality", mode: "serial"});
    expect(result.cli.length).toBe(1);
    expect(result.apiRequests.length).toBe(failure === "upstream" ? 1 : 0);
    expect(result.code).toBe(failure === "upstream" ? 0 : 2);
    const report = JSON.parse(result.out);
    expect(report.roles[0].backend).toBe(failure === "upstream" ? "api" : "codex");
  }, 30_000);
}

test("T08 invalid roles fail before either model receives materials", async () => {
  const result = await exercise("auto", "pass", {roles: "missing-role", mode: "serial"});
  expect(result.code).not.toBe(0);
  expect(result.cli).toEqual([]);
  expect(result.apiRequests).toEqual([]);
});

for (const mode of ["parallel", "serial"]) {
  test(`T08 selected roles respect the ${mode} scheduling barrier`, async () => {
    const result = await exercise("codex", "pass", {mode, gate: mode});
    expect(result.code, result.out + result.err).toBe(0);
    const trace = readFileSync(log + ".trace", "utf8").trim().split("\n");
    expect(trace).toHaveLength(4);
    expect(trace.map(line => line.split(" ")[0])).toEqual(
      mode === "parallel" ? ["start", "start", "end", "end"] : ["start", "end", "start", "end"],
    );
    expect(trace.filter(line => line.startsWith("start")).sort()).toEqual(["start comments", "start quality"]);
  }, 30_000);
}

test("ledger reviews preserves selected roles that could not start and their missing materials", () => {
  s.fresh();
  const app = join(s.work, "app");
  s.git(s.work, "clone", "-q", repo, app);
  s.ok([s.forge, "ledger", "open", "--id", "selection", "--title", "Check review coverage", "--repo", "app",
    "--branch", "main", "--base", base, "--depth", "targeted"]);
  Object.assign(s.env, { FORGE_CODEX_BIN: codex, REQUESTS: log, QUALITY: JSON.stringify(modelReport("pass")) });
  const args = [s.forge, "review", "--task", "selection", "--repo", "app", "--roles", "business,quality", "--backend", "codex"];
  const prior = s.run([s.forge, "review", "--task", "selection", "--repo", "app", "--roles", "quality", "--backend", "codex"], app);
  expect(prior.code, prior.out + prior.err).toBe(0);
  const result = s.run(args, app);
  expect(result.code, result.out + result.err).toBe(3);
  const reviews = JSON.parse(s.ok([s.forge, "ledger", "reviews", "selection"]));
  expect(reviews).toHaveLength(3);
  expect(reviews[0]).toMatchObject({ kind: "review", role: "quality", status: "pass", base, head });
  expect(reviews[1]).toMatchObject({ kind: "review_selection", role: "business", status: "incomplete", backend: null, attempts: [],
    missing_materials: ["spec"], base, head });
  expect(reviews[2]).toMatchObject({ kind: "review", role: "quality", status: "pass", backend: "codex", attempts: [{backend: "codex", status: "pass"}] });
  expect(readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line).role)).toEqual(["quality", "quality"]);

  const ledger = new Ledger(s.work);
  try {
    const event = ledger.getTaskEvents("selection").find(event => event.seq === reviews[1].seq)!;
    const fact = JSON.parse(event.payload_json);
    expect(fact).toMatchObject({ kind: "review_selection", status: "info", source: "tool" });
    expect(fact.meta.selection_id).toBeString();
    expect(fact.meta.execution_id).toBeUndefined();
  } finally { ledger.closeDb(); }

  const empty = s.run([...args, "--base", head], app);
  expect(empty.code).not.toBe(0);
  expect(empty.err + empty.out).toContain("Empty review diff");
  expect(JSON.parse(s.ok([s.forge, "ledger", "reviews", "selection"]))).toEqual(reviews);

  s.env.QUALITY = JSON.stringify(modelReport("incomplete"));
  expect(s.run(args, app).code).toBe(3);
  const attempted = JSON.parse(s.ok([s.forge, "ledger", "reviews", "selection"])).at(-1);
  expect(attempted).toMatchObject({ kind: "review", role: "quality", status: "incomplete", backend: "codex",
    attempts: [{ backend: "codex", status: "incomplete" }] });
});

for (const version of ["0.4", "0.5"] as const) test(`v${version} performance retry preserves the original role and range`, () => {
  s.fresh();
  const app = join(s.work, "app");
  s.git(s.work, "clone", "-q", repo, app);
  const db = new Ledger(s.work);
  try {
    const task = "perf-recovery";
    db.openTask({workflow_version:version, task_id:task, title:"Recover original review", endpoint:"local", depth:"full",
      repo:"app", branch:"main", base_sha:base, head_sha:head});
    for (const file of ["ssot", "tech-spec", "test-spec"]) s.privateFile(`.workbench/specs/${task}/${file}.md`, "Review the pinned revision.");
    const floor = db.freezeSpec({task_id: task}).spec.evidence_floor_seq.review;
    Object.assign(s.env, {FORGE_CODEX_BIN:codex, REQUESTS:log, PASS:JSON.stringify(modelReport("pass"))});
    const review = (role: string, ...more: string[]) => s.run([s.forge, "review", "--task", task, "--repo", "app", "--roles", role, "--backend", "codex", ...more], app);
    expect(review("performance").code).not.toBe(0);
    const scope = { task_id:task, repo:"app", branch:"main", sha:head, source:"tool" as const, actor:"tool" };
    const failure = db.recordEvidence({...scope, kind:"review", status:"fail", summary:"upstream transient failure",
      meta:{ role:"performance", base, head, review_task_id:task, review_floor_seq:floor, report_status:"error", exit_code:2, error_code:"upstream_unavailable" }});
    const standalone = s.run([join(kit,"review-agents/bin/review"), "--repo", app, "--base", base, "--head", head, "--roles", "performance"]);
    expect(standalone.code).not.toBe(0);
    expect(review("performance", "--base", head).code).not.toBe(0);
    if (version === "0.5") {
      expect(review("performance").code).not.toBe(0);
      expect(readFileSync(log, "utf8")).toBe("");
      return;
    }

    for (const kind of ["lint","test"] as const) db.recordEvidence({...scope, kind, status:"pass", summary: "fixture verification"});
    s.env.QUALITY = JSON.stringify(modelReport("pass"));
    const readiness = () => db.checkPushReadiness({task_id:task, repo:"app", branch:"main", head_sha:head});
    expect(review("quality,simplify").code).toBe(0);
    expect(readiness().hasExplicitFailure).toBe(true);
    s.env.PASS = JSON.stringify(modelReport("blocked"));
    expect(review("performance").code).toBe(1);
    expect(readiness().hasExplicitFailure).toBe(true);
    s.env.PASS = JSON.stringify(modelReport("pass"));
    const retry = review("performance");
    expect(retry.code, retry.out + retry.err).toBe(0);
    expect(JSON.parse(retry.out).roles).toMatchObject([{ role:"performance", base, head, status:"pass", backend:"codex" }]);
    expect(readiness().ready).toBe(true);
    expect(db.getTaskEvents(task).find(e => e.seq === failure.seq)).toEqual(failure);
    const records = db.getTaskEvents(task).filter(e => e.event_type === "EVIDENCE_CAPTURED")
      .map(e => ({seq:e.seq, ...JSON.parse(e.payload_json)})).filter(e => e.meta?.role === "performance");
    expect(records.map(r => r.status)).toEqual(["fail","fail","pass"]);
    expect(records[1].meta.retry_of).toBe(failure.seq);
    expect(records[2].meta.retry_of).toBe(records[1].seq);
    const inputs = readFileSync(log,"utf8").trim().split("\n").map(line => JSON.parse(line));
    const prompt = JSON.parse(inputs.at(-1).prompt);
    expect(prompt).toMatchObject({role:"performance",base,head});
    expect(prompt.instructions).toContain("# Simplicity and performance reviewer");
    expect(prompt.instructions).not.toContain("# Code simplification reviewer");
    expect(inputs.at(-1).args).toContain("read-only");
    expect(review("performance").code).not.toBe(0);
  } finally { db.closeDb(); }
}, 30_000);
