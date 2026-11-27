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
  renameSync,
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
import { recoverInstall } from "../src/managed-assets";
import { loadModelsConfig, loadWorkbenchConfig } from "../src/config";
import { runGit, withinProcessDeadline } from "../src/git";
import { stagePin } from "../src/ledger/ship-actions";
import { observeStage } from "../src/stage-observation";
import { Ledger } from "../src/ledger";

isolateHome();

let target: string;

function copySourceKit(destination: string) {
  const source = join(import.meta.dir, "..");
  mkdirSync(destination);
  for (const item of ["bin", "src", "core", "templates", "kit.toml", "package.json"]) {
    cpSync(join(source, item), join(destination, item), { recursive: true });
  }
  symlinkSync(join(source, "node_modules"), join(destination, "node_modules"));
}

beforeEach(() => {
  target = mkdtempSync(join(tmpdir(), "forge-cli-test-"));
});

afterEach(() => {
  rmSync(target, { recursive: true, force: true });
});

describe("forge CLI: init / add-repo / sync / doctor", () => {
  test("verification checks the migration journal at the selected workbench", () => {
    const first = join(target, "first"), second = join(target, "second");
    for (const root of [first, second]) {
      mkdirSync(join(root, ".workbench"), {recursive:true});
      writeFileSync(join(root, ".workbench/workbench.yaml"), "repos: []\n");
    }
    mkdirSync(join(second, ".workbench/sync-journal"));
    const env = {...process.env};
    delete env.FORGE_WORKBENCH_ROOT;
    const run = (cwd:string, selected:string) => Bun.spawnSync([process.execPath,
      join(import.meta.dir,"../src/bin/cli.ts"), "verify", "--cwd", selected, "--task", "absent"], {cwd, env});
    expect(run(first,second).stderr.toString()).toContain("interrupted migration");
    const healthy = run(second,first);
    expect(healthy.exitCode).not.toBe(0);
    expect(healthy.stderr.toString()).not.toContain("interrupted migration");
  });
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
    expect(defaults).toContain('model = "gpt-6.2-sol"');
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

    const check = Bun.spawnSync([join(res.root, ".workbench/bin/forge"), "verify", "--task", "absent"],
      { cwd:res.root, env:{...process.env,BUN_BIN:process.execPath} });
    expect(check.exitCode).toBe(1);
    expect(check.stdout.toString()+check.stderr.toString()).toMatch(/attached checkout/);
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
    expect(JSON.parse(readFileSync(join(bench, ".workbench/env/environments.example.json"), "utf8"))).not.toHaveProperty("fat");
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
    expect(defaults).not.toContain("max_steward_rounds");
    const custom = defaults.replace("enabled: true", "enabled: false\n  max_steward_rounds: 3");
    writeFileSync(policy, custom);
    const agents = join(root, "AGENTS.md"),
      skill = join(root, ".agents/skills/ship/SKILL.md"),
      bundle = join(bin, "cli.js");
    const rendered = readFileSync(agents, "utf8");
    writeFileSync(agents, "x".repeat(8000));
    expect(doctorWorkbench(root).issues).toContainEqual(expect.objectContaining({
      check: "agents-md", message: expect.stringContaining("move the edited file aside"),
    }));
    writeFileSync(agents, rendered);
    expect(rendered).toContain("移交");
    writeFileSync(skill,"private edit");
    expect(doctorWorkbench(root).issues).toContainEqual(expect.objectContaining({
      check:"projection",message:expect.stringContaining("move the edited file aside"),
    }));
    expect(()=>syncWorkbench({targetDir:root})).toThrow("Ownership conflict");
    expect(readFileSync(skill,"utf8")).toBe("private edit");
    for (const path of [agents,skill,bundle]) rmSync(path);
    const broken = doctorWorkbench(root);
    expect(broken.issues).toContainEqual(expect.objectContaining({
      check:"bins",message:expect.stringContaining("From the forge-kit release directory, run ./bin/forge sync " + Bun.$.escape(broken.root)),
    }));
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
    for (const entry of [forge, bundle]) {
      const release = join(kit, "bin/forge");
      const repair = "From the forge-kit release directory, run ./bin/forge sync " + Bun.$.escape(broken.root);
      // Executable permissions alone cannot establish launcher integrity.
      writeFileSync(entry, "changed entry point");
      const moved = entry + ".saved";
      const drift = run(release, ["doctor", root, "--json"], 1);
      expect(drift.issues).toContainEqual(expect.objectContaining({check:"projection",
        message:expect.stringContaining(repair)}));
      renameSync(entry, moved);
      run(release, ["sync", root]);
      expect(run(release, ["doctor", root, "--json"]).ok).toBe(true);
      chmodSync(entry, 0o000);
      const unreadable = run(release, ["doctor", root, "--json"], 1);
      expect(unreadable.issues).toContainEqual(expect.objectContaining({check:"bins", message:expect.stringContaining(repair)}));
      expect(unreadable.issues).toContainEqual(expect.objectContaining({check:"projection", message:expect.stringContaining(entry)}));
      chmodSync(entry, entry === forge ? 0o755 : 0o644);
      rmSync(moved);
    }
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
    lock.kit_version = "0.5.2";
    writeFileSync(lockPath, JSON.stringify(lock));
    writeFileSync(join(bench, "AGENTS.local.md"), "operator edits");
    for (const file of ["bin/forge", "bin/cli.js"])
      rmSync(join(wb, file));
    // A source checkout must dispatch and install its current program even when dist is stale.
    mkdirSync(join(kit, "dist"), {recursive: true});
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

  test("stage resolution diagnoses incompatible verification, delivery and observer references before sync", () => {
    const { root } = initWorkbench({ targetDir: target });
    const cfg = join(root, ".workbench/workbench.yaml"),
      original = readFileSync(cfg, "utf8");
    const lock = join(root, ".workbench/kit-lock.json"),
      initial = readFileSync(lock);
    const marker = join(root, "stage-ran");
    const actions = {
      check: { purpose: "verify", argv: ["bun", "-e", "console.log('verified')"] },
      write: {
        purpose: "deliver",
        argv: ["bun", "-e", "await Bun.write(" + JSON.stringify(marker) + ", 'ran')"],
        inputs: [],
      },
      probe: { purpose: "observe", argv: ["bun", "-e", "console.log('observed')"], inputs: [] },
    };
    const stages = {
      check: { action: "check" },
      roll: { action: "write", observe: "probe" },
      read: { action: "probe" },
    };
    const legal = {
      actions,
      stages,
      verification: { stages: ["verify", "check"] },
      delivery: { stages: ["ship", "roll"] },
    };
    function configure(extensions: object) {
      writeFileSync(cfg, original + "\nextensions: " + JSON.stringify(extensions) + "\n");
    }
    function invalid(extensions: object, field: string) {
      configure(extensions);
      const diagnosis = doctorWorkbench(root);
      expect(diagnosis.ok).toBe(false);
      expect(JSON.stringify(diagnosis.issues)).toContain(field);
      expect(() => syncWorkbench({ targetDir: root })).toThrow(field);
      expect(readFileSync(lock)).toEqual(initial);
      expect(existsSync(marker)).toBe(false);
    }
    for (const stage of ["ship", "roll", "read"])
      invalid({ ...legal, verification: { stages: [stage] } }, "verification.stages");
    for (const stage of ["verify", "check", "read"])
      invalid({ ...legal, delivery: { stages: [stage] } }, "delivery.stages");
    for (const observe of ["missing", "write", "check"])
      invalid({ ...legal, stages: { ...stages, roll: { action: "write", observe } } }, "roll.observe");
    invalid(
      { ...legal, actions: { ...actions, missing: { purpose: "verify", cwd: ".workbench", argv: ["./absent"] } } },
      "missing.argv[0]",
    );
    writeFileSync(join(root, "input.json"), "{}");
    symlinkSync(join(root, "input.json"), join(root, "link.json"));
    for (const inputs of [
      ["../external"],
      ["."],
      ["missing.json"],
      ["link.json"],
      ["input.json", "./input.json"],
    ]) {
      invalid({ ...legal, actions: { ...actions, write: { ...actions.write, inputs } } }, "write.inputs");
    }
    configure({ ...legal, stages: { ...stages, roll: { action: "write" } } });
    expect(doctorWorkbench(root).issues).toContainEqual(
      expect.objectContaining({ level: "warn", message: expect.stringContaining("roll.observe") }),
    );
    configure(legal);
    expect(doctorWorkbench(root).issues).toEqual([]);
    syncWorkbench({ targetDir: root });
    expect(existsSync(marker)).toBe(false);
  });

  test("sync and doctor reject a malformed declared model tier before writing", () => {
    const { root } = initWorkbench({ targetDir: join(target, "instance") });
    const lock = join(root, ".workbench/kit-lock.json");
    const before = readFileSync(lock);
    const models = join(root, ".workbench/models.toml");
    const valid = '[tiers.standard]\nmodel = "fixture-standard"\neffort = "low"\n';
    for (const [contents, field] of [
      ['[tiers.standard]\nmodel = "fixture-standard"\n', "tiers.standard.effort"],
      [valid + '[review.roles]\nquality = "unregistered"\n', "review.roles.quality"],
      [valid + 'modle = "unused"\n', "tiers.standard.modle"],
    ]) {
      writeFileSync(models, contents);
      expect(JSON.stringify(doctorWorkbench(root).issues)).toContain(field);
      expect(() => syncWorkbench({ targetDir: root })).toThrow(field);
      expect(() => loadModelsConfig(root)).toThrow(field);
      expect(readFileSync(lock)).toEqual(before);
    }
    writeFileSync(models, valid);
    syncWorkbench({ targetDir: root });
    expect(doctorWorkbench(root).ok).toBe(true);
    expect(loadModelsConfig(root).tiers.standard).toEqual({model: "fixture-standard", effort: "low"});
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
      expect(proc.stderr.toString()).toContain("actual verification tool");
    }
    expect(record("fat", ["--actor", "hook"]).exitCode).not.toBe(0);
    const fat = record("fat");
    expect(fat.exitCode).not.toBe(0);
    const manual = record("manual");
    expect(manual.exitCode,manual.stderr.toString()).toBe(0);
    expect(JSON.parse(JSON.parse(manual.stdout.toString()).payload_json).source).toBe("manual");
  });
});


