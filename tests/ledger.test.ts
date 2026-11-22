import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "forge-ledger-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("SQLite WAL Hash-Chained Ledger", () => {
  test("full lifecycle: unique branch ownership, multi-repo attach, decisions, idempotent blockers, latest-status readiness, close & archive", () => {
    const ledger = new Ledger(dir);
    try {
      const opened = ledger.openTask({
        task_id: "20261121-audio-billing",
        title: "Audio billing settlement fix",
        endpoint: "fat",
        depth: "full",
        repo: "canvas",
        branch: "fix/audio-billing",
        base_sha: "aaaa1111",
        head_sha: "cccc2222",
      });
      expect(opened.task.status).toBe("OPEN");
      expect(opened.event.prev_hash).toBe("GENESIS");

      // Second OPEN task cannot claim the SAME (repo, branch)!
      expect(() =>
        ledger.openTask({
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
        base_sha: "bbbb1111",
        head_sha: "dddd2222",
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
        task_id: "20261121-audio-billing",
        kind: "test",
        status: "pass",
        summary: "go test pass 1",
        repo: "canvas",
        branch: "fix/audio-billing",
        sha: "cccc2222",
      });
      ledger.recordEvidence({
        task_id: "20261121-audio-billing",
        kind: "test",
        status: "fail",
        summary: "go test fail 2",
        repo: "canvas",
        branch: "fix/audio-billing",
        sha: "cccc2222",
      });
      expect(
        ledger.checkPushReadiness({
          task_id: "20261121-audio-billing",
          repo: "canvas",
          head_sha: "cccc2222",
        }).ready,
      ).toBe(false);

      // Re-pass test + fallback review + FAT delivery evidence on BOTH repos
      for (const [repo, sha] of [
        ["canvas", "cccc2222"],
        ["web-app", "dddd2222"],
      ] as const) {
        ledger.recordEvidence({
          task_id: "20261121-audio-billing",
          kind: "test",
          status: "pass",
          summary: "tests pass",
          repo,
          branch: "fix/audio-billing",
          sha,
        });
        ledger.recordEvidence({
          task_id: "20261121-audio-billing",
          kind: "review",
          status: "fallback",
          summary: "review-quality native_fallback",
          repo,
          branch: "fix/audio-billing",
          sha,
          meta: { role: "review-quality" },
        });
      }

      // FAT endpoint cannot close until FAT/Hurl delivery evidence is recorded!
      expect(() =>
        ledger.closeTask({ task_id: "20261121-audio-billing" }),
      ).toThrow('endpoint "fat" requires recorded fat delivery evidence');

      for (const [repo, sha] of [
        ["canvas", "cccc2222"],
        ["web-app", "dddd2222"],
      ] as const) {
        ledger.recordEvidence({
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
      ledger.openTask({
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
      ledger.openTask({
        task_id: "20261121-inv",
        title: "Root cause analysis",
        endpoint: "investigation",
        depth: "targeted",
      });
      expect(ledger.closeTask({ task_id: "20261121-inv", archive: false }).task.status).toBe(
        "CLOSED",
      );

      ledger.openTask({
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
      ledger.openTask({
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
      ledger.openTask({
        task_id: "20250101-old-task",
        title: "Old investigation",
        endpoint: "investigation",
        depth: "targeted",
      });
      ledger.closeTask({ task_id: "20250101-old-task", archive: false });
      ledger.db
        .query("UPDATE tasks SET closed_at = '2025-01-02T00:00:00.000Z' WHERE task_id = ?")
        .run("20250101-old-task");

      ledger.openTask({
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

  test("concurrent subprocess writes serialize cleanly under SQLite WAL", async () => {
    const ledger = new Ledger(dir);
    ledger.openTask({
      task_id: "20261121-concurrent",
      title: "Concurrency stress",
      endpoint: "local",
      depth: "targeted",
    });
    ledger.closeDb();

    const ledgerSrc = join(import.meta.dir, "..", "src", "bin", "ledger.ts");
    const procs = Array.from({ length: 8 }, (_, i) =>
      Bun.spawn(
        [
          process.execPath,
          ledgerSrc,
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
    writeFileSync(join(repoPath, "a.ts"), "export const v = 1;\n");
    runGit(repoPath, ["add", "a.ts"]);
    runGit(repoPath, ["commit", "-m", "chore: init"]);
    runGit(repoPath, ["checkout", "-b", "feat/live-check"]);
    const sha1 = runGit(repoPath, ["rev-parse", "HEAD"]).stdout.trim();

    const ledger = new Ledger(dir);
    try {
      ledger.openTask({
        task_id: "20261121-live",
        title: "Live HEAD close check",
        endpoint: "local",
        depth: "targeted",
        repo: "live-svc",
        branch: "feat/live-check",
        base_sha: sha1,
        head_sha: sha1,
      });
      ledger.recordEvidence({
        task_id: "20261121-live",
        kind: "test",
        status: "pass",
        summary: "bun test",
        repo: "live-svc",
        branch: "feat/live-check",
        sha: sha1,
      });
      ledger.recordEvidence({
        task_id: "20261121-live",
        kind: "review",
        status: "pass",
        summary: "review ok",
        repo: "live-svc",
        branch: "feat/live-check",
        sha: sha1,
      });

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
      ledger.openTask({
        task_id: "20261121-missing-branch",
        title: "Missing branch close check",
        endpoint: "fat",
        depth: "targeted",
        repo: "live-svc",
        branch: "feat/does-not-exist",
        base_sha: sha1,
        head_sha: sha1,
      });
      ledger.recordEvidence({
        task_id: "20261121-missing-branch",
        kind: "test",
        status: "pass",
        summary: "bun test",
        repo: "live-svc",
        branch: "feat/does-not-exist",
        sha: sha1,
      });
      ledger.recordEvidence({
        task_id: "20261121-missing-branch",
        kind: "review",
        status: "pass",
        summary: "review ok",
        repo: "live-svc",
        branch: "feat/does-not-exist",
        sha: sha1,
      });
      ledger.recordEvidence({
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

      // Subsequent FAT/hurl failure on the SAME SHA MUST revoke an earlier hurl pass!
      ledger.openTask({
        task_id: "20261121-fat-revoke",
        title: "FAT failure revokes earlier pass",
        endpoint: "fat",
        depth: "targeted",
        repo: "live-svc",
        branch: "main",
        base_sha: sha1,
        head_sha: sha1,
      });
      ledger.recordEvidence({
        task_id: "20261121-fat-revoke",
        kind: "test",
        status: "pass",
        summary: "bun test",
        repo: "live-svc",
        branch: "main",
        sha: sha1,
      });
      ledger.recordEvidence({
        task_id: "20261121-fat-revoke",
        kind: "review",
        status: "pass",
        summary: "review ok",
        repo: "live-svc",
        branch: "main",
        sha: sha1,
      });
      ledger.recordEvidence({
        task_id: "20261121-fat-revoke",
        kind: "hurl",
        status: "pass",
        summary: "hurl pass 1",
        repo: "live-svc",
        branch: "main",
        sha: sha1,
      });
      ledger.recordEvidence({
        task_id: "20261121-fat-revoke",
        kind: "hurl",
        status: "fail",
        summary: "hurl failed on re-run",
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
});
