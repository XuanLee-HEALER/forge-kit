import { beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { runGit } from "../../src/git";
import { Ledger } from "../../src/ledger";
import { isolateHome } from "./hermetic";

// The outer verification process instruments its checkout. Each fixture has
// its own checkout and must let its verifier install the matching observers.
function childEnvironment(root: string, overrides: NodeJS.ProcessEnv) {
  const env = { ...process.env };
  const parentDirs = [env.FORGE_VERIFY_PROJECT_MODULE, env.FORGE_VERIFY_CARGO_MODULE]
    .filter((path): path is string => Boolean(path)).map(path => dirname(path));
  if (env.FORGE_VERIFY_CHECKOUT) {
    for (const key of Object.keys(env)) if (key.startsWith("FORGE_VERIFY_")) delete env[key];
    for (const key of ["BUN_OPTIONS", "NODE_OPTIONS", "PYTEST_PLUGINS", "PYTHONPATH"]) delete env[key];
    if (env.CARGO && parentDirs.includes(dirname(env.CARGO))) delete env.CARGO;
  }
  const child: NodeJS.ProcessEnv = { ...env, FORGE_WORKBENCH_ROOT: root, ...overrides };
  // Fixtures may prepend their own binaries to the inherited PATH.
  if (child.PATH) child.PATH = child.PATH.split(delimiter).filter(entry => !parentDirs.includes(entry)).join(delimiter);
  return child;
}

export function executorFixture(version: "0.4" | "0.5" = "0.4") {
  isolateHome();
  let root: string, repo: string, head: string, ledger: Ledger;
  function git(...args: string[]) {
    const res = runGit(repo, args);
    if (res.code) throw Error(res.stderr);
    return res.stdout.trim();
  }
  function cli(bin: string, args: string[], env: Record<string, string | undefined> = {}) {
    return Bun.spawnSync([process.execPath, join(import.meta.dir, "../../src/bin/cli.ts"), bin, ...args], {
      cwd: repo,
      env: childEnvironment(root, env),
    });
  }
  async function cliAsync(bin: string, args: string[], env: NodeJS.ProcessEnv = {}) {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../src/bin/cli.ts"), bin, ...args], {
      cwd: repo, env: childEnvironment(root, env), stdout: "pipe", stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  }
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "forge-task-")));
    repo = join(root, "service");
    mkdirSync(repo);
    mkdirSync(join(root, ".workbench/env"), { recursive: true });
    writeFileSync(
      join(root, ".workbench/workbench.yaml"),
      "repos: [service]\nguard:\n  prod_db_targets: [{host: live.db}]\n",
    );
    git("init", "-b", "feature");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.org");
    writeFileSync(join(repo, "code.txt"), "original");
    git("add", ".");
    git("commit", "-m", "base");
    head = git("rev-parse", "HEAD");
    ledger = new Ledger(root);
    ledger.openTask({
      workflow_version: version,
      task_id: "task",
      title: "Verification",
      endpoint: "local",
      depth: "targeted",
      repo: "service",
      branch: "feature",
      head_sha: head,
    });
  });
  afterEach(() => {
    ledger.closeDb();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    git,
    cli,
    cliAsync,
    get root() {
      return root;
    },
    get repo() {
      return repo;
    },
    get head() {
      return head;
    },
    get ledger() {
      return ledger;
    },
    evidence: () =>
      ledger
        .getTaskEvents("task")
        .filter((e) => e.event_type === "EVIDENCE_CAPTURED")
        .map((e) => JSON.parse(e.payload_json)),
    ready: () =>
      ledger.checkPushReadiness({ task_id: "task", repo: "service", branch: "feature", head_sha: head }).ready,
  };
}
