import { isolateHome } from "./helpers/hermetic";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "../src/git";
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
  test("only commit and verified PR commands are observed", () => {
    for (const command of ["bun test", "make build", "tsc", "hurl suite.hurl", "review-quality", "codex review", "echo git commit", "git commit --dry-run", "git commit --short"]) {
      expect(classifyPostToolEvidence(command, repoDir, 0, "")).toEqual([]);
    }
    for (const header of ["set -e", "set -eu", "set -euo pipefail", "set -o errexit"]) {
      expect(classifyPostToolEvidence(header + "\ngit commit -m docs", repoDir, 0, "")[0]?.kind).toBe("commit");
    }
    expect(classifyPostToolEvidence("set -e\ngit commit -m docs\ngit rev-parse HEAD", repoDir, 0, "")[0]?.kind).toBe("commit");
    expect(classifyPostToolEvidence("set -e\ngit commit -m docs && echo committed\ngit status", repoDir, 0, "")).toEqual([]);
    expect(classifyPostToolEvidence("set -e\ngit add missing && git commit -m docs\ntrue", repoDir, 0, "")).toEqual([]);
    for (const suffix of ["git status", "git rev-parse HEAD", "git log -1", "echo done", "true"]) {
      expect(classifyPostToolEvidence("git commit -m docs && " + suffix, repoDir, 0, "")[0]?.kind).toBe("commit");
    }
    const command = "set -e\ngit add note.md && git commit -m update && git rev-parse HEAD && git status --short";
    expect(classifyPostToolEvidence(command, repoDir, 1, "")).toEqual([]);
    const ledger = new Ledger(wb);
    ledger.addExemption({ repo: "svc", branch: "feat/work", reason: "documentation" });
    writeFileSync(join(repoDir, "note.md"), "updated\n");
    expect(runGit(repoDir, ["add", "note.md"]).code).toBe(0);
    expect(runGit(repoDir, ["commit", "-m", "update"]).code).toBe(0);
    const head = runGit(repoDir, ["rev-parse", "HEAD"]).stdout.trim();
    expect(handleLedgerHook(wb, {hook_event_name:"PostToolUse", cwd:repoDir, tool_name:"Bash", tool_use_id:"commit-id",
      tool_input:{command}, tool_response:{exit_code:0,output:""}}).recorded).toBe(1);
    expect(ledger.findActiveExemption("svc", "feat/work")?.head_sha).toBe(head);
    const event = ledger.getTaskEvents("20261121-work").at(-1)!;
    expect(event.sha).toBe(head);
    expect(JSON.parse(event.payload_json)).toMatchObject({kind:"commit",source:"hook"});
    ledger.closeDb();
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
    expect(record("gh pr new -t demo -b b", 443)).toBe(1);
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

});
