import { writeFileSync } from "node:fs";
import { join } from "node:path";

// These canned findings model the transport contract. The scorer independently
// checks location, severity and concept against the labels in paired.json.
const samples = {
  business: ["count > 10;", "Exactly 10 items lose the discount."],
  quality: ["(xs.length - 1)", "The denominator uses one fewer score than the input length."],
  simplify: ["ids.indexOf(id)", "Repeated indexOf scans make the algorithm quadratic."],
  comments: ["Accepts milliseconds and returns seconds.", "The documented milliseconds and seconds are reversed."],
} as const;

function fixtureReport(prompt: string) {
  const { role, diff, spec } = JSON.parse(prompt);
  const rule = samples[role as keyof typeof samples];
  const patch = diff?.["sample.ts"];
  if (!rule || typeof patch !== "string" || !spec) throw Error("Missing paired evaluation material");
  const added = patch.split("\n").map((line: string) => line.replace(/^\d+: /, "")).filter((line: string) => line.startsWith("+") && !line.startsWith("+++"));
  if (!added.length) throw Error("Missing added sample source");
  const index = added.findIndex((line: string) => line.includes(rule[0]));
  const findings = index < 0 ? [] : [{ severity: "blocking", path: "sample.ts", line: index + 1,
    title: rule[1], evidence: added[index].slice(1), recommendation: "Apply the specified behavior." }];
  return { status: findings.length ? "findings" : "pass", summary: "Offline transport fixture", findings,
    checked: ["sample.ts"], limitations: ["Deterministic provider fixture"] };
}

export function offlineProviders(root: string) {
  // This executable is a standalone evaluation process. Its simulated clients
  // only need Bun, Git, temporary files and a synthetic loopback credential.
  for (const name of Object.keys(process.env)) {
    if (!["PATH", "TMPDIR", "LANG"].includes(name)) delete process.env[name];
  }
  process.env.HOME = root;
  const calls = new Set<string>();
  const server = Bun.serve({hostname: "127.0.0.1", port: 0, async fetch(request) {
    const route = new URL(request.url).pathname;
    if (request.method !== "POST" || !["/codex", "/v1/responses"].includes(route)) return new Response(null, {status: 404});
    const api = route === "/v1/responses";
    const prompt = api ? (await request.json()).input : await request.text();
    const report = fixtureReport(prompt);
    const { head, role } = JSON.parse(prompt);
    calls.add([api ? "api" : "codex", role, head].join("/"));
    return Response.json(api ? {id: "resp_fixture", object: "response", status: "completed", output: [
      {id: "msg_fixture", type: "message", role: "assistant", content: [{type: "output_text", text: JSON.stringify(report)}]},
    ]} : report);
  }});
  const codex = join(root, "fixture-codex");
  writeFileSync(codex, `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args[0] !== "exec" || !args.includes("-o")) process.exit(2);
const url = ${JSON.stringify(new URL("/codex", server.url).href)};
const response = await fetch(url, {method: "POST", body: await Bun.stdin.text()});
if (!response.ok) process.exit(2);
await Bun.write(args[args.indexOf("-o") + 1], await response.text());
`, {mode:0o755});
  process.env.FORGE_CODEX_BIN = codex;
  process.env.OPENAI_BASE_URL = new URL("/v1", server.url).href;
  process.env.OPENAI_API_KEY = "synthetic-offline-fixture";
  return {calls, close: () => server.stop(true)};
}
