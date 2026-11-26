import { isolateHome } from "./helpers/hermetic";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
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
import {
  addRepo,
  checkCodexHooksTrust,
  doctorWorkbench,
  initWorkbench,
  syncWorkbench,
} from "../src/cli";
import { loadWorkbenchConfig } from "../src/config";
import { runGit } from "../src/git";
import { Ledger } from "../src/ledger";

isolateHome();

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

    for (const name of ["wb-verify", "forge-review"])
      expect(lstatSync(join(res.root, ".workbench/bin", name)).mode & 0o111).toBeTruthy();

    const defaults = readFileSync(join(res.root, ".codex/config.toml"), "utf8");
    expect(defaults).toContain('model = "gpt-6.2-astra"');
    expect(defaults).toContain('model_reasoning_effort = "medium"');

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

    for (const bin of ["forge-review", "wb-verify"]) {
      const check = Bun.spawnSync([join(res.root, ".workbench/bin", bin), "--task", "absent"],
        { cwd:res.root, env:{...process.env,BUN_BIN:process.execPath} });
      expect(check.exitCode).toBe(1);
      expect(JSON.parse(check.stdout.toString()).ok).toBe(false);
    }
    const doc = doctorWorkbench(res.root);
    expect(doc.ok).toBe(true);
    expect(doc.issues.length).toBe(0);
  });

  test("installed forge restores managed shipping files and diagnoses policy and wrapper failures", () => {
    const kit = join(import.meta.dir, "..");
    const root = join(target, "bench");
    const bin = join(root, ".workbench/bin");
    const run = (exe: string, args: string[], exitCode = 0) => {
      const result = Bun.spawnSync([exe, ...args], {
        cwd: target,
        env: { ...process.env, BUN_BIN: process.execPath },
      });
      expect(result.exitCode, result.stderr.toString()).toBe(exitCode);
      return JSON.parse(result.stdout.toString());
    };
    run(join(kit, "bin/forge"), ["init", root, "--skip-review-agents"]);
    for (const name of [
      "forge",
      "ledger",
      "ledger-hook",
      "guard",
      "wb-git",
      "dbcred",
      "cmdfmt",
      "lang-check",
      "wb-verify",
      "forge-review",
      "forge-ship",
    ]) {
      expect(lstatSync(join(bin, name)).mode & 0o111, name).toBeTruthy();
    }
    const triagePath = ".agents/skills/pr-triage/SKILL.md";
    const triage = readFileSync(join(kit, "core", triagePath), "utf8");
    expect(readFileSync(join(root, triagePath), "utf8")).toBe(triage);
    rmSync(join(root, triagePath));
    const forge = join(bin, "forge");
    run(forge, ["init", join(target, "second"), "--skip-review-agents"]);
    const policy = join(root, ".workbench/ship-policy.yaml");
    const defaults = readFileSync(join(kit, "templates/ship-policy.yaml"), "utf8");
    expect(readFileSync(policy, "utf8")).toBe(defaults);
    const custom = defaults.replace("enabled: true", "enabled: false");
    writeFileSync(policy, custom);
    const agents = join(root, "AGENTS.md"),
      skill = join(root, ".agents/skills/ship/SKILL.md"),
      bundle = join(bin, "forge-ship.js");
    const rendered = readFileSync(agents, "utf8");
    expect(rendered).toContain("HANDED_OFF");
    for (const path of [agents, skill, bundle]) writeFileSync(path, "stale");
    run(forge, ["sync", root]);
    expect(readFileSync(join(root, triagePath), "utf8")).toBe(triage);
    expect(readFileSync(agents, "utf8")).toBe(rendered);
    expect(readFileSync(skill, "utf8")).toBe(readFileSync(join(kit, "core/.agents/skills/ship/SKILL.md"), "utf8"));
    expect(readFileSync(bundle).equals(readFileSync(join(kit, "dist/forge-ship.js")))).toBe(true);
    expect(readFileSync(policy, "utf8")).toBe(custom);
    expect(run(forge, ["doctor", root, "--json"]).ok).toBe(true);
    writeFileSync(policy, "fast_track: {}");
    expect(run(forge, ["doctor", root, "--json"], 1).issues).toContainEqual(
      expect.objectContaining({ check: "ship-policy" }),
    );
    writeFileSync(policy, custom);
    chmodSync(join(bin, "forge-ship"), 0o644);
    expect(run(forge, ["doctor", root, "--json"], 1).issues).toContainEqual(
      expect.objectContaining({
        check: "bins",
        message: expect.stringContaining("executable wrapper: .workbench/bin/forge-ship"),
      }),
    );
    chmodSync(join(bin, "forge-ship"), 0o755);
    rmSync(bundle);
    expect(run(forge, ["doctor", root, "--json"], 1).issues).toContainEqual(
      expect.objectContaining({
        check: "bins",
        message: expect.stringContaining("readable bundle: .workbench/bin/forge-ship.js"),
      }),
    );
    rmSync(policy);
    rmSync(join(bin, "forge-ship"));
    const missing = run(forge, ["doctor", root, "--json"], 1).issues;
    expect(missing).toContainEqual(expect.objectContaining({ check: "ship-policy" }));
    expect(missing).toContainEqual(
      expect.objectContaining({ check: "bins", message: expect.stringContaining("forge-ship") }),
    );
  });

  test("one source-checkout sync upgrades an older workbench even with a stale dist CLI", () => {
    const kit = join(target, "kit"),
      bench = join(target, "bench");
    const source = join(import.meta.dir, "..");
    mkdirSync(kit);
    for (const item of ["bin", "src", "core", "templates", "kit.toml", "package.json", "dist"])
      cpSync(join(source, item), join(kit, item), { recursive: true });
    symlinkSync(join(source, "node_modules"), join(kit, "node_modules"));
    initWorkbench({ targetDir: bench, kitRoot: kit, skipReviewAgents: true });
    const wb = join(bench, ".workbench"),
      lockPath = join(wb, "kit-lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    lock.kit_version = "0.3.0";
    writeFileSync(lockPath, JSON.stringify(lock));
    writeFileSync(join(bench, "AGENTS.local.md"), "operator edits");
    for (const file of ["ship-policy.yaml", "bin/forge", "bin/forge-ship", "bin/forge-ship.js"])
      rmSync(join(wb, file));
    // A v0.3 checkout has a built CLI and no forge-ship bundle. This sentinel makes accidental old-code dispatch observable.
    writeFileSync(join(kit, "dist/cli.js"), 'throw Error("stale management CLI");');
    rmSync(join(kit, "dist/forge-ship.js"));
    const run = (exe: string, ...args: string[]) =>
      Bun.spawnSync([exe, ...args], { cwd: kit, env: { ...process.env, BUN_BIN: process.execPath } });
    const sync = run(join(kit, "bin/forge"), "sync", bench);
    expect(sync.exitCode, sync.stderr.toString()).toBe(0);
    expect(JSON.parse(readFileSync(lockPath, "utf8")).kit_version).toBe(
      (Bun.TOML.parse(readFileSync(join(kit, "kit.toml"), "utf8")) as { kit: { version: string } }).kit
        .version,
    );
    expect(readFileSync(join(bench, "AGENTS.local.md"), "utf8")).toBe("operator edits");
    expect(readFileSync(join(wb, "ship-policy.yaml"), "utf8")).toBe(
      readFileSync(join(kit, "templates/ship-policy.yaml"), "utf8"),
    );
    const doctor = run(join(wb, "bin/forge"), "doctor", bench, "--json");
    expect(doctor.exitCode, doctor.stderr.toString()).toBe(0);
    expect(JSON.parse(doctor.stdout.toString()).ok).toBe(true);
    const ship = run(join(wb, "bin/forge-ship"), "unknown");
    expect(ship.exitCode).toBe(1);
    expect(ship.stderr.toString() + ship.stdout.toString()).toContain("Expected forge-ship");
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
    Bun.spawnSync(["git", "init", "-b", "main"], { env: process.env, cwd: repo });
    Bun.spawnSync(["git", "config", "user.email", "a@b.c"], { env: process.env, cwd: repo });
    Bun.spawnSync(["git", "config", "user.name", "A"], { env: process.env, cwd: repo });
    writeFileSync(join(repo, "f.txt"), "hi\n");
    Bun.spawnSync(["git", "add", "f.txt"], { env: process.env, cwd: repo });
    Bun.spawnSync(["git", "commit", "-m", "init"], { env: process.env, cwd: repo });

    const linkedWt = join(res.root, "linked-wt");
    Bun.spawnSync(["git", "worktree", "add", "-b", "feat/wt", linkedWt, "main"], { env: process.env, cwd: repo });

    expect(() => addRepo({ repoPath: linkedWt, workbenchDir: res.root })).toThrow(
      "linked git worktree",
    );
  });

  test("checkCodexHooksTrust detects untrusted vs trusted hooks in Codex config.toml", () => {
    const res = initWorkbench({
      targetDir: target,
      name: "trust-check",
      skipReviewAgents: true,
    });
    const fakeCodexHome = mkdtempSync(join(tmpdir(), "forge-codex-home-"));
    try {
      const cfgPath = join(fakeCodexHome, "config.toml");
      writeFileSync(cfgPath, 'model = "gpt-6.2-sol"\n', "utf8");
      const untrusted = checkCodexHooksTrust(res.root, fakeCodexHome);
      expect(untrusted.checked).toBe(true);
      expect(untrusted.totalCount).toBe(5);
      expect(untrusted.trustedCount).toBe(0);

      const hooksPath = untrusted.hooksPath;
      writeFileSync(
        cfgPath,
        [
          `[hooks.state."${hooksPath}:pre_tool_use:0:0"]`,
          'trusted_hash = "sha256:aaa"',
          `[hooks.state."file:${hooksPath}:post_tool_use:0:0"]`,
          'trusted_hash = "sha256:bbb"',
          `[hooks.state."${hooksPath}:session_start:0:0"]`,
          "enabled = false",
          'trusted_hash = "sha256:ccc"',
        ].join("\n") + "\n",
        "utf8",
      );
      const partial = checkCodexHooksTrust(res.root, fakeCodexHome);
      expect(partial.checked).toBe(true);
      expect(partial.totalCount).toBe(5);
      expect(partial.trustedCount).toBe(2);
    } finally {
      rmSync(fakeCodexHome, { recursive: true, force: true });
    }
  });

  test("ledger CLI only accepts manual evidence and rejects actor overrides", () => {
    const res = initWorkbench({
      targetDir: target,
      name: "role-check",
      skipReviewAgents: true,
    });
    const ledgerBin = join(res.root, ".workbench", "bin", "ledger");
    const opened = Bun.spawnSync(
      [ledgerBin, "open", "--id", "role-test-1", "--title", "Role test", "--endpoint", "local", "--depth", "targeted"],
      { env: process.env, cwd: res.root },
    );
    expect(opened.exitCode).toBe(0);

    const record = (kind: string, extra: string[] = []) => Bun.spawnSync(
      [ledgerBin, "record", "role-test-1", "--kind", kind, "--status", "pass", "--summary", "x", ...extra], { env: process.env, cwd: res.root });
    for (const kind of ["test", "build", "lint", "review", "hurl"]) {
      const proc = record(kind);
      expect(proc.exitCode).not.toBe(0);
      expect(proc.stderr.toString()).toContain("actual verification or review tool");
    }
    expect(record("fat", ["--actor", "hook"]).exitCode).not.toBe(0);
    const fat = record("fat");
    expect(fat.exitCode).toBe(0);
    expect(JSON.parse(JSON.parse(fat.stdout.toString()).payload_json).source).toBe("manual");
  });
});
