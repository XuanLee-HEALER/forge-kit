import { expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

test("every role reviews the pinned text of deletions, large files, renames and new tests", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-coverage-"));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { maxBuffer: 16_000_000 });
    expect(r.exitCode, r.stderr.toString()).toBe(0);
    return r.stdout.toString().trim();
  };
  try {
    git("init", "-q");
    const expected = new Set<string>();
    const deleted = Array.from({ length: 60 }, (_, i) => "deleted-" + i + ".txt");
    function content(file: string, size: number) {
      return Array.from({ length: size }, (_, i) => {
        const token = "MARK_" + file.replace(/[^a-z0-9]/g, "_") + "_" + i + "_END";
        expected.add(token);
        return token + " fixture material".repeat(4) + "\n";
      }).join("");
    }
    for (const file of deleted) writeFileSync(join(repo, file), content(file, 350));
    writeFileSync(join(repo, "widget.ts"), "export const value = 1;\n");
    writeFileSync(join(repo, "rename-me.txt"), "one unchanged line\n");
    git("add", "--", ...deleted, "widget.ts", "rename-me.txt");
    git("commit", "-qm", "baseline");
    const base = git("rev-parse", "HEAD");
    git("rm", "-q", "--", ...deleted);
    renameSync(join(repo, "rename-me.txt"), join(repo, "renamed.txt"));
    writeFileSync(join(repo, "widget.ts"), "export const value = 2; // MODIFIED_SOURCE\n");
    writeFileSync(join(repo, "widget.test.ts"), "expect(value).toBe(2); // NEW_TEST\n");
    for (let i = 0; i < 18; i++) writeFileSync(join(repo, "added-" + i + ".txt"), content("added" + i, 2));
    writeFileSync(join(repo, "big.txt"), content("big", 18_000));
    git("add", "-u");
    git("add", "--", "renamed.txt", "widget.test.ts", "big.txt", ...Array.from({ length: 18 }, (_, i) => "added-" + i + ".txt"));
    git("commit", "-qm", "large change");
    const head = git("rev-parse", "HEAD");
    expect(Buffer.byteLength(git("diff", "-M", base, head))).toBeGreaterThan(1_572_864);
    const changes = git("diff", "--name-status", "-M", base, head).split("\n");
    expect(changes.length).toBeGreaterThanOrEqual(80);
    expect(changes.filter(line => line.startsWith("D\t"))).toHaveLength(60);
    expect(changes).toContain("R100\trename-me.txt\trenamed.txt");
    writeFileSync(join(repo, "widget.ts"), "DIRTY_WORKTREE_ONLY\n");
    const fake = join(dir, "codex");
    writeFileSync(fake, `#!/usr/bin/env bun
import {appendFileSync,readFileSync} from "node:fs";
const q=JSON.parse(await Bun.stdin.text());
const mode=readFileSync(import.meta.path+".mode","utf8");
const mark = delta => appendFileSync(import.meta.path+".workers", JSON.stringify({role:q.role,delta})+"\\n");
if (mode==="pass") mark(1);
appendFileSync(import.meta.path+".log", JSON.stringify({role:q.role,index:q.index,chunks:q.chunks})+"\\n");
const omitted=c=>q.role==="quality" && c.patch.includes("MARK_deleted_17_txt_175_END");
if(mode==="interrupt" && q.chunks.some(omitted)) process.exit(7);
const partial=mode==="mixed" && q.role==="quality" && q.chunks.some(c=>c.path==="widget.test.ts");
const checked=q.chunks.filter(c=>mode!=="omit" || !omitted(c)).map(({id,path})=>({id,path,conclusion:partial && path==="widget.test.ts"?"incomplete":"reviewed"}));
const source=q.chunks.some(c=>c.path==="widget.ts");
const findings=(mode!=="pass" && source && q.role==="quality") ? [{severity:"blocking",path:"widget.ts",line:1,title:"fixture finding",evidence:"MODIFIED_SOURCE",recommendation:"fix"}] : [];
await Bun.write(process.argv[process.argv.indexOf("-o")+1],JSON.stringify({role:q.role,checked,findings,status:partial?"incomplete":findings.length?"findings":"pass",summary:"fixture",limitations:[]}));
if (mode==="pass") mark(-1);
`, { mode: 0o755 });
    for (const [mode, status, exit] of [["pass", "pass", 0], ["blocked", "blocked", 1], ["omit", "incomplete", 3], ["interrupt", "incomplete", 3], ["mixed", "incomplete", 3]] as const) {
      writeFileSync(fake + ".mode", mode);
      writeFileSync(fake + ".log", "");
      const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/review.ts"), "--base", base, "--head", head,
        "--repo", repo, "--roles", "quality,comments", "--model", "gpt-6.2-sol", "--effort", "medium"],
        { env: { PATH: process.env.PATH, HOME: dir, FORGE_CODEX_BIN: fake }, timeout: 120_000, maxBuffer: 16_000_000 });
      expect(r.exitCode, r.stderr.toString() + r.stdout.toString().slice(0, 1000)).toBe(exit);
      const report = JSON.parse(r.stdout.toString());
      expect(report.roles.find((role: { role: string }) => role.role === "quality").status).toBe(status);
      expect(report.roles.find((role: { role: string }) => role.role === "comments").status).toBe("pass");
      if (mode === "mixed") {
        const quality = report.roles.find((role: { role: string }) => role.role === "quality");
        expect(quality.coverage.missing.map((chunk: { path: string }) => chunk.path)).toEqual(["widget.test.ts"]);
        expect(quality.coverage.reviewed).toBe(quality.coverage.expected - 1);
      }
      if (mode === "omit" || mode === "interrupt") {
        const q = report.roles.find((role: { role: string }) => role.role === "quality");
        expect(q.coverage.missing.some((m: { path: string }) => m.path === "deleted-17.txt")).toBe(true);
        expect(q.coverage.reviewed).toBeLessThan(q.coverage.expected);
        if (mode === "omit") expect(q.coverage.missing).toHaveLength(1);
      }
      type Call = { role: string; index: unknown; chunks: { id: string; path: string; patch: string }[] };
      const calls: Call[] = readFileSync(fake + ".log", "utf8").trim().split("\n").map(row => JSON.parse(row));
      for (const role of ["quality", "comments"]) {
        const batches = calls.filter(call => call.role === role);
        expect(batches.length).toBeGreaterThan(1);
        if (mode === "pass") {
          // 20b5adb delivered all 335 chunks in 94 calls per role on this fixture.
          // The marker checks below verify the payload survives the denser packing.
          expect(batches.length).toBeLessThan(94);
          const schedule = report.roles.find((entry: {role: string}) => entry.role === role).scheduling;
          expect(schedule.backend_calls).toBe(batches.length);
          let active = 0, peak = 0;
          for (const line of readFileSync(fake + ".workers", "utf8").trim().split("\n")) {
            const event = JSON.parse(line);
            if (event.role === role) {
              active += event.delta;
              peak = Math.max(active, peak);
            }
          }
          expect(active).toBe(0);
          expect(peak).toBeGreaterThanOrEqual(1);
          expect(peak).toBeLessThanOrEqual(schedule.concurrency_limit);
        }
        const tokens = new Set<string>();
        for (const batch of batches) {
          expect(JSON.stringify(batch.index)).toContain("deleted-17.txt");
          for (const chunk of batch.chunks) {
            expect(chunk.patch).not.toContain("DIRTY_WORKTREE_ONLY");
            for (const token of chunk.patch.matchAll(/MARK_\w+?_END/g)) tokens.add(token[0]);
          }
        }
        if (mode === "interrupt" && role === "quality") {
          expect(tokens.size).toBeLessThan(expected.size);
          continue;
        }
        expect(tokens.size).toBe(expected.size);
        expect([...expected].find(token => !tokens.has(token))).toBeUndefined();
        expect(batches.some(b => ["widget.ts", "widget.test.ts"].every(file => b.chunks.some(c => c.path === file)))).toBe(true);
        expect(batches.flatMap(b => b.chunks).filter(c => c.path === "big.txt").length).toBeGreaterThan(1);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 360_000);
