import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox } from "./v05-sandbox";
import { Ledger } from "../src/ledger";
import { installedInstance, verificationPolicy } from "../src/workflow-config";
import { parse, stringify } from "yaml";
import { readFileSync } from "node:fs";

test("custom delivery and verification keep the configured receipts and each reviewed range", () => {
  const s = sandbox();
  try {
    s.fresh();
    const file = join(s.work, ".workbench/workbench.yaml");
    const yaml = parse(readFileSync(file, "utf8"));
    yaml.extensions = {
      delivery: { endpoint: "rollout" },
      actions: { smoke: { argv: ["bun", "-e", "console.log('checked')"], purpose: "verify" } },
      stages: { smoke: { action: "smoke" } },
      verification: { environment: "isolated", stages: ["smoke"] },
    };
    writeFileSync(file, stringify(yaml));
    const repo = join(s.work, "service");
    mkdirSync(repo);
    const git = (...args: string[]) => s.git(repo, ...args).trim();
    git("init", "-b", "feature");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    const revisions = ["base", "middle", "head"].map(message => {
      writeFileSync(join(repo, "change.txt"), message);
      git("add", "--", "change.txt");
      git("commit", "-m", message, "--", "change.txt");
      return git("rev-parse", "HEAD");
    });
    const [base, middle, head] = revisions;
    const task = JSON.parse(s.ok([s.forge, "ledger", "open", "--id", "regression", "--title", "Regression", "--repo", "service",
      "--branch", "feature", "--depth", "targeted", "--base", base]));
    expect(task.endpoint).toBe("rollout");
    s.privateFile(".workbench/specs/regression/scope.md", "Exercise readiness.\n");
    const db = new Ledger(s.work);
    try {
      const spec = db.freezeSpec({ task_id: task.task_id }).spec;
      const bind = { task_id: task.task_id, repo: "service", branch: "feature", sha: head, source: "tool" as const, actor: "tool", summary: "fixture" };
      const check = (checkEndpoint = false) => db.checkPushReadiness({ ...bind, head_sha: head, checkEndpoint });
      const review = (base: string, status: "pass" | "fail") => db.recordEvidence({ ...bind, kind: "review", status,
        meta: { role: "quality", base, review_task_id: task.task_id, freeze_seq: spec.freeze_seq, review_floor_seq: spec.evidence_floor_seq.review } });
      review(middle, "pass");
      for (const kind of ["lint", "test"] as const) db.recordEvidence({ ...bind, kind, status: "pass" });
      expect(check().ready).toBe(false);
      const policy = verificationPolicy(s.work, "service", head, installedInstance(s.work)!);
      db.recordEvidence({ ...bind, kind: "verify", status: "pass", meta: {
        mode: "all", policy_sha256: policy, freeze_seq: spec.freeze_seq, review_task_id: task.task_id } });
      expect(check().missing.join(" ")).toContain("baseline-to-HEAD");
      db.recordEvidence({ ...bind, kind: "review", status: "pass", meta: {
        role: "quality", base, review_task_id: task.task_id, review_floor_seq: spec.evidence_floor_seq.review, freeze_seq: 0 } });
      expect(check().ready).toBe(false);
      review(base, "pass");
      expect(check().ready).toBe(true);
      db.recordEvidence({ ...bind, kind: "review", status: "fail", meta: {
        role: "business", base: middle, report_status: "incomplete", attempts: [], backend: null, missing_materials: ["spec"],
        review_task_id: task.task_id, freeze_seq: spec.freeze_seq, review_floor_seq: spec.evidence_floor_seq.review } });
      review(middle, "pass");
      expect(check().ready).toBe(false);
      db.recordEvidence({ ...bind, kind: "review", status: "pass", meta: {
        role: "business", base: middle, review_task_id: task.task_id, freeze_seq: spec.freeze_seq,
        review_floor_seq: spec.evidence_floor_seq.review } });
      expect(check().ready).toBe(true);
      const priorFormat = JSON.parse(s.ok([s.forge, "ledger", "reviews", task.task_id]));
      expect(priorFormat.filter((row: {kind: string}) => row.kind === "review_selection")).toHaveLength(1);
      const stats = JSON.parse(s.ok([s.forge, "ledger", "stats", "--json"]));
      expect(stats.reviews.business).toMatchObject({ pass: 1, fail: 0 });
      db.recordEvidence({ ...bind, kind: "review_selection", status: "info", meta: {
        role: "quality", base: middle, report_status: "incomplete", backend: null, attempts: [],
        missing_materials: ["diff"], review_task_id: task.task_id, freeze_seq: spec.freeze_seq, review_floor_seq: spec.evidence_floor_seq.review } });
      review(base, "pass");
      expect(check().missing.join(" ")).toContain("Selected review incomplete (quality)");
      expect(check().missing.join(" ")).not.toContain("latest review failed");
      review(middle, "pass");
      expect(check().ready).toBe(true);
      review(middle, "fail");
      review(base, "pass");
      expect(check().ready).toBe(false);
      review(middle, "pass");
      expect(check().ready).toBe(true);
      db.recordEvidence({ ...bind, kind: "prod", status: "pass", meta: {delivery_endpoint: "another-rollout"} });
      expect(check(true).ready).toBe(false);
      db.recordEvidence({ ...bind, kind: "prod", status: "pass", meta: {delivery_endpoint: "rollout"} });
      expect(check(true).ready).toBe(true);
      yaml.extensions.verification.environment = "second-environment";
      writeFileSync(file, stringify(yaml));
      expect(check().ready).toBe(false);
      git("commit", "--allow-empty", "-m", "second revision");
      const next = git("rev-parse", "HEAD");
      const secondCheck = () => db.checkPushReadiness({ ...bind, branch: "feature", head_sha: next });
      db.recordEvidence({ ...bind, sha: next, kind: "review", status: "pass", meta: {
        role: "quality", base, review_task_id: task.task_id, freeze_seq: spec.freeze_seq, review_floor_seq: spec.evidence_floor_seq.review } });
      db.recordEvidence({ ...bind, sha: next, kind: "verify", status: "pass", meta: {
        mode: "all", policy_sha256: verificationPolicy(s.work, "service", next, installedInstance(s.work)!),
        freeze_seq: spec.freeze_seq, review_task_id: task.task_id } });
      expect(secondCheck().ready).toBe(true);
      // A previous executor could pass a range of distinct commit IDs with identical trees.
      git("revert", "--no-commit", head, middle);
      git("commit", "-m", "restore baseline");
      const empty = git("rev-parse", "HEAD");
      expect(git("diff", "--name-only", base, empty)).toBe("");
      db.recordEvidence({ ...bind, sha: empty, kind: "verify", status: "pass", meta: {
        mode: "all", policy_sha256: verificationPolicy(s.work, "service", empty, installedInstance(s.work)!),
        freeze_seq: spec.freeze_seq, review_task_id: task.task_id } });
      db.recordEvidence({ ...bind, sha: empty, kind: "review", status: "pass", meta: {
        role: "quality", base, review_task_id: task.task_id, freeze_seq: spec.freeze_seq,
        review_floor_seq: spec.evidence_floor_seq.review } });
      expect(db.checkPushReadiness({ ...bind, head_sha: empty }).missing.join(" ")).toContain("baseline-to-HEAD");
      delete yaml.extensions.verification;
      writeFileSync(file, stringify(yaml));
      expect(secondCheck().ready).toBe(false);
      // Default verification still needs evidence of execution after a successful build.
      for (const kind of ["lint", "build"] as const)
        db.recordEvidence({ ...bind, sha: next, kind, status: "pass" });
      expect(secondCheck().ready).toBe(false);
      db.recordEvidence({ ...bind, sha: next, kind: "test", status: "pass" });
      expect(secondCheck().ready).toBe(true);
    } finally { db.closeDb(); }
  } finally { s.cleanup(); }
}, 20_000);

