import { beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "../../src/git";
import { Ledger } from "../../src/ledger";
import { isolateHome } from "./hermetic";

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
      env: { ...process.env, FORGE_WORKBENCH_ROOT: root, ...env },
    });
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
