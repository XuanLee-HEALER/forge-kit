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
    'if (!data.spec?.includes("Fixture requirements") || !args.includes("--ephemeral")) process.exit(2);',
    'if (process.env.MUTATE_REPO) await Bun.write(process.env.MUTATE_REPO + "/edit", "modified");',
    'await Bun.write(args[args.indexOf("-o")+1], JSON.stringify({status:"pass",summary:"reviewed fixture",findings:[],checked:[],limitations:["Runtime coverage unavailable"]}));',
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
  const r = run(["--roles", "quality"], { MUTATE_REPO: f.repo });
  expect(r.exitCode).toBe(2);
  expect(f.evidence().filter(e => e.kind === "review")).toHaveLength(0);
});
test("an invalid explicit version cannot start a review", () => {
  expect(run(["--head", "deadbee", "--roles", "quality"]).exitCode).not.toBe(0);
  expect(f.evidence().filter(e => e.kind === "review")).toHaveLength(0);
});
