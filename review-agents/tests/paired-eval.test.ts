import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { matchesDefect } from "../scripts/score";
import { join } from "node:path";
import samples from "../evals/paired.json";

test("the offline CLI scores each paired sample through each simulated provider", () => {
  const home = mkdtempSync(join(tmpdir(), "paired-evaluation-"));
  const result = Bun.spawnSync([process.execPath, "scripts/evaluate.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: { PATH: process.env.PATH, HOME: home, OPENAI_BASE_URL: "http://127.0.0.1:1",
      FORGE_CODEX_BIN: "/fixture/absent", OPENAI_API_KEY: "synthetic-unused" },
  });
  rmSync(home, {recursive:true, force:true});
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const output = JSON.parse(result.stdout.toString());
  expect(output.evaluation).toBe("offline");
  expect(output.ok).toBe(true);
  expect(output.results).toHaveLength(samples.length * 4);
  for (const {id, role} of samples) {
    for (const kind of ["clean", "defect"]) {
      for (const backend of ["api", "codex"]) {
        expect(output.results).toContainEqual(expect.objectContaining({
          sample: id, kind, backend, ok: true,
          report: expect.objectContaining({roles: [expect.objectContaining({
            backend, role, status: kind === "defect" ? "blocked" : "pass",
          })]}),
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
      const finding = {severity: "blocking" as const, path: "sample.ts", line: sample.line, title,
        evidence: sample.after.split("\n")[sample.line - 1], recommendation: "Follow the style guide."};
      expect(matchesDefect(sample, finding), title).toBe(false);
    }
  }
});
