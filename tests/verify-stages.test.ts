import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { executorFixture } from "./helpers/executor";

const f = executorFixture("0.5");

test("custom and core stages execute in declaration order against one isolated revision", () => {
  const configDir = join(f.root, ".workbench");
  for (const file of ["models.toml", "ship-policy.yaml"]) {
    copyFileSync(join(import.meta.dir, "../templates", file), join(configDir, file));
  }
  const trace = join(f.root, "trace");
  const step = (id: string) => "import {appendFileSync} from 'node:fs'; appendFileSync(" +
    JSON.stringify(trace) + ", JSON.stringify([" + JSON.stringify(id) + ",process.cwd(),process.env.FIXTURE_CREDENTIAL ?? null])+'\\n');console.log(" + JSON.stringify(id) + ")";
  const builtin = (id: string) => {
    const filename = id + ".ts";
    writeFileSync(join(f.repo, filename), step(id));
    return "bun " + filename;
  };
  writeFileSync(join(f.repo, "package.json"), JSON.stringify({ scripts: { check: builtin("static"), test: builtin("dynamic") } }));
  f.git("add", "--", "package.json", "static.ts", "dynamic.ts"); f.git("commit", "-m", "checks");
  const file = join(configDir, "workbench.yaml");
  const config = parse(readFileSync(file, "utf8"));
  config.extensions = {
    actions: { first: { argv: ["bun", "-e", step("first")], purpose: "verify" },
      last: { argv: ["bun", "-e", step("last")], purpose: "verify" } },
    stages: { before: { action: "first" }, after: { action: "last" } },
    verification: { stages: ["before", "verify", "after"] },
  };
  writeFileSync(file, stringify(config));
  const docs = join(configDir, "specs/task");
  mkdirSync(docs, { recursive: true });
  writeFileSync(join(docs, "scope.md"), "Check the configured stages in order.");
  f.ledger.freezeSpec({ task_id: "task" });
  const result = f.cli("verify", [], { FIXTURE_CREDENTIAL: "synthetic" });
  expect(result.exitCode, result.stderr.toString() + result.stdout.toString()).toBe(0);
  const events = readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(events.map(row => row[0])).toEqual(["first", "static", "dynamic", "last"]);
  expect(events.every(row => row[1] === events[0][1] && row[2] === null)).toBe(true);
  expect(events[0][1]).not.toBe(f.repo);
  expect(existsSync(events[0][1])).toBe(false);
  const receipt = f.evidence().at(-1);
  expect(receipt).toMatchObject({ kind: "verify", source: "tool", status: "pass", meta: { mode: "all" } });
  expect(receipt.meta.stages.map((s: { kind: string }) => s.kind)).toEqual(["verify", "lint", "test", "verify"]);
  expect(receipt.meta.stages[0].output_sha256).toBe(new Bun.CryptoHasher("sha256").update("first\n").digest("hex"));

  config.extensions.actions.first.argv = ["bun", "-e", "process.exit(9)"];
  writeFileSync(file, stringify(config));
  expect(f.cli("verify", []).exitCode).toBe(1);
  expect(f.evidence().at(-1)).toMatchObject({ kind: "verify", status: "fail", meta: { stages: [{ stage: "before", exit_code: 9 }] } });
});
