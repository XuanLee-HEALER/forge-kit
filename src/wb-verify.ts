import { createHash } from "node:crypto";
import { runVerificationProcess } from "./verification-process";
import { basename } from "node:path";
import { isVerificationCommand, type VerificationKind as Kind } from "./verify-command";
import { parseArgs } from "node:util";
import { findWorkbenchRoot } from "./config";
import { zeroTestRun, runLangChecks, type CheckMode } from "./lang-check";
import { executionSnapshot, recheckExecution, targetOptions } from "./ledger/execution";
import { Ledger } from "./ledger/store";

export function verifyCli(args: string[]) {
  const split = args.indexOf("--");
  const argv = split < 0 ? [] : args.slice(split + 1);
  const { values } = parseArgs({
    args: split < 0 ? args : args.slice(0, split),
    options: {
      ...targetOptions,
      mode: { type: "string" },
      kind: { type: "string" },
    },
  });
  const kind = values.kind as Kind | undefined,
    mode = (values.mode ?? "all") as CheckMode;
  if (
    !["static", "dynamic", "all"].includes(mode) ||
    ((split >= 0 || kind !== undefined) &&
      (!argv.length || !kind || !["lint", "test", "build", "hurl"].includes(kind) || values.mode))
  )
    throw Error("Use --mode static|dynamic|all or --kind lint|test|build|hurl -- <command> [args...]");
  const ledger = new Ledger(findWorkbenchRoot(values.cwd));
  try {
    const snap = executionSnapshot(ledger, values);
    const started = Date.now();
    const results: { kind: Kind; command: string[]; exit_code: number; output_sha256: string }[] = [];
    let skipped = false;
    function result(k: Kind, command: string[], code: number, output_sha256: string) {
      results.push({ kind: k, command, exit_code: code, output_sha256 });
    }
    if (kind) {
      if (!isVerificationCommand(kind, argv, snap.dir, snap.head))
        throw Error("Expected an executable verification runner for " + kind);
      const hash = createHash("sha256");
      const child = runVerificationProcess(argv, kind === "test", {
        cwd: snap.dir,
        timeoutMs: 0,
        onOutput(stdout, stderr) {
          hash.update(stdout).update(stderr);
        },
      });
      if (child.noPytestCalls || (kind === "test" && zeroTestRun(basename(argv[0]), child.code, child.stdout + "\n" + child.stderr)))
        skipped = true;
      else result(kind, argv, child.code, hash.digest("hex"));
    } else {
      const hashes = { static: createHash("sha256"), dynamic: createHash("sha256") };
      const report = runLangChecks({
        targetDir: snap.dir,
        mode,
        onOutput(phase, stdout, stderr) {
          hashes[phase].update(stdout).update(stderr);
        },
      });
      for (const phase of ["static", "dynamic"] as const) {
        if (mode !== "all" && mode !== phase) continue;
        const checks = report.checks.filter((c) => c.phase === phase && c.status !== "skipped");
        if (!checks.length) {
          skipped = true;
          continue;
        }
        result(
          phase === "static" ? "lint" : "test",
          ["lang-check", "--mode", phase],
          checks.some((c) => c.status === "fail") ? 1 : 0,
          hashes[phase].digest("hex"),
        );
      }
    }
    ledger.db
      .transaction(() => {
        recheckExecution(ledger, snap);
        for (const { kind, ...meta } of results)
          ledger.recordEvidence({
            task_id: snap.task_id,
            repo: snap.repo,
            branch: snap.branch,
            sha: snap.head,
            kind,
            source: "tool",
            actor: "tool",
            status: meta.exit_code ? "fail" : "pass",
            summary: kind + " verification",
            meta: {
              ...meta,
              duration_ms: Date.now() - started,
              started_at: new Date(started).toISOString(),
              review_task_id: snap.task_id,
              review_floor_seq: snap.floors.review,
            },
          });
      })
      .immediate();
    return {
      ok: !skipped && results.every((r) => !r.exit_code),
      task_id: snap.task_id,
      head: snap.head,
      results,
      ...(skipped ? { error: "No applicable checks executed for a requested phase" } : {}),
    };
  } finally {
    ledger.closeDb();
  }
}
