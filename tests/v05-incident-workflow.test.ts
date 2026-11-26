import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { sandbox, type Sandbox } from "./v05-sandbox";

const incidents = [
  { source: "QA defect", report: "During QA acceptance a synthetic invoice returned an empty total.", expected: "qa" },
  { source: "production defect", report: "A production operator reports missing totals in synthetic customer invoices.", expected: "live" },
  { source: "alert", report: "Monitoring alert on the live invoice service: error count above threshold.", expected: "live" },
] as const;

async function decide(s: Sandbox, skill: string, catalog: unknown, report: string) {
  const room = join(s.root, "diagnostician");
  mkdirSync(room);
  const schema = join(s.root, "decision.schema.json"), answer = join(s.root, "decision.json");
  writeFileSync(schema, JSON.stringify({type:"object", additionalProperties:false, required:["environment","command"],
    properties:{environment:{type:"string"},command:{type:"array",items:{type:"string"}}}}));
  const tier = (Bun.TOML.parse(s.read(".workbench/models.toml")) as {tiers:{standard:{model:string; effort:string}}}).tiers.standard;
  const args = ["codex", "exec", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check", "-s", "read-only",
    "-c", 'approval_policy="never"', "-c", "model_reasoning_effort="+JSON.stringify(tier.effort),
    "-m", tier.model, "-C", room, "--json", "--output-schema", schema, "-o", answer, "-"];
  const prompt = "Handle this synthetic incident using the installed bugfix skill below. The instance discovery result is supplied. " +
    "Your next command will be run by the harness. Return its argv and the environment name used by the instance. " +
    "Choose the first operational step after discovery. You have no other tools or input.\n" +
    JSON.stringify({report, installed_skill:skill, discovery:catalog});
  const proc = Bun.spawn(args, {cwd:room, env:{PATH:process.env.PATH,HOME:process.env.HOME,CODEX_HOME:process.env.CODEX_HOME},
    stdin:Buffer.from(prompt), stdout:"pipe", stderr:"pipe", timeout:120_000});
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const events = out.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const failure = events.findLast(row => row.type === "turn.failed" || row.type === "error");
  expect(code, failure?.error?.message ?? failure?.message ?? err.slice(-500)).toBe(0);
  const thread = events.find(row => row.type === "thread.started")?.thread_id;
  expect(thread).toBeString();
  return {thread, decision:JSON.parse(readFileSync(answer, "utf8")) as {environment:string; command:string[]}};
}

// Model credentials and a live Codex CLI are required only for this acceptance run.
for (const incident of incidents) test.skipIf(process.env.FORGE_LIVE_T10 !== "1")(`T10 installed bugfix routes ${incident.source}`, async () => {
  const s = sandbox();
  const ticket = randomUUID(), requests: {path:string; method:string; ticket:string|null}[] = [];
  const responses = new Map(["qa","live"].map(env => ["/"+env, randomUUID()]));
  const server = Bun.serve({hostname:"127.0.0.1", port:0, fetch(req) {
    const url = new URL(req.url);
    requests.push({path:url.pathname, method:req.method, ticket:url.searchParams.get("ticket")});
    return Response.json({receipt:responses.get(url.pathname)});
  }});
  try {
    s.fresh();
    const stages: Record<string,{action:string}> = {};
    const actions: Record<string,object> = {};
    for (const env of ["qa","live"]) {
      const action = "read" + randomUUID().slice(0,8);
      const stage = "inspect" + randomUUID().slice(0,8);
      actions[action] = {purpose:"diagnose",cwd:".",argv:["bun","-e",
        "console.log(await (await fetch(process.argv[1])).text())",server.url.origin+"/"+env+"?ticket="+ticket]};
      stages[stage] = {action};
    }
    const cfg = parse(s.read(".workbench/workbench.yaml"));
    cfg.extensions = {actions, stages};
    writeFileSync(join(s.work,".workbench/workbench.yaml"), stringify(cfg));
    const entry = JSON.parse(s.ok([s.forge,"instance","show","skill","bugfix","--json"]));
    const skill = readFileSync(entry.value.path, "utf8");
    const catalog = JSON.parse(s.ok([s.forge,"instance","list","--json"]));
    const {thread, decision} = await decide(s, skill, catalog, incident.report + " Ticket " + ticket);
    // Only execute literal commands in this synthetic instance, including a mistaken environment choice.
    expect(decision.command.slice(0,3)).toEqual(["forge","instance","run"]);
    expect(decision.command).toHaveLength(4);
    expect(Object.hasOwn(stages, decision.command[3])).toBe(true);
    const proc = Bun.spawn([s.forge, ...decision.command.slice(1)], {cwd:s.work,env:s.env,stdout:"pipe",stderr:"pipe",timeout:12_000});
    const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(code, out+err).toBe(0);
    console.log(JSON.stringify({source:incident.source,ticket,thread,skillSha256:createHash("sha256").update(skill).digest("hex"),decision,requests}));
    expect(requests).toEqual([{path:"/"+incident.expected,method:"GET",ticket}]);
    expect(decision.environment).toBe(incident.expected);
    expect(out).toContain(responses.get("/"+incident.expected)!);
    expect(JSON.parse(s.ok([s.forge,"ledger","query","--json"])).tasks).toEqual([]);
  } finally { await server.stop(true); s.cleanup(); }
}, 150_000);
