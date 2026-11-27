import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox } from "./v05-sandbox";

// Opt in with "bun tests/v05-author-workflow.ts". This evaluates installed work instructions with real Codex sessions.
const s = sandbox();
const observations: object[] = [];
const threads = new Set<string>();
const children = new Set<ReturnType<typeof Bun.spawn>>();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const contract = "Create normalize.ts exporting normalizeLabel(value: string): string. The result equals " +
  "value.trim().toUpperCase(), preserving internal spaces. Check '  red fox  ' => 'RED FOX', 'a  b' => 'A  B', and whitespace only => ''. " +
  "Contract tests live in normalize.test.ts, use bun:test, and import ./normalize.";
const cases = [
  ["A", true, false, true, "full"], ["B", false, true, false, "full"],
  ["C", true, true, true, "targeted"], ["D", false, false, false, "full"],
  ["E", true, true, false, "full"], ["F", false, true, true, "full"],
  ["G", true, false, false, "full"], ["H", false, false, true, "full"],
] as const;
type Plan = {
  decisions: Record<string, string>;
  fullDecision: {passed: string; blocker: string; newRisk: string};
  assignments: Record<"full"|"targeted", {implementation: string[]; tests: string[]; scheduling: string; frozenDocuments: string[]; canStartUnconfirmed: boolean; canStartBeforeFreeze: boolean}>;
};
type Job = {files: Record<string,string>; output: string; prompt: string};
type Input = {title:string; dir:string; role:"implementer"|"reviewer"; prompt:string; schema?: object};

function authorRoom(files: Record<string,string>) {
  const cwd = mkdtempSync(join(s.root, "author-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(cwd, name), content);
  return cwd;
}

async function session(input: Input) {
  const role = Bun.TOML.parse(s.read(".codex/agents/" + input.role + ".toml")) as Record<string,string>;
  const last = join(s.root, randomUUID() + ".answer");
  const args = ["codex", "exec", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check", "--json",
    "-C", input.dir, "-m", String(role.model), "-s", String(role.sandbox_mode), "-c", 'approval_policy="never"',
    "-c", "model_reasoning_effort="+JSON.stringify(role.model_reasoning_effort),
    "-c", "developer_instructions="+JSON.stringify(role.developer_instructions), "-o", last];
  if (input.schema) {
    const path = join(s.root, randomUUID()+".schema.json");
    writeFileSync(path, JSON.stringify(input.schema));
    args.push("--output-schema", path);
  }
  args.push("-");
  const started = Date.now();
  const proc = Bun.spawn(args, {cwd:input.dir, env:{PATH:process.env.PATH, HOME:process.env.HOME, CODEX_HOME:process.env.CODEX_HOME},
    stdin:Buffer.from("This is a synthetic workbench acceptance case. Use only the supplied materials and your own workspace. "+
      "Do not delegate or use the network. "+input.prompt), stdout:"pipe",stderr:"pipe",timeout:180_000});
  children.add(proc);
  try {
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(),new Response(proc.stderr).text()]);
    const events = stdout.split("\n").filter(Boolean).map(line => JSON.parse(line));
    const failure = events.findLast(e=>e.type==="turn.failed" || e.type==="error");
    assert.equal(code, 0, input.title + ": " + (failure?.error?.message ?? failure?.message ?? stderr.slice(-600)));
    const id = events.find(e=>e.type==="thread.started")?.thread_id;
    assert.ok(id && !threads.has(id), "expected a fresh Codex session for "+input.title);
    threads.add(id);
    observations.push({job:input.title,thread:id,model:role.model,started,ended:Date.now()});
    return readFileSync(last, "utf8");
  } finally { children.delete(proc); }
}

