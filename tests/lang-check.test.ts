import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectRepoLanguages, runLangChecks } from "../src/lang-check";
import { classifyPostToolEvidence } from "../src/ledger-hook";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "forge-lang-check-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("lang-check (Go / TypeScript / Python static & dynamic checks) and ledger-hook classification", () => {
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
    expect(pyPass.ok).toBe(true);
    expect(pyPass.executed).toBeGreaterThanOrEqual(1);

    writeFileSync(join(pyRepo, "broken.py"), "def oops(:\n  pass\n");
    const pyFail = runLangChecks({ targetDir: pyRepo, mode: "static" });
    expect(pyFail.ok).toBe(false);
    expect(pyFail.failed).toBeGreaterThanOrEqual(1);
  });

  test("classifies lang-check, go vet, biome check, pyright, mypy, bunx tsc, and python -m pytest in ledger-hook", () => {
    const repoDir = join(dir, "svc");
    mkdirSync(repoDir, { recursive: true });

    // lang-check --mode static -> lint
    const lcStatic = classifyPostToolEvidence(
      `.workbench/bin/lang-check ${repoDir} --mode static`,
      dir,
      0,
      "lang-check (static) [ts] -> executed=1, failed=0, ok=true\n  [PASS] (ts/static) tsc-noEmit",
    );
    expect(lcStatic.length).toBe(1);
    expect(lcStatic[0]?.kind).toBe("lint");
    expect(lcStatic[0]?.status).toBe("pass");
    expect(lcStatic[0]?.targetDir).toBe(repoDir);

    // lang-check --mode dynamic -> test
    const lcDyn = classifyPostToolEvidence(
      `.workbench/bin/lang-check ${repoDir} --mode dynamic`,
      dir,
      0,
      "lang-check (dynamic) [go] -> executed=1, failed=0, ok=true\n  [PASS] (go/dynamic) go-test-race",
    );
    expect(lcDyn.length).toBe(1);
    expect(lcDyn[0]?.kind).toBe("test");
    expect(lcDyn[0]?.status).toBe("pass");

    // lang-check --mode all with JSON report where BOTH static and dynamic ran -> records BOTH lint and test!
    const lcAllBoth = classifyPostToolEvidence(
      `.workbench/bin/lang-check ${repoDir} --mode all --json`,
      dir,
      0,
      JSON.stringify({
        ok: true,
        executed: 2,
        checks: [
          { phase: "static", status: "pass" },
          { phase: "dynamic", status: "pass" },
        ],
      }),
    );
    expect(lcAllBoth.map((e) => `${e.kind}:${e.status}`)).toEqual(["lint:pass", "test:pass"]);

    // lang-check --mode all where ONLY static ran MUST NOT fabricate test:pass!
    const lcAllStaticOnly = classifyPostToolEvidence(
      `.workbench/bin/lang-check ${repoDir} --mode all --json`,
      dir,
      0,
      JSON.stringify({
        ok: true,
        executed: 1,
        checks: [{ phase: "static", status: "pass" }],
      }),
    );
    expect(lcAllStaticOnly.map((e) => `${e.kind}:${e.status}`)).toEqual(["lint:pass"]);

    // lang-check exit 2 (executed=0 fail-closed) or --help MUST record 0 events!
    expect(classifyPostToolEvidence(`.workbench/bin/lang-check ${repoDir}`, dir, 2, "")).toEqual([]);
    expect(classifyPostToolEvidence(`.workbench/bin/lang-check --help`, dir, 0, "Usage:")).toEqual([]);

    // Language static & dynamic CLI direct invocations
    expect(classifyPostToolEvidence("go vet ./...", repoDir, 0, "")[0]?.kind).toBe("lint");
    expect(classifyPostToolEvidence("go vet -n ./...", repoDir, 0, "")).toEqual([]);
    expect(classifyPostToolEvidence("go vet -C ../other ./...", repoDir, 0, "")[0]?.targetDir).toBe(
      join(dir, "other"),
    );
    expect(classifyPostToolEvidence("go test -race ./...", repoDir, 0, "")[0]?.kind).toBe("test");
    expect(classifyPostToolEvidence("biome check .", repoDir, 0, "")[0]?.kind).toBe("lint");
    expect(classifyPostToolEvidence("bunx --bun tsc --noEmit", repoDir, 0, "")[0]?.kind).toBe("lint");
    expect(classifyPostToolEvidence("bunx --bun tsc --version", repoDir, 0, "5.9")).toEqual([]);
    expect(classifyPostToolEvidence("pyright", repoDir, 0, "")[0]?.kind).toBe("lint");
    expect(classifyPostToolEvidence("mypy .", repoDir, 0, "")[0]?.kind).toBe("lint");
    expect(classifyPostToolEvidence("PYTHONDEVMODE=1 .venv/bin/python -m pytest -W error::RuntimeWarning tests/", repoDir, 0, "")[0]?.kind).toBe("test");
    expect(classifyPostToolEvidence("python3 -m pytest --collect-only", repoDir, 0, "")).toEqual([]);
  });
});
