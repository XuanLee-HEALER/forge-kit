import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { addRepo, doctorWorkbench, initWorkbench, syncWorkbench } from "../src/cli";
import { loadWorkbenchConfig } from "../src/config";
import { runGit } from "../src/git";
import { Ledger } from "../src/ledger";

let target: string;

beforeEach(() => {
  target = mkdtempSync(join(tmpdir(), "forge-cli-test-"));
});

afterEach(() => {
  rmSync(target, { recursive: true, force: true });
});

describe("forge CLI: init / add-repo / sync / doctor", () => {
  test("init refuses to overwrite existing unmanaged AGENTS.md without --force", () => {
    writeFileSync(join(target, "AGENTS.md"), "# Legacy\n");
    expect(() =>
      initWorkbench({ targetDir: target, skipReviewAgents: true }),
    ).toThrow("existing unmanaged files");

    const forced = initWorkbench({
      targetDir: target,
      skipReviewAgents: true,
      force: true,
    });
    expect(existsSync(join(forced.root, ".workbench", "kit-lock.json"))).toBe(true);
  });

  test("init, add-repo (including inline YAML repos), models.toml -> agents sync, and doctor", () => {
    const res = initWorkbench({
      targetDir: target,
      name: "acme-garage",
      gitOrg: "acme",
      packs: ["dbop", "comm-lark"],
      skipReviewAgents: true,
    });
    expect(existsSync(join(res.root, ".workbench", "env", ".gitignore"))).toBe(true);
    expect(existsSync(join(res.root, ".workbench", "ledger", ".gitignore"))).toBe(true);
    expect(existsSync(join(res.root, ".agents", "skills", "ready", "SKILL.md"))).toBe(true);
    expect(existsSync(join(res.root, ".agents", "skills", "grill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(res.root, ".codex", "agents", "spec-reviewer.toml"))).toBe(true);
    expect(existsSync(join(res.root, ".workbench", "bin", "lang-check"))).toBe(true);

    // Customize private rules + models.toml + inline YAML repos array
    writeFileSync(join(res.root, "AGENTS.local.md"), "# My Private Local Rules\n");
    writeFileSync(
      join(res.root, ".workbench", "models.toml"),
      `[tiers.mechanical]\nmodel = "gpt-6.1-terra"\neffort = "medium"\n\n[tiers.standard]\nmodel = "gpt-6.2-sol"\neffort = "high"\n\n[tiers.deep]\nmodel = "gpt-6.2-astra"\neffort = "high"\n`,
    );
    writeFileSync(
      join(res.root, ".workbench", "workbench.yaml"),
      `name: "acme-garage"\nrepos: ["existing-placeholder"]\nguard:\n  prod_db_hosts:\n    - "pg-prod.acme.internal"\n`,
    );
    writeFileSync(join(res.root, ".workbench", "repos", "existing-placeholder.md"), "# placeholder\n");

    const ledger = new Ledger(res.root);
    ledger.openTask({
      task_id: "20261121-keep",
      title: "Must survive sync",
      endpoint: "local",
      depth: "targeted",
    });
    ledger.closeDb();

    // Add a mock Go repo -> updates inline YAML repos cleanly!
    const backend = join(res.root, "backend");
    mkdirSync(backend, { recursive: true });
    runGit(backend, ["init", "-b", "main"]);
    writeFileSync(join(backend, "go.mod"), "module acme/backend\n");
    writeFileSync(join(backend, "Makefile"), "build:\n\tgo build ./...\ntest:\n\tgo test ./...\n");

    const added = addRepo({ repoPath: backend });
    expect(added.registered).toBe(true);
    expect(loadWorkbenchConfig(res.root).repos).toEqual([
      "existing-placeholder",
      "backend",
    ]);

    // Sync renders updated models.toml into .codex/agents/dev.toml while preserving private files!
    syncWorkbench({ targetDir: res.root });
    expect(readFileSync(join(res.root, ".codex", "agents", "dev.toml"), "utf8")).toContain(
      'model_reasoning_effort = "high"',
    );
    expect(readFileSync(join(res.root, "AGENTS.local.md"), "utf8")).toBe(
      "# My Private Local Rules\n",
    );

    const doc = doctorWorkbench(res.root);
    expect(doc.ok).toBe(true);
    expect(doc.issues.length).toBe(0);
  });

  test("doctor catches plaintext API keys and absolute symlinks", () => {
    const res = initWorkbench({
      targetDir: target,
      name: "bad-garage",
      skipReviewAgents: true,
    });
    writeFileSync(
      join(res.root, "AGENTS.local.md"),
      "OPENAI_API_KEY=sk-1234567890abcdefghijklmnop\n",
    );
    symlinkSync(
      join(res.root, ".agents", "skills", "feature"),
      join(res.root, ".agents", "skills", "abs-bad"),
    );
    expect(
      isAbsolute(readlinkSync(join(res.root, ".agents", "skills", "abs-bad"))),
    ).toBe(true);
    expect(lstatSync(join(res.root, ".agents", "skills", "abs-bad")).isSymbolicLink()).toBe(true);

    const doc = doctorWorkbench(res.root);
    expect(doc.ok).toBe(false);
    expect(doc.issues.some((i) => i.check === "secrets")).toBe(true);
    expect(doc.issues.some((i) => i.check === "symlinks")).toBe(true);
  });

  test("add-repo rejects linked git worktrees (.git file instead of primary repo dir)", () => {
    const res = initWorkbench({
      targetDir: target,
      name: "wt-check",
      skipReviewAgents: true,
    });
    const repo = join(res.root, "main-svc");
    mkdirSync(repo, { recursive: true });
    Bun.spawnSync(["git", "init", "-b", "main"], { cwd: repo });
    Bun.spawnSync(["git", "config", "user.email", "a@b.c"], { cwd: repo });
    Bun.spawnSync(["git", "config", "user.name", "A"], { cwd: repo });
    writeFileSync(join(repo, "f.txt"), "hi\n");
    Bun.spawnSync(["git", "add", "f.txt"], { cwd: repo });
    Bun.spawnSync(["git", "commit", "-m", "init"], { cwd: repo });

    const linkedWt = join(res.root, "linked-wt");
    Bun.spawnSync(["git", "worktree", "add", "-b", "feat/wt", linkedWt, "main"], { cwd: repo });

    expect(() => addRepo({ repoPath: linkedWt, workbenchDir: res.root })).toThrow(
      "linked git worktree",
    );
  });
});
