import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { executorFixture } from "./helpers/executor";

const f = executorFixture("0.5");

test("an interrupted Git comparison cannot turn identical trees into a passing review", () => {
  const base = f.head;
  f.ledger.attachRepo({task_id: "task", repo: "service", branch: "feature", base_sha: base});
  const specs = join(f.root, ".workbench/specs/task");
  mkdirSync(specs, {recursive: true});
  writeFileSync(join(specs, "scope.md"), "Review changes to the tracked content.\n");
  f.ledger.freezeSpec({task_id: "task"});
  const report = join(f.root, "quality.md");
  writeFileSync(report, "Verified tracked content.\n");
  const bin = join(f.root, "bin");
  mkdirSync(bin);
  const git = Bun.which("git");
  if (!git) throw Error("Git is required by the fixture");
  writeFileSync(join(bin, "git"), [
    "#!/bin/sh",
    'for arg do [ "$arg" != diff ] || kill -TERM "$$"; done',
    'exec "$FIXTURE_REAL_GIT" "$@"', "",
  ].join("\n"), {mode: 0o755});
  const env = {PATH: bin + delimiter + process.env.PATH, FIXTURE_REAL_GIT: git};
  function record(head: string, envOverrides: Record<string, string> = {}) {
    return f.cli("ledger", ["review-record", "task", "--role", "quality", "--base", base,
      "--head", head, "--status", "pass", "--summary", "Tracked content checked", "--report", report], envOverrides);
  }

  writeFileSync(join(f.repo, "code.txt"), "changed");
  f.git("commit", "-qm", "change tracked content", "--", "code.txt");
  const changed = f.git("rev-parse", "HEAD");
  const control = record(changed);
  expect(control.exitCode, control.stderr.toString()).toBe(0);
  f.git("revert", "--no-edit", changed);
  const sameTree = f.git("rev-parse", "HEAD");
  expect(sameTree).not.toBe(base);
  expect(f.git("rev-parse", sameTree + "^{tree}")).toBe(f.git("rev-parse", base + "^{tree}"));
  const probe = Bun.spawnSync(["git", "diff", "--quiet", base, sameTree], {cwd: f.repo, env: {...process.env, ...env}});
  expect(probe.signalCode).toBe("SIGTERM");
  const previous = f.ledger.getTaskEvents("task");
  const rejected = record(sameTree, env);
  expect(rejected.exitCode).not.toBe(0);
  expect(f.ledger.getTaskEvents("task")).toEqual(previous);
}, 20_000);

test("reviews projects the historical tool model and effort without changing the receipt", () => {
  const receipt = {task_id: "task", repo: "service", branch: "feature", sha: f.head,
    kind: "review" as const, status: "pass" as const, source: "tool" as const, actor: "tool", summary: "Historical quality review"};
  const meta = {role: "quality", base: f.head, head: f.head, report_status: "pass"};
  const recordedModel = {model: "historical-model", effort: "high"};
  // The 0.5.4 tool stored its resolved tier as meta.model.
  const known = f.ledger.recordEvidence({...receipt, meta: {...meta, model: recordedModel}});
  const unknown = f.ledger.recordEvidence({...receipt, meta});
  const previous = f.ledger.getTaskEvents("task");
  const result = f.cli("ledger", ["reviews", "task"]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const rows = JSON.parse(result.stdout.toString());
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({seq: known.seq, source: "tool", role: "quality", ...recordedModel});
  expect(rows[1]).toMatchObject({seq: unknown.seq, source: "tool", role: "quality"});
  expect(rows[1].model ?? null).toBeNull();
  expect(rows[1].effort ?? null).toBeNull();
  expect(f.ledger.getTaskEvents("task")).toEqual(previous);
});
