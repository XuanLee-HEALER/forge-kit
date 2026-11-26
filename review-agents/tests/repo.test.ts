import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/repo";
import { validateReport } from "../src/report";
import { detectDiffPitfallLanguages } from "../src/roles";
test("pinned reads, complete pagination and no worktree contamination", () => {
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
    r.diff("a.ts", 0);
    expect(r.missing()).toEqual(["a.ts"]);
    let n = 0;
    while (true) {
      const p = r.diff("a.ts", n);
      n = p.nextOffset;
      if (!p.truncated) break;
    }
    expect(r.missing()).toEqual([]);
    expect(() => r.read("../secret", "head", 0)).toThrow();
    expect(() => r.diff("a.ts", -1)).toThrow();
    expect(r.search("line399", "*.ts", 0).text).toContain("line399");
    expect(r.search("", "**", 0).text).toBe("1: a.ts");
    const deletedBase = git("rev-parse","HEAD");
    rmSync(join(dir,"a.ts"));
    git("add", "-u", "--", "a.ts");
    git("commit", "-qm", "delete file");
    writeFileSync(join(dir,"a.ts"), "working tree replacement");
    const deletion = new Repo(dir, deletedBase, git("rev-parse","HEAD"));
    expect(deletion.lineCount("a.ts")).toBe(400);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("unread diffs never pass and blocking findings determine exit state", () => {
  const raw = {
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

test("the review budget stops Git before unread diffs and oversized input blobs", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-limit-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args]);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString().trim();
  };
  function review(base: string, head: string, missing: string[], opened: string[]) {
    const trace = join(dir, ".git", head + ".jsonl");
    const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/review.ts"),
      "--base", base, "--head", head, "--repo", dir, "--roles", "quality", "--backend", "codex"], {
      env: {...process.env, GIT_TRACE2_EVENT: trace, FORGE_CODEX_BIN: join(dir, "unused-provider")},
    });
    expect(result.exitCode, result.stderr.toString()).toBe(3);
    expect(JSON.parse(result.stdout.toString()).roles[0]).toMatchObject({
      status:"incomplete", missing_materials:missing, attempts:[],
    });
    const events = readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const diffs = events.filter(e => e.event === "start" && e.argv.includes("--unified=5"));
    expect(diffs.map(e => e.argv.at(-1))).toEqual(opened);
  }
  try {
    git("init", "-q");
    git("commit", "--allow-empty", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    const line = "x".repeat(299) + "\n";
    for (const file of ["a.ts", "b.ts"]) writeFileSync(join(dir, file), line.repeat(2600));
    writeFileSync(join(dir, "c.ts"), "small final change\n");
    git("add", "--", "a.ts", "b.ts", "c.ts");
    git("commit", "-qm", "combined changes");
    const first = git("rev-parse", "HEAD");
    review(base, first, ["b.ts", "c.ts"], ["a.ts", "b.ts"]);
    writeFileSync(join(dir, "a.ts"), line.repeat(6000));
    writeFileSync(join(dir, "c.ts"), "later change\n");
    git("commit", "-qam", "large input blob");
    review(first, git("rev-parse", "HEAD"), ["a.ts","c.ts"], []);
  } finally { rmSync(dir, {recursive:true, force:true}); }
}, 30_000);
