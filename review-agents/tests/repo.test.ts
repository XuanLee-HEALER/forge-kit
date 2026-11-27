import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/repo";
import { validateReport } from "../src/report";
import { detectDiffPitfallLanguages } from "../src/roles";
test("pinned reads and no worktree contamination", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-test-"));
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", dir, ...args]);
    if (r.exitCode) throw Error(r.stderr.toString());
    return r.stdout.toString().trim();
  };
  try {
    git("init");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "test");
    writeFileSync(join(dir, "a.ts"), "old\n");
    git("add", "a.ts");
    git("commit", "-m", "base");
    const base = git("rev-parse", "HEAD");
    writeFileSync(
      join(dir, "a.ts"),
      Array.from({ length: 400 }, (_, i) => `line${i}`).join("\n"),
    );
    git("add", "a.ts");
    git("commit", "-m", "head");
    writeFileSync(join(dir, "a.ts"), "UNCOMMITTED");
    const r = new Repo(dir, base, "HEAD");
    expect(r.read("a.ts", "head", 0).text).not.toContain("UNCOMMITTED");
    expect(() => r.read("../secret", "head", 0)).toThrow();
    expect(r.search("line399", "*.ts", 0).text).toContain("line399");
    expect(r.search("", "**", 0).text).toBe("1: a.ts");
    const deletedBase = git("rev-parse","HEAD");
    rmSync(join(dir,"a.ts"));
    git("add", "-u", "--", "a.ts");
    git("commit", "-qm", "delete file");
    writeFileSync(join(dir,"a.ts"), "working tree replacement");
    const deletion = new Repo(dir, deletedBase, git("rev-parse","HEAD"));
    expect(deletion.read("a.ts", "base", 399).text).toBe("400: line399");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("unread diffs never pass and blocking findings determine exit state", () => {
  const raw = {
    role:"quality",
    status: "pass",
    summary: "ok",
    findings: [],
    checked: [],
    limitations: [],
  };
  expect(validateReport(raw, ["a"], ["a"], () => 1).status).toBe("incomplete");
  expect(
    validateReport(
      {
        ...raw,
        findings: [
          {
            severity: "blocking",
            path: "a",
            line: 1,
            title: "x",
            evidence: "x",
            recommendation: "x",
          },
        ],
      },
      ["a"],
      [],
      () => 1,
    ).status,
  ).toBe("findings");
});

test("detectDiffPitfallLanguages selects only matching Go/TS/Python pitfall checklists", () => {
  expect(detectDiffPitfallLanguages(["internal/service.go"])).toEqual(["go"]);
  expect(detectDiffPitfallLanguages(["src/app.tsx", "web/Page.svelte"])).toEqual(["ts"]);
  expect(detectDiffPitfallLanguages(["api/routes.py"])).toEqual(["python"]);
  expect(detectDiffPitfallLanguages(["cmd/main.go", "worker/task.py"])).toEqual(["go", "python"]);
  expect(detectDiffPitfallLanguages(["README.md", "deploy.yaml"])).toEqual([]);

  const pitfallsDir = join(import.meta.dir, "..", "prompts", "lang-pitfalls");
  for (const lang of ["go", "ts", "python"]) {
    const p = join(pitfallsDir, `${lang}.md`);
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, "utf8").trim().length).toBeGreaterThan(100);
  }
});
