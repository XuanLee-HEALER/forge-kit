import { existsSync, mkdirSync, writeFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { findWorkbenchRoot, loadModelsConfig } from "./config";
import { checkoutEnvironment, runGit } from "./git";
import { executionSnapshot, recheckExecution, targetOptions } from "./ledger/execution";
import { readOnlyRoleReview, reviewAgentDirectories } from "./ledger/review-fallback";
import { Ledger } from "./ledger/store";

const tiers = { quality: "deep", performance: "deep", simplify: "standard", comments: "mechanical" } as const;

export async function reviewCli(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      ...targetOptions,
      base: { type: "string" },
      roles: { type: "string" },
      "no-fallback": { type: "boolean" },
    },
  });
  const requested = (values.roles ?? "quality,performance,simplify,comments")
    .split(",")
    .map((r) => (r === "perf" ? "performance" : r));
  if (!requested.every((r) => Object.hasOwn(tiers, r)) || new Set(requested).size !== requested.length)
    throw Error("Invalid or repeated review role");
  const roles = requested as (keyof typeof tiers)[];
  const root = findWorkbenchRoot(values.cwd),
    ledger = new Ledger(root);
  const tmp = mkdtempSync(join(tmpdir(), "forge-roles-"));
  try {
    const snap = executionSnapshot(ledger, values);
    const { task_id, repo, head, dir, base } = snap;
    if (
      !base ||
      !/^[a-f0-9]{40,64}$/i.test(base) ||
      runGit(dir, ["merge-base", "--is-ancestor", base, head]).code ||
      (values.base !== undefined &&
        (!/^[a-f0-9]{7,64}$/i.test(values.base) ||
          runGit(dir, ["rev-parse", "--verify", values.base + "^{commit}"]).stdout.trim() !== base))
    )
      throw Error("Expected the attached review base, an ancestor of HEAD");
    const config = loadModelsConfig(root);
    const candidates = reviewAgentDirectories(root);
    const jobs = roles.map(async (role) => {
      const started_at = new Date().toISOString();
      let execution_id: string = crypto.randomUUID();
      const model = config.tiers[tiers[role]],
        out = join(tmp, role + ".json");
      let findings: unknown[] = [],
        original: unknown;
      let exit_code: number | null = null,
        report_status: string | null = null,
        error_code: string | null = null;
      let passed = false,
        fallback_used = false,
        findings_count = 0,
        summary = "",
        usedModel = model.model;
      try {
        const runner = candidates
          .flatMap((d) => [join(d, "dist", "review-" + role + ".js"), join(d, "dist", role + ".js")])
          .find((p) => existsSync(p));
        if (!runner) throw Error("Missing role runner for " + role);
        const child = Bun.spawn(
          [
            process.execPath,
            runner,
            "--repo",
            dir,
            "--base",
            base,
            "--head",
            head,
            "--model",
            model.model,
            "--effort",
            model.effort,
            "--task-id",
            task_id,
            "--floor-seq",
            String(snap.floors.review),
            "--task",
            join(tmp, role),
            "--out",
            out,
          ],
          {
            cwd: dir,
            env: {
              ...checkoutEnvironment(),
              FORGE_WORKBENCH_ROOT: root,
              ...(process.env.REVIEW_CONFIG ? { REVIEW_CONFIG: resolve(process.env.REVIEW_CONFIG) } : {}),
              FORGE_MODELS_TOML: resolve(process.env.FORGE_MODELS_TOML || join(root, ".workbench/models.toml")),
            },
            stdout: "ignore",
            stderr: "inherit",
          },
        );
        const code = (exit_code = await child.exited);
        const report = JSON.parse(readFileSync(out, "utf8"));
        if (
          report.role !== role ||
          report.base !== base ||
          report.head !== head ||
          report.reviewTaskId !== task_id ||
          report.reviewFloorSeq !== snap.floors.review ||
          report.repo !== dir
        )
          throw Error("Role report does not match launch binding");
        original = report;
        report_status = typeof report.status === "string" ? report.status : null;
        error_code = typeof report.errorCode === "string" ? report.errorCode : null;
        if (
          typeof report.reviewExecution?.id === "string" &&
          /^[a-zA-Z0-9_-]{1,100}$/.test(report.reviewExecution.id)
        )
          execution_id = report.reviewExecution.id;
        findings = Array.isArray(report.findings) ? report.findings : [];
        findings_count = findings.length;
        passed =
          code === 0 &&
          report.status === "pass" &&
          Array.isArray(report.findings) &&
          report.findings.every((f: { severity?: string }) => f?.severity === "suggestion");
        summary = String(report.summary ?? report.status);
        if (
          code === 2 &&
          report.status === "error" &&
          report.errorCode === "credit_balance_exhausted" &&
          !values["no-fallback"]
        ) {
          recheckExecution(ledger, snap);
          fallback_used = true;
          usedModel = config.tiers.standard.model;
          const fallback = readOnlyRoleReview(
            dirname(dirname(runner)),
            dir,
            role,
            base,
            head,
            config.tiers.standard,
            true,
          );
          findings = fallback.findings!;
          findings_count = findings.length;
          passed = fallback.passed;
          summary = fallback.report;
        }
      } catch (err) {
        summary = String(err);
      }
      const report_path = join(root, ".workbench/ledger/reviews", task_id, execution_id + "-" + role + ".json");
      return {
        original,
        findings,
        report_path,
        role,
        status: passed ? ("pass" as const) : ("fail" as const),
        summary,
        meta: {
          role,
          base,
          head,
          execution_id,
          started_at,
          review_task_id: task_id,
          review_floor_seq: snap.floors.review,
          findings_count,
          exit_code,
          report_status,
          error_code,
          credit_balance_exhausted:
            exit_code === 2 && report_status === "error" && error_code === "credit_balance_exhausted",
          report_path,
          fallback_used,
          model: usedModel,
        },
      };
    });
    const completed = await Promise.all(jobs);
    const results = completed.map(({ original, ...result }) => {
      mkdirSync(dirname(result.report_path), { recursive: true });
      writeFileSync(result.report_path, JSON.stringify({ ...result, provider_report: original }, null, 2), {
        mode: 0o600,
      });
      return result;
    });
    ledger.db
      .transaction(() => {
        recheckExecution(ledger, snap);
        for (const r of results)
          ledger.recordEvidence({
            task_id,
            repo,
            branch: snap.branch,
            sha: head,
            actor: "tool",
            source: "tool",
            kind: "review",
            status: r.status,
            summary: r.summary,
            meta: r.meta,
            tool_use_id: "review-execution:" + r.meta.execution_id,
          });
      })
      .immediate();
    return { ok: results.every((r) => r.status === "pass"), task_id, repo, base, head, roles: results };
  } finally {
    ledger.closeDb();
    rmSync(tmp, { recursive: true, force: true });
  }
}