test("interrupted migration recovery describes the original destination for absent files, links and regular files", () => {
  const journal = join(target, ".workbench/sync-journal");
  mkdirSync(journal, {recursive:true});
  const dest = join(target, "AGENTS.md");
  const original = "previous content";
  const next = "managed replacement";
  const hash = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
  const digest = hash(original);
  for (const before of [null, "link:original-link-target", digest]) {
    writeFileSync(dest, "unexpected edit");
    if (before === digest) writeFileSync(join(journal, "0.old"), original);
    writeFileSync(join(journal, "0.new"), next);
    writeFileSync(join(journal, "operations.json"), JSON.stringify([
      {path:"AGENTS.md", before, after:hash(next), mode:0o644},
      {path:".workbench/kit-lock.json", before:null, after:null},
    ]));
    const attempt = () => recoverInstall(target);
    expect(attempt).toThrow("moving it aside");
    if (before === null) expect(attempt).toThrow("retry ./bin/forge sync");
    else if (before === digest) expect(attempt).toThrow("Copy the saved file " + join(journal,"0.old") + " back to " + dest);
    else expect(attempt).toThrow('original target "original-link-target"');
    expect(readFileSync(dest,"utf8")).toBe("unexpected edit");
    rmSync(dest);
    if (before === digest) cpSync(join(journal,"0.old"),dest);
    else if (before) symlinkSync("original-link-target",dest);
    attempt();
    expect(readFileSync(dest, "utf8")).toBe(next);
    expect(existsSync(journal)).toBe(false);
    mkdirSync(journal);
  }
});

