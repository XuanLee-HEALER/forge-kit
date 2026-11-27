import { enterVerificationScope } from "./verification-scope";
import { defaultVerificationTimeout, VerificationLog, verificationLogDirectory } from "./verification-log";
import { redactArguments, redactSecrets } from "./shared/redact";
import { copyVerificationFixtures } from "./verification-fixtures";
import { checkMigration } from "./managed-assets";
import { checkoutLocalRevision, materializeGitlinks } from "./verification-gitlinks";
import { verificationReuseKey } from "./verification-reuse";
import { installedInstance, verificationPolicy } from "./workflow-config";
import { createHash } from "node:crypto";
import { runVerificationProcess } from "./verification-process";
import { join, resolve } from "node:path";
import { mkdtempSync, mkdirSync, existsSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { runProcess } from "./git";
import { usesV05 } from "./ledger/types";
import { resolveInstance, runInstanceStage, verificationStageCwd } from "./instance";
import { isVerificationCommand, type VerificationKind as Kind } from "./verify-command";
import { parseArgs } from "node:util";
import { findWorkbenchRoot } from "./config";
import { runLangChecks, type CheckMode } from "./lang-check";
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
      offline: { type: "boolean" },
      "fixture-env": { type: "string", multiple: true },
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
    throw Error("Use --mode all for the configured verification stages, --mode static|dynamic to filter built-in checks (configured actions still run), or --kind lint|test|build|hurl -- <command> [args...] for a recognized runner");
  const root = findWorkbenchRoot(values.cwd);
  checkMigration(root);
  const ledger = new Ledger(root);
  let temporary: string | undefined;
  let recordAborted: ((error: unknown) => Error) | undefined;
  const logs = new Map<string, VerificationLog>();
  try {
    const snap = executionSnapshot(ledger, values);
    const modern = usesV05(ledger, snap.task_id);
    let dir = snap.dir;
    let baseEnv: NodeJS.ProcessEnv | undefined;
    const scopes = enterVerificationScope(root, {task: snap.task_id, head: snap.head});
    let logDir: string | undefined;
    function log(key: string) {
      let journal = logs.get(key);
      if (!journal) {
        journal = new VerificationLog(logDir ??= verificationLogDirectory(root, 7, snap.task_id));
        logs.set(key, journal);
      }
      return journal;
    }
    function finishLog(key: string, failed: boolean) {
      const meta = log(key).finish(failed, fullRun && (key === "dynamic" || key === "static"));
      logs.delete(key);
      return meta;
    }
    const started = Date.now();
    const results: { kind: Kind | "verify"; stage?: string; action?: string; options_sha256?: string; command: string[]; exit_code: number; output_sha256: string; output_excerpt?: string; log_path?: string }[] = [];
    let environment: string | undefined;
    let fixtures: ReturnType<typeof copyVerificationFixtures> | undefined;
    const fixtureMetadata = () => fixtures ? { fixture_sha256: fixtures.digests } : {};
    let policyDigest: string | undefined;
    let reuseKey: string | undefined;
    const fullRun = modern && !kind && mode === "all";
    let phase = "checkout preparation";
    const recordRun = (passed: boolean, aborted = false) => ledger.recordEvidence({
      task_id: snap.task_id, repo: snap.repo, branch: snap.branch, sha: snap.head, kind: "verify",
      source: "tool", actor: "tool", status: passed ? "pass" : "fail",
      summary: aborted ? "Verification failed during " + phase : "Configured verification stages",
      meta: { mode, ...(reuseKey && {reuse_key: reuseKey}), ...fixtureMetadata(), ...(environment && {environment}), ...(policyDigest && {policy_sha256:policyDigest}), stages: results, review_task_id: snap.task_id,
        freeze_seq: snap.freeze_seq, started_at: new Date(started).toISOString(), duration_ms: Date.now() - started,
        ...(aborted && { startup_failure: true, failed_phase: phase }) },
    });
    function saveReceipt(write: () => void) {
      try { ledger.db.transaction(write).immediate(); }
      catch (error) {
        const cause = redactSecrets(error instanceof Error ? error.message : String(error));
        const paths = results.filter(r => r.log_path).map(r =>
          (r.stage ?? r.kind) + " (exit " + r.exit_code + "): " + r.output_excerpt + "\n" + r.log_path);
        throw Error([...paths, "Cannot save verification receipt: " + cause].join("\n"));
      }
    }
    recordAborted = (error) => {
      const message = redactSecrets(error instanceof Error ? error.message : String(error));
      const key = logs.has(phase) ? phase : [...logs.keys()].at(-1) ?? phase;
      log(key).note(message);
      const failure = finishLog(key, true);
      results.push({kind: "verify", stage: phase, command: ["forge", "verify"], exit_code: 1, ...failure});
      if (snap.freeze_seq) saveReceipt(() => {
        recheckExecution(ledger, snap);
        if (fullRun) recordRun(false, true);
        else ledger.recordEvidence({
          task_id: snap.task_id, repo: snap.repo, branch: snap.branch, sha: snap.head, kind: kind ?? "verify",
          source: "tool", actor: "tool", status: "fail", summary: "Verification failed during " + phase,
          meta: { ...failure, stage: phase, exit_code: 1, freeze_seq: snap.freeze_seq, review_task_id: snap.task_id, mode },
        });
      });
      return Error(phase + " (exit 1): " + failure.output_excerpt + "\n" + failure.log_path);
    };
    phase = "instance configuration";
    const config = modern ? (kind ? installedInstance(root) : resolveInstance(root)) : undefined;
    const timeoutMs = config?.verification.value.timeout_ms ?? defaultVerificationTimeout;
    logDir = verificationLogDirectory(root, config?.verification.value.failure_log_retention_days ?? 7, snap.task_id);
    phase = "checkout preparation";
    function isolatedGit(cwd: string, args: string[]) {
      if (!baseEnv) throw Error("Missing isolated verification environment");
      const result = runProcess(["git", "-c", "core.hooksPath=/dev/null", ...args], {
        cwd, timeoutMs, env: { ...baseEnv, GIT_CONFIG_GLOBAL: "/dev/null", GIT_ALLOW_PROTOCOL: "file", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" },
      });
      if (result.code) log(phase).note(result.stdout + "\n" + result.stderr);
      return result;
    }
    if (modern) {
      if (!snap.freeze_seq) throw Error("Freeze the confirmed specification before verification");
      temporary = realpathSync(mkdtempSync(join(tmpdir(), "forge-verify-")));
      dir = join(temporary, "checkout");
      const home = join(temporary, "home");
      mkdirSync(home, { mode: 0o700 });
      baseEnv = { PATH: process.env.PATH, LANG: process.env.LANG, HOME: home, TMPDIR: temporary,
        FORGE_VERIFICATION_SCOPES: scopes, FORGE_VERIFY_ACTIVE_SHA: snap.head, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
      mkdirSync(dir);
      checkoutLocalRevision(snap.dir, dir, snap.head, isolatedGit);
      phase = "gitlink preparation";
      materializeGitlinks(snap.dir, dir, snap.head, isolatedGit);
      phase = "dependency installation";
      if (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"))) {
        const cache = process.env.BUN_INSTALL_CACHE_DIR;
        const installArgs = [process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"];
        if (cache) installArgs.push("--cache-dir", resolve(cache), "--backend=copyfile");
        if (values.offline) installArgs.push("--offline");
        const install = log(phase).run(installArgs, dir, baseEnv, timeoutMs);
        if (install.code) throw Error("Cannot install locked verification dependencies (exit " + install.code + ")");
        finishLog(phase, false);
      }
    }
    baseEnv ??= {...process.env, FORGE_VERIFICATION_SCOPES: scopes};
    if (values["fixture-env"]?.length) {
      if (!temporary || !baseEnv) throw Error("--fixture-env requires an isolated v0.5 verification checkout");
      phase = "fixture preparation";
      fixtures = copyVerificationFixtures(temporary, values["fixture-env"]);
      Object.assign(baseEnv, fixtures.env);
    }
    let skipped = false;
    const skippedPhases = new Set<string>();
    if (kind) {
      phase = kind;
      if (!isVerificationCommand(kind, argv, dir, snap.head, baseEnv))
        throw Error("Expected an executable verification runner for " + kind);
      const child = runVerificationProcess(argv, kind === "test", {cwd: dir, baseEnv, timeoutMs, log: log(phase)});
      skipped = child.noTests;
      if (skipped) {
        skippedPhases.add(phase);
        log(phase).note("No applicable checks executed for a requested phase");
      }
      if (child.stderr) log(phase).note(child.stderr);
      results.push({kind, stage: phase, command: redactArguments(argv), exit_code: skipped ? 1 : child.code,
        ...finishLog(phase, skipped || child.code !== 0)});
    } else {
      phase = "instance configuration";
      environment = config?.verification.value.environment;
      if (config) policyDigest = verificationPolicy(ledger.workbenchRoot, snap.repo, snap.head, config, dir);
      if (fullRun && policyDigest) {
        reuseKey = verificationReuseKey(policyDigest, Boolean(values.offline), fixtures?.digests ?? {});
        const receipt = ledger.db.query<{seq: number; payload_json: string}, [string,string,string,string,number]>(
          `SELECT seq,payload_json FROM events WHERE task_id=? AND repo=? AND branch=? AND sha=? AND seq>?
           AND event_type='EVIDENCE_CAPTURED' AND actor='tool'
           AND (json_extract(payload_json,'$.kind')='verify' OR
             (json_extract(payload_json,'$.kind') IN ('lint','test','build') AND json_extract(payload_json,'$.status')='fail'))
           ORDER BY seq DESC LIMIT 1`
        ).get(snap.task_id, snap.repo, snap.branch, snap.head, snap.freeze_seq!);
        const prior = receipt && JSON.parse(receipt.payload_json);
        if (prior?.kind === "verify" && prior.status === "pass" && prior.meta?.reuse_key === reuseKey) {
          recheckExecution(ledger, snap);
          return {ok: true, reused: true, receipt_seq: receipt!.seq, task_id: snap.task_id, head: snap.head, results: prior.meta.stages};
        }
      }
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
          const code = runInstanceStage(ledger.workbenchRoot, stage, { checkout: dir, head: snap.head, task: snap.task_id, repo: snap.repo, config, env: baseEnv, log: log(phase) });
          results.push({ kind: "verify", stage, action: custom.value.action, command: ["forge", "instance", "run", stage],
            options_sha256: createHash("sha256").update(JSON.stringify([action.value, custom.value.options])).digest("hex"),
            exit_code: code, ...finishLog(phase, code !== 0) });
          if (code !== 0) break;
          continue;
        }
        if (stage !== "verify") throw Error("Core stage cannot run as verification: " + stage);
        const report = runLangChecks({
          targetDir: dir,
          baseEnv,
          mode,
          timeoutMs,
          log: key => { phase = key; return log(key); },
        });
        for (const phase of ["static", "dynamic"] as const) {
          if (mode !== "all" && mode !== phase) continue;
          const checks = report.checks.filter((c) => c.phase === phase && c.status !== "skipped");
          if (!checks.length) {
            skipped = true;
            skippedPhases.add(phase);
            log(phase).note("No applicable checks executed for a requested phase");
          }
          const failure = checks.find(check => check.status === "fail");
          if (failure) log(phase).note([failure.name, "exit", failure.exit_code ?? 1, failure.output_excerpt].filter(Boolean).join(" "));
          const code = failure?.exit_code || (!checks.length || failure ? 1 : 0);
          results.push({kind: phase === "static" ? "lint" : "test", stage: phase,
            command: ["forge", "lang-check", "--mode", phase], exit_code: code, ...finishLog(phase, code !== 0)});
        }
        if (skipped || results.some(item => item.exit_code)) break;
      }
    }
    fixtures?.verify();
    if (modern) {
      const current = isolatedGit(dir, ["rev-parse", "HEAD"]);
      const changes = isolatedGit(dir, ["status", "--porcelain", "--untracked-files=no", "--ignore-submodules=untracked"]);
      if (current.code || current.stdout.trim() !== snap.head || changes.code || changes.stdout)
        throw Error("Verification changed the isolated checkout revision or tracked inputs");
    }
    if (policyDigest) {
      const current = resolveInstance(ledger.workbenchRoot);
      if (verificationPolicy(ledger.workbenchRoot, snap.repo, snap.head, current, dir) !== policyDigest)
        throw Error("Configured verification inputs changed during this run");
    }
    recordAborted = undefined;
    const ok = !skipped && results.length > 0 && results.every(r => !r.exit_code);
    saveReceipt(() => {
      recheckExecution(ledger, snap);
      for (const { kind, ...meta } of results.filter(r => r.kind !== "verify" && (modern || !skippedPhases.has(r.stage!))))
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
            ...fixtureMetadata(),
            duration_ms: Date.now() - started,
            started_at: new Date(started).toISOString(),
            review_task_id: snap.task_id,
            review_floor_seq: snap.floors.review,
          },
        });
      if (fullRun || (!ok && results.some(item => item.kind === "verify"))) recordRun(ok);
    });
    return {
      ok,
      task_id: snap.task_id,
      head: snap.head,
      results,
      ...(skipped ? { error: "No applicable checks executed for a requested phase" } : {}),
    };
  } catch (error) {
    throw recordAborted ? recordAborted(error) : error;
  } finally {
    for (const journal of logs.values()) journal.dispose();
    ledger.closeDb();
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}
