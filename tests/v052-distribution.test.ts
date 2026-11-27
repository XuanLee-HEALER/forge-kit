import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { kit } from "./v05-sandbox";

test("README preserves the byte ranges around the backend sentence from f4a5d03", () => {
  // Digests of the first 39 lines and the suffix starting at line 41, including all LF bytes.
  // Storing the digests lets a shallow, fixed-SHA verification checkout run this contract.
  const readme = readFileSync(join(kit, "README.md"));
  const offsets = [...readme.keys()].filter(i => readme[i] === 10);
  const prefix = readme.subarray(0, offsets[38] + 1);
  const sentence = readme.subarray(offsets[38] + 1, offsets[39]).toString();
  const suffix = readme.subarray(offsets[39] + 1);
  const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  expect(sha(prefix)).toBe("f2cff839b5008f73b98e434aadd888af90adecf0ea0106a033bd954834119867");
  expect(sha(suffix)).toBe("e59770c65492678f82241283200b4e1ece5a0f3dcf82a28e6d8c5eef7dac668f");
  expect(sentence).toContain("Codex CLI");
  expect(sentence).toContain("无内置上下文");
});

test("current distribution removes stale JS bundles and retired protocol configuration", () => {
  const temp = mkdtempSync(join(tmpdir(), "forge-dist-contract-"));
  try {
    // Build a private copy so a failed or interrupted check cannot alter a developer's dist.
    for (const part of ["package.json", "src", "scripts", "review-agents"]) {
      cpSync(join(kit, part), join(temp, part), {
        recursive: true, filter: path => !/(?:^|\/)(node_modules|dist)(?:\/|$)/.test(path),
      });
    }
    symlinkSync(join(kit, "node_modules"), join(temp, "node_modules"));
    if (existsSync(join(kit, "review-agents/node_modules"))) symlinkSync(join(kit, "review-agents/node_modules"), join(temp, "review-agents/node_modules"));
    for (const manifest of ["package.json", "review-agents/package.json"]) {
      expect(JSON.parse(readFileSync(join(temp, manifest), "utf8")).version).toBe("0.5.4");
    }
    expect(readFileSync(join(kit, "kit.toml"), "utf8")).toMatch(/^version = "0\.5\.4"$/m);
    mkdirSync(join(temp, "dist"));
    writeFileSync(join(temp, "dist/stale.js"), "stale");
    const result = Bun.spawnSync([process.execPath, "run", "build"], { cwd: temp });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(readdirSync(join(temp, "dist"))).toEqual(["cli.js"]);
    for (const entry of ["dist/cli.js", "review-agents/dist/review.js"]) {
      const out = Bun.spawnSync([process.execPath, join(temp, entry), "--help"], { cwd: temp });
      expect(out.exitCode, out.stderr.toString()).toBe(0);
    }
    for (const path of ["core/AGENTS.md", "core/.agents/skills/ship/SKILL.md", "templates/workbench.yaml"]) {
      const source = readFileSync(join(kit, path), "utf8");
      expect(source).not.toMatch(/atomic_pr_hosts|forge\.atomic-pr\.v1|forge\/atomic-pr\/v1/);
    }
    for (const path of new Bun.Glob("**/*").scanSync({ cwd: join(kit, "core"), dot: true, onlyFiles: true })) {
      expect(readFileSync(join(kit, "core", path), "utf8"), path).not.toMatch(/\bFAT\b|\bHurl\b/i);
    }
    expect(readFileSync(join(temp, "dist/cli.js"), "utf8")).not.toMatch(/forge\.atomic-pr\.v1|forge\/atomic-pr\/v1/);
    for (const path of ["review-agents/evals/paired.json", "review-agents/tests/paired-eval.test.ts"]) {
      expect(existsSync(join(kit, path)), path).toBe(false);
    }
    expect(readFileSync(join(kit, "core/AGENTS.md")).length).toBeLessThan(8000);
    const guard = join(kit, "src/guard");
    const lines = readdirSync(guard).filter(f => f.endsWith(".ts")).reduce((n, f) => n + (readFileSync(join(guard, f), "utf8").match(/\n/g)?.length ?? 0), 0);
    expect(lines).toBeLessThanOrEqual(750);
    for (const obsolete of ["docs/designs", "docs", "packs"]) expect(existsSync(join(kit, obsolete))).toBe(false);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}, 30_000);
