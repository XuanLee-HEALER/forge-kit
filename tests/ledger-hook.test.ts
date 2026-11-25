import { isolateHome } from "./helpers/hermetic";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { locateRepo, runGit } from "../src/git";
import { Ledger } from "../src/ledger";
import { classifyPostToolEvidence, handleLedgerHook } from "../src/ledger-hook";

isolateHome();

let wb: string;
let repoDir: string;

let savedPath: string | undefined;
beforeEach(() => {
  wb = mkdtempSync(join(tmpdir(), "forge-lhook-test-"));
  const bin = join(wb, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "gh"), `#!/bin/sh
set -eu
[ "$1" = pr ] && [ "$2" = view ]
branch=$(git branch --show-current)
case "$3" in */pull/99) branch=feat/other;; esac
sha=$(git rev-parse "$branch")
printf '{"url":"%s","headRefName":"%s","headRefOid":"%s","state":"OPEN","isCrossRepository":false,"headRepository":{"name":"svc"},"headRepositoryOwner":{"login":"acme"}}' "$3" "$branch" "\${TEST_GH_REMOTE_OID:-$sha}"`, { mode: 0o755 });
  savedPath = process.env.PATH; process.env.PATH = bin + ":" + savedPath;
  mkdirSync(join(wb, ".workbench", "ledger"), { recursive: true });
  writeFileSync(
    join(wb, ".workbench", "workbench.yaml"),
    `name: "hook-wb"\nrepos:\n  - svc\n`,
  );
  repoDir = join(wb, "svc");
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(join(repoDir, "tests"));
  runGit(repoDir, ["init", "-b", "main"]);
  runGit(repoDir, ["config", "user.email", "dev@example.com"]);
  runGit(repoDir, ["config", "user.name", "Dev"]);
  writeFileSync(join(repoDir, "a.txt"), "v1\n");
  runGit(repoDir, ["add", "a.txt"]);
  runGit(repoDir, ["commit", "-m", "chore: init"]);
  runGit(repoDir, ["checkout", "-b", "feat/work"]);

  const head = runGit(repoDir, ["rev-parse", "HEAD"]).stdout.trim();
  const ledger = new Ledger(wb);
  ledger.openTask({
    task_id: "20261121-work",
    title: "Hook auto-evidence",
    endpoint: "pr",
    depth: "full",
    repo: "svc",
    branch: "feat/work",
    base_sha: head,
    head_sha: head,
  });
  ledger.closeDb();
});

afterEach(() => {
  process.env.PATH = savedPath;
  rmSync(wb, { recursive: true, force: true });
});

