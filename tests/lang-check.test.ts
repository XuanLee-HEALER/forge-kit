import { isolateHome } from "./helpers/hermetic";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { detectRepoLanguages, runLangChecks } from "../src/lang-check";

isolateHome();

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "forge-lang-check-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("lang-check (Go / TypeScript / Python static & dynamic checks)", () => {
  test("detects languages accurately and fails closed (ok=false, executed=0) on empty repo", () => {
    expect(detectRepoLanguages(dir)).toEqual([]);
    const emptyRes = runLangChecks({ targetDir: dir, mode: "all" });
    expect(emptyRes.ok).toBe(false);
    expect(emptyRes.executed).toBe(0);

    // Python static check (pass + syntax error fail)
    const pyRepo = join(dir, "py-svc");
    mkdirSync(pyRepo, { recursive: true });
    writeFileSync(join(pyRepo, "app.py"), "def add(a: int, b: int) -> int:\n    return a + b\n");
    expect(detectRepoLanguages(pyRepo)).toEqual(["python"]);
    const pyPass = runLangChecks({ targetDir: pyRepo, mode: "static" });
    expect(pyPass.ok, JSON.stringify(pyPass.checks)).toBe(true);
    expect(pyPass.executed).toBeGreaterThanOrEqual(1);

    writeFileSync(join(pyRepo, "broken.py"), "def oops(:\n  pass\n");
    const pyFail = runLangChecks({ targetDir: pyRepo, mode: "static" });
    expect(pyFail.ok).toBe(false);
    expect(pyFail.failed).toBeGreaterThanOrEqual(1);

    // Pure JS Node package (package.json + .js + test script, no tsconfig/.ts) is auto-detected as ts family
    const jsRepo = join(dir, "js-pkg");
    mkdirSync(jsRepo, { recursive: true });
    writeFileSync(
      join(jsRepo, "package.json"),
      JSON.stringify({ name: "js-pkg", scripts: { test: "bun -e 'process.exit(0)'" } }),
    );
    writeFileSync(join(jsRepo, "index.js"), "export const ok = true;\n");
    expect(detectRepoLanguages(jsRepo)).toEqual(["ts"]);

    // Pure JS package with deeply nested source file (depth 3+: src/lib/client/index.mjs) is also detected!
    const deepJsRepo = join(dir, "deep-js-pkg");
    mkdirSync(join(deepJsRepo, "src", "lib", "client"), { recursive: true });
    writeFileSync(join(deepJsRepo, "package.json"), JSON.stringify({ name: "deep-js-pkg" }));
    writeFileSync(join(deepJsRepo, "src", "lib", "client", "index.mjs"), "export const x = 1;\n");
    expect(detectRepoLanguages(deepJsRepo)).toEqual(["ts"]);
  });
});

test("the compiler checks the project independently of package script names", () => {
  const bin = join(dir, "node_modules/.bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(join(dirname(require.resolve("typescript/package.json")), "bin/tsc"), join(bin, "tsc"));

  writeFileSync(join(dir, "lint.js"), 'console.log("lint passed")');
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: true }, files: ["example.ts"] }));
  writeFileSync(join(dir, "example.ts"), 'const count: number = "invalid";');
  const situations = [
    { name: "lint", body: "bun lint.js" },
    { name: "check", body: "bun lint.js" },
    { name: "typecheck", body: "bun lint.js" },
    { name: "check", body: "bun --bun run tsc --noEmit", extra: { tsc: "bun lint.js" } },
  ];
  for (const { name, body, extra } of situations) {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { [name]: body, ...extra } }));
    const report = runLangChecks({ targetDir: dir, mode: "static" });
    expect(report.ok, name).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({name, status: "pass"}));
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: "tsc-noEmit", status: "fail", output_excerpt: expect.stringContaining("TS2322"),
    }));
  }
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { check: "bun --bun run tsc --noEmit" } }));
  const direct = runLangChecks({targetDir: dir, mode: "static"});
  expect(direct.checks.map(item => [item.name, item.status])).toEqual([["tsc-noEmit", "fail"]]);
  // Bun resolves a local tsc.ts before the installed binary for "bun run tsc".
  writeFileSync(join(dir, "tsc.ts"), 'console.log("project check")');
  const shadowed = runLangChecks({targetDir: dir, mode: "static"});
  expect(shadowed.checks.map(item => [item.name, item.status])).toEqual([["check", "pass"], ["tsc-noEmit", "fail"]]);
}, 30_000);
