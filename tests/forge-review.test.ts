import { beforeEach, test, expect } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { executorFixture } from "./helpers/executor";
const f = executorFixture();
let agents: string, codex: string;
beforeEach(() => {
  agents = join(f.root, "mock-agents");
  codex = join(f.root, "codex");
  mkdirSync(join(agents, "dist"), { recursive: true });
  mkdirSync(join(agents, "prompts"));
  for (const role of ["quality", "simplify", "comments", "performance"]) {
    writeFileSync(join(agents, "prompts", role + ".md"), "Review " + role);
    writeFileSync(
      join(agents, "dist", "review-" + role + ".js"),
      `
      const role=${JSON.stringify(role)}, args=process.argv.slice(2), arg=k=>args[args.indexOf(k)+1], action=process.env.ACTION;
      if(action==="parallel"){
        await Bun.write(process.env.MARKERS+"/"+role,"started");
        for(let i=0; i<100 && (await Array.fromAsync(new Bun.Glob("*").scan(process.env.MARKERS))).length<4;i++) await Bun.sleep(20);
        if((await Array.fromAsync(new Bun.Glob("*").scan(process.env.MARKERS))).length!==4) process.exit(1);
      }
      if(action==="head") Bun.spawnSync(["git","commit","--allow-empty","-m","advance"]);
      if(action==="dirty") await Bun.write("edit","changed");
      if(action==="freeze" || action==="refreeze") {
        const r=Bun.spawnSync([process.execPath,process.env.LEDGER,"freeze","task","--lock-tests","code.txt"]); if(r.exitCode)throw Error(r.stderr.toString());
      }
      if(action==="model" && (arg("--model")!=="custom-model" || !(await Bun.file(process.env.FORGE_MODELS_TOML).exists()) || !(await Bun.file(process.env.REVIEW_CONFIG).exists()))) process.exit(2);
      const exhausted=action.startsWith("credit"), findings=action==="findings";
      await Bun.write(arg("--out"),JSON.stringify({role, repo:arg("--repo"),base:arg("--base"),head:arg("--head"),
        reviewTaskId:arg("--task-id"),reviewFloorSeq:Number(arg("--floor-seq")),status:exhausted?"error":findings?"findings":"pass",
        errorCode:exhausted?"credit_balance_exhausted":undefined, findings:findings?[{title:"issue",path:"code.txt",line:1,recommendation:"update check"}]:[], summary:"fixture"}));
      process.exit(exhausted?2:findings?1:0);
    `,
    );
  }
  writeFileSync(
    codex,
    '#!/usr/bin/env bun\nconst a=process.argv.slice(2); if(a[a.indexOf("-s")+1]!=="read-only" || !a.at(-1).includes(process.env.RANGE)) process.exit(1); if(process.env.DEFER_FREEZE) { const r=Bun.spawnSync([process.execPath,process.env.DEFER_FREEZE,"freeze","task","--lock-tests","code.txt"]); if(r.exitCode)process.exit(3); } await Bun.write(a[a.indexOf("-o")+1],JSON.stringify({passed:process.env.ACTION!=="credit-finding",findings:process.env.ACTION==="credit-finding"?[{path:"code.txt",line:2,title:"bug",severity:"blocking",evidence:"broken",recommendation:"fix it"}]:[],report:"reviewed range"}));',
  );
  chmodSync(codex, 0o755);
  mkdirSync(join(f.root, "markers"));
  const docs = join(f.root, ".workbench/specs/task");
  mkdirSync(docs, { recursive: true });
  for (const file of ["ssot", "tech-spec", "test-spec"]) writeFileSync(join(docs, file + ".md"), file);
  f.ledger.db.query("UPDATE tasks SET verification_depth='full'").run();
  for (const kind of ["test", "lint"] as const)
    f.ledger.recordEvidence({
      task_id: "task",
      repo: "service",
      sha: f.head,
      kind,
      source: "tool",
      status: "pass",
      summary: "checked",
    });
});
function run(action: string, args: string[] = []) {
  return f.cli("forge-review", args, {
    ACTION: action,
    FORGE_REVIEW_AGENTS_DIR: agents,
    FORGE_CODEX_BIN: codex,
    MARKERS: join(f.root, "markers"),
    LEDGER: join(import.meta.dir, "../src/bin/ledger.ts"),
    RANGE: f.head + ".." + f.head,
  });
}
test("four role runners execute concurrently and record pinned tool passes", () => {
  expect(f.ready()).toBe(false);
  const r = run("parallel");
  expect(r.exitCode, r.stdout.toString()).toBe(0);
  expect(f.ready()).toBe(true);
  const reviews = f.evidence().filter((p) => p.kind === "review");
  expect(reviews.length).toBe(4);
  for (const p of reviews)
    expect(p).toMatchObject({
      source: "tool",
      meta: { base: f.head, head: f.head, review_task_id: "task", fallback_used: false },
    });
});
test("credit exhaustion uses the pinned read-only fallback unless disabled; findings block delivery", () => {
  expect(run("credit").exitCode).toBe(0);
  expect(f.evidence().at(-1).meta.fallback_used).toBe(true);
  expect(f.ready()).toBe(true);
  const blocked = run("credit-finding", ["--roles", "quality"]);
  expect(blocked.exitCode).toBe(1);
  const fallbackRole = JSON.parse(blocked.stdout.toString()).roles[0];
  expect(fallbackRole.findings[0]).toMatchObject({ path: "code.txt", line: 2, recommendation: "fix it" });
  expect(JSON.parse(readFileSync(fallbackRole.report_path, "utf8")).findings).toEqual(fallbackRole.findings);
  expect(f.evidence().at(-1).meta).toMatchObject({ fallback_used: true, findings_count: 1 });
  expect(run("credit", ["--roles", "perf", "--no-fallback"]).exitCode).toBe(1);
  expect(f.evidence().at(-1).meta.fallback_used).toBe(false);
  expect(f.evidence().at(-1).meta).toMatchObject({
    exit_code: 2,
    report_status: "error",
    error_code: "credit_balance_exhausted",
    credit_balance_exhausted: true,
  });
  const deferred = f.cli(
    "ledger",
    ["review-fallback", "task", "--repo", "service", "--role", "performance", "--sha", f.head],
    { FORGE_REVIEW_AGENTS_DIR:agents, FORGE_CODEX_BIN: codex, RANGE: f.head + ".." + f.head },
  );
  expect(deferred.exitCode, deferred.stderr.toString()).toBe(0);
  const failed = run("findings", ["--roles", "quality"]);
  expect(failed.exitCode).toBe(1);
  const role = JSON.parse(failed.stdout.toString()).roles[0];
  expect(role.findings[0]).toMatchObject({ path: "code.txt", line: 1, recommendation: "update check" });
  expect(JSON.parse(readFileSync(role.report_path, "utf8")).findings).toEqual(role.findings);
  expect(f.evidence().at(-1).meta.findings_count).toBe(1);
  expect(f.ready()).toBe(false);
});
for (const action of ["dirty", "freeze", "refreeze", "head"])
  test("no review credit after " + action + " during execution", () => {
    if (action === "refreeze") f.ledger.freezeSpec({ task_id: "task" });
    expect(run(action, ["--roles", "quality"]).exitCode).toBe(1);
    expect(f.evidence().some((p) => p.kind === "review")).toBe(false);
  });

