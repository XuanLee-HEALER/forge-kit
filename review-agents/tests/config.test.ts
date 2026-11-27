import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("standalone review rejects missing, partial or invalid model settings before launch", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-options-"));
  try {
    const git = (...args: string[]) => {
      const r = Bun.spawnSync(["git", "-C", dir, "-c", "user.email=fixture@example.invalid", "-c", "user.name=Fixture", ...args]);
      expect(r.exitCode, r.stderr.toString()).toBe(0);
    };
    git("init", "-q");
    git("commit", "--allow-empty", "-qm", "base");
    writeFileSync(join(dir, "code"), "change\n");
    git("add", "--", "code");
    git("commit", "-qm", "change", "--", "code");
    const fake = join(dir, "fake");
    writeFileSync(fake, '#!/bin/sh\ntouch "$0-invoked"\n', { mode: 0o755 });
    for (const options of [[], ["--effort", "medium"], ["--model", "gpt-6.2-sol"],
    ["--model", "gpt-6.2-sol", "--effort", "invalid"], ["--model", "invalid", "--effort", "medium"],
    ["--model", "gpt-6.2-sol", "--effort", "medium", "--backend", "codex"]]) {
      const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/review.ts"),
        "--repo", dir, "--base", "HEAD~", "--head", "HEAD", "--roles", "quality", ...options], {
        env: { PATH: process.env.PATH, HOME: dir, FORGE_CODEX_BIN: fake, REVIEW_MODEL: "gpt-6.2-sol" },
      });
      expect(r.exitCode, options.join(" ")).not.toBe(0);
      expect(r.stderr.toString()).toMatch(/--model|--effort|--backend/);
      expect(existsSync(fake + "-invoked"), options.join(" ")).toBe(false);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
