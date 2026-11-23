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

      // Re-pass test + static lint + fallback review + FAT delivery evidence on BOTH repos
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
          kind: "lint",
          status: "pass",
          summary: "static check pass",
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

  test("spec freeze, disk drift detection, amend scope radiation, and full-depth static lint gate", () => {
    const ledger = new Ledger(dir);
    try {
      const specDir = join(dir, ".workbench", "specs", "20261123-cycle");
      Bun.spawnSync(["mkdir", "-p", specDir]);
      ledger.openTask({
        task_id: "20261123-cycle",
        title: "Spec-driven dev cycle",
        endpoint: "fat",
        depth: "full",
        repo: "api-svc",
        branch: "feat/cycle",
        base_sha: "1111aaaa",
        head_sha: "2222bbbb",
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
        task_id: "20261123-cycle",
        kind: "hurl",
        status: "pass",
        summary: "hurl ok",
        repo: "api-svc",
        sha: "2222bbbb",
      });
      ledger.recordEvidence({
        task_id: "20261123-cycle",
        kind: "review",
        status: "pass",
        summary: "quality ok",
        repo: "api-svc",
        sha: "2222bbbb",
        meta: { role: "quality" },
      });
      const missingLint = ledger.checkPushReadiness({
        task_id: "20261123-cycle",
        repo: "api-svc",
        head_sha: "2222bbbb",
        checkEndpoint: true,
      });
      expect(missingLint.ready).toBe(false);
      expect(missingLint.missing.join(" ")).toContain("static check (lint)");

      // Record static lint -> now ready=true (pure Hurl without unit tests works cleanly!)
      ledger.recordEvidence({
        task_id: "20261123-cycle",
        kind: "lint",
        status: "pass",
        summary: "go vet pass",
        repo: "api-svc",
        sha: "2222bbbb",
      });
      expect(
        ledger.checkPushReadiness({
          task_id: "20261123-cycle",
          repo: "api-svc",
          head_sha: "2222bbbb",
          checkEndpoint: true,
        }).ready,
      ).toBe(true);

      // Silent disk tamper of ssot.md is caught immediately as drift!
      writeFileSync(join(specDir, "ssot.md"), "# SSOT\nINV-1: TAMPERED\n");
      const drifted = ledger.checkPushReadiness({
        task_id: "20261123-cycle",
        repo: "api-svc",
        head_sha: "2222bbbb",
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
          head_sha: "2222bbbb",
        }).ready,
      ).toBe(false);

      // Revise test-spec.md and re-freeze -> preserves lint & review, but invalidates prior test/hurl/fat!
      writeFileSync(join(specDir, "test-spec.md"), "# Test Spec\nHurl case 1 & 2\n");
      const refrozen = ledger.freezeSpec({ task_id: "20261123-cycle" });
      expect(refrozen.spec.state).toBe("FROZEN");
      expect(refrozen.spec.locked_test_globs).toEqual(["*.hurl"]); // preserved across re-freeze
      const postAmend = ledger.checkPushReadiness({
        task_id: "20261123-cycle",
        repo: "api-svc",
        head_sha: "2222bbbb",
        checkEndpoint: true,
      });
      expect(postAmend.ready).toBe(false);
      // Prior lint & review remain valid (NOT in missing!), while test/fat must be re-run!
      expect(postAmend.missing.join(" ")).not.toContain("static check (lint)");
      expect(postAmend.missing.join(" ")).not.toContain("review");
      expect(postAmend.missing.join(" ")).toContain("hurl");

      // Re-run Hurl after re-freeze -> task is ready again & hash chain verifies!
      ledger.recordEvidence({
        task_id: "20261123-cycle",
        kind: "hurl",
        status: "pass",
        summary: "hurl re-run pass",
        repo: "api-svc",
        sha: "2222bbbb",
      });
      const readyAfter = ledger.checkPushReadiness({
        task_id: "20261123-cycle",
        repo: "api-svc",
        head_sha: "2222bbbb",
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
    const ledger = new Ledger(dir);
    try {
      const { writeFileSync, symlinkSync, unlinkSync } = require("node:fs") as typeof import("node:fs");
      const specDir = join(dir, ".workbench", "specs", "20261123-hard");
      Bun.spawnSync(["mkdir", "-p", specDir]);
      writeFileSync(join(dir, "AGENTS.md"), "# Workbench Agents\n");

      ledger.openTask({
        task_id: "20261123-hard",
        title: "Freeze hardening checks",
        endpoint: "local",
        depth: "full",
        repo: "api-svc",
        branch: "feat/hard",
        base_sha: "aaaa1111",
        head_sha: "bbbb2222",
      });

      // Record lint + hurl + quality review BEFORE first freeze
      ledger.recordEvidence({
        task_id: "20261123-hard",
        kind: "lint",
        status: "pass",
        summary: "pre-freeze lint",
        repo: "api-svc",
        sha: "bbbb2222",
      });
      ledger.recordEvidence({
        task_id: "20261123-hard",
        kind: "hurl",
        status: "pass",
        summary: "pre-freeze hurl",
        repo: "api-svc",
        sha: "bbbb2222",
      });
      ledger.recordEvidence({
        task_id: "20261123-hard",
        kind: "review",
        status: "pass",
        summary: "pre-freeze review",
        repo: "api-svc",
        sha: "bbbb2222",
        meta: { role: "quality" },
      });
      expect(
        ledger.checkPushReadiness({
          task_id: "20261123-hard",
          repo: "api-svc",
          head_sha: "bbbb2222",
        }).ready,
      ).toBe(true);

      // Symlink pointing inside workbench root (AGENTS.md) but OUTSIDE spec_dir MUST be rejected!
      symlinkSync(join(dir, "AGENTS.md"), join(specDir, "ssot.md"));
      writeFileSync(join(specDir, "tech-spec.md"), "# Tech\nok\n");
      writeFileSync(join(specDir, "test-spec.md"), "# Test\nok\n");
      expect(() => ledger.freezeSpec({ task_id: "20261123-hard" })).toThrow(
        "resolves outside selected spec directory",
      );

      // Replace symlink with real file and perform first freeze -> MUST invalidate pre-freeze evidence!
      unlinkSync(join(specDir, "ssot.md"));
      writeFileSync(join(specDir, "ssot.md"), "# SSOT\nINV-1: server decides\n");
      const f1 = ledger.freezeSpec({ task_id: "20261123-hard" });
      expect(f1.spec.evidence_floor_seq.lint).toBe(f1.event.seq);
      expect(f1.spec.evidence_floor_seq.test).toBe(f1.event.seq);
      expect(f1.spec.evidence_floor_seq.review).toBe(f1.event.seq);
      expect(f1.spec.evidence_floor_seq.fat).toBe(f1.event.seq);
      const afterFirstFreeze = ledger.checkPushReadiness({
        task_id: "20261123-hard",
        repo: "api-svc",
        head_sha: "bbbb2222",
      });
      expect(afterFirstFreeze.ready).toBe(false);
      expect(afterFirstFreeze.missing.join(" ")).toContain("lint");

      // Record post-freeze evidence -> ready=true
      for (const [kind, role] of [
        ["lint", undefined],
        ["hurl", undefined],
        ["review", "quality"],
      ] as const) {
        ledger.recordEvidence({
          task_id: "20261123-hard",
          kind,
          status: "pass",
          summary: `post-freeze ${kind}`,
          repo: "api-svc",
          sha: "bbbb2222",
          meta: role ? { role } : undefined,
        });
      }
      expect(
        ledger.checkPushReadiness({
          task_id: "20261123-hard",
          repo: "api-svc",
          head_sha: "bbbb2222",
        }).ready,
      ).toBe(true);

      // Lock-only re-freeze adding --lock-tests preserves post-freeze evidence and rejects dropping locks
      const fLock = ledger.freezeSpec({
        task_id: "20261123-hard",
        locked_test_globs: ["tests/**/*.hurl"],
      });
      expect(fLock.spec.locked_test_globs).toEqual(["tests/**/*.hurl"]);
      expect(
        ledger.checkPushReadiness({
          task_id: "20261123-hard",
          repo: "api-svc",
          head_sha: "bbbb2222",
        }).ready,
      ).toBe(true);
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
            head_sha: "bbbb2222",
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
});
