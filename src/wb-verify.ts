import { checkMigration } from "./managed-assets";
import { verificationPolicy } from "./workflow-config";
import { createHash } from "node:crypto";
import { runVerificationProcess } from "./verification-process";
import { basename, join, resolve } from "node:path";
import { mkdtempSync, mkdirSync, existsSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { runGit, runProcess } from "./git";
import { usesV05 } from "./ledger/types";
import { resolveInstance, runInstanceStage, verificationStageCwd } from "./instance";
import { findKitRoot } from "./kit-root";
import { isVerificationCommand, type VerificationKind as Kind } from "./verify-command";
import { parseArgs } from "node:util";
import { findWorkbenchRoot } from "./config";
import { zeroTestRun, runLangChecks, type CheckMode } from "./lang-check";
import { executionSnapshot, recheckExecution, targetOptions } from "./ledger/execution";
import { Ledger } from "./ledger/store";

export function verifyCli(args: string[]) {
  if (process.env.FORGE_ACTIVE_STAGE) throw Error("A configured stage cannot recursively run forge verify");
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
  const root = findWorkbenchRoot(values.cwd);
  checkMigration(root);
  const ledger = new Ledger(root);
  let temporary: string | undefined;
  let recordAborted: (() => void) | undefined;
  try {
    const snap = executionSnapshot(ledger, values);
    const modern = usesV05(ledger, snap.task_id);
    let dir = snap.dir;
    let baseEnv: NodeJS.ProcessEnv | undefined;
    if (process.env.FORGE_VERIFY_ACTIVE_SHA === snap.head) throw Error("Recursive verification of the same commit");
    const started = Date.now();
    const results: { kind: Kind | "verify"; stage?: string; action?: string; options_sha256?: string; command: string[]; exit_code: number; output_sha256: string }[] = [];
    let environment: string | undefined;
    let policyDigest: string | undefined;
    const fullRun = modern && !kind && mode === "all";
    let phase = "checkout preparation";
    const recordRun = (passed: boolean, aborted = false) => ledger.recordEvidence({
      task_id: snap.task_id, repo: snap.repo, branch: snap.branch, sha: snap.head, kind: "verify",
      source: "tool", actor: "tool", status: passed ? "pass" : "fail",
      summary: aborted ? "Verification failed during " + phase : "Configured verification stages",
      meta: { mode, ...(environment && {environment}), ...(policyDigest && {policy_sha256:policyDigest}), stages: results, review_task_id: snap.task_id,
        freeze_seq: snap.freeze_seq, started_at: new Date(started).toISOString(), duration_ms: Date.now() - started,
        ...(aborted && { startup_failure: true, failed_phase: phase }) },
    });
    if (fullRun && snap.freeze_seq) {
      recordAborted = () => ledger.db.transaction(() => {
        recheckExecution(ledger, snap);
        recordRun(false, true);
      }).immediate();
    }
    if (modern) {
      if (!snap.freeze_seq) throw Error("Freeze the confirmed specification before verification");
      temporary = realpathSync(mkdtempSync(join(tmpdir(), "forge-verify-")));
      dir = join(temporary, "checkout");
      const home = join(temporary, "home");
      mkdirSync(home, { mode: 0o700 });
      baseEnv = { PATH: process.env.PATH, LANG: process.env.LANG, HOME: home, TMPDIR: temporary,
        FORGE_VERIFY_ACTIVE_SHA: snap.head, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
      const clone = runGit(temporary, ["clone", "--no-local", "--no-checkout", "--", snap.dir, dir]);
      if (clone.code) throw Error("Cannot isolate verification checkout: " + clone.stderr);
      const checkout = runGit(dir, ["-c", "advice.detachedHead=false", "checkout", "--detach", snap.head]);
      if (checkout.code) throw Error("Cannot select verification version: " + checkout.stderr);
      if (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"))) {
        const cache = process.env.BUN_INSTALL_CACHE_DIR;
        const installArgs = [process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"];
        if (cache) installArgs.push("--cache-dir", resolve(cache), "--offline", "--backend=copyfile");
        const install = runProcess(installArgs, { cwd: dir, env: baseEnv, timeoutMs: 120_000 });
        if (install.code) throw Error("Cannot install locked verification dependencies: " + install.stderr);
      }
    }
    let skipped = false;
    function result(k: Kind, command: string[], code: number, output_sha256: string) {
      results.push({ kind: k, command, exit_code: code, output_sha256 });
    }
    if (kind) {
      if (!isVerificationCommand(kind, argv, dir, snap.head))
        throw Error("Expected an executable verification runner for " + kind);
      const hash = createHash("sha256");
      const child = runVerificationProcess(argv, kind === "test", {
        cwd: dir,
        baseEnv,
        timeoutMs: 0,
        onOutput(stdout, stderr) {
          hash.update(stdout).update(stderr);
        },
      });
      if (child.noPytestCalls || (kind === "test" && zeroTestRun(basename(argv[0]), child.code, child.stdout + "\n" + child.stderr)))
        skipped = true;
      else result(kind, argv, child.code, hash.digest("hex"));
    } else {
      phase = "instance configuration";
      const config = modern ? resolveInstance(ledger.workbenchRoot, findKitRoot()) : undefined;
      environment = config?.verification.value.environment;
      if (config) policyDigest = verificationPolicy(ledger.workbenchRoot, snap.repo, snap.head, config);
      const stages = config?.verification.value.stages ?? ["verify"];
      if (config) {
        for (const id of stages) {
          const stage = config.stages.get(id);
          const action = stage && stage.source !== "core" && config.actions.get(stage.value.action);
          if (action) verificationStageCwd(ledger.workbenchRoot, snap.repo, dir, action.value.cwd, config.repos);
        }
      }
      for (const stage of stages) {
        phase = "stage " + stage;
        const custom = config?.stages.get(stage);
        if (custom?.source !== "core" && config && custom) {
          const action = config.actions.get(custom.value.action);
          if (!action) throw Error("Missing verification action for stage " + stage);
          const hash = createHash("sha256");
          const code = runInstanceStage(ledger.workbenchRoot, findKitRoot(), stage, { checkout: dir, head: snap.head, repo: snap.repo, config },
            (stdout, stderr) => { hash.update(stdout).update(stderr); });
          results.push({ kind: "verify", stage, action: custom.value.action, command: ["forge", "instance", "run", stage],
            options_sha256: createHash("sha256").update(JSON.stringify([action.value, custom.value.options])).digest("hex"),
            exit_code: code, output_sha256: hash.digest("hex") });
          if (code !== 0) break;
          continue;
        }
        if (stage !== "verify") throw Error("Core stage cannot run as verification: " + stage);
        const hashes = { static: createHash("sha256"), dynamic: createHash("sha256") };
        const report = runLangChecks({
          targetDir: dir,
          baseEnv,
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
            ["forge", "lang-check", "--mode", phase],
            checks.some((c) => c.status === "fail") ? 1 : 0,
            hashes[phase].digest("hex"),
          );
        }
        if (skipped || results.some(item => item.exit_code)) break;
      }
    }
    if (modern) {
      const current = runGit(dir, ["rev-parse", "HEAD"]);
      const changes = runGit(dir, ["status", "--porcelain", "--untracked-files=no"]);
      if (current.code || current.stdout.trim() !== snap.head || changes.code || changes.stdout)
        throw Error("Verification changed the isolated checkout revision or tracked inputs");
    }
    if (policyDigest) {
      const current = resolveInstance(ledger.workbenchRoot, findKitRoot());
      if (verificationPolicy(ledger.workbenchRoot, snap.repo, snap.head, current) !== policyDigest)
        throw Error("Configured verification inputs changed during this run");
    }
    recordAborted = undefined;
    const ok = !skipped && results.length > 0 && results.every(r => !r.exit_code);
    ledger.db
      .transaction(() => {
        recheckExecution(ledger, snap);
        for (const { kind, ...meta } of results.filter(r => r.kind !== "verify"))
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
        if (fullRun) recordRun(ok);
      })
      .immediate();
    return {
      ok,
      task_id: snap.task_id,
      head: snap.head,
      results,
      ...(skipped ? { error: "No applicable checks executed for a requested phase" } : {}),
    };
  } catch (error) {
    recordAborted?.();
    throw error;
  } finally {
    ledger.closeDb();
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}
