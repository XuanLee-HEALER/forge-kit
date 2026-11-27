import { beforeEach, test, expect } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { executorFixture } from "./helpers/executor";

const f = executorFixture();
let codex: string;
beforeEach(() => {
  const docs = join(f.root, ".workbench/specs/task");
  mkdirSync(docs, { recursive: true });
  for (const name of ["scope", "ssot", "tech-spec", "test-spec"]) writeFileSync(join(docs, name + ".md"), "Fixture requirements");
  const frozen = f.cli("ledger", [ "freeze", "task"]);
  expect(frozen.exitCode, frozen.stderr.toString()).toBe(0);
  writeFileSync(join(f.repo, "code.txt"), "updated");
  f.git("commit", "-m", "implement fixture", "--", "code.txt");
  codex = join(f.root, "test-codex");
  writeFileSync(codex, [
    "#!/usr/bin/env bun",
    'const args = process.argv.slice(2), data = JSON.parse(await Bun.stdin.text());',
    'await Bun.write(import.meta.path + "." + data.role, JSON.stringify({model:args[args.indexOf("-m")+1],effort:args.find(a=>a.startsWith("model_reasoning_effort="))}));',
    'if (!data.spec?.includes("Fixture requirements") || !args.includes("--ephemeral")) process.exit(2);',
    'if (await Bun.file(import.meta.path + ".mutate").exists()) await Bun.write(' + JSON.stringify(join(f.repo, "edit")) + ', "modified");',
    'const preset = Bun.file(import.meta.path + ".report");',
    'await Bun.write(args[args.indexOf("-o")+1], JSON.stringify({...(await preset.exists() ? await preset.json() : {status:"pass",summary:"reviewed fixture",findings:[],limitations:["Runtime coverage unavailable"]}),role:data.role,checked:data.chunks.map(({id,path})=>({id,path,conclusion:"reviewed"}))}));',
  ].join("\n"));
  chmodSync(codex, 0o755);
});

function run(args: string[], env: Record<string, string> = {}) {
  return f.cli("review", [ "--task", "task", "--repo", "service", ...args], { FORGE_CODEX_BIN: codex, ...env });
}
test("ordered review records only actual roles against the pinned task and version", () => {
  const r = run(["--roles", "quality,business", "--mode", "ordered", "--order", "business,quality"]);
  expect(r.exitCode, r.stderr.toString() + r.stdout.toString()).toBe(0);
  const report = JSON.parse(r.stdout.toString());
  expect(report.roles.map((role: { role: string }) => role.role)).toEqual(["business", "quality"]);
  expect(report.roles.map((role: { limitations: string[] }) => role.limitations)).toEqual([
    ["Runtime coverage unavailable"], ["Runtime coverage unavailable"],
  ]);
  const history = f.cli("ledger", ["reviews", "task"]);
  expect(JSON.parse(history.stdout.toString())[0].limitations).toEqual(["Runtime coverage unavailable"]);
  const records = f.evidence().filter(e => e.kind === "review");
  expect(records).toHaveLength(2);
  for (const record of records) {
    expect(record.meta.limitations).toEqual(["Runtime coverage unavailable"]);
    expect(record.source).toBe("tool");
    expect(record.meta.head).toBe(f.git("rev-parse", "HEAD"));
    expect(record.meta.review_task_id).toBe("task");
    expect(record.meta.report_status).toBe("pass");
    expect(record.meta.backend).toBe("codex");
  }
});
test("a dirty checkout during review produces no trusted evidence", () => {
  writeFileSync(codex + ".mutate", "change checkout during review");
  const r = run(["--roles", "quality"]);
  expect(r.exitCode).toBe(2);
  expect(f.evidence().filter(e => e.kind === "review")).toHaveLength(0);
});
test("an invalid explicit version cannot start a review", () => {
  expect(run(["--head", "deadbee", "--roles", "quality"]).exitCode).not.toBe(0);
  expect(f.evidence().filter(e => e.kind === "review")).toHaveLength(0);
});

test("a nonexistent finding line records a real provider error instead of a blocker", () => {
  writeFileSync(codex + ".report", JSON.stringify({status:"findings",summary:"fixture",checked:["code.txt"],limitations:[],
    findings:[{severity:"blocking",path:"code.txt",line:900,title:"Fixture",evidence:"Fixture",recommendation:"Fixture"}]}));
  const result = run(["--roles", "quality"]);
  expect(result.exitCode).toBe(3);
  expect(f.evidence().at(-1)).toMatchObject({source:"tool", meta:{backend:"codex",report_status:"incomplete",
    missing_materials:["code.txt"],findings:[],attempts:[{backend:"codex",status:"incomplete",reason:expect.stringMatching(/location/i)}]}});
});

test("forge resolves each role through explicit pair, tier, role mapping and defaults", async () => {
  const config=join(f.root,".workbench/models.toml");
  const tiers='[tiers.mechanical]\nmodel="gpt-6.1-terra"\neffort="low"\n[tiers.standard]\nmodel="gpt-6.2-sol"\neffort="medium"\n[tiers.deep]\nmodel="gpt-6.2-astra"\neffort="high"\n';
  const roles=["business","quality","simplify","comments"];
  for(const [mapping, options, expected] of [
    ["",[],["deep","deep","standard","mechanical"]],
    ['[review.roles]\nquality="mechanical"\n',[],["deep","mechanical","standard","mechanical"]],
    ['[review.roles]\nquality="mechanical"\n',["--tier","standard"],roles.map(()=>"standard")],
    ["",["--model","gpt-6.1-sol","--effort","high"],roles.map(()=>"explicit")],
  ] as const) {
    writeFileSync(config,tiers+mapping);
    const result=run(["--roles",roles.join(","),...options]);
    expect(result.exitCode,result.stderr.toString()+result.stdout.toString()).toBe(0);
    const pairs: Record<string,[string,string]>={mechanical:["gpt-6.1-terra","low"],standard:["gpt-6.2-sol","medium"],deep:["gpt-6.2-astra","high"],explicit:["gpt-6.1-sol","high"]};
    for(const [i,role] of roles.entries()){
      const [model,effort]=pairs[expected[i]];
      expect(await Bun.file(codex+"."+role).json()).toEqual({model,effort:"model_reasoning_effort="+JSON.stringify(effort)});
    }
  }
  const before=f.evidence();
  for(const invalid of [["--model","gpt-6.2-sol"],["--effort","low"],["--tier","absent"],["--model","unknown","--effort","low"]]){
    expect(run(["--roles","quality",...invalid]).exitCode).not.toBe(0);
    expect(f.evidence()).toEqual(before);
  }
},30_000);