async function paired(label: string, jobs: Job[]) {
  const rooms = jobs.map(job=>authorRoom(job.files));
  const arrived = new Map<string,number>();
  const runs = jobs.map((job,i)=>{
    const dir = rooms[i]!;
    writeFileSync(join(dir,"begin.sh"), 'set -eu\nprintf ready > ready\nwhile [ ! -e proceed ]; do sleep 0.1; done\n');
    return session({dir, role:"implementer", title:label+"/"+job.output, prompt:
      "Your first shell action must be sh ./begin.sh. Wait until it finishes before creating any artifact. " +
      "Read these files in your current directory: "+Object.keys(job.files).join(", ")+". "+job.prompt+
      " Write only "+job.output+". The peer workspace and peer output are unavailable."});
  });
  let cancelled = false;
  const release = (async()=>{
    for (let end=Date.now()+100_000; Date.now()<end && arrived.size<jobs.length;) {
      if (cancelled) return;
      for (const dir of rooms) if (!arrived.has(dir) && existsSync(join(dir,"ready"))) arrived.set(dir,Date.now());
      if (arrived.size<jobs.length) await Bun.sleep(50);
    }
    assert.equal(arrived.size, jobs.length, "the two actual authors must both enter the rendezvous: "+label);
    const released = Date.now();
    jobs.forEach((j,i)=>{
      assert.ok(!existsSync(join(rooms[i]!,j.output)), "author finished before peer arrived: "+j.output);
      const inputs = Object.entries(j.files).map(([file,text])=>({file,sha256:hash(text)}));
      observations.push({job:label+"/"+j.output,inputs,arrived:arrived.get(rooms[i]!),released});
    });
    for (const dir of rooms) writeFileSync(join(dir,"proceed"),"go");
  })();
  try { await Promise.all([release,...runs]); } finally { cancelled = true; }
  return jobs.map((job,i)=>{
    for (const [file,content] of Object.entries(job.files)) assert.equal(readFileSync(join(rooms[i]!,file),"utf8"),content);
    const output = readFileSync(join(rooms[i]!,job.output),"utf8");
    assert.ok(output.trim());
    return output;
  });
}