test("a timed-out target observer reports the stage, action and manual recovery without printing child output", () => {
  const { root } = initWorkbench({ targetDir: target });
  const file = join(root,".workbench/workbench.yaml");
  writeFileSync(file,readFileSync(file,"utf8")+`
extensions:
  actions:
    submit: {purpose: deliver, argv: [bun, -e, "console.log('submit')"], inputs: []}
    checkRollout: {purpose: observe, argv: [bun, -e, "console.error('private-output'); await Bun.sleep(30000)"], inputs: []}
  stages:
    rollout: {action: submit, observe: checkRollout}
  delivery: {endpoint: rollout, stages: [rollout]}
`);
  const stage = stagePin(root, "rollout");
  let failure = "";
  try {
    withinProcessDeadline(Date.now()+700, () => observeStage(root,stage,"ft-test/1","rollout",[]));
  } catch(error) {
    failure=String(error);
  }
  expect(failure).toContain("stage rollout failed (Process timed out");
  expect(failure).toContain("ft-test/1");
  expect(failure).toContain("manual recovery");
  expect(failure).not.toContain("private-output");
});

test("a partially published install can replay a restored file after a later conflict", () => {
  const journal = join(target, ".workbench/sync-journal");
  const dest = join(target, "AGENTS.md");
  const lock = join(target, ".workbench/kit-lock.json");
  const hash = (bytes: string) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  mkdirSync(journal, {recursive: true});
  writeFileSync(dest, "old");
  writeFileSync(lock, "concurrent edit");
  writeFileSync(join(journal, "0.old"), "old");
  writeFileSync(join(journal, "0.new"), "updated");
  writeFileSync(join(journal, "1.new"), "new lock");
  writeFileSync(join(journal, "operations.json"), JSON.stringify([
    {path: "AGENTS.md", before: hash("old"), after: hash("updated"), mode: 0o640},
    {path: ".workbench/kit-lock.json", before: null, after: hash("new lock"), mode: 0o600},
  ]));
  const recover = () => recoverInstall(target);
  expect(recover).toThrow("Migration conflict at " + lock);
  expect(readFileSync(dest, "utf8")).toBe("updated");
  expect(recover).toThrow("Migration conflict at " + lock);
  writeFileSync(dest, "edit after interruption");
  expect(recover).toThrow("Copy the saved file " + join(journal, "0.old"));
  expect(readFileSync(join(journal, "0.new"), "utf8")).toBe("updated");
  cpSync(join(journal, "0.old"), dest);
  rmSync(lock);
  recover();
  recover();
  expect(readFileSync(dest, "utf8")).toBe("updated");
  expect(lstatSync(dest).mode & 0o777).toBe(0o640);
  expect(readFileSync(lock, "utf8")).toBe("new lock");
  expect(existsSync(journal)).toBe(false);
});

