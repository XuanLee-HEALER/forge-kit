import { isolateHome } from "./helpers/hermetic";
import { nativeReview } from "./helpers/native-review";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger";
import { evidenceSource } from "../src/ledger/types";

isolateHome();

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "forge-ledger-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fixtureHistory(repo: string, branch: string) {
  const path = join(dir, repo);
  mkdirSync(path);
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", path, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.org", ...args]);
    expect(r.exitCode).toBe(0);
    return r.stdout.toString().trim();
  };
  git("init", "-b", branch);
  git("commit", "--allow-empty", "-m", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(path, "change.txt"), "feature change");
  git("add", "--", "change.txt");
  git("commit", "-m", "head");
  return { base, head: git("rev-parse", "HEAD") };
}

function freezeFixture(ledger: Ledger, task_id: string) {
  const specs = join(dir, ".workbench/specs", task_id);
  mkdirSync(specs, { recursive: true });
  for (const document of ["ssot", "tech-spec", "test-spec"])
    writeFileSync(join(specs, document + ".md"), "Exercise the ledger workflow.");
  ledger.freezeSpec({ task_id });
}

describe("SQLite WAL Hash-Chained Ledger", () => {
  test.each(["tool", "hook", "operator"])("legacy evidence uses the recorded actor %s", actor => {
    expect(evidenceSource({}, actor)).toBe(actor === "operator" ? "manual" : actor);
    expect(evidenceSource({ source: "manual" }, actor)).toBe("manual");
  });

  test("unlabelled receipts follow the sole attachment at the time of recording", () => {
    const ledger = new Ledger(dir);
    const task_id = "legacy-branch";
    const repo = "svc";
    const { base, head: sha } = fixtureHistory(repo, "feat");
    const branch = Bun.spawnSync(["git", "-C", join(dir, repo), "branch", "sibling"]);
    expect(branch.exitCode).toBe(0);
    const record = (branch: string | null, status: "pass" | "fail") =>
      ledger.recordEvidence({ task_id, repo, sha, branch, kind: "test", status, source: "hook", summary: "test" });
    const ready = () => ledger.checkPushReadiness({ task_id, repo, branch: "feat", head_sha: sha }).ready;
    try {
      ledger.openTask({ workflow_version: "0.4", task_id, title: task_id, endpoint: "local", depth: "targeted", repo, branch: "feat", base_sha: base, head_sha: sha });
      freezeFixture(ledger, task_id);
      nativeReview(ledger, task_id, { repo, branch: "feat", base, head: sha });
      record(null, "fail");
      expect(ready()).toBe(false);
      record("feat", "pass");
      expect(ready()).toBe(true);
      record(null, "fail");
      expect(ready()).toBe(false);
      ledger.attachRepo({ task_id, repo, branch: "sibling", base_sha: base, head_sha: sha });
      record("sibling", "pass");
      record(null, "pass");
      expect(ready()).toBe(false);
      ledger.detachRepo({ task_id, repo, branch: "sibling" });
      expect(ready()).toBe(false);
      record(null, "pass");
      expect(ready()).toBe(true);
    } finally {
      ledger.closeDb();
    }
  });

  test("manual executable results cannot satisfy delivery even with a trusted-looking actor", () => {
    const ledger = new Ledger(dir);
    const task_id = "manual-only";
    try {
      ledger.openTask({ workflow_version: "0.4", task_id, title: task_id, endpoint: "local", depth: "full", repo: "svc", branch: "feat", head_sha: "abcdef00" });
      for (const kind of ["lint", "test", "hurl", "build", "review"] as const) {
        ledger.recordEvidence({ task_id, kind, actor: "hook", repo: "svc", sha: "abcdef00", status: "pass", summary: "attested" });
      }
      expect(ledger.formatCompactContext()).toContain("[manual]");
      const state = ledger.checkPushReadiness({ task_id, repo: "svc", head_sha: "abcdef00" });
      expect(state.ready).toBe(false);
      expect(state.recordedReviewRoles).toEqual([]);
      expect(() => ledger.closeTask({ task_id })).toThrow("missing completion evidence");
    } finally { ledger.closeDb(); }
  });

  test("root attachment keeps its frozen file identity across status and re-freeze", () => {
    const root = join(dir, "workspace");
    fixtureHistory("workspace", "main");
    const ledger = new Ledger(root);
    const task_id = "root-lock";
    try {
      const file = "tests/contract.ts";
      mkdirSync(join(root, "tests"));
      writeFileSync(join(root, file), "original");
      const docs = join(root, ".workbench/specs", task_id);
      mkdirSync(docs, {recursive: true});
      writeFileSync(join(docs, "scope.md"), "Root CLI contract");
      ledger.openTask({task_id, title: task_id, endpoint: "local", depth: "targeted", repo: ".", branch: "main"});
      ledger.freezeSpec({task_id, locked_test_globs: [file]});
      const frozen = ledger.getSpecState(task_id);
      expect(Object.keys(frozen.locked_test_files)).toEqual(["./" + file]);
      expect(frozen.drifted_locked_tests).toEqual([]);
      expect(ledger.freezeSpec({task_id}).spec.drifted_locked_tests).toEqual([]);
      writeFileSync(join(root, file), "changed");
      expect(ledger.getSpecState(task_id).drifted_locked_tests).toEqual(["./" + file]);
    } finally { ledger.closeDb(); }
  });

  test("locks matching tests on disk and in Git until an authorized amendment is frozen", () => {
    const ledger = new Ledger(dir);
    const task_id = "locked-digests";
    const repo = join(dir, "svc");
    mkdirSync(repo);
    const git = (...args: string[]) => {
      const r = Bun.spawnSync(["git", ...args], { env: process.env, cwd: repo });
      expect(r.exitCode).toBe(0);
      return r.stdout.toString().trim();
    };
    const file = join(repo, "suite.hurl");
    const commit = (message: string) => { git("add", "."); git("commit", "-m", message); return git("rev-parse", "HEAD"); };
    try {
      git("init", "-b", "feat"); git("config", "user.name", "Dev"); git("config", "user.email", "dev@example.com");
      const child = join(dir, "contract-repo");
      git("init", "-b", "main", child);
      git("-C", child, "config", "user.name", "Dev");
      git("-C", child, "config", "user.email", "dev@example.com");
      writeFileSync(join(child, "api.hurl"), "contract");
      git("-C", child, "add", "api.hurl");
      git("-C", child, "commit", "-m", "submodule contract");
      git("-c", "protocol.file.allow=always", "submodule", "add", child, "contracts");
      writeFileSync(join(repo, ".gitattributes"), "*.hurl text eol=crlf\n");
      writeFileSync(file, "original\r\n");
      let head = commit("initial");
      const reviewBase = head;
      writeFileSync(join(repo, "new-contract.hurl"), "pending\r\n");
      ledger.openTask({ workflow_version: "0.4", task_id, title: task_id, endpoint: "local", depth: "targeted", repo: "svc", worktree: repo, branch: "feat", base_sha: reviewBase, head_sha: head });
      const docs = join(dir, ".workbench/specs", task_id);
      mkdirSync(docs, { recursive: true });
      for (const doc of ["ssot", "tech-spec", "test-spec"]) writeFileSync(join(docs, doc + ".md"), doc);
      ledger.attachRepo({ task_id, repo: "contract-repo", branch: "main" });
      const frozen = ledger.freezeSpec({ task_id, locked_test_globs: ["*.hurl"] }).spec;
      expect(frozen.locked_test_files["contract-repo/api.hurl"]).toBeDefined();
      ledger.detachRepo({ task_id, repo: "contract-repo", branch: "main", reason: "delivered separately" });
      expect(ledger.getSpecState(task_id).drifted_locked_tests).toEqual([]);
      expect(frozen.locked_test_files["svc/contracts/api.hurl"]).toMatch(/^[a-f0-9]{64}$/);
      expect(frozen.locked_test_files["svc/suite.hurl"]).toMatch(/^[a-f0-9]{64}$/);
      expect(ledger.checkPushReadiness({ task_id, repo: "svc", head_sha: head }).missing.join(" ")).toContain("new-contract.hurl");
      expect(() => ledger.closeTask({ task_id })).toThrow("new-contract.hurl");
      head = commit("include frozen contract");
      ledger.freezeSpec({ task_id });
      git("-C", child, "rm", "api.hurl");
      git("-C", child, "commit", "-m", "delete detached contract");
      ledger.attachRepo({ task_id, repo: "contract-repo", branch: "main" });
      expect(ledger.checkPushReadiness({ task_id, repo: "contract-repo", head_sha: git("-C", child, "rev-parse", "HEAD") }).missing.join(" ")).toContain("contract-repo/api.hurl");
      ledger.detachRepo({ task_id, repo: "contract-repo", branch: "main", reason: "continue work" });
      git("rm", "new-contract.hurl");
      git("commit", "-m", "omit contract");
      writeFileSync(join(repo, "new-contract.hurl"), "pending\r\n");
      expect(ledger.getSpecState(task_id).drifted_locked_tests).toContain("svc/new-contract.hurl");
      expect(ledger.checkPushReadiness({ task_id, repo: "svc", head_sha: git("rev-parse", "HEAD") }).missing.join(" ")).toContain("new-contract.hurl");
      git("reset", "--hard", head);
      const detached = join(dir, "detached");
      git("worktree", "add", "--detach", detached, head);
      git("-C", detached, "-c", "protocol.file.allow=always", "submodule", "update", "--init");
      writeFileSync(join(detached, "suite.hurl"), "changed in delivery checkout");
      const merged = ledger.checkPushReadiness({ task_id, repo: "svc", head_sha: head, checkoutDir: detached });
      expect(merged.hasExplicitFailure).toBe(true);
      expect(merged.missing.join(" ")).toContain("suite.hurl");
      const drift = () => ledger.getSpecState(task_id).drifted_locked_tests;
      git("checkout", "--detach", head);
      const moved = join(dir, "moved");
      git("worktree", "add", moved, "feat");
      git("-C", moved, "-c", "protocol.file.allow=always", "submodule", "update", "--init");
      writeFileSync(join(moved, "suite.hurl"), "changed after checkout moved");
      expect(drift()).toEqual(["svc/suite.hurl"]);
      git("worktree", "remove", "--force", moved);
      git("checkout", "feat");
      for (const action of [() => writeFileSync(file, "modified"), () => rmSync(file)]) {
        action();
        expect(drift()).toEqual(["svc/suite.hurl"]);
        expect(ledger.checkPushReadiness({ task_id, repo: "svc", head_sha: head }).missing.join(" ")).toContain("冻结测试");
        expect(() => ledger.closeTask({ task_id })).toThrow("冻结测试");
        expect(() => ledger.freezeSpec({ task_id })).toThrow("冻结测试");
        writeFileSync(file, "original\r\n");
      }
      writeFileSync(join(repo, "added.hurl"), "added");
      expect(drift()).toEqual(["svc/added.hurl"]);
      rmSync(join(repo, "added.hurl"));
      writeFileSync(file, "committed change");
      let next = commit("revise contract");
      git("checkout", "-B", "feat", head);
      const delivery = ledger.checkPushReadiness({ task_id, repo: "svc", head_sha: next });
      expect(delivery.hasExplicitFailure).toBe(true);
      expect(delivery.missing.join(" ")).toContain("svc/suite.hurl");
      git("reset", "--hard", next);
      writeFileSync(file, "original\r\n");
      expect(drift()).toEqual(["svc/suite.hurl"]);
      ledger.amendSpec({ task_id, scope: "test_spec", reason: "approved contract change" });
      writeFileSync(file, "authorized working change");
      expect(ledger.freezeSpec({ task_id }).spec.drifted_locked_tests).toContain("svc/suite.hurl");
      expect(ledger.checkPushReadiness({ task_id, repo: "svc", head_sha: next }).missing.join(" ")).toContain("suite.hurl");
      next = commit("publish authorized contract");
      expect(ledger.getSpecState(task_id).drift_detected).toBe(false);
      ledger.recordEvidence({
        task_id, kind: "test", status: "pass", source: "tool", repo: "svc", sha: next, summary: "verified",
      });
      nativeReview(ledger, task_id, { repo: "svc", branch: "feat", base: reviewBase, head: next });
      ledger.recordEvidence({ task_id, source: "hook", kind: "commit", status: "pass", repo: "svc", branch: "feat", sha: next, summary: "committed" });
      ledger.updateEndpoint({ task_id, endpoint: "fat", reason: "FAT delivery" });
      ledger.recordEvidence({ task_id, kind: "fat", status: "pass", repo: "svc", sha: next, summary: "accepted" });
      git("update-ref", "refs/remotes/origin/fat", next);
      git("checkout", "-b", "main", next);
      git("branch", "-D", "feat");
      git("submodule", "deinit", "-f", "contracts");
      writeFileSync(file, "unexpected change");
      expect(ledger.closeTask({ task_id, archive: false }).task.status).toBe("CLOSED");
    } finally { ledger.closeDb(); }
  }, 20000);

  test("full lifecycle: unique branch ownership, multi-repo attach, decisions, idempotent blockers, latest-status readiness, close & archive", () => {
    const canvas = fixtureHistory("canvas", "fix/audio-billing"), web = fixtureHistory("web-app", "fix/audio-billing");
    const ledger = new Ledger(dir);
    try {
      const opened = ledger.openTask({ workflow_version: "0.4",
        task_id: "20261121-audio-billing",
        title: "Audio billing settlement fix",
        endpoint: "fat",
        depth: "full",
        repo: "canvas",
        branch: "fix/audio-billing",
        base_sha: canvas.base,
        head_sha: canvas.head,
      });
      expect(opened.task.status).toBe("OPEN");
      expect(opened.event.prev_hash).toBe("GENESIS");

      // Second OPEN task cannot claim the SAME (repo, branch)!
      expect(() =>
        ledger.openTask({ workflow_version: "0.4",
          task_id: "20261121-conflict",
          title: "Conflicting owner",
          endpoint: "local",
          depth: "targeted",
          repo: "canvas",
          branch: "fix/audio-billing",
        }),
      ).toThrow("already owned by OPEN task");

      // Attach second repo to the SAME task
      ledger.attachRepo({
        task_id: "20261121-audio-billing",
        repo: "web-app",
        branch: "fix/audio-billing",
        base_sha: web.base,
        head_sha: web.head,
      });

      // Empty/unverified task CANNOT silently close!
      expect(() =>
        ledger.closeTask({ task_id: "20261121-audio-billing" }),
      ).toThrow("missing completion evidence");

      // Decision & superseding decision: compact context hides superseded decision
      const d1 = ledger.recordDecision({
        task_id: "20261121-audio-billing",
        key: "rounding",
        summary: "round up to integer credits",
      });
      ledger.recordDecision({
        task_id: "20261121-audio-billing",
        key: "rounding",
        summary: "bankers rounding per billing spec",
        supersedes_seq: d1.seq,
      });
      const ctx = ledger.formatCompactContext();
      expect(ctx).toContain("bankers rounding");
      expect(ctx).not.toContain("round up to integer credits");

      // Blocker ID tracking: cannot double-open or close unknown/closed blocker
      ledger.recordBlocker({
        task_id: "20261121-audio-billing",
        action: "open",
        blocker_id: "B1",
        summary: "refund path missing server authority check",
      });
      expect(() =>
        ledger.recordBlocker({
          task_id: "20261121-audio-billing",
          action: "open",
          blocker_id: "B1",
          summary: "dup",
        }),
      ).toThrow("already OPEN");
      expect(() =>
        ledger.recordBlocker({
          task_id: "20261121-audio-billing",
          action: "close",
          blocker_id: "NOPE",
          summary: "ghost",
        }),
      ).toThrow("not found");
      ledger.recordBlocker({
        task_id: "20261121-audio-billing",
        action: "close",
        blocker_id: "B1",
        summary: "verified server authority",
      });
      expect(() =>
        ledger.recordBlocker({
          task_id: "20261121-audio-billing",
          action: "close",
          blocker_id: "B1",
          summary: "double close",
        }),
      ).toThrow("already CLOSED");

      // Pass then FAIL on same SHA revokes readiness!
      ledger.recordEvidence({
        source: "tool",
        task_id: "20261121-audio-billing",
        kind: "test",
        status: "pass",
        summary: "go test pass 1",
        repo: "canvas",
        branch: "fix/audio-billing",
        sha: canvas.head,
      });
      ledger.recordEvidence({
        source: "tool",
        task_id: "20261121-audio-billing",
        kind: "test",
        status: "fail",
        summary: "go test fail 2",
        repo: "canvas",
        branch: "fix/audio-billing",
        sha: canvas.head,
      });
      expect(
        ledger.checkPushReadiness({
          task_id: "20261121-audio-billing",
          repo: "canvas",
          head_sha: canvas.head,
        }).ready,
      ).toBe(false);

      // Re-pass executable checks and register each branch review before FAT delivery.
      freezeFixture(ledger, "20261121-audio-billing");
      for (const [repo, sha] of [
        ["canvas", canvas.head],
        ["web-app", web.head],
      ] as const) {
        ledger.recordEvidence({
          source: "tool",
          task_id: "20261121-audio-billing",
          kind: "test",
          status: "pass",
          summary: "tests pass",
          repo,
          branch: "fix/audio-billing",
          sha,
        });
        ledger.recordEvidence({
          source: "tool",
          task_id: "20261121-audio-billing",
          kind: "lint",
          status: "pass",
          summary: "static check pass",
          repo,
          branch: "fix/audio-billing",
          sha,
        });
        nativeReview(ledger, "20261121-audio-billing", {
          repo, branch: "fix/audio-billing", head: sha, base: repo === "canvas" ? canvas.base : web.base,
        });
      }

      // FAT endpoint cannot close until FAT/Hurl delivery evidence is recorded!
      expect(() =>
        ledger.closeTask({ task_id: "20261121-audio-billing" }),
      ).toThrow('endpoint "fat" requires recorded fat delivery evidence');

      for (const [repo, sha] of [
        ["canvas", canvas.head],
        ["web-app", web.head],
      ] as const) {
        ledger.recordEvidence({
          source: "tool",
          task_id: "20261121-audio-billing",
          kind: "fat",
          status: "pass",
          summary: "FAT deployed & Hurl verified",
          repo,
          branch: "fix/audio-billing",
          sha,
        });
      }

      // Zero-repo dev task cannot close without --force-incomplete
      ledger.openTask({ workflow_version: "0.4",
        task_id: "20261121-empty-dev",
        title: "Empty dev task",
        endpoint: "pr",
        depth: "targeted",
      });
      expect(() => ledger.closeTask({ task_id: "20261121-empty-dev" })).toThrow(
        "has no attached repository",
      );
      ledger.cancelTask({ task_id: "20261121-empty-dev", reason: "test cleanup" });

      // FTS5 query respects repo & status filters!
      const ftsMatch = ledger.query({ q: "bankers", repo: "canvas", status: "OPEN" });
      expect(ftsMatch.events.length).toBe(1);
      const ftsMiss = ledger.query({ q: "bankers", repo: "other-repo", status: "OPEN" });
      expect(ftsMiss.events.length).toBe(0);

      // Close & archive succeeds now that both repos are verified!
      const closed = ledger.closeTask({
        task_id: "20261121-audio-billing",
        summary: "Verified in FAT and shipped",
      });
      expect(closed.task.status).toBe("CLOSED");
      expect(closed.archivePath && existsSync(closed.archivePath)).toBe(true);
      const md = readFileSync(closed.archivePath!, "utf8");
      expect(md).toContain(closed.task.tip_hash);

      // Verify full hash chain + unknown task check
      const v = ledger.verify();
      expect(v.ok).toBe(true);
      expect(ledger.verify("non-existent-id").ok).toBe(false);
    } finally {
      ledger.closeDb();
    }
  });

  test("investigation task can close without build/test; force-incomplete requires reason", () => {
    const ledger = new Ledger(dir);
    try {
      ledger.openTask({ workflow_version: "0.4",
        task_id: "20261121-inv",
        title: "Root cause analysis",
        endpoint: "investigation",
        depth: "targeted",
      });
      expect(ledger.closeTask({ task_id: "20261121-inv", archive: false }).task.status).toBe(
        "CLOSED",
      );

      ledger.openTask({ workflow_version: "0.4",
        task_id: "20261121-partial",
        title: "Partial close test",
        endpoint: "local",
        depth: "targeted",
        repo: "svc",
        branch: "feat/x",
        head_sha: "11112222",
      });
      expect(() =>
        ledger.closeTask({ task_id: "20261121-partial", forceIncomplete: true }),
      ).toThrow("--reason");
      expect(
        ledger.closeTask({
          task_id: "20261121-partial",
          forceIncomplete: true,
          forceReason: "handed off to user",
          archive: false,
        }).task.status,
      ).toBe("CLOSED");
    } finally {
      ledger.closeDb();
    }
  });

  test("DB trigger blocks UPDATE and verify() catches raw tampering", () => {
    const ledger = new Ledger(dir);
    try {
      ledger.openTask({ workflow_version: "0.4",
        task_id: "20261121-tamper-test",
        title: "Tamper check",
        endpoint: "local",
        depth: "targeted",
      });
      expect(() =>
        ledger.db.exec(
          "UPDATE events SET payload_json = '{\"hacked\":true}' WHERE seq = 1;",
        ),
      ).toThrow("immutable");

      ledger.db.exec("DROP TRIGGER trg_events_no_update;");
      ledger.db.exec(
        "UPDATE events SET payload_json = '{\"hacked\":true}' WHERE seq = 1;",
      );
      const v = ledger.verify();
      expect(v.ok).toBe(false);
      expect(v.errors.some((e) => e.includes("entry_hash tampered"))).toBe(true);
    } finally {
      ledger.closeDb();
    }
  });

  test("per-task hash chains allow physical pruning without breaking active chains", () => {
    const ledger = new Ledger(dir);
    try {
      ledger.openTask({ workflow_version: "0.4",
        task_id: "20250101-old-task",
        title: "Old investigation",
        endpoint: "investigation",
        depth: "targeted",
      });
      ledger.closeTask({ task_id: "20250101-old-task", archive: false });
      ledger.db
        .query("UPDATE tasks SET closed_at = '2025-01-02T00:00:00.000Z' WHERE task_id = ?")
        .run("20250101-old-task");

      ledger.openTask({ workflow_version: "0.4",
        task_id: "20261121-active-task",
        title: "Current open task",
        endpoint: "pr",
        depth: "targeted",
      });

      const applied = ledger.prune({ beforeDays: 90, apply: true });
      expect(applied.deleted).toEqual(["20250101-old-task"]);
      expect(ledger.verify().ok).toBe(true);
      expect(ledger.verify().checked_tasks).toBe(1);
    } finally {
      ledger.closeDb();
    }
  });

  test("prune selects candidates after a concurrent reopen commits before the write lock", () => {
    const ledger = new Ledger(dir);
    const other = new Ledger(dir);
    try {
      for (const id of ["old-closed", "old-reopened"]) {
        ledger.openTask({ workflow_version: "0.4", task_id: id, title: id, endpoint: "investigation", depth: "targeted" });
        ledger.closeTask({ task_id: id, archive: false });
      }
      ledger.db.exec("UPDATE tasks SET closed_at = '2000-01-01'");
      const exec = ledger.db.exec.bind(ledger.db);
      ledger.db.exec = (sql, ...bindings) => {
        if (sql === "BEGIN IMMEDIATE;") other.reopenTask({ task_id: "old-reopened" });
        return exec(sql, ...bindings);
      };
      const result = ledger.prune({ apply: true, beforeDays: 90 });
      expect(result.candidates).toEqual(["old-closed"]);
      expect(result.deleted).toEqual(["old-closed"]);
      expect(other.getTask("old-reopened")?.status).toBe("OPEN");
    } finally {
      other.closeDb();
      ledger.closeDb();
    }
  });

  test("concurrent subprocess writes serialize cleanly under SQLite WAL", async () => {
    const ledger = new Ledger(dir);
    ledger.openTask({ workflow_version: "0.4",
      task_id: "20261121-concurrent",
      title: "Concurrency stress",
      endpoint: "local",
      depth: "targeted",
    });
    ledger.closeDb();

    const ledgerSrc = join(import.meta.dir, "..", "src", "bin", "cli.ts");
    const procs = Array.from({ length: 8 }, (_, i) =>
      Bun.spawn(
        [
          process.execPath,
          ledgerSrc,
          "ledger",
          "record",
          "20261121-concurrent",
          "--kind",
          "note",
          "--status",
          "info",
          "--summary",
          `worker-${i}`,
        ],
        {
          env: { ...process.env, FORGE_WORKBENCH_ROOT: dir },
          stdout: "pipe",
          stderr: "pipe",
        },
      ),
    );
    const codes = await Promise.all(procs.map((p) => p.exited));
    expect(codes.every((c) => c === 0)).toBe(true);

    const check = new Ledger(dir);
    try {
      expect(check.getTaskEvents("20261121-concurrent").length).toBe(9);
      expect(check.verify().ok).toBe(true);
    } finally {
      check.closeDb();
    }
  });

  test("closeTask verifies LIVE git branch HEAD so unrecorded commits cannot close with stale evidence", () => {
    const repoPath = join(dir, "live-svc");
    const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    const { runGit } = require("../src/git") as typeof import("../src/git");
    mkdirSync(repoPath, { recursive: true });
    runGit(repoPath, ["init", "-b", "main"]);
    runGit(repoPath, ["config", "user.email", "dev@example.com"]);
    runGit(repoPath, ["config", "user.name", "Dev"]);
    runGit(repoPath, ["commit", "--allow-empty", "-m", "chore: baseline"]);
    const start = runGit(repoPath, ["rev-parse", "HEAD"]).stdout.trim();
    writeFileSync(join(repoPath, "a.ts"), "export const v = 1;\n");
    runGit(repoPath, ["add", "a.ts"]);
    runGit(repoPath, ["commit", "-m", "chore: init"]);
    runGit(repoPath, ["checkout", "-b", "feat/live-check"]);
    const sha1 = runGit(repoPath, ["rev-parse", "HEAD"]).stdout.trim();

    const ledger = new Ledger(dir);
    try {
      ledger.openTask({ workflow_version: "0.4",
        task_id: "20261121-live",
        title: "Live HEAD close check",
        endpoint: "local",
        depth: "targeted",
        repo: "live-svc",
        branch: "feat/live-check",
        base_sha: start,
        head_sha: sha1,
      });
      freezeFixture(ledger, "20261121-live");
      ledger.recordEvidence({
        source: "tool",
        task_id: "20261121-live",
        kind: "test",
        status: "pass",
        summary: "bun test",
        repo: "live-svc",
        branch: "feat/live-check",
        sha: sha1,
      });
      nativeReview(ledger, "20261121-live", { repo: "live-svc", branch: "feat/live-check", base: start, head: sha1 });
      expect(ledger.checkPushReadiness({ task_id: "20261121-live", repo: "live-svc", head_sha: sha1 }).ready).toBe(true);

      // Now make an UNRECORDED new commit on feat/live-check!
      writeFileSync(join(repoPath, "a.ts"), "export const v = 2;\n");
      runGit(repoPath, ["add", "a.ts"]);
      runGit(repoPath, ["commit", "-m", "feat: unrecorded commit"]);
      const sha2 = runGit(repoPath, ["rev-parse", "HEAD"]).stdout.trim();

      // closeTask MUST check live sha2 and REJECT stale evidence from sha1!
      expect(() => ledger.closeTask({ task_id: "20261121-live" })).toThrow(
        sha2.slice(0, 8),
      );

      // Missing/unresolvable live branch on an existing repo MUST ALSO fail closed!
      ledger.openTask({ workflow_version: "0.4",
        task_id: "20261121-missing-branch",
        title: "Missing branch close check",
        endpoint: "fat",
        depth: "targeted",
        repo: "live-svc",
        branch: "feat/does-not-exist",
        base_sha: start,
        head_sha: sha1,
      });
      ledger.recordEvidence({
        source: "tool",
        task_id: "20261121-missing-branch",
        kind: "test",
        status: "pass",
        summary: "bun test",
        repo: "live-svc",
        branch: "feat/does-not-exist",
        sha: sha1,
      });
      ledger.recordEvidence({
        source: "tool",
        task_id: "20261121-missing-branch",
        kind: "hurl",
        status: "pass",
        summary: "hurl pass",
        repo: "live-svc",
        branch: "feat/does-not-exist",
        sha: sha1,
      });
      expect(() => ledger.closeTask({ task_id: "20261121-missing-branch" })).toThrow(
        "could not be resolved on disk",
      );

      // Local Hurl verifies the revision. FAT acceptance has its own latest result.
      ledger.openTask({ workflow_version: "0.4",
        task_id: "20261121-fat-revoke",
        title: "FAT failure revokes earlier pass",
        endpoint: "fat",
        depth: "targeted",
        repo: "live-svc",
        branch: "main",
        base_sha: start,
        head_sha: sha1,
      });
      freezeFixture(ledger, "20261121-fat-revoke");
      ledger.recordEvidence({
        source: "tool",
        task_id: "20261121-fat-revoke",
        kind: "test",
        status: "pass",
        summary: "bun test",
        repo: "live-svc",
        branch: "main",
        sha: sha1,
      });
      nativeReview(ledger, "20261121-fat-revoke", { repo: "live-svc", branch: "main", base: start, head: sha1 });
      ledger.recordEvidence({
        source: "tool",
        task_id: "20261121-fat-revoke",
        kind: "hurl",
        status: "pass",
        summary: "hurl pass 1",
        repo: "live-svc",
        branch: "main",
        sha: sha1,
      });
      expect(() => ledger.closeTask({ task_id: "20261121-fat-revoke" })).toThrow('endpoint "fat" requires recorded fat delivery evidence');
      ledger.recordEvidence({ task_id: "20261121-fat-revoke", repo: "live-svc", branch: "main", sha: sha1,
        kind: "fat", source: "manual", status: "pass", summary: "deployment verified" });
      ledger.recordEvidence({
        source: "tool",
        task_id: "20261121-fat-revoke",
        kind: "fat",
        status: "fail",
        summary: "FAT acceptance failed on re-run",
        repo: "live-svc",
        branch: "main",
        sha: sha1,
      });
      expect(() => ledger.closeTask({ task_id: "20261121-fat-revoke" })).toThrow(
        "latest fat delivery verification failed",
      );
    } finally {
      ledger.closeDb();
    }
  });

  test("spec freeze, disk drift detection, amend scope radiation, and full-depth static lint gate", () => {
    const api = fixtureHistory("api-svc", "feat/cycle");
    const ledger = new Ledger(dir);
    try {
      const specDir = join(dir, ".workbench", "specs", "20261123-cycle");
      Bun.spawnSync(["mkdir", "-p", specDir]);
      ledger.openTask({ workflow_version: "0.4",
        task_id: "20261123-cycle",
        title: "Spec-driven dev cycle",
        endpoint: "fat",
        depth: "full",
        repo: "api-svc",
        branch: "feat/cycle",
        base_sha: api.base,
        head_sha: api.head,
      });

      // Missing spec files -> freeze fails closed
      expect(() => ledger.freezeSpec({ task_id: "20261123-cycle" })).toThrow(
        "Missing required spec document",
      );

      const { writeFileSync } = require("node:fs") as typeof import("node:fs");
      writeFileSync(join(specDir, "ssot.md"), "# SSOT\nINV-1: server decides billing\n");
      writeFileSync(join(specDir, "tech-spec.md"), "# Tech Spec\nTransactional debit\n");
      writeFileSync(join(specDir, "test-spec.md"), "# Test Spec\nHurl case for INV-1\n");

      const frozen = ledger.freezeSpec({
        task_id: "20261123-cycle",
        locked_test_globs: ["*.hurl"],
      });
      expect(frozen.spec.state).toBe("FROZEN");
      expect(frozen.spec.drifted_files).toEqual([]);
      expect(frozen.spec.locked_test_globs).toEqual(["*.hurl"]);

      // Full-depth task requires static lint + exec verify (hurl/test/build) + review!
      ledger.recordEvidence({
        source: "tool",
        task_id: "20261123-cycle",
        kind: "hurl",
        status: "pass",
        summary: "hurl ok",
        repo: "api-svc",
        sha: api.head,
      });
      const reviewCycle = () => nativeReview(ledger, "20261123-cycle", {
        repo: "api-svc", branch: "feat/cycle", ...api,
      });
      reviewCycle();
      const missingLint = ledger.checkPushReadiness({
        task_id: "20261123-cycle",
        repo: "api-svc",
        head_sha: api.head,
        checkEndpoint: true,
      });
      expect(missingLint.ready).toBe(false);
      expect(missingLint.missing.join(" ")).toContain("static check (lint)");

      ledger.recordEvidence({ task_id: "20261123-cycle", repo: "api-svc", sha: api.head, source: "manual",
        kind: "fat", status: "pass", summary: "deployment accepted" });
      // Record static lint -> now ready=true (pure Hurl without unit tests works cleanly!)
      ledger.recordEvidence({
        source: "tool",
        task_id: "20261123-cycle",
        kind: "lint",
        status: "pass",
        summary: "go vet pass",
        repo: "api-svc",
        sha: api.head,
      });
      expect(
        ledger.checkPushReadiness({
          task_id: "20261123-cycle",
          repo: "api-svc",
          head_sha: api.head,
          checkEndpoint: true,
        }).ready,
      ).toBe(true);

      // Silent disk tamper of ssot.md is caught immediately as drift!
      writeFileSync(join(specDir, "ssot.md"), "# SSOT\nINV-1: TAMPERED\n");
      const drifted = ledger.checkPushReadiness({
        task_id: "20261123-cycle",
        repo: "api-svc",
        head_sha: api.head,
      });
      expect(drifted.ready).toBe(false);
      expect(drifted.missing.join(" ")).toContain("frozen spec drifted");

      // Restore ssot.md, then run explicit `amend --scope test_spec` -> blocks until re-frozen
      writeFileSync(join(specDir, "ssot.md"), "# SSOT\nINV-1: server decides billing\n");
      const amended = ledger.amendSpec({
        task_id: "20261123-cycle",
        scope: "test_spec",
        reason: "add boundary Hurl case",
      });
      expect(amended.spec.state).toBe("AMENDED");
      expect(amended.spec.stale_stages).toEqual(["test", "fat"]);
      expect(
        ledger.checkPushReadiness({
          task_id: "20261123-cycle",
          repo: "api-svc",
          head_sha: api.head,
        }).ready,
      ).toBe(false);

      // Revise test-spec.md and re-freeze. The prior lint still satisfies static verification.
      writeFileSync(join(specDir, "test-spec.md"), "# Test Spec\nHurl case 1 & 2\n");
      const refrozen = ledger.freezeSpec({ task_id: "20261123-cycle" });
      expect(refrozen.spec.state).toBe("FROZEN");
      expect(refrozen.spec.locked_test_globs).toEqual(["*.hurl"]); // preserved across re-freeze
      const postAmend = ledger.checkPushReadiness({
        task_id: "20261123-cycle",
        repo: "api-svc",
        head_sha: api.head,
        checkEndpoint: true,
      });
      expect(postAmend.ready).toBe(false);
      expect(postAmend.missing.join(" ")).not.toContain("static check (lint)");
      expect(postAmend.missing.join(" ")).toMatch(/review/i);
      expect(postAmend.missing.join(" ")).toContain("hurl");

      // Register a current review and re-run Hurl and FAT acceptance.
      reviewCycle();
      ledger.recordEvidence({
        source: "tool",
        task_id: "20261123-cycle",
        kind: "hurl",
        status: "pass",
        summary: "hurl re-run pass",
        repo: "api-svc",
        sha: api.head,
      });
      ledger.recordEvidence({ task_id: "20261123-cycle", repo: "api-svc", sha: api.head, source: "manual",
        kind: "fat", status: "pass", summary: "deployment accepted" });
      const readyAfter = ledger.checkPushReadiness({
        task_id: "20261123-cycle",
        repo: "api-svc",
        head_sha: api.head,
        checkEndpoint: true,
      });
      expect(readyAfter.ready).toBe(true);
      expect(readyAfter.recordedReviewRoles).toEqual(["quality"]);
      expect(ledger.verify().ok).toBe(true);
    } finally {
      ledger.closeDb();
    }
  });

  test("freeze hardening: invalidates pre-freeze evidence, blocks re-freeze of drift/out-of-scope edits, and anchors symlinks to spec_dir", () => {
    const api = fixtureHistory("api-svc", "feat/hard");
    const ledger = new Ledger(dir);
    try {
      const { writeFileSync, symlinkSync, unlinkSync } = require("node:fs") as typeof import("node:fs");
      const specDir = join(dir, "docs", "custom specs");
      Bun.spawnSync(["mkdir", "-p", specDir]);
      writeFileSync(join(dir, "AGENTS.md"), "# Workbench Agents\n");

      ledger.openTask({ workflow_version: "0.4",
        task_id: "20261123-hard",
        title: "Freeze hardening checks",
        endpoint: "local",
        depth: "full",
        repo: "api-svc",
        branch: "feat/hard",
        base_sha: api.base,
        head_sha: api.head,
      });

      // Record executable evidence before first freeze.
      ledger.recordEvidence({
        source: "tool",
        task_id: "20261123-hard",
        kind: "lint",
        status: "pass",
        summary: "pre-freeze lint",
        repo: "api-svc",
        sha: api.head,
      });
      ledger.recordEvidence({
        source: "tool",
        task_id: "20261123-hard",
        kind: "hurl",
        status: "pass",
        summary: "pre-freeze hurl",
        repo: "api-svc",
        sha: api.head,
      });
      const reviewHard = () => nativeReview(ledger, "20261123-hard", {
        repo: "api-svc", branch: "feat/hard", ...api,
      });
      expect(() => reviewHard()).toThrow("FROZEN specification");

      // Symlink pointing inside workbench root (AGENTS.md) but OUTSIDE spec_dir MUST be rejected!
      symlinkSync(join(dir, "AGENTS.md"), join(specDir, "ssot.md"));
      writeFileSync(join(specDir, "tech-spec.md"), "# Tech\nok\n");
      writeFileSync(join(specDir, "test-spec.md"), "# Test\nok\n");
      expect(() => ledger.freezeSpec({ task_id: "20261123-hard", spec_dir: specDir })).toThrow(
        "resolves outside selected spec directory",
      );

      // Replace symlink with real file and perform first freeze -> MUST invalidate pre-freeze evidence!
      unlinkSync(join(specDir, "ssot.md"));
      writeFileSync(join(specDir, "ssot.md"), "# SSOT\nINV-1: server decides\n");
      const f1 = ledger.freezeSpec({ task_id: "20261123-hard", spec_dir: specDir });
      expect(f1.spec.evidence_floor_seq.lint).toBe(f1.event.seq);
      expect(f1.spec.evidence_floor_seq.test).toBe(f1.event.seq);
      expect(f1.spec.evidence_floor_seq.review).toBe(f1.event.seq);
      expect(f1.spec.evidence_floor_seq.fat).toBe(f1.event.seq);
      const afterFirstFreeze = ledger.checkPushReadiness({
        task_id: "20261123-hard",
        repo: "api-svc",
        head_sha: api.head,
      });
      expect(afterFirstFreeze.ready).toBe(false);
      expect(afterFirstFreeze.missing.join(" ")).toContain("lint");

      for (const kind of ["lint", "hurl"] as const) {
        ledger.recordEvidence({
          source: "tool",
          task_id: "20261123-hard",
          kind,
          status: "pass",
          summary: `post-freeze ${kind}`,
          repo: "api-svc",
          sha: api.head,
        });
      }
      reviewHard();
      expect(
        ledger.checkPushReadiness({
          task_id: "20261123-hard",
          repo: "api-svc",
          head_sha: api.head,
        }).ready,
      ).toBe(true);

      // Lock-only re-freeze preserves executable evidence and rejects dropping locks.
      const fLock = ledger.freezeSpec({
        task_id: "20261123-hard",
        locked_test_globs: ["tests/**/*.hurl"],
      });
      expect(fLock.spec.spec_dir).toBe(f1.spec.spec_dir);
      expect(fLock.spec.locked_test_globs).toEqual(["tests/**/*.hurl"]);
      expect(
        ledger.checkPushReadiness({
          task_id: "20261123-hard",
          repo: "api-svc",
          head_sha: api.head,
        }).missing,
      ).toEqual([expect.stringMatching(/review/i)]);
      reviewHard();
      expect(() =>
        ledger.freezeSpec({ task_id: "20261123-hard", locked_test_globs: [] }),
      ).toThrow("Cannot remove locked test glob");

      // Silent drift cannot be approved by calling freezeSpec again without amend!
      writeFileSync(join(specDir, "ssot.md"), "# SSOT\nINV-1: DRIFTED\n");
      expect(() => ledger.freezeSpec({ task_id: "20261123-hard" })).toThrow(
        "Cannot re-freeze drifted spec document(s)",
      );

      // Even after `amend --scope test_spec`, out-of-scope drift in ssot.md still blocks re-freeze!
      ledger.amendSpec({
        task_id: "20261123-hard",
        scope: "test_spec",
        reason: "adjust hurl assertion",
      });
      expect(() => ledger.freezeSpec({ task_id: "20261123-hard" })).toThrow(
        "out-of-scope spec document(s) changed",
      );

      // Restoring ssot.md and editing only test-spec.md allows re-freeze cleanly
      writeFileSync(join(specDir, "ssot.md"), "# SSOT\nINV-1: server decides\n");
      writeFileSync(join(specDir, "test-spec.md"), "# Test\nok v2\n");
      const f2 = ledger.freezeSpec({ task_id: "20261123-hard" });
      expect(f2.spec.state).toBe("FROZEN");

      // Replacing the entire spec directory with a symlink pointing outside workbench MUST be caught as drift!
      const outsideDir = mkdtempSync(join(tmpdir(), "forge-outside-spec-"));
      try {
        writeFileSync(join(outsideDir, "ssot.md"), "# SSOT\nINV-1: server decides\n");
        writeFileSync(join(outsideDir, "tech-spec.md"), "# Tech\nok\n");
        writeFileSync(join(outsideDir, "test-spec.md"), "# Test\nok v2\n");
        rmSync(specDir, { recursive: true, force: true });
        symlinkSync(outsideDir, specDir);
        const dirDrifted = ledger.getSpecState("20261123-hard");
        expect(dirDrifted.drifted_files.length).toBe(3);
        expect(
          ledger.checkPushReadiness({
            task_id: "20261123-hard",
            repo: "api-svc",
            head_sha: api.head,
          }).ready,
        ).toBe(false);
      } finally {
        rmSync(outsideDir, { recursive: true, force: true });
      }
      expect(ledger.verify().ok).toBe(true);
    } finally {
      ledger.closeDb();
    }
  });

  test("detachRepo, deleted delivered branch closeTask tolerance, reopenTask, and updateEndpoint", () => {
    const repoDir = join(dir, "web");
    mkdirSync(repoDir, { recursive: true });
    const run = (args: string[]) => {
      const r = Bun.spawnSync(["git", ...args], { env: process.env, cwd: repoDir });
      if (r.exitCode !== 0) throw new Error(r.stderr.toString());
      return r.stdout.toString().trim();
    };
    run(["init", "-b", "main"]);
    run(["config", "user.email", "t@t.local"]);
    run(["config", "user.name", "T"]);
    writeFileSync(join(repoDir, "a.ts"), "export const a = 1;\n");
    run(["add", "a.ts"]);
    run(["commit", "-m", "init"]);
    const baseSha = run(["rev-parse", "HEAD"]);

    run(["checkout", "-b", "feat/retry"]);
    writeFileSync(join(repoDir, "a.ts"), "export const a = 2;\n");
    run(["add", "a.ts"]);
    run(["commit", "-m", "fix: retry"]);
    const featSha = run(["rev-parse", "HEAD"]);

    run(["checkout", "-b", "integrate/retry-fat"]);
    const fatSha = run(["rev-parse", "HEAD"]);
    run(["checkout", "main"]);

    const ledger = new Ledger(dir);
    try {
      ledger.openTask({ workflow_version: "0.4",
        task_id: "20261124-retry",
        title: "Retry fix",
        endpoint: "local",
        depth: "targeted",
        repo: "web",
        branch: "old/renamed-branch",
        base_sha: baseSha,
        head_sha: baseSha,
      });
      ledger.attachRepo({
        task_id: "20261124-retry",
        repo: "web",
        branch: "feat/retry",
        base_sha: baseSha,
        head_sha: featSha,
      });
      ledger.attachRepo({
        task_id: "20261124-retry",
        repo: "web",
        branch: "integrate/retry-fat",
        base_sha: baseSha,
        head_sha: fatSha,
      });

      // Detach abandoned/renamed branch cleanly
      const detEv = ledger.detachRepo({
        task_id: "20261124-retry",
        repo: "web",
        branch: "old/renamed-branch",
        reason: "renamed to feat/retry",
      });
      expect(detEv.event_type).toBe("REPO_DETACHED");

      // Promote endpoint local -> fat
      const upd = ledger.updateEndpoint({
        task_id: "20261124-retry",
        endpoint: "fat",
        reason: "user approved FAT",
      });
      expect(upd.task.endpoint).toBe("fat");

      freezeFixture(ledger, "20261124-retry");
      // The two branches point to the same SHA. An unlabelled receipt cannot identify either branch.
      ledger.recordEvidence({
        source: "tool", task_id: "20261124-retry", kind: "test", status: "pass",
        summary: "unbound test", repo: "web", sha: featSha,
      });
      expect(() => ledger.closeTask({ task_id: "20261124-retry", archive: false })).toThrow("no passing");
      for (const branch of ["feat/retry", "integrate/retry-fat"]) {
        for (const kind of ["lint", "test", "fat"] as const) {
          ledger.recordEvidence({
            source: "tool",
            task_id: "20261124-retry",
            kind,
            status: "pass",
            summary: `${kind} pass`,
            repo: "web",
            branch,
            sha: featSha,
          });
        }
        nativeReview(ledger, "20261124-retry", { repo: "web", branch, base: baseSha, head: featSha, role: "business" });
      }

      // Push delivered commit to origin/fat before deleting temporary FAT integration branch on disk
      const bareOrigin = join(dir, "web-origin.git");
      Bun.spawnSync(["git", "init", "--bare", bareOrigin], { env: process.env, stdout: "pipe", stderr: "pipe" });
      run(["remote", "add", "origin", bareOrigin]);
      run(["push", "origin", "integrate/retry-fat:refs/heads/fat"]);
      run(["fetch", "origin"]);
      run(["branch", "-D", "integrate/retry-fat"]);
      const closed = ledger.closeTask({
        task_id: "20261124-retry",
        summary: "FAT verified",
        archive: false,
      });
      expect(closed.task.status).toBe("CLOSED");

      // Reopen CLOSED task to advance endpoint fat -> pr, reusing existing SHA evidence!
      // Reject empty enum values on reopen (both API and CLI leave task CLOSED with zero new events!)
      const eventsBeforeBadReopen = ledger.getTaskEvents("20261124-retry").length;
      expect(() =>
        ledger.reopenTask({ task_id: "20261124-retry", depth: "" as never }),
      ).toThrow("Invalid verification depth");
      expect(() =>
        ledger.reopenTask({ task_id: "20261124-retry", endpoint: "" as never }),
      ).toThrow("Invalid endpoint");
      const ledgerCli = join(import.meta.dir, "..", "src", "bin", "cli.ts");
      for (const badFlag of ["--depth=", "--endpoint="]) {
        const proc = Bun.spawnSync([process.execPath, ledgerCli, "ledger", "reopen", "20261124-retry", badFlag], {
          env: { ...process.env, FORGE_WORKBENCH_ROOT: dir },
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(proc.exitCode).not.toBe(0);
      }
      expect(ledger.getTask("20261124-retry")?.status).toBe("CLOSED");
      expect(ledger.getTaskEvents("20261124-retry").length).toBe(eventsBeforeBadReopen);

      const reopened = ledger.reopenTask({
        task_id: "20261124-retry",
        endpoint: "pr",
        reason: "create PR after FAT",
      });
      expect(reopened.task.status).toBe("OPEN");
      expect(reopened.task.endpoint).toBe("pr");
      // Detach temporary FAT integration branch before PR close (its commit lives on origin/fat, not origin/main)
      ledger.detachRepo({
        task_id: "20261124-retry",
        repo: "web",
        branch: "integrate/retry-fat",
        reason: "temporary FAT branch cleaned up before PR",
      });
      expect(
        ledger.checkPushReadiness({
          task_id: "20261124-retry",
          repo: "web",
          head_sha: featSha,
        }).ready,
      ).toBe(true);

      expect(() => ledger.closeTask({task_id: "20261124-retry", archive: false}))
        .toThrow("run forge ledger pr-sync 20261124-retry --repo web to verify the remote PR head");
      // Record PR evidence and close again cleanly (without duplicating lint/test/review!)
      ledger.recordEvidence({
        source: "tool",
        task_id: "20261124-retry",
        kind: "pr",
        status: "pass",
        summary: "PR #979 opened",
        meta: { pr_head_oid: featSha, pr_url: "https://github.com/acme/web/pull/979" },
        branch: "feat/retry",
        repo: "web",
        sha: featSha,
      });
      expect(
        ledger.closeTask({ task_id: "20261124-retry", archive: false }).task.status,
      ).toBe("CLOSED");

      // Divergent cherry-pick FAT workflow (`fatSha !== featSha`):
      // Attach integration branch -> guard blocks push before evidence -> verify cherryFatSha -> guard allows push
      // -> push to origin/fat -> after deployment/acceptance record fat/pass on featSha -> detach temp branch -> close!
      mkdirSync(join(dir, ".workbench"), { recursive: true });
      writeFileSync(
        join(dir, ".workbench", "workbench.yaml"),
        `name: "demo"\nrepos:\n  - web\nledger:\n  enabled: true\nguard:\n  protected_branches:\n    - main\n`,
      );
      run(["checkout", "-b", "fat-diverged", baseSha]);
      writeFileSync(join(repoDir, "fat-only.txt"), "fat history\n");
      run(["add", "fat-only.txt"]);
      run(["commit", "-m", "chore: fat base commit"]);
      run(["cherry-pick", featSha]);
      const cherryFatSha = run(["rev-parse", "HEAD"]);
      expect(cherryFatSha).not.toBe(featSha);

      ledger.openTask({ workflow_version: "0.4",
        task_id: "20261124-cherry",
        title: "Divergent cherry-pick FAT delivery",
        endpoint: "fat",
        depth: "targeted",
        repo: "web",
        branch: "feat/retry",
        base_sha: baseSha,
        head_sha: featSha,
      });
      ledger.attachRepo({
        task_id: "20261124-cherry",
        repo: "web",
        branch: "fat-diverged",
        base_sha: baseSha,
        head_sha: cherryFatSha,
      });
      freezeFixture(ledger, "20261124-cherry");
      const integrationReady = () => ledger.checkPushReadiness({
        task_id: "20261124-cherry", repo: "web", branch: "fat-diverged", head_sha: cherryFatSha,
      });
      expect(integrationReady().ready).toBe(false);
      ledger.recordEvidence({
        source: "tool",
        task_id: "20261124-cherry",
        kind: "test",
        status: "pass",
        summary: "fat integration test pass",
        repo: "web",
        branch: "fat-diverged",
        sha: cherryFatSha,
      });
      nativeReview(ledger, "20261124-cherry", {
        repo: "web", branch: "fat-diverged", base: baseSha, head: cherryFatSha, role: "business",
      });
      expect(integrationReady().ready).toBe(true);
      // Execute push to origin/fat, then AFTER deployment & acceptance record evidence on canonical `featSha`!
      run(["push", "-f", "origin", "fat-diverged:refs/heads/fat"]);
      run(["fetch", "origin"]);
      run(["checkout", "main"]);
      for (const kind of ["test", "fat"] as const) {
        ledger.recordEvidence({
          source: "tool",
          task_id: "20261124-cherry",
          kind,
          status: "pass",
          summary: `${kind} pass (cherry-pick ${cherryFatSha.slice(0, 8)})`,
          repo: "web",
          branch: "feat/retry",
          sha: featSha,
        });
      }
      nativeReview(ledger, "20261124-cherry", { repo: "web", branch: "feat/retry", base: baseSha, head: featSha, role: "business" });
      // Without detaching divergent cherry-pick branch (which lacks fat acceptance on cherryFatSha), close fails closed;
      // after detaching temp branch per ship/SKILL.md, close succeeds cleanly!
      expect(() => ledger.closeTask({ task_id: "20261124-cherry", archive: false })).toThrow();
      run(["branch", "-D", "fat-diverged"]);
      ledger.detachRepo({
        task_id: "20261124-cherry",
        repo: "web",
        branch: "fat-diverged",
        reason: "pushed cherry-pick to origin/fat and cleaned up",
      });
      expect(
        ledger.closeTask({ task_id: "20261124-cherry", archive: false }).task.status,
      ).toBe("CLOSED");

      // Local-only tag, `origin/feat/*` (not `origin/fat`!), OR personal `fork/fat` MUST NOT satisfy FAT cleaned-branch delivery tolerance!
      const forkBare = join(dir, "web-fork.git");
      Bun.spawnSync(["git", "init", "--bare", forkBare], { env: process.env, stdout: "pipe", stderr: "pipe" });
      run(["remote", "add", "fork", forkBare]);
      run(["checkout", "-b", "feat/local-tag-only", baseSha]);
      writeFileSync(join(repoDir, "b.ts"), "export const b = 1;\n");
      run(["add", "b.ts"]);
      run(["commit", "-m", "feat: not on origin/fat"]);
      const tagOnlySha = run(["rev-parse", "HEAD"]);
      run(["tag", "v-local-only", tagOnlySha]);
      // Remove `origin/fat` so `origin/fat/candidate` can be created (testing exact ref match vs prefix match!)
      run(["push", "origin", "--delete", "fat"]);
      run(["fetch", "--prune", "origin"]);
      run(["push", "origin", "feat/local-tag-only:refs/heads/feat/local-tag-only"]);
      run(["push", "origin", "feat/local-tag-only:refs/heads/fat/candidate"]);
      run(["push", "fork", "feat/local-tag-only:refs/heads/fat"]);
      run(["fetch", "origin"]);
      run(["fetch", "fork"]);
      run(["checkout", "main"]);
      ledger.openTask({ workflow_version: "0.4",
        task_id: "20261124-tag-only",
        title: "Local tag, origin feature branch, & fork/fat must fail closed for FAT",
        endpoint: "fat",
        depth: "targeted",
        repo: "web",
        branch: "feat/local-tag-only",
        base_sha: baseSha,
        head_sha: tagOnlySha,
      });
      freezeFixture(ledger, "20261124-tag-only");
      for (const kind of ["test", "fat"] as const) {
        ledger.recordEvidence({
          source: "tool",
          task_id: "20261124-tag-only",
          kind,
          status: "pass",
          summary: `${kind} pass`,
          repo: "web",
          sha: tagOnlySha,
        });
      }
      nativeReview(ledger, "20261124-tag-only", { repo: "web", branch: "feat/local-tag-only", base: baseSha, head: tagOnlySha, role: "business" });
      run(["branch", "-D", "feat/local-tag-only"]);
      expect(() => ledger.closeTask({ task_id: "20261124-tag-only", archive: false })).toThrow(
        "could not be resolved on disk",
      );
      ledger.cancelTask({ task_id: "20261124-tag-only", reason: "cleanup" });

      // Endpoint downgrade guards: dev -> investigation forbidden; dev -> lower dev requires --reason!
      run(["checkout", "-b", "feat/downgrade-guard", baseSha]);
      const dgSha = run(["rev-parse", "HEAD"]);
      run(["checkout", "main"]);
      ledger.openTask({ workflow_version: "0.4",
        task_id: "20261124-dg",
        title: "Downgrade guard test",
        endpoint: "prod",
        depth: "full",
        repo: "web",
        branch: "feat/downgrade-guard",
        head_sha: dgSha,
      });
      ledger.recordBlocker({
        task_id: "20261124-dg",
        action: "open",
        blocker_id: "b1",
        summary: "unfinished blocker",
      });
      expect(() =>
        ledger.updateEndpoint({ task_id: "20261124-dg", endpoint: "investigation" }),
      ).toThrow("Cannot downgrade development task");
      expect(() =>
        ledger.updateEndpoint({ task_id: "20261124-dg", endpoint: "fat" }),
      ).toThrow("requires a non-empty --reason");
      const dgRes = ledger.updateEndpoint({
        task_id: "20261124-dg",
        endpoint: "fat",
        reason: "re-scoped to FAT only by user",
      });
      expect(dgRes.task.endpoint).toBe("fat");
      expect(JSON.parse(dgRes.event.payload_json).downgrade).toBe(true);
      ledger.cancelTask({ task_id: "20261124-dg", reason: "cleanup" });

      // Local-endpoint task with deleted branch MUST STILL fail closed!
      run(["checkout", "-b", "feat/local-del", featSha]);
      const localSha = run(["rev-parse", "HEAD"]);
      run(["checkout", "main"]);
      ledger.openTask({ workflow_version: "0.4",
        task_id: "20261124-local-del",
        title: "Local deleted branch",
        endpoint: "local",
        depth: "targeted",
        repo: "web",
        branch: "feat/local-del",
        base_sha: baseSha,
        head_sha: localSha,
      });
      freezeFixture(ledger, "20261124-local-del");
      ledger.recordEvidence({
        source: "tool",
        task_id: "20261124-local-del",
        kind: "test",
        status: "pass",
        summary: "ok",
        repo: "web",
        sha: localSha,
      });
      nativeReview(ledger, "20261124-local-del", {
        repo: "web", branch: "feat/local-del", base: baseSha, head: localSha, role: "business",
      });
      run(["branch", "-D", "feat/local-del"]);
      expect(() => ledger.closeTask({ task_id: "20261124-local-del", archive: false })).toThrow(
        "could not be resolved on disk",
      );
      ledger.cancelTask({ task_id: "20261124-local-del", reason: "cleanup" });
      expect(() => ledger.reopenTask({ task_id: "20261124-local-del" })).toThrow(
        "Only CLOSED tasks can be reopened",
      );

      expect(ledger.verify().ok).toBe(true);
    } finally {
      ledger.closeDb();
    }
  });
});
