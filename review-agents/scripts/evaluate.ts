import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cases from "../evals/quality.json";
import { runReview } from "../src/engine";

import { matchesDefect } from "./score";
import { offlineCodex } from "./offline";

const live = process.argv.includes("--live");
const onlySample = process.argv.find(arg => arg.startsWith("--sample="))?.slice(9);
if (onlySample && !cases.some(c => c.id === onlySample)) throw Error("Unknown evaluation sample");
const root = mkdtempSync(join(tmpdir(), "review-eval-"));
const results: Array<{ sample: string; kind: string; backend: string; ok: boolean; report: Awaited<ReturnType<typeof runReview>> }> = [];
if (!live) offlineCodex(root);
const model = {model:"gpt-6.2-sol",effort:"medium"};
try {
  for (const sample of cases.filter(c => !onlySample || c.id === onlySample)) {
    const repo = join(root, sample.id);
    mkdirSync(repo);
    function git(...args: string[]) {
      const p = Bun.spawnSync(["git", "-C", repo, "-c", "user.name=Review fixture", "-c", "user.email=review@example.invalid", "-c", "commit.gpgsign=false", ...args], {
        env: { ...process.env, GIT_AUTHOR_DATE: "2024-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2024-01-01T00:00:00Z" } });
      if (p.exitCode !== 0) throw Error(p.stderr.toString());
      return p.stdout.toString().trim();
    }
    git("init", "-q");
    const file = join(repo, "sample.ts");
    const spec = join(root, sample.id + ".md");
    writeFileSync(spec, sample.spec);
    git("commit", "--allow-empty", "-qm", "baseline");
    const base = git("rev-parse", "HEAD");
    for (const kind of ["clean", "defect"]) {
      writeFileSync(file, (kind === "clean" ? sample.before : sample.after) + "\n");
      git("add", "--", "sample.ts");
      git("commit", "-qm", kind);
      const head = git("rev-parse", "HEAD");
      const report = await runReview({ repo, spec, base, head, roles: sample.role, model });
      const role = report.roles[0];
      const match = role.findings.some(f => matchesDefect(sample, f));
      const ok = role.backend === "codex" && (kind === "defect" ? role.status === "blocked" && match : role.status === "pass" && !role.findings.length);
      results.push({ sample: sample.id, kind, backend:"codex", ok, report });
      process.stderr.write([sample.id, kind, role.status].join(" ") + "\n");
    }
  }
  const ok = results.every(r => r.ok);
  console.log(JSON.stringify({ version: 1, evaluation: live ? "live" : "offline", ok, results }, null, 2));
  process.exitCode = ok ? 0 : 1;
} finally { rmSync(root, { recursive: true, force: true }); }