test("guard and ledger fields keep their v0.4 sections in sync, doctor and policy reads", () => {
  const {root} = initWorkbench({targetDir: target});
  const path = join(root, ".workbench/workbench.yaml");
  const lock = join(root, ".workbench/kit-lock.json");
  const config = Bun.YAML.parse(readFileSync(path,"utf8")) as {guard: Record<string,unknown>; ledger: Record<string,unknown>};
  config.guard.custom_block_patterns = ["^blocked-command$"];
  config.guard.prod_db_targets = [{host:"db-a"}, {name:"reporting", engine:"custom-engine", host:"db-b"}];
  config.guard.protected_branches = ["release"];
  config.ledger.exempt_max_lines = 0;
  writeFileSync(path, JSON.stringify(config));
  syncWorkbench({targetDir:root});
  expect(doctorWorkbench(root).issues.filter(i=>i.check==="configuration")).toEqual([]);
  expect(loadWorkbenchConfig(root)).toMatchObject({
    guard:{custom_block_patterns:["^blocked-command$"],protected_branches:["release"],
      prod_db_targets:[{name:"db-a",host:"db-a"},{name:"reporting",engine:"custom-engine",host:"db-b"}]},
    ledger:{exempt_max_lines:0},
  });
  const before = readFileSync(lock);
  for (const [section,key,value,expected] of [
    ["ledger","protected_branches",["release"],"move it to guard.protected_branches"],
    ["guard","exempt_max_lines",0,"move it to ledger.exempt_max_lines"],
    ["guard","prod_db_host",["db-a"],"guard.prod_db_host"],
    ["ledger","enabled_tasks",true,"ledger.enabled_tasks"],
    ["guard","prod_db_targets",[{host:"db-a",engnie:"postgres"}],"guard.prod_db_targets[0].engnie"],
  ] as const) {
    writeFileSync(path,JSON.stringify({...config,[section]:{...config[section],[key]:value}}));
    expect(()=>loadWorkbenchConfig(root)).toThrow(expected);
    expect(()=>syncWorkbench({targetDir:root})).toThrow(expected);
    const doctor = doctorWorkbench(root);
    expect(doctor.ok).toBe(false);
    const diagnosis=doctor.issues.map(i=>i.message).join("\n");
    expect(diagnosis).toContain(section+"."+key);
    expect(diagnosis).toContain(expected);
    expect(readFileSync(lock)).toEqual(before);
  }
});
