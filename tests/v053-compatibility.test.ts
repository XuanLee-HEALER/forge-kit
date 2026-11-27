import { expect, test } from "bun:test";
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendEventInTx } from "../src/ledger/transactions";
import { executorFixture } from "./helpers/executor";

const f = executorFixture("0.5");

function scope(id: string) {
  const dir = join(f.root, ".workbench/specs", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "scope.md"), "Check observable results.\n");
  return dir;
}

function cli(bin: string, args: string[], env?: Record<string, string>) {
  const result = f.cli(bin, args, env);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString();
}

test("a changed exported generator brings its unchanged caller into the review", () => {
  scope("task");
  cli("ledger", ["freeze", "task"]);
  writeFileSync(join(f.repo, "stream.ts"), "export function* values() { yield 1; }\n");
  writeFileSync(join(f.repo, "reader.ts"), 'import { values } from "./stream";\nexport const first = values().next().value;\n');
  f.git("add", "--", "stream.ts", "reader.ts");
  f.git("commit", "-qm", "define generator and consumer");
  const base = f.git("rev-parse", "HEAD");
  writeFileSync(join(f.repo, "stream.ts"), 'export function* values() { yield "one"; }\n');
  f.git("commit", "-qm", "change yielded type", "--", "stream.ts");
  const backend = join(f.root, "reviewer");
  writeFileSync(backend, `#!/usr/bin/env bun
import {appendFileSync} from "node:fs";
const q=JSON.parse(await Bun.stdin.text());
const checked=q.chunks.map(({id,path})=>({id,path,conclusion:"reviewed"}));
appendFileSync(import.meta.path+".paths", checked.map(c=>c.path).join("\\n")+"\\n");
await Bun.write(process.argv[process.argv.indexOf("-o")+1],JSON.stringify({role:q.role,checked,status:"pass",summary:"Checked",limitations:[],findings:[]}));
`, {mode: 0o755});
  cli("review", ["--task", "task", "--repo", "service", "--base", base, "--roles", "quality"], {FORGE_CODEX_BIN: backend});
  expect(f.git("diff", "--name-only", base, "HEAD")).toBe("stream.ts");
  expect(readFileSync(backend + ".paths", "utf8").split("\n")).toContain("reader.ts");
});

test("verification uses fresh evidence when the stage locale changes", () => {
  scope("task");
  cli("ledger", ["freeze", "task"]);
  const workbench = join(f.root, ".workbench");
  for (const file of ["models.toml", "ship-policy.yaml"])
    copyFileSync(join(import.meta.dir, "../templates", file), join(workbench, file));
  const observations = join(f.root, "locales");
  const program = 'import {appendFileSync} from "node:fs"; appendFileSync(' + JSON.stringify(observations) + ', process.env.LANG+"\\n")';
  appendFileSync(join(workbench, "workbench.yaml"), [
    "extensions:", "  verification: {stages: [locale]}", "  stages: {locale: {action: observe}}", "  actions:",
    "    observe: " + JSON.stringify({purpose: "verify", cwd: ".", argv: ["bun", "-e", program]}), "",
  ].join("\n"));
  const args = ["--task", "task", "--cwd", f.repo, "--mode", "all", "--offline"];
  for (const LANG of ["C", "C", "en_US.UTF-8"]) cli("verify", args, { LANG });
  expect(readFileSync(observations, "utf8")).toBe("C\nen_US.UTF-8\n");
});

test("a task opened under 0.5.2 can first freeze with its historical working files", () => {
  const id = "historical";
  // Seed the 0.5.2 TASK_OPENED wire format in the isolated ledger, keeping a valid event chain.
  const ts = "2026-11-01T00:00:00.000Z";
  f.ledger.db.transaction(() => {
    f.ledger.db.query("INSERT INTO tasks (task_id,title,status,endpoint,verification_depth,tip_hash,created_at,updated_at) VALUES (?,?,'OPEN','local','targeted','GENESIS',?,?)")
      .run(id, id, ts, ts);
    appendEventInTx(f.ledger.db, { task_id: id, event_type: "TASK_OPENED", actor: "agent", ts,
      payload: {title: id, endpoint: "local", workflow_version: "0.5", verification_depth: "targeted", base_sha: null} });
  })();
  const dir = scope(id);
  writeFileSync(join(dir, "old-run.log"), "original\n");
  cli("ledger", ["freeze", id]);
  expect(f.ledger.getSpecState(id).state).toBe("FROZEN");
  expect(readFileSync(join(dir, "old-run.log"), "utf8")).toBe("original\n");
  cli("ledger", ["verify", "--task", id]);
});
