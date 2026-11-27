import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { Ledger } from "../src/ledger";
import { digest } from "./helpers/historical-kit";
import { kit, legacyRevision, sandbox, type Sandbox } from "./v05-sandbox";

let source: Sandbox, s: Sandbox, app: string, base: string, head: string;

// Use the 0.4.1 task and executor writers to retain the exact historical event format.
beforeAll(() => {
  source = sandbox();
  const tar = join(source.root, "0.4.1.tar");
  if (process.env.FORGE_V04_TEST_ARCHIVE) copyFileSync(process.env.FORGE_V04_TEST_ARCHIVE, tar);
  else source.git(kit, "--no-replace-objects", "-c", "core.attributesFile=/dev/null", "-c", "tar.umask=0002",
    "archive", "--format=tar", "--output", tar, legacyRevision);
  expect(digest(tar)).toBe("0fb9dc3bab1714fcdf54e514e46561e4ceca516784301bd98efb00e6e9355468");
  source.ok(["tar", "-xf", tar, "-C", source.work]);
  symlinkSync(join(kit, "node_modules"), join(source.work, "node_modules"));
});
afterAll(() => source.cleanup());
beforeEach(() => {
  s = sandbox();
  s.env.FORGE_WORKBENCH_ROOT = s.work;
  s.privateFile(".workbench/workbench.yaml", "name: legacy\nrepos: [app]\n");
  app = join(s.work, "app");
  mkdirSync(app);
  s.git(app, "init", "-b", "feature");
  s.git(app, "config", "user.name", "Fixture");
  s.git(app, "config", "user.email", "fixture@example.invalid");
  base = change("baseline");
  head = change("delivery revision");
  const oldLedger = ["bun", join(source.work, "src/bin/ledger.ts")];
  s.ok([...oldLedger, "open", "--id", "active", "--title", "Legacy delivery", "--repo", "app",
    "--branch", "feature", "--worktree", app, "--endpoint", "local", "--depth", "full", "--base", base, "--head", head]);
  for (const name of ["ssot", "tech-spec", "test-spec"])
    s.privateFile(".workbench/specs/active/" + name + ".md", "Review the committed change.\n");
  s.ok([...oldLedger, "freeze", "active"]);
});
afterEach(() => s.cleanup());

function change(contents: string) {
  s.privateFile("app/value.txt", contents);
  s.git(app, "add", "--", "value.txt");
  s.git(app, "commit", "-qm", contents, "--", "value.txt");
  return s.git(app, "rev-parse", "HEAD").trim();
}
function oldReview(status: "pass" | "findings") {
  s.env.FORGE_REVIEW_AGENTS_DIR = join(s.work, "role-fixture");
  // Only the provider output is synthetic. The old executor verifies the range and records its own evidence.
  s.privateFile("role-fixture/dist/review-quality.js", `
    const args = process.argv.slice(2);
    const get = key => args[args.indexOf(key) + 1];
    const status = ${JSON.stringify(status)};
    const findings = status === "findings" ? [{title: "Incorrect value", path: "value.txt", line: 1, recommendation: "Repair the value"}] : [];
    await Bun.write(get("--out"), JSON.stringify({role: "quality", repo: get("--repo"), base: get("--base"),
      head: get("--head"), reviewTaskId: get("--task-id"), reviewFloorSeq: Number(get("--floor-seq")),
      status, findings}));
    process.exitCode = findings.length ? 1 : 0;
  `);
  const result = s.run(["bun", join(source.work, "src/bin/forge-review.ts"), "--cwd", app,
    "--task", "active", "--roles", "quality", "--no-fallback"], app);
  expect(result.code, result.out + result.err).toBe(status === "pass" ? 0 : 1);
  expect(JSON.parse(result.out).roles[0]).toMatchObject({status: status === "pass" ? "pass" : "fail",
    meta: {report_status: status, role: "quality", base, head}});
}
const current = () => ["bun", join(kit, "src/bin/cli.ts"), "ledger"];
function native(role: string, summary: string) {
  const report = s.privateFile(".workbench/runs/active/" + summary + ".md", summary + "\n");
  s.ok([...current(), "review-record", "active", "--role", role, "--status", "pass", "--base", base,
    "--head", head, "--summary", summary, "--report", report]);
}
function checks() {
  const db = new Ledger(s.work);
  try {
    for (const kind of ["lint", "test"] as const)
      db.recordEvidence({task_id: "active", repo: "app", branch: "feature", sha: head, source: "tool",
        kind, status: "pass", summary: "Fixture " + kind});
  } finally { db.closeDb(); }
}
function expectClose(allowed: boolean) {
  const db = new Ledger(s.work);
  try {
    const readiness = db.checkPushReadiness({task_id: "active", repo: "app", branch: "feature", head_sha: head, checkEndpoint: true});
    const close = s.run([...current(), "close", "active", "--no-archive"]);
    expect(readiness.ready, readiness.missing.join(", ")).toBe(allowed);
    expect(close.code === 0, close.out + close.err).toBe(allowed);
    expect(db.getTask("active")?.status).toBe(allowed ? "CLOSED" : "OPEN");
  } finally { db.closeDb(); }
}

for (const advance of [false, true]) test("native reassessment of a 0.4 tool failure " + (advance ? "after a fix" : "at the same HEAD"), () => {
  oldReview("findings");
  const history = () => JSON.parse(s.ok([...current(), "reviews", "active"]));
  const original = history()[0];
  expect(original).toMatchObject({role: "quality", source: "tool", status: "findings", base, head});
  if (advance) head = change("fix the quality finding");
  checks();
  native("quality", "Reviewed the full range");
  expectClose(false);
  native("quality", "Verified the original finding #" + original.seq);
  expectClose(true);
  expect(history()[0]).toEqual(original);
}, 20_000);

test("the old tool can retry its own failure on the same range", () => {
  oldReview("findings");
  oldReview("pass");
  checks();
  expectClose(true);
}, 20_000);

test("a native business pass can close a full 0.4 task", () => {
  checks();
  expectClose(false);
  native("business", "Reviewed the business behavior");
  expectClose(true);
}, 20_000);

test("a 0.4 task can close on a later tool-reviewed HEAD with an earlier failure in its history", () => {
  const originalHead = head;
  oldReview("findings");
  head = change("repair the value before the historical tool reruns");
  oldReview("pass");
  checks();
  expectClose(true);
  const reviews = JSON.parse(s.ok([...current(), "reviews", "active"]));
  expect(reviews).toMatchObject([
    {role: "quality", source: "tool", status: "findings", base, head: originalHead},
    {role: "quality", source: "tool", status: "pass", base, head},
  ]);
}, 20_000);
