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
      git("commit", "--allow-empty", "-m", message);
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
        meta: { role: "quality", base, review_task_id: task.task_id, review_floor_seq: spec.freeze_seq } });
      review(base, "pass");
      for (const kind of ["lint", "test"] as const) db.recordEvidence({ ...bind, kind, status: "pass" });
      expect(check().ready).toBe(false);
      const policy = verificationPolicy(installedInstance(s.work)!);
      db.recordEvidence({ ...bind, kind: "verify", status: "pass", meta: {
        mode: "all", policy_sha256: policy, freeze_seq: spec.freeze_seq, review_task_id: task.task_id } });
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
        role: "quality", base, review_task_id: task.task_id, review_floor_seq: spec.freeze_seq } });
      db.recordEvidence({ ...bind, sha: next, kind: "verify", status: "pass", meta: {
        mode: "all", policy_sha256: verificationPolicy(installedInstance(s.work)!),
        freeze_seq: spec.freeze_seq, review_task_id: task.task_id } });
      expect(secondCheck().ready).toBe(true);
      delete yaml.extensions.verification;
      writeFileSync(file, stringify(yaml));
      expect(secondCheck().ready).toBe(false);
    } finally { db.closeDb(); }
  } finally { s.cleanup(); }
});
