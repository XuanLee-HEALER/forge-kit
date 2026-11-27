import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { matchesDefect } from "../scripts/score";
import { join } from "node:path";
import samples from "../evals/quality.json";

test("the offline CLI scores clean and defect samples in each of the four Codex roles", () => {
  const home = mkdtempSync(join(tmpdir(), "paired-evaluation-"));
  const result = Bun.spawnSync([process.execPath, "scripts/evaluate.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      PATH: process.env.PATH, HOME: home, OPENAI_BASE_URL: "http://127.0.0.1:1",
      FORGE_CODEX_BIN: "/fixture/absent", OPENAI_API_KEY: "synthetic-unused"
    },
  });
  rmSync(home, { recursive: true, force: true });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const output = JSON.parse(result.stdout.toString());
  expect(output.evaluation).toBe("offline");
  expect(output.ok).toBe(true);
  expect(output.results).toHaveLength(samples.length * 2);
  for (const { id, role } of samples) {
    for (const kind of ["clean", "defect"]) {
      {
        const backend = "codex";
        expect(output.results).toContainEqual(expect.objectContaining({
          sample: id, kind, backend, ok: true,
          report: expect.objectContaining({
            roles: [expect.objectContaining({
              backend, role, status: kind === "defect" ? "blocked" : "pass",
            })]
          }),
        }));
      }
    }
  }
}, 30_000);

test("unrelated blocking findings on the labeled line do not earn defect credit", () => {
  const unrelated: Record<string, string[]> = {
    business: ["This API is often used in hot paths.", "Log the discount after every ten requests for observability."],
    quality: ["Expose the array length in debug logs.", "Rename denominator to follow the naming convention."],
    simplify: ["Prefer indexOf over includes for compatibility.", "The API name does not describe its O(n) memory usage."],
    comments: ["Document the maximum supported milliseconds and seconds.", "The comment is missing punctuation after seconds."],
  };
  for (const sample of samples) {
    for (const title of unrelated[sample.id]) {
      const finding = {
        severity: "blocking" as const, path: "sample.ts", line: sample.line, title,
        evidence: sample.after.split("\n")[sample.line - 1], recommendation: "Follow the style guide."
      };
      expect(matchesDefect(sample, finding), title).toBe(false);
    }
  }
});

test("quality evaluator identifies false positives on the clean sample and missed defects", () => {
  const home = mkdtempSync(join(tmpdir(), "quality-scoring-"));
  try {
    const fake = join(home, "codex");
    writeFileSync(fake, `#!/usr/bin/env bun
const request=JSON.parse(await Bun.stdin.text());
const clean=request.chunks.some(c=>c.patch.includes("count >= 10"));
const findings=clean?[{severity:"blocking",path:"sample.ts",line:1,title:"False finding",evidence:"count >= 10",recommendation:"inspect"}]:[];
await Bun.write(process.argv[process.argv.indexOf("-o")+1],JSON.stringify({role:request.role,status:findings.length?"findings":"pass",checked:request.chunks.map(({id,path})=>({id,path,conclusion:"reviewed"})),findings,summary:"fixture",limitations:[]}));
`, { mode: 0o755 });
    // The live-mode orchestration receives only our local executable and synthetic inputs.
    const r = Bun.spawnSync([process.execPath, "scripts/evaluate.ts", "--live", "--sample=business"], {
      cwd: join(import.meta.dir, ".."), env: { PATH: process.env.PATH, HOME: home, FORGE_CODEX_BIN: fake }
    });
    expect(r.exitCode, r.stderr.toString()).toBe(1);
    const report = JSON.parse(r.stdout.toString());
    expect(report.ok).toBe(false);
    expect(report.results).toHaveLength(2);
    for (const row of report.results) {
      expect(row.ok).toBe(false);
      expect(row.report.status).toBe(row.kind === "clean" ? "blocked" : "pass");
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});