test("a targeted scope stays frozen through test-only and technical amendments", () => {
  const s = sandbox();
  try {
    s.fresh();
    const repo = join(s.work, "app");
    mkdirSync(repo);
    s.git(repo, "init", "-b", "feature");
    s.git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "--allow-empty", "-m", "base");
    const ledger = (...args: string[]) => s.ok([s.forge, "ledger", ...args]);
    ledger("open", "--id", "scope", "--title", "Scope lock", "--repo", "app", "--branch", "feature", "--depth", "targeted");
    const original = "Deliver the approved scope.";
    const file = s.privateFile(".workbench/specs/scope/scope.md", original);
    const freeze = () => JSON.parse(ledger("freeze", "scope")).spec.hashes.scope;
    const amend = (scope: string) => ledger("amend", "scope", "--scope", scope, "--reason", "Exercise " + scope);
    const locked = () => s.hook("PreToolUse", {tool_name: "Bash", tool_input: {
      command: "echo changed >> .workbench/specs/scope/scope.md",
    }}).some(reply => reply.text.includes("冻结 Spec 保护"));
    let digest = freeze();
    for (const scope of ["test_spec", "tech_spec"]) {
      amend(scope);
      expect(locked()).toBe(true);
      writeFileSync(file, "Replace entire task.");
      const failed = s.run([s.forge, "ledger", "freeze", "scope"]);
      expect(failed.code).not.toBe(0);
      expect(failed.err + failed.out).toContain("out-of-scope spec document(s) changed (.workbench/specs/scope/scope.md)");
      writeFileSync(file, original);
      expect(freeze()).toBe(digest);
    }
    for (const scope of ["requirement", "invariant"]) {
      amend(scope);
      expect(locked()).toBe(false);
      writeFileSync(file, "Authorized " + scope);
      const next = freeze();
      expect(next).not.toBe(digest);
      digest = next;
      expect(locked()).toBe(true);
    }
  } finally { s.cleanup(); }
});
