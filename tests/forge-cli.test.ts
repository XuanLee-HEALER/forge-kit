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
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
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

function copySourceKit(destination: string) {
  const source = join(import.meta.dir, "..");
  mkdirSync(destination);
  for (const item of ["bin", "src", "core", "templates", "kit.toml", "package.json", "dist"]) {
    cpSync(join(source, item), join(destination, item), { recursive: true });
  }
  for (const subdir of ["src","prompts"]) cpSync(join(source,"review-agents",subdir),join(destination,"review-agents",subdir),{recursive:true});
  symlinkSync(join(source,"review-agents/node_modules"),join(destination,"review-agents/node_modules"));
  symlinkSync(join(source, "node_modules"), join(destination, "node_modules"));
}

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
      initWorkbench({ targetDir: target }),
    ).toThrow("existing unmanaged files");

    const forced = initWorkbench({
      targetDir: target,
      force: true,
    });
    expect(existsSync(join(forced.root, ".workbench", "kit-lock.json"))).toBe(true);
  });

  test("init, add-repo (including inline YAML repos), models.toml -> agents sync, and doctor", () => {
    const res = initWorkbench({
      targetDir: target,
      name: "acme-garage",
      gitOrg: "acme",
    });
    expect(existsSync(join(res.root, ".workbench", "env", ".gitignore"))).toBe(true);
    expect(existsSync(join(res.root, ".workbench", "ledger", ".gitignore"))).toBe(true);
    expect(existsSync(join(res.root, ".agents", "skills", "ready", "SKILL.md"))).toBe(true);
    expect(existsSync(join(res.root, ".agents", "skills", "grill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(res.root, ".codex", "agents", "reviewer.toml"))).toBe(true);
    expect(existsSync(join(res.root, ".workbench", "bin", "cli.js"))).toBe(true);

    expect(lstatSync(join(res.root, ".workbench/bin/forge")).mode & 0o111).toBeTruthy();

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

    // Sync renders updated models.toml into .codex/agents/implementer.toml while preserving private files!
    syncWorkbench({ targetDir: res.root });
    expect(readFileSync(join(res.root, ".codex", "agents", "implementer.toml"), "utf8")).toContain(
      'model_reasoning_effort = "high"',
    );
    expect(readFileSync(join(res.root, "AGENTS.local.md"), "utf8")).toBe(
      "# My Private Local Rules\n",
    );

    for (const bin of ["review", "verify"]) {
      const check = Bun.spawnSync([join(res.root, ".workbench/bin/forge"), bin, "--task", "absent"],
        { cwd:res.root, env:{...process.env,BUN_BIN:process.execPath} });
      expect(check.exitCode).toBe(1);
      expect(check.stdout.toString()+check.stderr.toString()).toMatch(/attached checkout/);
    }
    const doc = doctorWorkbench(res.root);
    expect(doc.ok).toBe(true);
    expect(doc.issues.length).toBe(0);
  });

  test("retired domain skills are absent from clean installs and CLI help", () => {
    const kit = join(import.meta.dir, "..");
    const bench = join(target, "bench");
    const forge = join(kit, "bin/forge");
    const run = (exe: string, args: string[]) =>
      Bun.spawnSync([exe, ...args], { cwd: target, env: { ...process.env, BUN_BIN: process.execPath } });
    const init = run(forge, ["init", bench]);
    expect(init.exitCode, init.stderr.toString()).toBe(0);
    const skills = readdirSync(join(bench, ".agents/skills"));
    const retired = ["form-ux", "dbop", "comm-lark", "work-communication"];
    for (const name of retired) expect(skills).not.toContain(name);
    for (const path of ["AGENTS.md", ...skills.map((name) => `.agents/skills/${name}/SKILL.md`)]) {
      expect(readFileSync(join(bench, path), "utf8"), path).not.toMatch(/form-ux|comm-lark|work-communication|\bdbop\b|qa-polling\.md/);
    }
    const help = run(join(bench, ".workbench/bin/forge"), ["--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout.toString()).toContain("forge init");
    expect(help.stdout.toString()).not.toMatch(/--packs|form-ux|dbop|comm-lark|work-communication/);
    const requested = join(target, "requested");
    const legacy = run(forge, ["init", requested, "--packs", "dbop,comm-lark"]);
    if (legacy.exitCode === 0) {
      const installed = readdirSync(join(requested, ".agents/skills"));
      for (const name of retired) expect(installed).not.toContain(name);
    }
  });

  test("Bun distribution excludes retired source assets and instance skills", () => {
    const kit = join(import.meta.dir, "..");
    const stage = join(target, "kit");
    mkdirSync(stage);
    for (const name of ["package.json", ".gitignore", ".npmignore", "core", "packs", "templates", "dist"]) {
      if (existsSync(join(kit, name))) cpSync(join(kit, name), join(stage, name), { recursive: true });
    }
    // Real workbenches may keep retired skills as private overrides after upgrading.
    const privateSkill = join(stage, ".agents/skills/form-ux");
    mkdirSync(privateSkill, { recursive: true });
    writeFileSync(join(privateSkill, "SKILL.md"), "synthetic private form conventions");
    const archive = join(target, "distribution.tgz");
    const pack = Bun.spawnSync([process.execPath, "pm", "pack", "--ignore-scripts", "--filename", archive], { cwd: stage });
    expect(pack.exitCode, pack.stderr.toString()).toBe(0);
    const listing = Bun.spawnSync(["tar", "-tzf", archive]);
    expect(listing.exitCode, listing.stderr.toString()).toBe(0);
    expect(listing.stdout.toString()).toContain("core/.agents/skills/ready/SKILL.md");
    expect(listing.stdout.toString()).not.toMatch(/\/(form-ux|dbop|comm-lark|work-communication)(\/|$)|\/qa-polling\.md/m);
  });

  test("sync preserves edited domain skills and instance data from a v0.4 pack install", () => {
    const source = join(import.meta.dir, "..");
    const previousKit = join(target, "previous-kit");
    const bench = join(target, "bench");
    copySourceKit(previousKit);
    const previousForm = join(previousKit, "core/.agents/skills/form-ux");
    mkdirSync(previousForm, { recursive: true });
    writeFileSync(join(previousForm, "SKILL.md"), "old managed form conventions");
    initWorkbench({ targetDir: bench, kitRoot: source });
    const lockPath = join(bench, ".workbench/kit-lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    writeFileSync(lockPath, JSON.stringify({ ...lock, kit_version: "0.4.1", kit_root: previousKit, packs: ["dbop", "comm-lark"] }));
    const files = {
      ".agents/skills/form-ux/SKILL.md": "local form conventions",
      ".agents/skills/dbop/SKILL.md": "local database conventions",
      ".agents/skills/work-communication/references/qa-polling.md": "local reporting procedure",
      ".agents/skills/private-specialty/SKILL.md": "unmanaged specialty",
      ".workbench/env/environments.json": JSON.stringify({ local: { user: "fixture", password: "synthetic-only" } }),
      "AGENTS.local.md": "private configuration",
    };
    for (const [path, content] of Object.entries(files)) {
      const file = join(bench, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content, { mode: 0o600 });
    }
    for (let pass = 0; pass < 2; pass++) {
      const sync = Bun.spawnSync([join(source, "bin/forge"), "sync", bench], {
        cwd: target, env: { ...process.env, BUN_BIN: process.execPath },
      });
      expect(sync.exitCode, sync.stderr.toString()).toBe(0);
      for (const [path, content] of Object.entries(files)) {
        expect(readFileSync(join(bench, path), "utf8"), path).toBe(content);
      }
    }
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
    run(join(kit, "bin/forge"), ["init", root]);
    expect(readdirSync(bin).sort()).toEqual(["cli.js","forge"]);
    expect(lstatSync(join(bin,"forge")).mode & 0o111).toBeTruthy();
    const triagePath = ".agents/skills/pr-triage/SKILL.md";
    const triage = readFileSync(join(kit, "core", triagePath), "utf8");
    expect(readFileSync(join(root, triagePath), "utf8")).toBe(triage);
    rmSync(join(root, triagePath));
    const forge = join(bin, "forge");
    run(forge, ["init", join(target, "second")]);
    const policy = join(root, ".workbench/ship-policy.yaml");
    const defaults = readFileSync(join(kit, "templates/ship-policy.yaml"), "utf8");
    expect(readFileSync(policy, "utf8")).toBe(defaults);
    const custom = defaults.replace("enabled: true", "enabled: false");
    writeFileSync(policy, custom);
    const agents = join(root, "AGENTS.md"),
      skill = join(root, ".agents/skills/ship/SKILL.md"),
      bundle = join(bin, "cli.js");
    const rendered = readFileSync(agents, "utf8");
    expect(rendered).toContain("移交");
    writeFileSync(skill,"private edit");
    expect(doctorWorkbench(root).issues).toContainEqual(expect.objectContaining({
      check:"projection",message:expect.stringContaining("move the edited file aside"),
    }));
    expect(()=>syncWorkbench({targetDir:root})).toThrow("Ownership conflict");
    expect(readFileSync(skill,"utf8")).toBe("private edit");
    for (const path of [agents,skill,bundle]) rmSync(path);
    run(join(kit,"bin/forge"), ["sync", root]);
    expect(readFileSync(join(root, triagePath), "utf8")).toBe(triage);
    expect(readFileSync(agents, "utf8")).toBe(rendered);
    expect(readFileSync(skill, "utf8")).toBe(readFileSync(join(kit, "core/.agents/skills/ship/SKILL.md"), "utf8"));
    expect(readFileSync(bundle).byteLength).toBeGreaterThan(0);
    expect(readFileSync(policy, "utf8")).toBe(custom);
    expect(run(join(kit,"bin/forge"), ["doctor", root, "--json"]).ok).toBe(true);
    writeFileSync(policy, "fast_track: {}");
    expect(run(join(kit,"bin/forge"), ["doctor", root, "--json"], 1).issues).toContainEqual(
      expect.objectContaining({ check: "ship-policy" }),
    );
    writeFileSync(policy, custom);
    chmodSync(join(bin, "forge"), 0o644);
    expect(run(join(kit,"bin/forge"), ["doctor", root, "--json"], 1).issues).toContainEqual(
      expect.objectContaining({
        check: "bins",
        message: expect.stringContaining(".workbench/bin/forge"),
      }),
    );
    chmodSync(join(bin, "forge"), 0o755);
    rmSync(bundle);
    expect(run(join(kit,"bin/forge"), ["doctor", root, "--json"], 1).issues).toContainEqual(
      expect.objectContaining({
        check: "bins",
        message: expect.stringContaining(".workbench/bin/cli.js"),
      }),
    );
    rmSync(policy);
    rmSync(join(bin, "forge"));
    const missing = run(join(kit,"bin/forge"), ["doctor", root, "--json"], 1).issues;
    expect(missing).toContainEqual(expect.objectContaining({ check: "ship-policy" }));
    expect(missing).toContainEqual(
      expect.objectContaining({ check: "bins", message: expect.stringContaining(".workbench/bin/forge") }),
    );
  });

  test("one source-checkout sync upgrades an older workbench even with a stale dist CLI", () => {
    const kit = join(target, "kit"),
      bench = join(target, "bench");
    copySourceKit(kit);
    initWorkbench({ targetDir: bench, kitRoot: kit });
    const wb = join(bench, ".workbench"),
      lockPath = join(wb, "kit-lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    lock.kit_version = "0.4.1";
    writeFileSync(lockPath, JSON.stringify(lock));
    writeFileSync(join(bench, "AGENTS.local.md"), "operator edits");
    for (const file of ["bin/forge", "bin/cli.js"])
      rmSync(join(wb, file));
    // A source checkout must dispatch and install its current program even when dist is stale.
    writeFileSync(join(kit,"dist/cli.js"), 'throw Error("stale management CLI");');
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
    const ship = run(join(wb, "bin/forge"), "ship","unknown");
    expect(ship.exitCode).toBe(1);
    expect(ship.stderr.toString() + ship.stdout.toString()).toMatch(/ship/i);
  });

  test("sync and doctor validate both private environment files before changing projections", () => {
    const instance = join(target, "instance");
    initWorkbench({ targetDir: instance });
    const lock = join(instance, ".workbench/kit-lock.json");
    const initialLock = readFileSync(lock);
    const marker = "SYNTHETIC-PRIVATE-VALUE";
    const valid = JSON.stringify({ local: { user: "test", password: marker } });
    const primary = join(instance, ".workbench/env/environments.json");
    const legacy = join(instance, ".agents/skills/dbop/environments.json");
    mkdirSync(dirname(legacy), { recursive: true });
    function rejected(path: string) {
      const diagnosis = doctorWorkbench(instance);
      expect(diagnosis.ok).toBe(false);
      expect(JSON.stringify(diagnosis)).toContain(path);
      expect(JSON.stringify(diagnosis)).not.toContain(marker);
      let message = "";
      try {
        syncWorkbench({ targetDir: instance });
      } catch (e) {
        message = String(e);
      }
      expect(message).toContain(path);
      expect(message).not.toContain(marker);
      expect(readFileSync(lock)).toEqual(initialLock);
    }
    writeFileSync(primary, valid);
    for (const path of [legacy, primary]) {
      for (const bad of [
        marker + " is invalid JSON",
        JSON.stringify({ [marker]: { rw: { password: marker } } }),
        JSON.stringify({ [marker]: [marker] }),
      ]) {
        writeFileSync(path, bad);
        rejected(path);
      }
      writeFileSync(path, valid);
      chmodSync(path, 0);
      try {
        rejected(path);
      } finally {
        chmodSync(path, 0o600);
      }
    }
    const external = join(target, "external");
    mkdirSync(external);
    writeFileSync(join(external, "environments.json"), valid);
    rmSync(legacy);
    rmSync(dirname(legacy), { recursive: true });
    symlinkSync(external, dirname(legacy));
    rejected(legacy);
    rmSync(dirname(legacy));
    expect(doctorWorkbench(instance).ok).toBe(true);
    syncWorkbench({ targetDir: instance });
    expect(readFileSync(primary, "utf8")).toBe(valid);
  });

  test("doctor catches plaintext API keys and absolute symlinks", () => {
    const res = initWorkbench({
      targetDir: target,
      name: "bad-garage",
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
    });
    const ledgerBin = join(res.root, ".workbench", "bin", "forge");
    const opened = Bun.spawnSync(
      [ledgerBin, "ledger", "open", "--id", "role-test-1", "--title", "Role test", "--endpoint", "local", "--depth", "targeted"],
      { env: process.env, cwd: res.root },
    );
    expect(opened.exitCode).toBe(0);

    const record = (kind: string, extra: string[] = []) => Bun.spawnSync(
      [ledgerBin, "ledger", "record", "role-test-1", "--kind", kind, "--status", "pass", "--summary", "x", ...extra], { env: process.env, cwd: res.root });
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