describe("Ledger Passive Hooks (PostToolUse / SessionStart / PostCompact)", () => {
  test("validates manifest verification scripts without forwarded flags", () => {
    const evidence = (cmd: string) => classifyPostToolEvidence(cmd, repoDir, 0, "");
    const manifest = join(repoDir, "package.json");
    writeFileSync(manifest, JSON.stringify({ scripts: { test: "pytest --version", check: "tsc --version" } }));
    expect(evidence("npm test")).toEqual([]);
    expect(evidence("npm run check")).toEqual([]);
    writeFileSync(manifest, JSON.stringify({ scripts: { test: "pytest tests/" } }));
    expect(evidence("npm test")).toMatchObject([{ kind: "test", status: "pass" }]);
  });

  test("preserves the requested evidence kind through manifest delegation", () => {
    const evidence = (command: string, scripts: Record<string, string>) => {
      writeFileSync(join(repoDir, "package.json"), JSON.stringify({ scripts }));
      return classifyPostToolEvidence(command, repoDir, 0, "");
    };
    expect(evidence("npm test", { test: "tsc --noEmit" })).toEqual([]);
    expect(evidence("npm test", { test: "npm run lint", lint: "tsc --noEmit" })).toEqual([]);
    expect(evidence("npm run check", { check: "tsc --noEmit" })).toMatchObject([{ kind: "lint", status: "pass" }]);
    expect(evidence("npm run build", { build: "bun test" })).toEqual([]);
  });

  test("validates forwarded arguments at the underlying runner and checkout", () => {
    const sibling = join(wb, "svc-b");
    mkdirSync(join(sibling, "tests"), { recursive: true });
    runGit(sibling, ["init"]);
    mkdirSync(join(repoDir, "tests", "unit"), { recursive: true });
    const evidence = (args: string) => classifyPostToolEvidence("npm test -- " + args, repoDir, 0, "");
    for (const test of ["pytest", "npm run inner", "npm run inner --"]) {
      writeFileSync(join(repoDir, "package.json"), JSON.stringify({ scripts: { test, inner: "pytest" } }));
      expect(classifyPostToolEvidence("npm test ../svc-b/tests", repoDir, 0, "")).toEqual([]);
      expect(classifyPostToolEvidence("npm test --cache ../svc-b/tests tests/unit", repoDir, 0, ""))
        .toMatchObject([{ kind: "test", status: "pass" }]);
      expect(classifyPostToolEvidence("npm test tests/unit", repoDir, 0, "")).toMatchObject([{ kind: "test", status: "pass" }]);
      if (test === "npm run inner") {
        // npm consumes --co before its separator and executes the bare inner script.
        expect(evidence("--co")).toMatchObject([{ kind: "test", status: "pass" }]);
        expect(evidence("-v")).toEqual([]);
      } else {
        expect(evidence("--co")).toEqual([]);
        expect(evidence("-v")).toMatchObject([{ kind: "test", status: "pass" }]);
      }
      expect(evidence("../svc-b/tests")).toEqual([]);
      expect(evidence("tests/unit")).toMatchObject([{ kind: "test", status: "pass" }]);
    }
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ scripts: { test: "pytest" } }));
    expect(classifyPostToolEvidence("npm test -v", repoDir, 0, "")).toEqual([]);
    expect(classifyPostToolEvidence("npm test --logs-dir ../svc-b", repoDir, 0, ""))
      .toMatchObject([{ kind: "test", status: "pass", targetDir: repoDir }]);
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ scripts: { test: "npm run inner --", inner: "go -C . test" } }));
    expect(evidence("-v")).toMatchObject([{ kind: "test", status: "pass" }]);
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ scripts: { test: "npm run inner --", inner: "vitest" } }));
    expect(classifyPostToolEvidence("npm test -- -v", repoDir, 0, "")).toEqual([]);
  });

  test("rejects manifest state changes and suppresses verification before file writes", () => {
    const manifest = join(repoDir, "package.json");
    writeFileSync(manifest, JSON.stringify({ scripts: { test: "MAKEFLAGS=-n && make test" } }));
    expect(classifyPostToolEvidence("npm test", repoDir, 0, "")).toEqual([]);
    for (const later of ["eslint --fix .", "ruff check --fix", "biome check --write", "gofmt -w a.go", "tsc", "tsc --noEmit null", "bun build app.ts"]) {
      const script = "pytest && " + later;
      writeFileSync(manifest, JSON.stringify({ scripts: { test: script } }));
      expect(classifyPostToolEvidence("npm test", repoDir, 0, "")).toEqual([]);
      expect(classifyPostToolEvidence(script, repoDir, 0, "").some(e => e.kind === "test")).toBe(false);
    }
  });

  test("resolves trailing package scripts and their lifecycle hooks before crediting earlier tests", () => {
    const evidence = (command: string, scripts: Record<string, string>) => {
      writeFileSync(join(repoDir, "package.json"), JSON.stringify({ scripts }));
      return classifyPostToolEvidence(command, repoDir, 0, "").map(e => [e.kind, e.status]);
    };
    expect(evidence("pytest && npm run lint", { lint: "eslint . --format json --output-file report.json" })).toEqual([["lint", "pass"]]);
    expect(evidence("pytest && eslint . -o report.json", {})).toEqual([["lint", "pass"]]);
    expect(evidence("pytest && npm run lint", { lint: "eslint --fix ." })).toEqual([["lint", "pass"]]);
    expect(evidence("pytest && npm run check", { check: "tsc --noEmit" })).toEqual([["test", "pass"], ["lint", "pass"]]);
    expect(evidence("pytest && npm run check", { check: "tsc --noEmit", postcheck: "npm run change", change: "eslint --fix ." })).toEqual([]);
    expect(evidence("pytest && npm run check -- --fix", { check: "eslint ." })).toEqual([["lint", "pass"]]);
    expect(evidence("pytest && npm run check", { check: "npm run check" })).toEqual([]);
  });

  test("validates post-script lifecycle commands unless the manager skips them", () => {
    const evidence = (posttest: string, command = "npm test") => {
      writeFileSync(join(repoDir, "package.json"), JSON.stringify({ scripts: { test: "pytest", posttest } }));
      return classifyPostToolEvidence(command, repoDir, 0, "");
    };
    for (const command of ["npm test", "pnpm test", "yarn test", "bun run test"]) {
      for (const post of ["node update-fixtures.js", "echo x > app.ts", "exit 0", "A=1", "eslint --fix ."]) {
        expect(evidence(post, command)).toEqual([]);
      }
      expect(evidence("echo done", command)).toMatchObject([{ kind: "test", status: "pass" }]);
    }
    expect(evidence("node update-fixtures.js", "npm test --ignore-scripts")).toMatchObject([{ kind: "test", status: "pass" }]);
    for (const cmd of ["npm test --ignore-scripts false tests", "npm test --ignore-scripts=false tests",
      "npm --ignore-scripts false test", "npm_config_ignore_scripts=true npm test --no-ignore-scripts"]) {
      expect(evidence("node update-fixtures.js", cmd)).toEqual([]);
    }
    for (const cmd of ["npm test --ignore-scripts tests", "npm --ignore-scripts true test", "npm_config_ignore_scripts=true npm test"]) {
      expect(evidence("node update-fixtures.js", cmd)).toMatchObject([{ kind: "test", status: "pass" }]);
    }
    expect(evidence("node update-fixtures.js", "npm test -- --ignore-scripts")).toEqual([]);
  });

  test("requires executed lang-check phases and Hurl inputs through manifest scripts", () => {
    const evidence = (inner: string, output: string) => {
      writeFileSync(join(repoDir, "package.json"), JSON.stringify({ scripts: { test: "npm run inner", inner } }));
      return classifyPostToolEvidence("npm test", repoDir, 0, output);
    };
    const command = "lang-check --mode all --lang python --json";
    const report = (phase: string) => JSON.stringify({ ok: true, executed: 1, failed: 0, checks: [{ phase, status: "pass" }] });
    const banner = "> pkg@1.0.0 test\n> lang-check --mode all --json\n\n";
    expect(evidence(command, banner + report("dynamic"))).toMatchObject([{ kind: "test", status: "pass" }]);
    expect(evidence(command, banner + report("static"))).toEqual([]);
    expect(evidence(command, report("static"))).toEqual([]);
    expect(evidence(command, "")).toEqual([]);
    expect(evidence(command, report("dynamic"))).toMatchObject([{ kind: "test", status: "pass" }]);
    expect(evidence("hurl --test tests", "Executed files: 0\n")).toEqual([]);
    expect(evidence("hurl --test tests", "Executed files: 1\nSucceeded: 1 (100.0%)\n")).toMatchObject([{ kind: "test", status: "pass" }]);
  });

  test("classifies Bun builds directly and through a package script", () => {
    mkdirSync(join(repoDir, "src"));
    writeFileSync(join(repoDir, "src/index.ts"), "export default 1;");
    const build = "bun build --target=bun --outdir=dist src/index.ts";
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ scripts: { build } }));
    for (const command of [build, "npm run build", "bun run build"]) {
      expect(classifyPostToolEvidence(command, repoDir, 0, "")).toMatchObject([{ kind: "build", status: "pass" }]);
    }
    const sibling = join(wb, "svc-b");
    mkdirSync(sibling);
    runGit(sibling, ["init"]);
    writeFileSync(join(sibling, "package.json"), "{}");
    const evidence = (cmd: string) => classifyPostToolEvidence(cmd, repoDir, 0, "");
    for (const cmd of ["bun build ../svc-b/package.json", "bun build --sourcemap ../svc-b/package.json",
      "bun build --outdir ./dist ../svc-b/package.json"]) {
      expect(evidence(cmd)).toMatchObject([{ kind: "build", status: "pass", targetDir: sibling }]);
    }
    expect(evidence("bun --cwd . build ../svc-b/package.json")).toEqual([]);
    expect(evidence("bun build --external --cwd=../svc-b package.json"))
      .toMatchObject([{ kind: "build", status: "pass", targetDir: repoDir }]);
    expect(evidence("bun build --external --help package.json"))
      .toMatchObject([{ kind: "build", status: "pass", targetDir: repoDir }]);
    const direct = "bun build --cwd ../svc-b ./package.json";
    const delegatedCross = "bun --cwd . build --cwd=../svc-b ./package.json";
    const delegatedLocal = "bun --cwd . build";
    expect(classifyPostToolEvidence(direct, repoDir, 0, "")).toMatchObject([{ kind: "build", status: "pass", targetDir: sibling }]);
    expect(classifyPostToolEvidence(delegatedCross, repoDir, 0, "")).toEqual([]);
    expect(classifyPostToolEvidence(delegatedLocal, repoDir, 0, "")).toMatchObject([{ kind: "build", status: "pass", targetDir: repoDir }]);
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ scripts: { build: "echo skipped" } }));
    expect(classifyPostToolEvidence(delegatedLocal, repoDir, 0, "")).toEqual([]);
    writeFileSync(join(repoDir, "package.json"), "{}");
    expect(evidence("bun --cwd=. build ./src/index.ts")).toMatchObject([{ kind: "build", status: "pass" }]);
    expect(evidence("bun --cwd . build ./src/index.ts")).toEqual([]);
    expect(classifyPostToolEvidence("bun build --help", repoDir, 0, "")).toEqual([]);
    expect(classifyPostToolEvidence("bun build --version", repoDir, 0, "")).toEqual([]);
  });

  test("distinguishes Bun test scripts selected by a leading --cwd from the built-in runner", () => {
    const manifest = join(repoDir, "package.json");
    const evidence = (cmd: string, exitCode = 0) => classifyPostToolEvidence(cmd, repoDir, exitCode, "");
    const sibling = join(wb, "svc-b");
    mkdirSync(join(sibling, "tests"), { recursive: true });
    runGit(sibling, ["init"]);

    writeFileSync(manifest, JSON.stringify({ scripts: { test: "echo skipped" } }));
    expect(evidence("bun --cwd . test")).toEqual([]);
    expect(evidence("bun test --cwd .")).toMatchObject([{ kind: "test", status: "pass", targetDir: repoDir }]);

    writeFileSync(manifest, JSON.stringify({ scripts: { test: "pytest" } }));
    expect(evidence("bun --cwd . test")).toMatchObject([{ kind: "test", status: "pass", targetDir: repoDir }]);
    expect(evidence("bun --cwd . test ../svc-b/tests")).toEqual([]);

    writeFileSync(manifest, JSON.stringify({ scripts: {} }));
    expect(evidence("bun --cwd . test", 1)).toEqual([]);
    expect(evidence("bun --cwd=. test")).toMatchObject([{ kind: "test", status: "pass", targetDir: repoDir }]);
    expect(evidence("bun test")).toMatchObject([{ kind: "test", status: "pass", targetDir: repoDir }]);
  });

  test("resolves npm information flags in order and consumes config option values", () => {
    const sibling = join(wb, "svc-b");
    mkdirSync(sibling);
    runGit(sibling, ["init"]);
    writeFileSync(join(sibling, "init.js"), "");
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ scripts: { test: "pytest" } }));
    const evidence = (cmd: string) => classifyPostToolEvidence(cmd, repoDir, 0, "");
    for (const flag of ["--version", "--help", "--versions", "--usage"]) {
      expect(evidence("npm test " + flag + "=true")).toEqual([]);
      expect(evidence("npm test " + flag + " true")).toEqual([]);
      expect(evidence("npm " + flag + " false test")).toMatchObject([{ kind: "test", status: "pass" }]);
      const disable = flag === "--help" ? "--no-usage" : "--no-" + flag.slice(2);
      expect(evidence("npm test " + flag + " " + disable)).toMatchObject([{ kind: "test", status: "pass" }]);
    }
    for (const args of ["--help=0", "--help=FALSE", "--help=", "--no-usage=false", "--hel", "-H", "-sH", "--help --no-u", "--help --u=false"]) {
      expect(evidence("npm test " + args)).toEqual([]);
    }
    for (const args of ["--help=false", "-H false", "--help --no-usage=true"]) {
      expect(evidence("npm test " + args)).toMatchObject([{ kind: "test", status: "pass" }]);
    }
    for (const alias of ["--help", "-h", "-?"]) {
      expect(evidence("npm test " + alias + " --no-usage")).toMatchObject([{ kind: "test", status: "pass" }]);
      expect(evidence("npm test --no-usage " + alias)).toEqual([]);
    }
    expect(evidence("npm test --usage --help=false")).toMatchObject([{ kind: "test", status: "pass" }]);
    for (const args of ["--usage --no-help", "--no-help --usage", "--help --no-help"]) {
      expect(evidence("npm test " + args)).toEqual([]);
    }
    expect(evidence("npm test --init-module ../svc-b/init.js")).toMatchObject([{ kind: "test", status: "pass", targetDir: repoDir }]);
  });

  test("reconciles wrapped lang-check exit status and extracts reports between lifecycle banners", () => {
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ scripts: { test: "lang-check --mode all --json", posttest: "echo done" } }));
    const run = (phase: string, ok: boolean, code: number) => {
      const json = JSON.stringify({ ok, executed: 1, failed: ok ? 0 : 1,
        checks: [{ phase, status: ok ? "pass" : "fail", detail: 'braces }{"' }] }, null, 2);
      const output = "> pkg@1.0.0 test\n> lang-check --mode all --json\n\n{}\n" + json +
        "\n\n> pkg@1.0.0 posttest\n> echo done\n\ndone\n";
      return classifyPostToolEvidence("npm test", repoDir, code, output);
    };
    expect(run("dynamic", true, 0)).toMatchObject([{ kind: "test", status: "pass" }]);
    expect(run("dynamic", false, 1)).toMatchObject([{ kind: "test", status: "fail" }]);
    expect(run("dynamic", false, 0)).toEqual([]);
    expect(run("static", false, 1)).toEqual([]);
  });

  test("inherits nested lifecycle configuration and validates verbosity on the final runner", () => {
    const run = (scripts: Record<string, string>, cmd: string) => {
      writeFileSync(join(repoDir, "package.json"), JSON.stringify({ scripts }));
      return classifyPostToolEvidence(cmd, repoDir, 0, "");
    };
    const scripts = { test: "npm run inner", inner: "pytest", postinner: "eslint --fix ." };
    expect(run(scripts, "npm_config_ignore_scripts=true npm test")).toMatchObject([{ kind: "test", status: "pass" }]);
    expect(run(scripts, "npm test")).toEqual([]);
    expect(run({ ...scripts, test: "npm_config_ignore_scripts=false npm run inner" }, "npm_config_ignore_scripts=true npm test")).toEqual([]);
    const verbose = (inner: string) => run({ test: "npm run inner --", inner }, "npm test -- -v");
    expect(verbose("echo starting && go -C . test")).toMatchObject([{ kind: "test", status: "pass" }]);
    expect(verbose("echo starting && vitest")).toEqual([]);
    expect(verbose("echo starting && pytest > result")).toEqual([]);
  });

  test("resolves nested verification scripts and rejects no-ops, cycles and excessive depth", () => {
    const evidence = (scripts: Record<string, string>) => {
      writeFileSync(join(repoDir, "package.json"), JSON.stringify({ scripts }));
      return classifyPostToolEvidence("npm test", repoDir, 0, "");
    };
    for (const script of ["true", ":", "/bin/echo ok", "/usr/bin/printf ok", "pwd", "date", "exit 0"]) {
      expect(evidence({ test: script })).toEqual([]);
    }
    const chain = { test: "npm run test:unit", "test:unit": "npm run test:ci" };
    expect(evidence({ ...chain, "test:ci": "pytest --version" })).toEqual([]);
    expect(evidence({ ...chain, "test:ci": "pytest tests/" })).toMatchObject([{ kind: "test", status: "pass" }]);
    mkdirSync(join(repoDir, "sub"));
    writeFileSync(join(repoDir, "sub", "package.json"), JSON.stringify({ scripts: { unit: "true" } }));
    expect(evidence({ test: "npm --prefix sub run unit", unit: "pytest tests/" })).toEqual([]);
    expect(evidence({ test: "npm run a", a: "npm run b", b: "npm run a" })).toEqual([]);
    expect(evidence({ test: "npm run a", a: "npm run b", b: "npm run c", c: "npm run d",
      d: "npm run e", e: "npm run f", f: "npm run g", g: "pytest tests/" })).toEqual([]);
  });

  test("checks each manifest segment and resolves package scripts within the credited checkout", () => {
    const rootManifest = (test: string) => writeFileSync(join(repoDir, "package.json"), JSON.stringify({ scripts: { test } }));
    const evidence = (cwd = repoDir) => classifyPostToolEvidence("npm test", cwd, 0, "");
    for (const script of ["echo start && echo done", "echo start && pytest --version", "echo start && ls", "exec true && pytest", "return 0 && pytest", "! pytest",
      "pytest && exit 0", "pytest && git switch main", "pytest || true", "pytest; true"]) {
      rootManifest(script);
      expect(evidence()).toEqual([]);
    }
    rootManifest("echo start && pytest tests/");
    expect(evidence()).toMatchObject([{ kind: "test", status: "pass" }]);
    const src = join(repoDir, "src");
    mkdirSync(src);
    rootManifest("true");
    expect(evidence(src)).toEqual([]);

    const sibling = join(wb, "svc-b");
    mkdirSync(sibling);
    runGit(sibling, ["init"]);
    const localPackage = join(repoDir, "packages", "app");
    mkdirSync(localPackage, { recursive: true });
    for (const dir of [sibling, localPackage]) {
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "pytest tests/" } }));
    }
    for (const script of ["npm --prefix ../svc-b test", "cd ../svc-b && bun test", "make -C ../svc-b test"]) {
      rootManifest(script);
      expect(evidence(src)).toEqual([]);
    }
    for (const script of ["npm --prefix packages/app test", "cd packages/app && npm test", "make -C packages/app test"]) {
      rootManifest(script);
      expect(evidence(src)).toMatchObject([{ kind: "test", status: "pass" }]);
    }
  });

  test("rejects npm verification inherited from a parent of a nested checkout", () => {
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ scripts: { test: "pytest tests/" } }));
    const nested = join(repoDir, "nested");
    mkdirSync(nested);
    runGit(nested, ["init"]);
    expect(classifyPostToolEvidence("npm test", nested, 0, "")).toEqual([]);
  });

  test("matches enterprise PR evidence against the effective GH_HOST and GH_REPO", () => {
    runGit(repoDir, ["remote", "add", "origin", "https://ghe.example/acme/svc.git"]);
    const record = (args: string, host = "ghe.example") => handleLedgerHook(wb, {
      hook_event_name: "PostToolUse", cwd: repoDir, tool_name: "exec_command", tool_use_id: args,
      tool_input: { command: args + " -t demo -b b", workdir: repoDir },
      tool_response: { exit_code: 0, output: `https://${host}/acme/svc/pull/77` },
    }).recorded;
    expect(record("GH_HOST=ghe.example gh -R acme/svc pr create")).toBe(1);
    expect(record("GH_HOST=ghe.example GH_REPO=acme/svc gh pr create")).toBe(1);
    expect(record("GH_HOST=github.com gh pr create")).toBe(0);
    expect(record("GH_REPO=ghe.example/other/svc gh pr create")).toBe(0);
    const config = join(wb, "gh-config");
    mkdirSync(config);
    writeFileSync(join(config, "hosts.yml"), "'GHE.EXAMPLE':\n  user: demo\n");
    expect(record(`GH_HOST= GH_CONFIG_DIR='${config}' gh -R acme/svc pr create`)).toBe(1);
    expect(record(`GH_HOST= GH_CONFIG_DIR='${config}' GH_REPO=acme/svc gh pr create`)).toBe(1);
    writeFileSync(join(config, "hosts.yml"), "ghe.example: {}\nghe-b.example: {}\n");
    const multiHost = `GH_HOST= GH_CONFIG_DIR='${config}' gh -R acme/svc pr create --draft`;
    expect(record(multiHost)).toBe(0);
    runGit(repoDir, ["remote", "set-url", "origin", "https://github.com/acme/svc.git"]);
    expect(record(multiHost, "github.com")).toBe(1);
    runGit(repoDir, ["remote", "set-url", "origin", "https://ghe/acme/svc.git"]);
    expect(record("GH_HOST=ghe gh -R acme/svc pr create", "ghe")).toBe(1);
  });

  test("records PR creation with persistent repo flags and verifies the URL port", () => {
    runGit(repoDir, ["remote", "add", "origin", "https://github.com:443/acme/svc.git"]);
    const record = (command: string, port: number, workdir = repoDir) => handleLedgerHook(wb, {
      hook_event_name: "PostToolUse", cwd: workdir, tool_name: "exec_command",
      tool_use_id: command + port, tool_input: { command, workdir },
      tool_response: { exit_code: 0, output: `https://github.com:${port}/acme/svc/pull/42` },
    }).recorded;
    expect(record("gh -R acme/svc pr create -t demo -b b", 443)).toBe(1);
    expect(record("gh pr -R acme/svc create -t demo -b b", 443)).toBe(1);
    expect(record("env -Csvc gh pr create -t demo -b b", 443, wb)).toBe(1);
    runGit(repoDir, ["update-ref", "refs/remotes/origin/feat/work", "HEAD"]);
    process.env.TEST_GH_REMOTE_OID = "f".repeat(40);
    try { expect(record("gh pr create -t demo -b b", 443)).toBe(0); }
    finally { delete process.env.TEST_GH_REMOTE_OID; }
    expect(record("gh pr create -t demo -b b", 443)).toBe(1);
    runGit(repoDir, ["remote", "set-url", "origin", "https://github.com/acme/svc.git"]);
    expect(record("gh pr create -t demo -b b", 8443)).toBe(0);
  });

  test("ignores ambiguous `|| true` and echo text; records pinned review head SHA and deduplicates by tool_use_id", () => {
    // Ambiguous `bun test || true` must NOT fabricate pass!
    const amb = handleLedgerHook(wb, {
      hook_event_name: "PostToolUse",
      cwd: repoDir,
      tool_name: "exec_command",
      tool_use_id: "tu-amb",
      tool_input: { command: "bun test || true", workdir: repoDir },
      tool_response: { exit_code: 0, output: "failed" },
    });
    expect(amb.recorded).toBe(0);

    // `echo bun test` (unquoted!) and `bun test | tee test.log` MUST NOT fabricate pass!
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-echo-unquoted",
        tool_input: { command: "echo bun test", workdir: repoDir },
        tool_response: { exit_code: 0, output: "bun test" },
      }).recorded,
    ).toBe(0);
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-pipe",
        tool_input: { command: "bun test | tee test.log", workdir: repoDir },
        tool_response: { exit_code: 0, output: "FAIL" },
      }).recorded,
    ).toBe(0);

    // Env-prefixed real `CI=1 bun test` SHOULD record pass!
    const envTest = handleLedgerHook(wb, {
      hook_event_name: "PostToolUse",
      cwd: repoDir,
      tool_name: "exec_command",
      tool_use_id: "tu-env-test",
      tool_input: { command: "CI=1 bun test", workdir: repoDir },
      tool_response: { exit_code: 0, output: "all pass" },
    });
    expect(envTest.recorded).toBe(1);

    // Direct `bun test` records once; duplicate delivery with SAME tool_use_id is idempotent!
    const pass1 = handleLedgerHook(wb, {
      hook_event_name: "PostToolUse",
      cwd: repoDir,
      tool_name: "exec_command",
      tool_use_id: "tu-test-1",
      tool_input: { command: "bun test", workdir: repoDir },
      tool_response: { exit_code: 0, output: "3 pass" },
    });
    const pass1Dup = handleLedgerHook(wb, {
      hook_event_name: "PostToolUse",
      cwd: repoDir,
      tool_name: "exec_command",
      tool_use_id: "tu-test-1",
      tool_input: { command: "bun test", workdir: repoDir },
      tool_response: { exit_code: 0, output: "3 pass" },
    });
    expect(pass1.recorded).toBe(1);
    expect(pass1Dup.recorded).toBe(1);

    // Review CLI finishes for pinned SHA `oldsha1111` even after HEAD moves!
    const rev = handleLedgerHook(wb, {
      hook_event_name: "PostToolUse",
      cwd: wb,
      tool_name: "exec_command",
      tool_use_id: "tu-rev-1",
      tool_input: {
        command: `review-agents/bin/review-quality --repo ${repoDir} --base base0000 --head oldsha1111`,
      },
      tool_response: {
        exit_code: 2,
        output: JSON.stringify({
          status: "error",
          errorCode: "credit_balance_exhausted",
          head: "oldsha1111",
          base: "base0000",
        }),
      },
    });
    expect(rev.recorded).toBe(1);

    const ledger = new Ledger(wb);
    try {
      const events = ledger.getTaskEvents("20261121-work");
      // 1 TASK_OPENED + 1 REPO_ATTACHED + 1 CI=1 bun test + 1 bun test (deduped!) + 1 review-quality = 5 events
      expect(events.length).toBe(5);
      const revEv = events[events.length - 1];
      expect(revEv.sha).toBe("oldsha1111");
      expect(revEv.payload_json).toContain('"credit_balance_exhausted":true');
      expect(ledger.verify().ok).toBe(true);
    } finally {
      ledger.closeDb();
    }
  });

  test("blocks multi-line failure masking, review polling, hurl --version; handles cross-branch PR & 4-role fallback end-to-end", async () => {
    const head = runGit(repoDir, ["rev-parse", "HEAD"]).stdout.trim();

    // 1. Multi-line shell where line 1 fails and line 2 succeeds MUST NOT record pass!
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-multiline",
        tool_input: { command: "bun test\necho done", workdir: repoDir },
        tool_response: { exit_code: 0, output: "FAIL\ndone" },
      }).recorded,
    ).toBe(0);

    const report = JSON.stringify({ repo: repoDir, role: "quality", reviewFloorSeq: 0, reviewTaskId: "20261121-work", status: "pass", findings: [], base: head, head });
    for (const [args, expected] of [[`--base ${head} --head ${head}`, 1], ["--status=task-1", 0], ["--list=tasks", 0]] as const) {
      expect(handleLedgerHook(wb, { hook_event_name: "PostToolUse", cwd: wb, tool_name: "exec_command",
        tool_input: { command: `review-agents/bin/review-quality --repo ${repoDir} ${args}` },
        tool_response: { exit_code: 0, output: report } }).recorded).toBe(expected);
    }

    const finished = { repo: repoDir, head, base: head, role: "quality", reviewFloorSeq: 0, reviewTaskId: "20261121-work", status: "pass",
      reviewExecution: { id: "fixture-execution", startedAt: new Date().toISOString() } };
    for (const invocation of ["first", "replay"]) {
      expect(handleLedgerHook(wb, { hook_event_name: "PostToolUse", cwd: wb, tool_name: "exec_command",
        tool_use_id: invocation, tool_input: { command: "review-agents/bin/review-quality --resume saved-task" },
        tool_response: { exit_code: 0, output: JSON.stringify(finished) } }).recorded).toBe(1);
    }
    const receipt = "…truncated…\nFORGE_REVIEW_RECEIPT " + JSON.stringify(finished);
    const cli = `review-agents/bin/review-quality --repo ${repoDir} --base ${head} --head ${head}`;
    expect(classifyPostToolEvidence(cli, wb, 0, receipt)[0]?.status).toBe("pass");
    expect(classifyPostToolEvidence(cli + " && " + cli, wb, 0, receipt)).toEqual([]);
    expect(classifyPostToolEvidence(cli.replace("review-quality", "review-comments"), wb, 0, receipt)).toEqual([]);
    const replayLedger = new Ledger(wb);
    expect(replayLedger.getTaskEvents("20261121-work").filter(event => event.tool_use_id === "review-execution:fixture-execution")).toHaveLength(1);
    replayLedger.closeDb();
    const stale = join(wb, "prior-review.json");
    writeFileSync(stale, JSON.stringify({ status: "error", errorCode: "credit_balance_exhausted", head, base: head }));
    const failed = classifyPostToolEvidence(`review-agents/bin/review-quality --repo ${repoDir} --head ${head} --out ${stale}`,
      wb, 2, JSON.stringify({ status: "error", summary: "Task exists" }));
    expect(failed[0]?.meta?.credit_balance_exhausted).toBe(false);

    // 2. `review-quality --status` polling or in-flight JSON MUST NOT record pass!
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: wb,
        tool_name: "exec_command",
        tool_use_id: "tu-poll-flag",
        tool_input: { command: `review-agents/bin/review-quality --repo ${repoDir} --status task-1` },
        tool_response: {
          exit_code: 0,
          output: JSON.stringify({ status: "running", head }),
        },
      }).recorded,
    ).toBe(0);
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: wb,
        tool_name: "exec_command",
        tool_use_id: "tu-running-json",
        tool_input: { command: `review-agents/bin/review-quality --repo ${repoDir} --base ${head} --head ${head}` },
        tool_response: {
          exit_code: 0,
          output: JSON.stringify({ status: "running", head }),
        },
      }).recorded,
    ).toBe(0);

    // 3. `hurl --version`, `hurl --max-redirs 5`, `hurl --file-root <existing-dir>`, zero-entry hurl, `bun test --help`, `gh pr create --help`, and empty `codex review --commit=` MUST NOT record!
    mkdirSync(join(repoDir, "hurl-dir"), { recursive: true });
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-hurl-ver",
        tool_input: { command: "hurl --version", workdir: repoDir },
        tool_response: { exit_code: 0, output: "hurl 6.0.0" },
      }).recorded,
    ).toBe(0);
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-hurl-fileroot",
        tool_input: { command: "hurl --file-root hurl-dir", workdir: repoDir },
        tool_response: { exit_code: 0, output: "Executed files: 0" },
      }).recorded,
    ).toBe(0);
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-hurl-flagval",
        tool_input: { command: "hurl --max-redirs 5", workdir: repoDir },
        tool_response: { exit_code: 0, output: "Executed entries: 0" },
      }).recorded,
    ).toBe(0);
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-test-help",
        tool_input: { command: "bun test --help", workdir: repoDir },
        tool_response: { exit_code: 0, output: "Usage: bun test" },
      }).recorded,
    ).toBe(0);
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-gh-help",
        tool_input: { command: "gh pr create --help", workdir: repoDir },
        tool_response: { exit_code: 0, output: "Create a pull request" },
      }).recorded,
    ).toBe(0);
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-gh-dryrun",
        tool_input: { command: "gh pr create --dry-run --title t --body b", workdir: repoDir },
        tool_response: { exit_code: 0, output: "dry run" },
      }).recorded,
    ).toBe(0);
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-gh-dryrun-eq",
        tool_input: { command: "gh pr create --dry-run=true --title t --body b", workdir: repoDir },
        tool_response: { exit_code: 0, output: "https://github.com/acme/svc/pull/999" },
      }).recorded,
    ).toBe(0);
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-gh-web-eq",
        tool_input: { command: "gh pr create --web=true --title t --body b", workdir: repoDir },
        tool_response: { exit_code: 0, output: "Opening browser" },
      }).recorded,
    ).toBe(0);
    // Missing OR local-path origin (`/acme/svc`) MUST NOT allow recording pr/pass!
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-gh-no-origin",
        tool_input: { command: "gh pr create --title t --body b", workdir: repoDir },
        tool_response: { exit_code: 0, output: "https://github.com/acme/svc/pull/77" },
      }).recorded,
    ).toBe(0);
    runGit(repoDir, ["remote", "add", "origin", "/acme/svc"]);
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-gh-local-path-origin",
        tool_input: { command: "gh pr create --title t --body b", workdir: repoDir },
        tool_response: { exit_code: 0, output: "https://github.com/acme/svc/pull/77" },
      }).recorded,
    ).toBe(0);
    // Same-repo `-R acme/svc` failure MUST record pr/fail (while mismatched `-R other/svc`, attached `-Rother/svc`, and bundled `-dRother/svc` are ignored!)
    runGit(repoDir, ["remote", "set-url", "origin", "git@github.com:acme/svc.git"]);
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-gh-bundled-other-repo",
        tool_input: { command: "gh pr create -dRother/svc --title t --body b", workdir: repoDir },
        tool_response: { exit_code: 0, output: "https://github.com/other/svc/pull/78" },
      }).recorded,
    ).toBe(0);
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-gh-other-repo",
        tool_input: { command: "gh pr create -R other/svc --title t --body b", workdir: repoDir },
        tool_response: { exit_code: 1, output: "failed" },
      }).recorded,
    ).toBe(0);
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-gh-other-attached",
        tool_input: { command: "gh pr create -Rother/svc --title t --body b", workdir: repoDir },
        tool_response: { exit_code: 0, output: "https://github.com/other/svc/pull/7" },
      }).recorded,
    ).toBe(0);
    // Attached `-Hfeat/work` (contains `w`!) MUST NOT be mistaken for `-w` (`--web`)!
    // Also chained `echo <url> && gh pr create` and mismatched URL repo MUST NOT fabricate pr/pass!
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-gh-chained-url",
        tool_input: {
          command: "echo https://github.com/acme/svc/pull/8 && gh pr create --dry-run=false",
          workdir: repoDir,
        },
        tool_response: { exit_code: 0, output: "https://github.com/acme/svc/pull/8" },
      }).recorded,
    ).toBe(0);
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-gh-wrong-url-repo",
        tool_input: { command: "gh pr create -Hfeat/work -tnews --body b", workdir: repoDir },
        tool_response: { exit_code: 0, output: "https://github.com/other/svc/pull/8" },
      }).recorded,
    ).toBe(0);
    // Valid attached `-Hfeat/work -tnews` AND `-t --dry-run` (flag-like title value!) with matching PR URL succeed cleanly!
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-gh-attached-head-valid",
        tool_input: { command: "gh pr create -Hfeat/work -tnews --body b", workdir: repoDir },
        tool_response: { exit_code: 0, output: "https://github.com/acme/svc/pull/12" },
      }).recorded,
    ).toBe(1);
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-gh-title-dryrun-val",
        tool_input: { command: "gh pr create -t --dry-run --body b", workdir: repoDir },
        tool_response: { exit_code: 0, output: "https://github.com/acme/svc/pull/13" },
      }).recorded,
    ).toBe(1);
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-gh-title-help-val",
        tool_input: { command: "gh pr create -t --help --body b", workdir: repoDir },
        tool_response: { exit_code: 0, output: "https://github.com/acme/svc/pull/14" },
      }).recorded,
    ).toBe(1);
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-gh-title-ver-val",
        tool_input: { command: "gh pr create -t --version --body b", workdir: repoDir },
        tool_response: { exit_code: 0, output: "https://github.com/acme/svc/pull/15" },
      }).recorded,
    ).toBe(1);
    // Go pflag boolean false spellings (`--help=f`, `--dry-run=F`, `--web=0`) AND last-write-wins (`--help --help=f`) allow pr/pass!
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-gh-pflag-false",
        tool_input: { command: "gh pr create --help=f --dry-run=F --web=0 -t demo -b b", workdir: repoDir },
        tool_response: { exit_code: 0, output: "https://github.com/acme/svc/pull/16" },
      }).recorded,
    ).toBe(1);
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-gh-last-write-wins",
        tool_input: { command: "gh pr create --help --help=f -t demo -b b", workdir: repoDir },
        tool_response: { exit_code: 0, output: "https://github.com/acme/svc/pull/17" },
      }).recorded,
    ).toBe(1);
    // `-w=F --dry-run` MUST NOT mistake `F` after `=` for `-F` value flag (dry-run stays detected -> 0 recorded!)
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-gh-wf-dryrun",
        tool_input: { command: "gh pr create -w=F --dry-run -t demo -b b", workdir: repoDir },
        tool_response: { exit_code: 0, output: "https://github.com/acme/svc/pull/18" },
      }).recorded,
    ).toBe(0);
    // `-h=f` and `-dh=false` in gh still print help -> 0 recorded!
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-gh-hf",
        tool_input: { command: "gh pr create -h=f -t demo -b b", workdir: repoDir },
        tool_response: { exit_code: 0, output: "https://github.com/acme/svc/pull/19" },
      }).recorded,
    ).toBe(0);
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-gh-dh-false",
        tool_input: { command: "gh pr create -dh=false -t demo -b b", workdir: repoDir },
        tool_response: { exit_code: 0, output: "https://github.com/acme/svc/pull/20" },
      }).recorded,
    ).toBe(0);
    // Short `-h` cannot be overridden by subsequent `--help=f` in gh CLI -> 0 recorded!
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-gh-h-then-help-f",
        tool_input: { command: "gh pr create -h --help=f -t demo -b b", workdir: repoDir },
        tool_response: { exit_code: 0, output: "https://github.com/acme/svc/pull/21" },
      }).recorded,
    ).toBe(0);
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-gh-dh-false-then-help-f",
        tool_input: { command: "gh pr create -dh=false --help=f -t demo -b b", workdir: repoDir },
        tool_response: { exit_code: 0, output: "https://github.com/acme/svc/pull/22" },
      }).recorded,
    ).toBe(0);
    // Invalid Go strconv.ParseBool spellings (`--help=fAlSe`, `--help=" false "`) fail flag parsing -> 0 recorded (never pr/fail or pr/pass)!
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-gh-help-bad-case",
        tool_input: { command: "gh pr create --help=fAlSe -t demo -b b", workdir: repoDir },
        tool_response: { exit_code: 1, output: 'invalid argument "fAlSe" for "--help" flag' },
      }).recorded,
    ).toBe(0);
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-gh-help-bad-space",
        tool_input: { command: 'gh pr create --help=" false " -t demo -b b', workdir: repoDir },
        tool_response: { exit_code: 1, output: 'invalid argument " false " for "--help" flag' },
      }).recorded,
    ).toBe(0);
    // Invalid boolean value aborts pflag immediately even if followed by valid `--help=false` -> 0 recorded!
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-gh-help-bad-then-false",
        tool_input: { command: "gh pr create --help=fAlSe --help=false -t demo -b b", workdir: repoDir },
        tool_response: { exit_code: 1, output: 'invalid argument "fAlSe" for "--help" flag' },
      }).recorded,
    ).toBe(0);
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-gh-dryrun-bad-then-false",
        tool_input: { command: "gh pr create --dry-run=bad --dry-run=false -t demo -b b", workdir: repoDir },
        tool_response: { exit_code: 1, output: 'invalid argument "bad" for "--dry-run" flag' },
      }).recorded,
    ).toBe(0);
    // Invalid boolean value on ANY gh pr create flag (e.g. `--draft=bad --draft=false`, `-d=bad`) aborts pflag -> 0 recorded!
    // While valid `--draft` and `--attach --dry-run` still record normally!
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-gh-draft-bad-then-false",
        tool_input: { command: "gh pr create --draft=bad --draft=false -t demo -b b", workdir: repoDir },
        tool_response: { exit_code: 1, output: 'invalid argument "bad" for "-d, --draft" flag' },
      }).recorded,
    ).toBe(0);
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-gh-valid-draft-and-attach",
        tool_input: { command: "gh pr create --draft --attach --dry-run -t demo -b b", workdir: repoDir },
        tool_response: { exit_code: 0, output: "https://github.com/acme/svc/pull/23" },
      }).recorded,
    ).toBe(1);
    // Unclosed CSV quote AND newline-only EOF on StringSlice flags fail pflag -> 0 recorded!
    // While `"ok"\r\n` (quoted field + CRLF) succeeds in Go csv.Reader -> 1 recorded!
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-gh-bad-csv-label",
        tool_input: { command: `gh pr create --label '"foo' -t demo -b b`, workdir: repoDir },
        tool_response: { exit_code: 1, output: 'invalid argument "\\"foo" for "-l, --label" flag: parse error' },
      }).recorded,
    ).toBe(0);
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-gh-newline-only-csv",
        tool_input: { command: `gh pr create --label '\n' -t demo -b b`, workdir: repoDir },
        tool_response: { exit_code: 1, output: 'invalid argument "\\n" for "-l, --label" flag: EOF' },
      }).recorded,
    ).toBe(0);
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-gh-quoted-crlf-csv",
        tool_input: { command: `gh pr create --label '"ok"\r\n' -t demo -b b`, workdir: repoDir },
        tool_response: { exit_code: 0, output: "https://github.com/acme/svc/pull/41" },
      }).recorded,
    ).toBe(1);
    // Standalone `\r` (both raw single-quoted and Bash ANSI-C `$'\r'`) hits Go csv.Reader EOF -> 0 recorded;
    // `"ok"\r` (both raw and `$'"ok"\r'`) and empty `--label ''` are valid -> 1 recorded!
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-gh-cr-only-csv",
        tool_input: { command: `gh pr create --label '\r' -t demo -b b`, workdir: repoDir },
        tool_response: { exit_code: 1, output: 'invalid argument "\\r" for "-l, --label" flag: EOF' },
      }).recorded,
    ).toBe(0);
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-gh-ansi-c-cr-only-csv",
        tool_input: { command: `gh pr create --label $'\\r' -t demo -b b`, workdir: repoDir },
        tool_response: { exit_code: 1, output: 'invalid argument "\\r" for "-l, --label" flag: EOF' },
      }).recorded,
    ).toBe(0);
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-gh-quoted-cr-csv",
        tool_input: { command: `gh pr create --label '"ok"\r' -t demo -b b`, workdir: repoDir },
        tool_response: { exit_code: 0, output: "https://github.com/acme/svc/pull/43" },
      }).recorded,
    ).toBe(1);
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-gh-ansi-c-quoted-cr-csv",
        tool_input: { command: `gh pr create --label $'"ok"\\r' -t demo -b b`, workdir: repoDir },
        tool_response: { exit_code: 0, output: "https://github.com/acme/svc/pull/45" },
      }).recorded,
    ).toBe(1);
    // Bash ANSI-C NUL truncation (`$'"ok"\0tail'` -> `"ok"`) and UTF-8 multi-byte hex (`$'caf\xc3\xa9'` -> `café`)!
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-gh-ansi-c-nul-trunc",
        tool_input: { command: `gh pr create --label $'"ok"\\0tail' -t demo -b b`, workdir: repoDir },
        tool_response: { exit_code: 0, output: "https://github.com/acme/svc/pull/46" },
      }).recorded,
    ).toBe(1);
    const utf8Ev = classifyPostToolEvidence(
      `gh pr create --head $'caf\\xc3\\xa9' -t demo -b b`,
      repoDir,
      0,
      "https://github.com/acme/svc/pull/47",
    );
    expect(utf8Ev[0]?.targetBranch).toBe("café");
    // Surrogate-pair emoji inside `$'...'` AND split UTF-8 bytes across adjacent `$'...'$'...'` chunks!
    expect(
      classifyPostToolEvidence(
        `gh pr create --head $'feat/🚀' -t demo -b b`,
        repoDir,
        0,
        "https://github.com/acme/svc/pull/48",
      )[0]?.targetBranch,
    ).toBe("feat/🚀");
    expect(
      classifyPostToolEvidence(
        `gh pr create --head $'caf\\xc3'$'\\xa9' -t demo -b b`,
        repoDir,
        0,
        "https://github.com/acme/svc/pull/49",
      )[0]?.targetBranch,
    ).toBe("café");
    // Unquoted U+00A0 NBSP in branch name is NOT a POSIX shell word separator (stays a single token)!
    expect(
      classifyPostToolEvidence(
        `gh pr create --head feat/a\u00a0b -t demo -b b`,
        repoDir,
        0,
        "https://github.com/acme/svc/pull/50",
      )[0]?.targetBranch,
    ).toBe("feat/a\u00a0b");
    // Double-quoted backslash before non-special char stays literal per POSIX/Bash; CRLF PR URL lines still match!
    expect(
      classifyPostToolEvidence(
        `gh pr create --head "feat/a\\b" -t demo -b b`,
        repoDir,
        0,
        "https://github.com/acme/svc/pull/51\r\n",
      )[0]?.targetBranch,
    ).toBe("feat/a\\b");
    expect(
      classifyPostToolEvidence(
        `gh pr create --head "feat/a\\\\b" -t demo -b b`,
        repoDir,
        0,
        "https://github.com/acme/svc/pull/52",
      )[0]?.targetBranch,
    ).toBe("feat/a\\b");
    // Bash backslash-newline line continuation in verification commands MUST still classify!
    const contVerify = classifyPostToolEvidence("bun \\\nrun check", repoDir, 0, "ok");
    expect(contVerify.length).toBe(1);
    expect(contVerify[0]?.kind).toBe("lint");
    expect(contVerify[0]?.status).toBe("pass");
    expect(classifyPostToolEvidence("FOO=1 \\\nbun \\\ntest", repoDir, 0, "ok")[0]?.kind).toBe("test");
    // Dry-run / non-executing verification flags MUST NEVER fabricate pass evidence!
    expect(classifyPostToolEvidence("make test -n -f /dev/stdin", repoDir, 0, "false")).toEqual([]);
    expect(classifyPostToolEvidence("make test --dry -f Makefile", repoDir, 0, "false")).toEqual([]);
    expect(classifyPostToolEvidence("make test -kt", repoDir, 0, "ok")).toEqual([]);
    expect(classifyPostToolEvidence("make test -q", repoDir, 0, "")).toEqual([]);
    expect(classifyPostToolEvidence("make test -v", repoDir, 0, "GNU Make")).toEqual([]);
    expect(classifyPostToolEvidence("MAKEFLAGS=n make test", repoDir, 0, "false")).toEqual([]);
    expect(classifyPostToolEvidence("make test MAKEFLAGS=--dry-run", repoDir, 0, "false")).toEqual([]);
    expect(classifyPostToolEvidence("make test -f /dev/stdin MAKEFLAGS:=-n", repoDir, 0, "false")).toEqual([]);
    expect(classifyPostToolEvidence("make test MAKEFLAGS+=-i", repoDir, 0, "ignored")).toEqual([]);
    expect(classifyPostToolEvidence("make test -o test", repoDir, 0, "Nothing to be done")).toEqual([]);
    expect(classifyPostToolEvidence("make test -i", repoDir, 0, "ignored")).toEqual([]);
    expect(classifyPostToolEvidence("make test -f -n", repoDir, 0, "ok")[0]?.kind).toBe("test");
    // Directory-switching flags (`make -C`, `just -d/-f`, `go -C`, `bun --cwd`, `npm --prefix`, `tsc -p`) MUST attribute to targetDir!
    const otherRepoDir = join(wb, "other-repo");
    expect(
      classifyPostToolEvidence("make test -C ../other-repo -f /dev/stdin", repoDir, 0, "")[0]?.targetDir,
    ).toBe(otherRepoDir);
    expect(
      classifyPostToolEvidence("make -C ../other-repo test -sf /dev/stdin", repoDir, 0, "")[0]?.targetDir,
    ).toBe(otherRepoDir);
    expect(
      classifyPostToolEvidence("make -j 2 -C ../other-repo test -sf /dev/stdin", repoDir, 0, "")[0]?.targetDir,
    ).toBe(otherRepoDir);
    expect(
      classifyPostToolEvidence("make -l 2.5 --jobs 4 -C ../other-repo test", repoDir, 0, "")[0]?.targetDir,
    ).toBe(otherRepoDir);
    expect(
      classifyPostToolEvidence("make -l 1e2 test -sf /dev/stdin", repoDir, 0, "")[0]?.kind,
    ).toBe("test");
    expect(
      classifyPostToolEvidence("make -l 0x1p2 test -sf /dev/stdin", repoDir, 0, "")[0]?.kind,
    ).toBe("test");
    expect(
      classifyPostToolEvidence("make -j test", repoDir, 0, "")[0]?.kind,
    ).toBe("test");
    // Comments, background `&`, `!` negation, and shell control/state builtins (`exit`, `exec`, `pushd`, `export`, etc.)
    // MUST NEVER fabricate pass evidence, while `2>&1` redirection still works!
    expect(classifyPostToolEvidence("true # && make test", repoDir, 0, "")).toEqual([]);
    expect(classifyPostToolEvidence("make test -f /dev/stdin & wait", repoDir, 0, "")).toEqual([]);
    expect(classifyPostToolEvidence("! make test", repoDir, 0, "")).toEqual([]);
    expect(classifyPostToolEvidence("exit 0 && make test", repoDir, 0, "")).toEqual([]);
    expect(classifyPostToolEvidence("FOO=1 exit 0 && make test", repoDir, 0, "")).toEqual([]);
    expect(classifyPostToolEvidence("exec true && make test", repoDir, 0, "")).toEqual([]);
    expect(classifyPostToolEvidence("pushd .. && make test", repoDir, 0, "")).toEqual([]);
    expect(classifyPostToolEvidence("export MAKEFLAGS=-n && make test", repoDir, 0, "")).toEqual([]);
    expect(classifyPostToolEvidence("f() { true; } && make test", repoDir, 0, "")).toEqual([]);
    expect(classifyPostToolEvidence('echo "(typecheck)" && bun run check', repoDir, 0, "")[0]?.kind).toBe("lint");
    // `codex help review` and non-review codex subcommands MUST NEVER fabricate `review/pass`,
    // while `codex -C ../other-repo review --commit HEAD` attributes accurately!
    const nativePass = JSON.stringify({ overall_correctness: "patch is correct", findings: [] });
    expect(classifyPostToolEvidence("codex review --commit " + head, repoDir, 0, "[P1] blocking finding")[0]?.status).toBe("fail");
    expect(classifyPostToolEvidence("codex help review", repoDir, 0, "Usage: codex review")).toEqual([]);
    expect(classifyPostToolEvidence('codex exec "review"', repoDir, 0, "ok")).toEqual([]);
    expect(classifyPostToolEvidence("codex review --help", repoDir, 0, "Usage: codex review")).toEqual([]);
    expect(classifyPostToolEvidence("codex review -hh", repoDir, 0, "Usage: codex review")).toEqual([]);
    expect(classifyPostToolEvidence("codex review --base", repoDir, 2, "a value is required")).toEqual([]);
    expect(classifyPostToolEvidence("codex review --base --uncommitted", repoDir, 2, "a value is required")).toEqual([]);
    expect(classifyPostToolEvidence("codex review --base main --commit HEAD", repoDir, 2, "cannot be used with")).toEqual([]);
    expect(classifyPostToolEvidence("codex review --base a --base b", repoDir, 2, "cannot be used multiple times")).toEqual([]);
    expect(classifyPostToolEvidence("codex review --uncommitted=true", repoDir, 2, "unexpected value")).toEqual([]);
    expect(classifyPostToolEvidence("codex review --uncommitted foo", repoDir, 2, "cannot be used with")).toEqual([]);
    expect(classifyPostToolEvidence("codex review --base main foo", repoDir, 2, "cannot be used with")).toEqual([]);
    expect(classifyPostToolEvidence("codex review --commit HEAD foo", repoDir, 2, "cannot be used with")).toEqual([]);
    expect(classifyPostToolEvidence("codex review --title onlytitle", repoDir, 2, "required arguments")).toEqual([]);
    expect(classifyPostToolEvidence("codex -s typo review --uncommitted", repoDir, 2, "invalid value")).toEqual([]);
    expect(classifyPostToolEvidence("codex -stypo review --uncommitted", repoDir, 2, "invalid value")).toEqual([]);
    expect(classifyPostToolEvidence("codex -s=typo review --uncommitted", repoDir, 2, "invalid value")).toEqual([]);
    expect(classifyPostToolEvidence("codex -s READ-ONLY review --uncommitted", repoDir, 2, "invalid value")).toEqual([]);
    expect(classifyPostToolEvidence("codex -a typo review --commit HEAD", repoDir, 2, "invalid value")).toEqual([]);
    expect(classifyPostToolEvidence("codex -a untrusted review --uncommitted", repoDir, 2, "invalid value")).toEqual([]);
    expect(classifyPostToolEvidence("codex -atypo review --commit HEAD", repoDir, 2, "invalid value")).toEqual([]);
    expect(classifyPostToolEvidence("codex --remote ws://127.0.0.1:8080 review --uncommitted", repoDir, 1, "only supported for interactive TUI")).toEqual([]);
    expect(classifyPostToolEvidence("codex --worktree review --uncommitted", repoDir, 1, "Error: `--worktree` supports new interactive sessions")).toEqual([]);
    expect(classifyPostToolEvidence("codex --worktree review --uncommitted", repoDir, 1, "")).toEqual([]);
    expect(classifyPostToolEvidence("codex -c badOverride review --uncommitted", repoDir, 1, "")).toEqual([]);
    expect(classifyPostToolEvidence("codex review -c badOverride --uncommitted", repoDir, 1, "")).toEqual([]);
    expect(classifyPostToolEvidence("codex review -cbadOverride --uncommitted", repoDir, 1, "")).toEqual([]);
    expect(classifyPostToolEvidence("codex -c =val review --uncommitted", repoDir, 1, "")).toEqual([]);
    expect(classifyPostToolEvidence("codex --enable round55unknown review --uncommitted", repoDir, 1, "Error: Unknown feature flag: round55unknown")).toEqual([]);
    expect(classifyPostToolEvidence("codex review --disable round55unknown", repoDir, 1, "Error: Unknown feature flag: round55unknown")).toEqual([]);
    expect(classifyPostToolEvidence("codex -c 'model=[]' review --uncommitted", repoDir, 1, "Error loading config.toml: invalid type: sequence, expected a string\nin `model`")).toEqual([]);
    expect(classifyPostToolEvidence("codex --config='model=[]' review --uncommitted", repoDir, 1, "Error loading config.toml: invalid type: sequence, expected a string")).toEqual([]);
    expect(classifyPostToolEvidence("codex review -c 'model=[]' --uncommitted", repoDir, 1, "Error loading config.toml: invalid type: sequence, expected a string")).toEqual([]);
    expect(classifyPostToolEvidence("codex review -cmodel=[] --uncommitted", repoDir, 1, "Error loading config.toml: invalid type: sequence, expected a string")).toEqual([]);
    expect(classifyPostToolEvidence("codex review -cmodel_provider=round56_missing --uncommitted", repoDir, 1, "Error: Model provider `round56_missing` not found")).toEqual([]);
    expect(classifyPostToolEvidence('codex -c \'model_provider=""\' review --uncommitted', repoDir, 1, "Error: Model provider `` not found")).toEqual([]);
    expect(classifyPostToolEvidence("codex -c 'model_provider=round`57' review --uncommitted", repoDir, 1, "Error: Model provider `round`57` not found")).toEqual([]);
    expect(classifyPostToolEvidence("codex -c 'model_provider=\"a\\nb\"' review --uncommitted", repoDir, 1, "Error: Model provider `a\nb` not found")).toEqual([]);
    expect(
      classifyPostToolEvidence(
        "codex -c 'model_provider=\"a\\nOpenAI Codex v1\\nb\"' review --uncommitted",
        repoDir,
        1,
        "WARNING: proceeding\nError: Model provider `a\nOpenAI Codex v1\nb` not found",
      ),
    ).toEqual([]);
    expect(
      classifyPostToolEvidence(
        "codex -c 'model_provider=\"a\\nsession id: 12345678\\nb\"' review --uncommitted",
        repoDir,
        1,
        "Error: Model provider `a\nsession id: 12345678\nb` not found",
      ),
    ).toEqual([]);
    expect(classifyPostToolEvidence("codex --oss review --uncommitted", repoDir, 1, "Error: No default OSS provider configured. Use --local-provider=provider")).toEqual([]);
    expect(classifyPostToolEvidence("codex --strict-config -c bogus_field=1 review --uncommitted", repoDir, 1, "Error loading config.toml: unknown configuration field `bogus_field`")).toEqual([]);
    expect(
      classifyPostToolEvidence(
        "codex review --uncommitted",
        repoDir,
        1,
        "OpenAI Codex v0.169.1\nsession id: 01a20173-da26-78e2-9739-6d7b00c8836a\nError loading config.toml: mentioned in diff",
      )[0]?.status,
    ).toBe("fail");
    expect(classifyPostToolEvidence("codex review -", repoDir, 1, "No prompt provided via stdin.")).toEqual([]);
    expect(classifyPostToolEvidence("codex -c model=o3 review --uncommitted", repoDir, 0, nativePass)[0]?.status).toBe("pass");
    expect(classifyPostToolEvidence("codex review -cmodel=o3 --uncommitted", repoDir, 0, nativePass)[0]?.status).toBe("pass");
    expect(classifyPostToolEvidence("codex review --uncommitted", repoDir, 1, "API request timed out")[0]?.status).toBe("fail");
    expect(classifyPostToolEvidence("codex -i a.png review --uncommitted", repoDir, 2, "unexpected argument")).toEqual([]);
    expect(classifyPostToolEvidence("codex -m a -m b review --uncommitted", repoDir, 2, "cannot be used multiple times")).toEqual([]);
    expect(classifyPostToolEvidence("codex -C /tmp --cd /tmp review --uncommitted", repoDir, 2, "cannot be used multiple times")).toEqual([]);
    expect(classifyPostToolEvidence("codex --approve-for-me -s read-only review --uncommitted", repoDir, 2, "cannot be used with")).toEqual([]);
    expect(classifyPostToolEvidence("codex --approve-for-me -a never review --uncommitted", repoDir, 2, "cannot be used with")).toEqual([]);
    expect(classifyPostToolEvidence("codex --approve-for-me --dangerously-bypass-approvals-and-sandbox review --uncommitted", repoDir, 2, "cannot be used with")).toEqual([]);
    expect(
      classifyPostToolEvidence(
        "codex -s read-only -a never review --uncommitted",
        repoDir,
        2,
        "error: invalid value 'x' for '--foo'\n\nFor more information, try '--help'.",
      ),
    ).toEqual([]);
    expect(
      classifyPostToolEvidence("codex -s read-only -a never review --uncommitted", repoDir, 2, "API request timed out")[0]
        ?.status,
    ).toBe("fail");
    expect(classifyPostToolEvidence("codex -s read-only -a never review --uncommitted", repoDir, 0, nativePass)[0]?.status).toBe("pass");
    expect(classifyPostToolEvidence("codex -i a.png -m o3 review --uncommitted", repoDir, 0, nativePass)[0]?.status).toBe("pass");
    expect(classifyPostToolEvidence("codex review --uncommitted", repoDir, 0, "LGTM")[0]?.kind).toBe("review");
    expect(classifyPostToolEvidence("codex -C ../other-repo review --commit HEAD", repoDir, 0, "LGTM")).toEqual([]);
    expect(classifyPostToolEvidence("false && make test", repoDir, 1, "")).toEqual([]);
    expect(classifyPostToolEvidence("make -f /dev/stdin test && cd /dev/null", repoDir, 1, "R42_TEST_RAN")).toEqual([]);
    expect(classifyPostToolEvidence("cd /dev/null && make test", repoDir, 1, "")).toEqual([]);
    expect(classifyPostToolEvidence("cd missing/.. && make test", repoDir, 1, "")).toEqual([]);
    expect(classifyPostToolEvidence("cd a.txt/.. && make test", repoDir, 1, "")).toEqual([]);
    // Bare `cd` switches to `$HOME` (must NOT stay in previous repo dir!)
    const homeEv = classifyPostToolEvidence("cd svc && cd && make -f /dev/stdin test", wb, 0, "");
    expect(homeEv[0]?.targetDir).toBe(process.env.HOME ?? "");
    // Logical `cd -L` across symlink `/tmp/..` resolves to the target repo and records `fail`!
    const symlinkCdEv = classifyPostToolEvidence(`cd /tmp/..${repoDir} && make test`, repoDir, 2, "No rule");
    expect(symlinkCdEv[0]?.status).toBe("fail");
    expect(symlinkCdEv[0]?.targetDir).toBe(repoDir);
    // Physical `cd -P /tmp/..` resolves via OS realpath(3) (`/private` on macOS), NOT `/`!
    expect(classifyPostToolEvidence("cd -P /tmp/.. && make test", repoDir, 2, "")[0]?.targetDir).toBe(
      realpathSync.native("/tmp/.."),
    );
    // Explicit `OLDPWD=. cd -` and empty `OLDPWD= cd -` stay in current dir per Bash; quoted `"OLDPWD=."` is a command name (NOT env assign)!
    expect(classifyPostToolEvidence("cd svc && OLDPWD=. cd - && make test", wb, 2, "")[0]?.targetDir).toBe(repoDir);
    expect(classifyPostToolEvidence("cd svc && OLDPWD= cd - && make test", wb, 2, "")[0]?.targetDir).toBe(repoDir);
    expect(classifyPostToolEvidence("HOME= cd -P && make test", repoDir, 1, "")).toEqual([]);
    expect(classifyPostToolEvidence("OLDPWD= cd -P - && make test", repoDir, 1, "")).toEqual([]);
    expect(classifyPostToolEvidence('"OLDPWD=." cd - && make test', repoDir, 127, "")).toEqual([]);
    expect(classifyPostToolEvidence('"FOO=1" bun test', repoDir, 127, "")).toEqual([]);
    expect(classifyPostToolEvidence("cd -@ svc && make test", wb, 1, "")).toEqual([]);
    expect(classifyPostToolEvidence("cd -e svc && make test", wb, 1, "")).toEqual([]);
    expect(classifyPostToolEvidence("cd svc && bun test", wb, 1, "1 fail")[0]?.status).toBe("fail");
    expect(classifyPostToolEvidence(": x\\ # && make -f /dev/stdin test", repoDir, 0, "ROUND41_OK")[0]?.status).toBe("pass");
    expect(classifyPostToolEvidence("bun test 2>&1", repoDir, 0, "ok")[0]?.status).toBe("pass");
    // GNU Make ignores `-C` inside MAKEFLAGS, so targetDir MUST remain curDir (`repoDir`)!
    expect(
      classifyPostToolEvidence("MAKEFLAGS=-C../other-repo make test -sf /dev/stdin", repoDir, 0, "")[0]?.targetDir,
    ).toBe(repoDir);
    expect(
      classifyPostToolEvidence("make test --dir=../other-repo", repoDir, 0, "")[0]?.targetDir,
    ).toBe(otherRepoDir);
    expect(
      classifyPostToolEvidence("make test -sC../other-repo", repoDir, 0, "")[0]?.targetDir,
    ).toBe(otherRepoDir);
    expect(
      classifyPostToolEvidence("just test -d ../other-repo", repoDir, 0, "")[0]?.targetDir,
    ).toBe(otherRepoDir);
    expect(
      classifyPostToolEvidence("go test -C ../other-repo ./...", repoDir, 0, "")[0]?.targetDir,
    ).toBe(otherRepoDir);
    // Multi `-C` git commit resolves sequentially (`packages/api`, NOT `/work/api`)!
    expect(
      classifyPostToolEvidence("git -C packages -C api commit -m fix", "/work", 0, "")[0]?.targetDir,
    ).toBe("/work/packages/api");
    // `bun test --cwd` resolves positional test paths relative to `--cwd` (distinct from `bun run <script> --cwd`)!
    expect(
      classifyPostToolEvidence("bun test --cwd ../other-repo ./tests/a.test.ts", repoDir, 0, "")[0]?.targetDir,
    ).toBe(join(otherRepoDir, "tests"));
    // Shared external Vitest `--config` suppresses misattribution to the shared config directory!
    expect(
      classifyPostToolEvidence("vitest run --config ../other-repo/vitest.config.ts", repoDir, 0, ""),
    ).toEqual([]);
    // `npm run lint --workspaces=true`, `-ws`, `--usage`, `--usag`, `--versions`, and Bun `--filter`/`-Fname`/`--workspaces` suppress attribution!
    expect(classifyPostToolEvidence("npm run lint --workspaces=true", repoDir, 0, "")).toEqual([]);
    expect(classifyPostToolEvidence("npm run lint -ws", repoDir, 0, "")).toEqual([]);
    expect(classifyPostToolEvidence("npm --usage run check", repoDir, 0, "")).toEqual([]);
    expect(classifyPostToolEvidence("npm --usag run check", repoDir, 0, "")).toEqual([]);
    expect(classifyPostToolEvidence("npm --versions run check", repoDir, 0, "")).toEqual([]);
    expect(classifyPostToolEvidence("bun --filter=pkg-b test", repoDir, 0, "")).toEqual([]);
    expect(classifyPostToolEvidence("bun -Fpkg-b test", repoDir, 0, "")).toEqual([]);
    expect(classifyPostToolEvidence("bun --workspaces run test", repoDir, 0, "")).toEqual([]);
    // Output redirections (`> /dev/null`) are stripped before Node test file resolution!
    expect(classifyPostToolEvidence("node --test > /dev/null", repoDir, 0, "")[0]?.targetDir).toBe(
      repoDir,
    );
    // Multi-line `set -e` followed by `git switch` suppresses earlier test attribution so wrong branch SHA is never credited!
    expect(
      classifyPostToolEvidence("set -e\nnpm test\ngit switch main", repoDir, 0, ""),
    ).toEqual([]);
    expect(
      classifyPostToolEvidence("set -e\nnpm test\nnpm run build", repoDir, 0, "")
        .map(({ kind, status }) => [kind, status]),
    ).toEqual([["build", "pass"]]);
    for (const [command, kinds] of [
      ["npm run check && bun test", ["lint", "test"]],
      ["npm run check && ./tools/ls", []],
      ["npm run check && /bin/ls", ["lint"]],
      ["npm run check && make test clean", []],
      ["make test clean", []],
      ["just test deploy", []],
      ["npm run check && npm test && npm run build", ["build"]],
      ["npm run check && git commit -m x", []],
      ["npm run check && echo x > app.ts", []],
    ] as const) {
      expect(classifyPostToolEvidence(command, repoDir, 0, "").map((e) => [e.kind, e.status]))
        .toEqual(kinds.map((kind) => [kind, "pass"]));
    }
    for (const command of [
      "npm run test:integration -- --help",
      "pnpm test -- --version",
      "bun run test -- --pass-with-no-tests",
      "yarn lint -- --watch",
      "npm run check -- --showConfig",
      "npm run check -- --noCheck",
      "npm run lint -- --print-config",
      "npm -v test",
      "npm run check -- -v",
      "bun run check -v",
      "pnpm lint -v",
      "yarn build -v",
      "bun run check --showConfig",
      "pnpm check --showConfig",
      "yarn lint --print-config",
      "bun run check -- --SHOWCONFIG=true",
    ]) {
      expect(classifyPostToolEvidence(command, repoDir, 0, "")).toEqual([]);
    }
    for (const runner of ["vitest", "jest", "node --test", "bun test", "pytest --version", "pytest --collect-only", "go test -list=."]) {
      writeFileSync(join(repoDir, "package.json"), JSON.stringify({ scripts: { test: runner } }));
      expect(classifyPostToolEvidence("npm test -- -v", repoDir, 0, "")).toEqual([]);
    }
    for (const runner of ["go test", "pytest", "pytest tests/"]) {
      writeFileSync(join(repoDir, "package.json"), JSON.stringify({ scripts: { test: runner } }));
      expect(classifyPostToolEvidence("npm test -- -v", repoDir, 0, "")[0]?.kind).toBe("test");
    }
    for (const [command, exitCode, status] of [
      ["npm test -- -v", 0, "pass"],
      ["npm test -- -v", 1, "fail"],
      ["bun run test -v", 0, "pass"],
      ["pnpm test -- -n 2", 0, "pass"],
    ] as const) {
      expect(classifyPostToolEvidence(command, repoDir, exitCode, "")).toMatchObject([{ kind: "test", status }]);
    }
    for (const value of ["false", "0", "null"]) {
      expect(classifyPostToolEvidence(`npm run check -- --showConfig=${value}`, repoDir, 0, "")[0]?.status).toBe("pass");
    }
    expect(
      classifyPostToolEvidence("bun --cwd core --cwd ../other-repo run check", repoDir, 0, "")[0]?.targetDir,
    ).toBe(otherRepoDir);
    // Repeated npm `--prefix` resolves LAST prefix against invocation dir (NOT nested!)
    expect(
      classifyPostToolEvidence("npm --prefix ./src --prefix ../other-repo run lint", repoDir, 0, "")[0]?.targetDir,
    ).toBe(otherRepoDir);
    // `svelte-check -v` (version query) records nothing; relative `--tsconfig` resolves against `--workspace`!
    expect(classifyPostToolEvidence("svelte-check -v", repoDir, 0, "3.8.0")).toEqual([]);
    expect(classifyPostToolEvidence("npx svelte-check -v", repoDir, 0, "3.8.0")).toEqual([]);
    expect(
      classifyPostToolEvidence(
        "svelte-check --workspace ../other-repo --tsconfig tsconfig.json",
        repoDir,
        0,
        "",
      )[0]?.targetDir,
    ).toBe(otherRepoDir);
    // `pnpm -w exec vitest run` from a member beneath `pnpm-workspace.yaml` resolves to workspace root!
    const wsRoot = join(wb, "ws-root");
    const wsMember = join(wsRoot, "packages", "member");
    mkdirSync(wsMember, { recursive: true });
    writeFileSync(join(wsRoot, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    expect(
      classifyPostToolEvidence("pnpm -w exec vitest run", wsMember, 0, "")[0]?.targetDir,
    ).toBe(wsRoot);

    expect(
      classifyPostToolEvidence("bun --cwd ../other-repo run check", repoDir, 0, "")[0]?.targetDir,
    ).toBe(otherRepoDir);
    expect(
      classifyPostToolEvidence("bun run --cwd ../other-repo check", repoDir, 0, "")[0]?.targetDir,
    ).toBe(otherRepoDir);
    // For `bun run <script> --cwd ...`, trailing flags belong to `<script>`, NOT Bun -> targetDir stays repoDir!
    expect(
      classifyPostToolEvidence("bun run check --cwd ../other-repo", repoDir, 0, "")[0]?.targetDir,
    ).toBe(repoDir);
    expect(
      classifyPostToolEvidence("bun run check --cwd ../other-repo", repoDir, 1, "")[0]?.targetDir,
    ).toBe(repoDir);
    expect(
      classifyPostToolEvidence("npm run lint --prefix ../other-repo", repoDir, 0, "")[0]?.targetDir,
    ).toBe(otherRepoDir);
    expect(
      classifyPostToolEvidence("npx tsc -p ../other-repo/tsconfig.json --noEmit", repoDir, 0, "")[0]?.targetDir,
    ).toBe(otherRepoDir);
    expect(classifyPostToolEvidence("just test --dry-run", repoDir, 0, "")).toEqual([]);
    expect(classifyPostToolEvidence("JUST_DRY_RUN=1 just test", repoDir, 0, "")).toEqual([]);
    expect(classifyPostToolEvidence("just test --allow-missing", repoDir, 0, "")).toEqual([]);
    expect(classifyPostToolEvidence("go test -n ./...", repoDir, 0, "")).toEqual([]);
    expect(classifyPostToolEvidence("go test -n=true ./...", repoDir, 0, "")).toEqual([]);
    expect(classifyPostToolEvidence("go test -c ./...", repoDir, 0, "")).toEqual([]);
    expect(classifyPostToolEvidence("go test -list . ./...", repoDir, 0, "")).toEqual([]);
    expect(classifyPostToolEvidence("go build -n ./...", repoDir, 0, "")).toEqual([]);
    expect(classifyPostToolEvidence("pytest --collect-only", repoDir, 0, "")).toEqual([]);
    expect(classifyPostToolEvidence("npx tsc --showConfig", repoDir, 0, "{}")).toEqual([]);
    expect(classifyPostToolEvidence("npx tsc --build --dry", repoDir, 0, "A non-dry build")).toEqual([]);
    expect(classifyPostToolEvidence("npx tsc -b -d", repoDir, 0, "A non-dry build")).toEqual([]);
    expect(classifyPostToolEvidence("npx tsc --build --clean", repoDir, 0, "")).toEqual([]);
    expect(classifyPostToolEvidence("npx tsc --noCheck", repoDir, 0, "")).toEqual([]);
    expect(classifyPostToolEvidence("npx tsc --noCheck true --noCheck false --noEmit", repoDir, 2, "error TS2322")[0]?.status).toBe("fail");
    expect(classifyPostToolEvidence("npx tsc --noEmit --noCheck false", repoDir, 2, "error TS2322")[0]?.status).toBe("fail");
    expect(classifyPostToolEvidence("npx tsc --build --dry false --noEmit", repoDir, 0, "")[0]?.status).toBe("pass");
    expect(classifyPostToolEvidence("npx tsc --noEmit --help false", repoDir, 0, "")[0]?.status).toBe("pass");
    expect(classifyPostToolEvidence("npx tsc --help FALSE", repoDir, 0, "Version 5.9.3")).toEqual([]);
    expect(classifyPostToolEvidence("npx tsc -help", repoDir, 0, "Version 5.9.3")).toEqual([]);
    expect(classifyPostToolEvidence("npx tsc --v", repoDir, 0, "Version 5.9.3")).toEqual([]);
    expect(classifyPostToolEvidence("npx tsc --b -dry", repoDir, 0, "A non-dry build")).toEqual([]);
    expect(classifyPostToolEvidence("npx tsc -b -d FALSE", repoDir, 0, "A non-dry build")).toEqual([]);
    expect(classifyPostToolEvidence("npx tsc --version --outDir --version false", repoDir, 0, "Version 5.9.3")).toEqual([]);
    expect(classifyPostToolEvidence("npx tsc --types --version", repoDir, 0, "Version 5.9.3")).toEqual([]);
    expect(classifyPostToolEvidence("npx tsc --build --excludeFiles --dry", repoDir, 0, "A non-dry build")).toEqual([]);
    expect(classifyPostToolEvidence("npx tsc --types node --noEmit", repoDir, 0, "")[0]?.status).toBe("pass");
    expect(classifyPostToolEvidence("npx tsc @/dev/stdin", repoDir, 0, "Version 5.9.3")).toEqual([]);
    expect(classifyPostToolEvidence("npx tsc --noEmit --help null", repoDir, 0, "")[0]?.status).toBe("pass");
    expect(classifyPostToolEvidence("npx tsc --build -v", repoDir, 0, "")[0]?.kind).toBe("lint");
    expect(classifyPostToolEvidence("npx tsc -d --noEmit", repoDir, 0, "")[0]?.kind).toBe("lint");
    expect(classifyPostToolEvidence("npx eslint --print-config a.ts", repoDir, 0, "{}")).toEqual([]);
    expect(classifyPostToolEvidence("npm run lint --if-present", repoDir, 0, "")).toEqual([]);
    expect(classifyPostToolEvidence("npm_config_if_present=true npm run lint", repoDir, 0, "")).toEqual([]);
    expect(classifyPostToolEvidence("npm run lint --if-present --no-if-present", repoDir, 1, "missing")[0]?.status).toBe("fail");
    // Inherited process.env dry-run / if-present flags MUST also be respected (and overridable by explicit flags/env)!
    const prevNpmIf = process.env.npm_config_if_present;
    const prevMakeFlags = process.env.MAKEFLAGS;
    const prevJustDry = process.env.JUST_DRY_RUN;
    try {
      process.env.npm_config_if_present = "true";
      expect(classifyPostToolEvidence("npm run lint", repoDir, 0, "")).toEqual([]);
      expect(classifyPostToolEvidence("npm run lint --no-if-present", repoDir, 0, "")[0]?.status).toBe("pass");
      process.env.MAKEFLAGS = "-n";
      expect(classifyPostToolEvidence("make test", repoDir, 0, "false")).toEqual([]);
      expect(classifyPostToolEvidence("make test MAKEFLAGS=", repoDir, 0, "echo RECIPE")).toEqual([]);
      expect(classifyPostToolEvidence("MAKEFLAGS= make test", repoDir, 0, "ok")[0]?.status).toBe("pass");
      process.env.JUST_DRY_RUN = "1";
      expect(classifyPostToolEvidence("just test", repoDir, 0, "")).toEqual([]);
      expect(classifyPostToolEvidence("JUST_DRY_RUN=0 just test", repoDir, 0, "ok")[0]?.status).toBe("pass");
    } finally {
      if (prevNpmIf === undefined) delete process.env.npm_config_if_present;
      else process.env.npm_config_if_present = prevNpmIf;
      if (prevMakeFlags === undefined) delete process.env.MAKEFLAGS;
      else process.env.MAKEFLAGS = prevMakeFlags;
      if (prevJustDry === undefined) delete process.env.JUST_DRY_RUN;
      else process.env.JUST_DRY_RUN = prevJustDry;
    }
    expect(classifyPostToolEvidence("bun run check --if-present", repoDir, 0, "")).toEqual([]);
    expect(classifyPostToolEvidence("bun test nonexistent --pass-with-no-tests", repoDir, 0, "")).toEqual([]);
    expect(classifyPostToolEvidence("golangci-lint version", repoDir, 0, "v1")).toEqual([]);
    expect(classifyPostToolEvidence("golangci-lint run ./...", repoDir, 0, "")[0]?.kind).toBe("lint");

    // Trailing U+00A0 NBSP in a valid Git branch name MUST NOT be truncated by locateRepo()!
    const nbspBranch = "feat/a\u00a0";
    runGit(repoDir, ["checkout", "-b", nbspBranch]);
    try {
      const nbspLoc = locateRepo(wb, repoDir);
      expect(nbspLoc?.branch).toBe(nbspBranch);
    } finally {
      runGit(repoDir, ["checkout", "feat/work"]);
      runGit(repoDir, ["branch", "-D", nbspBranch]);
    }
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-gh-empty-label",
        tool_input: { command: "gh pr create -t demo -b b --label ''", workdir: repoDir },
        tool_response: { exit_code: 0, output: "https://github.com/acme/svc/pull/44" },
      }).recorded,
    ).toBe(1);
    // Error text mentioning a PR URL inline (NOT a standalone URL line) with `--attach` MUST record `pr/fail`, NOT `pr/pass`!
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-gh-attach-inline-url-err",
        tool_input: {
          command: "gh pr create --attach a.png -F https://github.com/acme/svc/pull/42 -t demo",
          workdir: repoDir,
        },
        tool_response: {
          exit_code: 1,
          output: "open https://github.com/acme/svc/pull/42: no such file or directory",
        },
      }).recorded,
    ).toBe(1);
    const errUrlCheck = new Ledger(wb);
    const errUrlEv = errUrlCheck
      .getTaskEvents("20261121-work")
      .find((e) => e.tool_use_id?.startsWith("tu-gh-attach-inline-url-err"));
    expect(JSON.parse(errUrlEv?.payload_json ?? "null")).toMatchObject({ kind: "pr", status: "fail", source: "hook" });
    errUrlCheck.closeDb();
    // Partial attachment upload failure with `--attach` still creates PR and prints PR URL (exit 1) -> recorded as pr/pass!
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-gh-attach-partial-fail",
        tool_input: { command: "gh pr create --attach a.png --attach b.png -t demo -b b", workdir: repoDir },
        tool_response: { exit_code: 1, output: "https://github.com/acme/svc/pull/42\nfailed to upload b.png" },
      }).recorded,
    ).toBe(1);
    const attachCheck = new Ledger(wb);
    const attachEv = attachCheck
      .getTaskEvents("20261121-work")
      .find((e) => e.tool_use_id?.startsWith("tu-gh-attach-partial-fail"));
    expect(JSON.parse(attachEv?.payload_json ?? "null")).toMatchObject({ kind: "pr", status: "pass", source: "hook", meta: { pr_url: "https://github.com/acme/svc/pull/42", pr_head_oid: head } });
    attachCheck.closeDb();
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-gh-same-repo-fail",
        tool_input: { command: "gh pr create -R acme/svc --title t --body b", workdir: repoDir },
        tool_response: { exit_code: 1, output: "failed" },
      }).recorded,
    ).toBe(1);
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-codex-empty-commit",
        tool_input: { command: "codex review --commit=", workdir: repoDir },
        tool_response: { exit_code: 1, output: "invalid commit" },
      }).recorded,
    ).toBe(0);

    // 3b. `codex review --commit=<old>` must pin the reviewed commit. Symbolic refs cannot establish launch-time identity.
    writeFileSync(join(repoDir, "a.txt"), "v2\n");
    runGit(repoDir, ["add", "a.txt"]);
    runGit(repoDir, ["commit", "-m", "feat: v2"]);
    const newHead = runGit(repoDir, ["rev-parse", "HEAD"]).stdout.trim();
    const prevCommit = runGit(repoDir, ["rev-parse", "HEAD~1"]).stdout.trim();
    expect(prevCommit).toBe(head);

    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-codex-eq",
        tool_input: { command: `codex review --commit=${prevCommit}`, workdir: repoDir },
        tool_response: { exit_code: 0, output: nativePass },
      }).recorded,
    ).toBe(1);
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-codex-tilde",
        tool_input: { command: "codex review --commit HEAD", workdir: repoDir },
        tool_response: { exit_code: 0, output: "LGTM" },
      }).recorded,
    ).toBe(0);
    const revCheckLedger = new Ledger(wb);
    const codexEvents = revCheckLedger
      .getTaskEvents("20261121-work")
      .filter((e) => e.tool_use_id?.startsWith("tu-codex-"));
    expect(codexEvents.length).toBe(1);
    expect(codexEvents.every((e) => e.sha === prevCommit)).toBe(true);
    expect(codexEvents.some((e) => e.sha === newHead)).toBe(false);
    revCheckLedger.closeDb();
    // Reset repoDir back to `head` for subsequent steps
    runGit(repoDir, ["reset", "--hard", head]);

    // 4. Cross-branch `gh pr create --head feat/other` MUST record PR evidence on feat/other, NOT feat/work!
    runGit(repoDir, ["branch", "feat/other", head]);
    const ledgerSetup = new Ledger(wb);
    ledgerSetup.openTask({
      task_id: "20261121-other",
      title: "Other branch PR",
      endpoint: "pr",
      depth: "targeted",
      repo: "svc",
      branch: "feat/other",
      base_sha: head,
      head_sha: head,
    });
    ledgerSetup.closeDb();

    // Bundled `-dHfeat/other` MUST resolve targetBranch=`feat/other` (NOT fall back to current branch feat/work)!
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-pr-other",
        tool_input: { command: "gh pr create -dHfeat/other --title other --body body", workdir: repoDir },
        tool_response: { exit_code: 0, output: "https://github.com/acme/svc/pull/99" },
      }).recorded,
    ).toBe(1);

    const ledgerCheck = new Ledger(wb);
    expect(
      ledgerCheck
        .getTaskEvents("20261121-work")
        .some((e) => e.tool_use_id?.startsWith("tu-pr-other")),
    ).toBe(false);
    expect(
      ledgerCheck
        .getTaskEvents("20261121-other")
        .some((e) => e.tool_use_id?.startsWith("tu-pr-other") && JSON.parse(e.payload_json).kind === "pr" && JSON.parse(e.payload_json).status === "pass"),
    ).toBe(true);
    ledgerCheck.closeDb();

    // 5. All 4 review roles hit credit_balance_exhausted via PostToolUse -> fallback recorded by the executor -> task becomes READY and CLOSABLE!
    const roles = ["quality", "performance", "simplify", "comments"] as const;
    for (const role of roles) {
      const failRec = handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: wb,
        tool_name: "exec_command",
        tool_use_id: `tu-fail-${role}`,
        tool_input: {
          command: `review-agents/bin/review-${role} --repo ${repoDir} --base ${head} --head ${head}`,
        },
        tool_response: {
          exit_code: 2,
          output: JSON.stringify({
            status: "error",
            errorCode: "credit_balance_exhausted",
            head,
            base: head,
          }),
        },
      });
      expect(failRec.recorded).toBe(1);
    }

    // Record passing static check (lint) + test + PR on feat/work
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-pass-lint",
        tool_input: { command: "bunx --bun tsc --noEmit", workdir: repoDir },
        tool_response: { exit_code: 0, output: "" },
      }).recorded,
    ).toBe(1);
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-pass-test",
        tool_input: { command: "bun test", workdir: repoDir },
        tool_response: { exit_code: 0, output: "ok" },
      }).recorded,
    ).toBe(1);
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-pass-pr",
        tool_input: { command: "gh pr create --title work --body body", workdir: repoDir },
        tool_response: { exit_code: 0, output: "https://github.com/acme/svc/pull/100" },
      }).recorded,
    ).toBe(1);

    // Before fallback -> checkPushReadiness fails because all 4 roles failed!
    const pre = new Ledger(wb);
    const preCheck = pre.checkPushReadiness({
      task_id: "20261121-work",
      repo: "svc",
      head_sha: head,
      checkEndpoint: true,
    });
    expect(preCheck.ready).toBe(false);
    expect(preCheck.missing.join(" ")).toContain("quality");
    const oldCheckout = join(wb, "old-checkout");
    const movedCheckout = join(wb, "moved-checkout");
    expect(runGit(repoDir, ["checkout", "--detach", head]).code).toBe(0);
    expect(runGit(repoDir, ["worktree", "add", oldCheckout, "feat/work"]).code).toBe(0);
    pre.attachRepo({ task_id: "20261121-work", repo: "svc", branch: "feat/work", worktree: oldCheckout });
    expect(runGit(repoDir, ["worktree", "move", oldCheckout, movedCheckout]).code).toBe(0);
    pre.closeDb();

    // Exercise the shipped executor with a local stand-in for the external Codex process.
    const bin = join(wb, "native-bin");
    const prompts = join(wb, "review-agents", "prompts");
    mkdirSync(bin);
    mkdirSync(prompts, { recursive: true });
    const codex = join(bin, "codex");
    writeFileSync(codex, `#!/bin/sh
case " $* " in *" -s read-only "*) ;; *) exit 2 ;; esac
while [ "$1" != "-o" ] && [ "$#" -gt 0 ]; do shift; done
[ "$#" -ge 2 ] || exit 2
echo '{"passed":true,"report":"Read-only fixture review completed"}' > "$2"
`);
    chmodSync(codex, 0o755);
    for (const role of roles) {
      writeFileSync(join(prompts, role + ".md"), "Review only.");
      const proc = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/bin/ledger.ts"),
        "review-fallback", "20261121-work", "--repo", "svc", "--role", role, "--sha", head],
        { env: { ...process.env, PATH: bin + ":" + process.env.PATH, FORGE_WORKBENCH_ROOT: wb } });
      expect(proc.exitCode, proc.stderr.toString()).toBe(0);
      expect(JSON.parse(proc.stdout.toString())).toMatchObject({ kind: "review", source: "tool", status: "fallback", meta: { role, head } });
    }

    // Now task is READY and closes cleanly, while original fail events remain preserved in hash chain!
    const post = new Ledger(wb);
    try {
      const closed = post.closeTask({ task_id: "20261121-work", archive: false });
      expect(closed.task.status).toBe("CLOSED");
      expect(post.verify().ok).toBe(true);
    } finally {
      post.closeDb();
    }
  }, 20000);

  test("injects compact active ledger summary on SessionStart and PostCompact", () => {
    const start = handleLedgerHook(wb, {
      hook_event_name: "SessionStart",
      cwd: wb,
      source: "startup",
    });
    expect(start.sessionContext).toContain("20261121-work");
    expect(start.sessionContext).toContain("svc:feat/work");

    const compact = handleLedgerHook(wb, {
      hook_event_name: "PostCompact",
      cwd: wb,
      trigger: "auto",
    });
    expect(compact.compactMessage).toContain("20261121-work");
  });

  test("captures multi-line cd/set -euo pipefail verification scripts and expanded JS/TS runners while rejecting failure masking", () => {
    // 1. Multi-line pure `cd` + `npm test` (both pass and fail)
    const r1 = handleLedgerHook(wb, {
      hook_event_name: "PostToolUse",
      cwd: wb,
      tool_name: "Bash",
      tool_use_id: "tu-ml-npm-test-pass",
      tool_input: { command: "cd svc\nnpm test" },
      tool_response: { exit_code: 0, stdout: "ok" },
    });
    expect(r1.recorded).toBe(1);

    const r1Fail = handleLedgerHook(wb, {
      hook_event_name: "PostToolUse",
      cwd: wb,
      tool_name: "Bash",
      tool_use_id: "tu-ml-npm-test-fail",
      tool_input: { command: "cd svc\nnpm test" },
      tool_response: { exit_code: 1, stdout: "failed" },
    });
    expect(r1Fail.recorded).toBe(1);

    // 2. Multi-line `set -euo pipefail` + `cd` + `npm run typecheck > /tmp/tc.log 2>&1`
    const r2 = handleLedgerHook(wb, {
      hook_event_name: "PostToolUse",
      cwd: wb,
      tool_name: "Bash",
      tool_use_id: "tu-ml-set-e-typecheck",
      tool_input: {
        command: "set -euo pipefail\ncd svc\nnpm run typecheck > /tmp/tc.log 2>&1",
      },
      tool_response: { exit_code: 0, stdout: "" },
    });
    expect(r2.recorded).toBe(1);

    // 3. Expanded runners: vitest run, svelte-check, pnpm test, pnpm -C, yarn lint, yarn run lint, node --test, bun run typecheck, keyword-in-filename under set -e
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(join(repoDir, "src", "foo.test.mjs"), "console.log('ok');\n");
    const runners = [
      { id: "tu-vitest", cmd: "npx vitest run", expectedKind: "test", cwd: repoDir },
      { id: "tu-svelte", cmd: "npx svelte-check --tsconfig ./tsconfig.json", expectedKind: "lint", cwd: repoDir },
      { id: "tu-pnpm-test", cmd: "pnpm test", expectedKind: "test", cwd: repoDir },
      { id: "tu-pnpm-ws-root", cmd: "pnpm --workspace-root test", expectedKind: "test", cwd: repoDir },
      { id: "tu-pnpm-c-test", cmd: "pnpm -C svc test", expectedKind: "test", cwd: wb },
      { id: "tu-yarn-lint", cmd: "yarn lint", expectedKind: "lint", cwd: repoDir },
      { id: "tu-yarn-run-lint", cmd: "yarn run lint", expectedKind: "lint", cwd: repoDir },
      { id: "tu-node-test", cmd: "node --test src/foo.test.mjs", expectedKind: "test", cwd: repoDir },
      { id: "tu-bun-tc", cmd: "bun run typecheck", expectedKind: "lint", cwd: repoDir },
      { id: "tu-edge-case", cmd: "set -e\nnpm test tests/edge-case.test.ts", expectedKind: "test", cwd: repoDir },
    ] as const;
    for (const item of runners) {
      const r = handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: item.cwd,
        tool_name: "Bash",
        tool_use_id: item.id,
        tool_input: { command: item.cmd },
        tool_response: { exit_code: 0, stdout: "ok" },
      });
      expect(r.recorded).toBe(1);
    }

    // 4. Adversarial rejections: MUST record 0!
    const badCmds = [
      // Unguarded multi-line where echo masks failing test
      "cd svc\nbun test\necho ok",
      // Disabling errexit mid-script
      "set -e\nset +e\ncd svc\nbun test\necho ok",
      // Errexit-exempt AND-list under `set -e` (single-line AND continued across newline!)
      "set -e\ncd svc\nfalse && npm test\ntrue",
      "set -e\ncd svc\nfalse &&\nnpm test\ntrue",
      // Heredoc data lines masquerading as verification command
      "set -e\ncd svc\ncat <<EOF\nnpm test\nEOF",
      // Errexit-exempt `if !` masking failure under `set -e`
      "set -euo pipefail\ncd svc\nif ! bun test; then echo ok; fi",
      // `trap` under `set -e`
      "set -e\ntrap 'exit 0' ERR\ncd svc\nbun test",
      // Node application arguments & non-test/info modes (`--test` after script, `-v`, `--v8-options`)
      "cd svc\nnode app.js --test",
      "cd svc\nnode -v --test",
      "cd svc\nnode --v8-options --test",
      "cd svc\nnode -e 'process.exit(0)' --test",
      // Watch-mode / discovery / report-merge / zero-test Vitest
      "cd svc\nnpx vitest --watch",
      "cd svc\nnpx vitest",
      "cd svc\nCI=1 vitest list",
      "cd svc\nCI=1 vitest --merge-reports",
      "cd svc\nnpx vitest run --passWithNoTests unmatched",
      // Dry-run & ambiguous filter pnpm
      "cd svc\npnpm test --dry-run",
      "cd svc\npnpm --filter forge-kit-no-such-project test",
    ];
    for (let idx = 0; idx < badCmds.length; idx++) {
      const bad = handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: wb,
        tool_name: "Bash",
        tool_use_id: `tu-bad-ml-${idx}`,
        tool_input: { command: badCmds[idx] },
        tool_response: { exit_code: 0, stdout: "ok" },
      });
      expect(bad.recorded).toBe(0);
    }

    // Verify ledger recorded expected kinds & statuses cleanly
    const ledger = new Ledger(wb);
    try {
      const events = ledger.getTaskEvents("20261121-work");
      const payloadByToolUse = (id: string) => {
        const ev = events.find((e) => e.tool_use_id === id);
        return ev ? (JSON.parse(ev.payload_json) as { kind?: string; status?: string }) : null;
      };

      const testPass = payloadByToolUse("tu-ml-npm-test-pass:0");
      expect(testPass?.kind).toBe("test");
      expect(testPass?.status).toBe("pass");

      const testFail = payloadByToolUse("tu-ml-npm-test-fail:0");
      expect(testFail?.kind).toBe("test");
      expect(testFail?.status).toBe("fail");

      const tcPass = payloadByToolUse("tu-ml-set-e-typecheck:0");
      expect(tcPass?.kind).toBe("lint");
      expect(tcPass?.status).toBe("pass");

      expect(payloadByToolUse("tu-vitest:0")?.kind).toBe("test");
      expect(payloadByToolUse("tu-svelte:0")?.kind).toBe("lint");
      expect(payloadByToolUse("tu-pnpm-test:0")?.kind).toBe("test");
      expect(payloadByToolUse("tu-pnpm-c-test:0")?.kind).toBe("test");
      expect(payloadByToolUse("tu-yarn-lint:0")?.kind).toBe("lint");
      expect(payloadByToolUse("tu-yarn-run-lint:0")?.kind).toBe("lint");
      expect(payloadByToolUse("tu-node-test:0")?.kind).toBe("test");
      expect(payloadByToolUse("tu-bun-tc:0")?.kind).toBe("lint");
      expect(payloadByToolUse("tu-edge-case:0")?.kind).toBe("test");
    } finally {
      ledger.closeDb();
    }

    // 5. Cross-repository attribution: commands executed from repo A (`svc`) targeting repo B (`svc-b`)
    // MUST credit ONLY `svc-b` (with svc-b's distinct SHA) and NEVER `svc`!
    const repoBDir = join(wb, "svc-b");
    mkdirSync(repoBDir, { recursive: true });
    runGit(repoBDir, ["init", "-b", "main"]);
    runGit(repoBDir, ["config", "user.email", "t@t.local"]);
    runGit(repoBDir, ["config", "user.name", "T"]);
    writeFileSync(join(repoBDir, "x.test.js"), "console.log('ok');\n");
    writeFileSync(join(repoBDir, "tsconfig.json"), "{}\n");
    runGit(repoBDir, ["add", "."]);
    runGit(repoBDir, ["commit", "-m", "init repo B"]);
    runGit(repoBDir, ["checkout", "-b", "feat/work"]);
    const repoBSha = runGit(repoBDir, ["rev-parse", "HEAD"]).stdout.trim();
    writeFileSync(
      join(wb, ".workbench", "workbench.yaml"),
      `name: "demo"\nrepos:\n  - svc\n  - svc-b\nledger:\n  enabled: true\n`,
    );
    const ledgerB = new Ledger(wb);
    ledgerB.attachRepo({
      task_id: "20261121-work",
      repo: "svc-b",
      branch: "feat/work",
      head_sha: repoBSha,
    });
    ledgerB.closeDb();

    const commitCommand = "env -C ../svc-b git commit -m demo";
    expect(classifyPostToolEvidence(commitCommand, repoDir, 0, "")).toMatchObject([
      { kind: "commit", status: "pass", targetDir: realpathSync(repoBDir) },
    ]);
    const crossRepoCmds = [
      { id: "tu-x-commit", cmd: commitCommand, kind: "commit" },
      { id: "tu-x-node", cmd: "node --test ../svc-b/x.test.js", kind: "test" },
      { id: "tu-x-pnpm-vitest", cmd: "pnpm vitest run --root ../svc-b", kind: "test" },
      { id: "tu-x-vitest-dir", cmd: "npx vitest run --dir ../svc-b", kind: "test" },
      { id: "tu-x-pnpm-svelte", cmd: "pnpm svelte-check --workspace ../svc-b", kind: "lint" },
      { id: "tu-x-npx-svelte", cmd: "npx svelte-check --tsconfig ../svc-b/tsconfig.json", kind: "lint" },
      { id: "tu-x-pnpm-c", cmd: "pnpm -C ../svc-b test", kind: "test" },
    ] as const;
    for (const c of crossRepoCmds) {
      const r = handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir, // Running from repo A (`svc`)!
        tool_name: "Bash",
        tool_use_id: c.id,
        tool_input: { command: c.cmd, workdir: repoDir },
        tool_response: { exit_code: 0, stdout: "ok" },
      });
      expect(r.recorded).toBe(1);
    }

    const verifyB = new Ledger(wb);
    try {
      const events = verifyB.getTaskEvents("20261121-work");
      for (const c of crossRepoCmds) {
        const ev = events.find((e) => e.tool_use_id === `${c.id}:0`);
        expect(ev?.repo).toBe("svc-b");
        expect(ev?.sha).toBe(repoBSha);
        expect((JSON.parse(ev!.payload_json) as { kind: string }).kind).toBe(c.kind);
      }
    } finally {
      verifyB.closeDb();
    }
  });
});
