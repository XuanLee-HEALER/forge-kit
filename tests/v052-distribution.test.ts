import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { kit } from "./v05-sandbox";

test("README preserves content outside the approved review and installation changes", () => {
  // SHA-256 of the same protected text at 0e252c19, usable in shallow offline checkouts.
  const readme = readFileSync(join(kit, "README.md"), "utf8");
  const protectedText = readme
    .replace(/^\| \*\*L2 .*\n/m, "")
    .replace(/(?<=^- \*\*统一入口[^\n]*\n)[\s\S]*?(?=^- \*\*任务账本)/m, "")
    .replace(/^```mermaid\n[\s\S]*?^```\n/m, "")
    .replace(/(?<=^#### 3\. 四维独立 Review\n)[\s\S]*?(?=\n#### 4\.)/m, "");
  expect(createHash("sha256").update(protectedText).digest("hex")).toBe("99f92e226a0a6fb25eb18d61ebdea266018bbcad60a319fceeacaabb27db22ba");
  expect(readme).toContain("forge ledger review-record");
});

test("current distribution removes stale JS bundles and retired protocol configuration", () => {
  const temp = mkdtempSync(join(tmpdir(), "forge-dist-contract-"));
  try {
    // Build a private copy so a failed or interrupted check cannot alter a developer's dist.
    for (const part of ["package.json", "src", "scripts"]) {
      cpSync(join(kit, part), join(temp, part), {
        recursive: true, filter: path => !/(?:^|\/)(node_modules|dist)(?:\/|$)/.test(path),
      });
    }
    symlinkSync(join(kit, "node_modules"), join(temp, "node_modules"));
    const manifest = JSON.parse(readFileSync(join(temp, "package.json"), "utf8"));
    expect(manifest.version).toBe("0.5.5");
    expect(JSON.stringify(manifest)).not.toContain("review-agents");
    expect(readFileSync(join(kit, "kit.toml"), "utf8")).toMatch(/^version = "0\.5\.5"$/m);
    mkdirSync(join(temp, "dist"));
    writeFileSync(join(temp, "dist/stale.js"), "stale");
    const result = Bun.spawnSync([process.execPath, "run", "build"], { cwd: temp });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(readdirSync(join(temp, "dist"))).toEqual(["cli.js"]);
    const out = Bun.spawnSync([process.execPath, join(temp, "dist/cli.js"), "--help"], {cwd: temp});
    expect(out.exitCode, out.stderr.toString()).toBe(0);
    for (const path of ["core/AGENTS.md", "core/.agents/skills/ship/SKILL.md", "templates/workbench.yaml"]) {
      const source = readFileSync(join(kit, path), "utf8");
      expect(source).not.toMatch(/atomic_pr_hosts|forge\.atomic-pr\.v1|forge\/atomic-pr\/v1/);
    }
    for (const path of new Bun.Glob("**/*").scanSync({ cwd: join(kit, "core"), dot: true, onlyFiles: true })) {
      expect(readFileSync(join(kit, "core", path), "utf8"), path).not.toMatch(/\bFAT\b|\bHurl\b/i);
    }
    expect(readFileSync(join(temp, "dist/cli.js"), "utf8")).not.toMatch(/forge\.atomic-pr\.v1|forge\/atomic-pr\/v1/);
    for (const path of ["review-agents/package.json", "review-agents/src", "src/forge-review.ts", "src/ledger/review-fallback.ts"]) {
      expect(existsSync(join(kit, path)), path).toBe(false);
    }
    expect(readFileSync(join(kit, "core/AGENTS.md")).length).toBeLessThan(8000);
    const guard = join(kit, "src/guard");
    const lines = readdirSync(guard).filter(f => f.endsWith(".ts")).reduce((n, f) => n + (readFileSync(join(guard, f), "utf8").match(/\n/g)?.length ?? 0), 0);
    expect(lines).toBeLessThanOrEqual(750);
    for (const obsolete of ["docs/designs", "docs", "packs"]) expect(existsSync(join(kit, obsolete))).toBe(false);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}, 30_000);
