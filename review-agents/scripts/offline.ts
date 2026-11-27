import { writeFileSync } from "node:fs";
import { join } from "node:path";

// The deterministic subprocess exercises prompt delivery and scoring offline.
export function offlineCodex(root: string) {
  const samples = {
    business: ["count > 10;", "Exactly 10 items lose the discount."],
    quality: ["(xs.length - 1)", "The denominator uses one fewer score than the input length."],
    simplify: ["ids.indexOf(id)", "Repeated indexOf scans make the algorithm quadratic."],
    comments: ["Accepts milliseconds and returns seconds.", "The documented milliseconds and seconds are reversed."],
  };
  const executable = join(root, "fixture-codex");
  writeFileSync(executable, `#!/usr/bin/env bun
const args = process.argv.slice(2);
const {role, chunks} = JSON.parse(await Bun.stdin.text());
const [marker, title] = ${JSON.stringify(samples)}[role];
const findings = [];
for (const chunk of chunks) {
  let line = chunk.newStart;
  for (const row of chunk.patch.split("\\n")) {
    if (row.startsWith("+") && !row.startsWith("+++") && row.includes(marker))
      findings.push({severity:"blocking",path:chunk.path,line,title,evidence:row.slice(1),recommendation:"Apply the specified behavior."});
    if ((row.startsWith("+") && !row.startsWith("+++")) || row.startsWith(" ")) line++;
  }
}
const checked = chunks.map(({id,path}) => ({id,path,conclusion:"reviewed"}));
await Bun.write(args[args.indexOf("-o")+1], JSON.stringify({role,checked,findings,limitations:[],summary:"Offline fixture",status:findings.length?"findings":"pass"}));
`, {mode:0o755});
  process.env.FORGE_CODEX_BIN = executable;
}