test("relative model and provider configs stay valid when the child switches to its checkout", () => {
  writeFileSync(join(f.root, "provider.toml"), "[openai]");
  writeFileSync(join(f.root, "custom.toml"), '[tiers.deep]\nmodel="custom-model"\neffort="high"');
  const child = Bun.spawnSync(
    [
      process.execPath,
      join(import.meta.dir, "../src/bin/forge-review.ts"),
      "--repo",
      "service",
      "--roles",
      "quality",
    ],
    {
      cwd: f.root,
      env: {
        ...process.env,
        FORGE_WORKBENCH_ROOT: f.root,
        ACTION: "model",
        FORGE_REVIEW_AGENTS_DIR: agents,
        FORGE_MODELS_TOML: "custom.toml",
        REVIEW_CONFIG: "provider.toml",
      },
    },
  );
  expect(child.exitCode, child.stdout.toString()).toBe(0);
});

test("repo selection resolves the primary branch when another open task owns a sibling branch", () => {
  writeFileSync(join(f.repo, "basic.test.ts"), 'import {test} from "bun:test"; test("basic",()=>{});');
  f.git("add", ".");
  f.git("commit", "-m", "test");
  f.git("branch", "sibling");
  f.ledger.openTask({
    task_id: "sibling",
    title: "sibling",
    repo: "service",
    branch: "sibling",
    endpoint: "local",
    depth: "targeted",
  });
  for (const [bin, args] of [
    ["wb-verify", ["--kind", "test", "--", process.execPath, "test"]],
    ["forge-review", ["--roles", "quality"]],
  ] as const) {
    const child = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, "../src/bin", bin + ".ts"), "--repo", "service", ...args],
      {
        cwd: f.root,
        env: { ...process.env, FORGE_WORKBENCH_ROOT: f.root, FORGE_REVIEW_AGENTS_DIR: agents, ACTION: "pass" },
      },
    );
    expect(child.exitCode, child.stdout.toString()).toBe(0);
    expect(JSON.parse(child.stdout.toString()).task_id).toBe("task");
  }
  expect(f.ledger.getTaskEvents("sibling").some((e) => e.event_type === "EVIDENCE_CAPTURED")).toBe(false);
});

test("deferred fallback rejects refreeze with unchanged evidence floor", () => {
  f.ledger.freezeSpec({ task_id: "task" });
  const floor = f.ledger.getSpecState("task").evidence_floor_seq.review;
  expect(run("credit", ["--roles", "comments", "--no-fallback"]).exitCode).toBe(1);
  renameSync(agents, join(f.root, ".workbench/review-agents"));
  const res = f.cli(
    "ledger",
    ["review-fallback", "task", "--repo", "service", "--role", "comments", "--sha", f.head],
    {
      FORGE_CODEX_BIN: codex,
      DEFER_FREEZE: join(import.meta.dir, "../src/bin/ledger.ts"),
      RANGE: f.head + ".." + f.head,
    },
  );
  expect(res.exitCode).toBe(1);
  expect(res.stderr.toString()).toContain("evidence changed");
  expect(f.ledger.getSpecState("task").evidence_floor_seq.review).toBe(floor);
  expect(f.evidence().at(-1).status).toBe("fail");
});