const jsonObject = (properties:Record<string,object>) => ({type:"object",properties,required:Object.keys(properties),additionalProperties:false});
const strings = {type:"array",items:{type:"string"}};
const assignment = jsonObject({implementation:strings,tests:strings,frozenDocuments:strings,canStartUnconfirmed:{type:"boolean"},canStartBeforeFreeze:{type:"boolean"},scheduling:{enum:["parallel","implementation-first","tests-first"]}});
try {
  s.fresh();
  const feature = s.read(".agents/skills/feature/SKILL.md");
  const facts = cases.map(([id,local,noCore,covered])=>({id,localAndSimple:local,preservesCoreAndContracts:noCore,mainAlreadyTestsIt:covered}));
  const schema = jsonObject({decisions:jsonObject(Object.fromEntries(cases.map(([id])=>[id,{enum:["full","targeted"]}]))),
    fullDecision:jsonObject(Object.fromEntries(["passed","blocker","newRisk"].map(id=>[id,{enum:["freeze","revise","operator"]}]))),
    assignments:jsonObject({full:assignment,targeted:assignment})});
  const plan: Plan = JSON.parse(await session({title:"workflow classification",dir:authorRoom({}),role:"reviewer",schema,
    prompt:"Apply the following installed feature instructions to each independent case. Report the chosen track and the two post-freeze " +
      "author input lists and launch schedule for each track. Also identify what freezes and whether authors may start without confirmation or before freezing. Use only these document names: ssot.md, tech-spec.md, test-spec.md, scope.md. "+
      "For launch schedule choose parallel, implementation-first, or tests-first. In full mode the operator already accepted the SSOT and authorized work. " +
      "Choose the next action in three cases: passed means independent reviews passed with unchanged scope and risks; blocker means a fixable test gap; newRisk means a new decision about a business risk.\n"+feature+"\nCases:\n"+JSON.stringify(facts)}));
  for (const [id,,,,expected] of cases) assert.equal(plan.decisions[id],expected,"case "+id);
  assert.deepEqual(plan.fullDecision,{passed:"freeze",blocker:"revise",newRisk:"operator"});
  observations.push({skillSha256:hash(feature),facts,plan});
  const ledger = (...args:string[])=>s.ok([s.forge,"ledger",...args]);
  for (const track of ["full","targeted"] as const) {
    const split = plan.assignments[track];
    assert.equal(split.scheduling,"parallel");
    assert.equal(split.canStartUnconfirmed,false);
    assert.equal(split.canStartBeforeFreeze,false);
    assert.deepEqual([...split.frozenDocuments].sort(),track==="full"?["ssot.md","tech-spec.md","test-spec.md"]:["scope.md"]);
    assert.deepEqual([...split.implementation].sort(),track==="full"?["ssot.md","tech-spec.md"]:["scope.md"]);
    assert.deepEqual([...split.tests].sort(),track==="full"?["ssot.md","test-spec.md"]:["scope.md"]);
    const repo = join(s.work,track);
    mkdirSync(repo);
    s.git(repo,"init","-b","main");
    s.git(repo,"config","user.name","Fixture");
    s.git(repo,"config","user.email","fixture@example.invalid");
    writeFileSync(join(repo,"existing.test.ts"),'import {expect,test} from "bun:test";import {normalizeLabel} from "./normalize";test("accepts existing normalized label",()=>expect(normalizeLabel("RED")).toBe("RED"));');
    writeFileSync(join(repo,"normalize.ts"),'export function normalizeLabel(value:string):string{return value.toUpperCase();}');
    s.git(repo,"add","--","normalize.ts","existing.test.ts");
    s.git(repo,"commit","-m","baseline coverage","--","normalize.ts","existing.test.ts");
    const head=s.git(repo,"rev-parse","main").trim();
    s.git(repo,"switch","-c","task","main");
    ledger("open","--id",track,"--title",track,"--endpoint","local","--depth",track,"--repo",track,"--branch","task","--worktree",repo,"--base",head,"--head",head);
    const docs: Record<string,string> = {};
    if (track==="full") {
      docs["ssot.md"]=contract;
      ledger("decide",track,"--key","confirmed-ssot","--summary","Synthetic operator accepts the public normalization contract and authorizes implementation");
      const [tech,tests]=await paired("specification",[
        {files:{...docs},output:"tech-spec.md",prompt:"Write a concise implementation specification for the contract. Name the file, export, and behavior; no extra requirements."},
        {files:{...docs},output:"test-spec.md",prompt:"Write a concise contract-test specification covering the given examples and public API; no extra requirements."},
      ]);
      docs["tech-spec.md"]=tech!; docs["test-spec.md"]=tests!;
      const review=JSON.parse(await session({title:"independent specification review",dir:authorRoom(docs),role:"reviewer",
        schema:jsonObject({pass:{type:"boolean"},reason:{type:"string"}}),prompt:"Read ssot.md, tech-spec.md and test-spec.md; check both derived documents for correctness and coverage. Accept if they satisfy the SSOT."}));
      assert.ok(review.pass,review.reason);
    } else docs["scope.md"]="Scope: update normalize.ts only. Main already tests normalized labels in existing.test.ts. Supplemental regression cases: "+contract;
    for (const [file,content] of Object.entries(docs)) s.privateFile(".workbench/specs/"+track+"/"+file,content);
    assert.notEqual(JSON.parse(ledger("spec-status",track)).state,"FROZEN");
    if(track==="targeted") ledger("decide",track,"--key","confirmed-spec","--summary","Synthetic operator accepts the scoped changes and cases");
    ledger("freeze",track);
    const freeze = JSON.parse(ledger("spec-status",track));
    assert.equal(freeze.state,"FROZEN");
    observations.push({track,freeze:freeze.state,freezeSeq:freeze.freeze_seq,inputs:split.frozenDocuments});
    const frozen = (names:string[]) => Object.fromEntries(names.map(name=>[name,s.read(".workbench/specs/"+track+"/"+name)]));
    const [code,tests]=await paired(track,[
      {files:frozen(split.implementation),output:"normalize.ts",prompt:"Implement the specified exported function."},
      {files:frozen(split.tests),output:"normalize.test.ts",prompt:"Write runnable Bun contract tests for the specified function. Do not create the implementation."},
    ]);
    writeFileSync(join(repo,"normalize.ts"),code!);
    writeFileSync(join(repo,"normalize.test.ts"),tests!);
    s.ok(["bun","test","existing.test.ts","normalize.test.ts"],repo);
    observations.push({track,implementation:hash(code!),contractTests:hash(tests!),integrated:"pass"});
    writeFileSync(join(repo,"normalize.ts"),'export function normalizeLabel(value:string){return value.toUpperCase();}');
    assert.notEqual(s.run(["bun","test","normalize.test.ts"],repo).code,0,"independent contract missed whitespace regression");
    const specFile = Object.keys(docs)[0]!;
    s.privateFile(".workbench/specs/"+track+"/"+specFile,docs[specFile]+"\nSynthetic drift\n");
    assert.equal(JSON.parse(ledger("spec-status",track)).drift_detected,true);
    observations.push({track,regressionRejected:true,freezeDriftDetected:true});
  }
  const taskCount = () => JSON.parse(ledger("query","--json")).tasks.length;
  assert.equal(taskCount(),2);
  s.ok([s.forge,"instance","list","--json"]);
  assert.equal(taskCount(),2);
  console.log(JSON.stringify({status:"pass",observations},null,2));
} finally {
  for (const proc of children) proc.kill();
  await Promise.all([...children].map(proc=>proc.exited));
  s.cleanup();
}
