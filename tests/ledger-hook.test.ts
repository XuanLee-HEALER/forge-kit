import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { locateRepo, runGit } from "../src/git";
import { Ledger } from "../src/ledger";
import { handleLedgerHook } from "../src/ledger-hook";

let wb: string;
let repoDir: string;

beforeEach(() => {
  wb = mkdtempSync(join(tmpdir(), "forge-lhook-test-"));
  mkdirSync(join(wb, ".workbench", "ledger"), { recursive: true });
  writeFileSync(
    join(wb, ".workbench", "workbench.yaml"),
    `name: "hook-wb"\nrepos:\n  - svc\n`,
  );
  repoDir = join(wb, "svc");
  mkdirSync(repoDir, { recursive: true });
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
  rmSync(wb, { recursive: true, force: true });
});

describe("Ledger Passive Hooks (PostToolUse / SessionStart / PostCompact)", () => {
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
    const { classifyPostToolEvidence } = require("../src/ledger-hook") as typeof import("../src/ledger-hook");
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
    expect(classifyPostToolEvidence("codex -c model=o3 review --uncommitted", repoDir, 0, "LGTM")[0]?.status).toBe("pass");
    expect(classifyPostToolEvidence("codex review -cmodel=o3 --uncommitted", repoDir, 0, "LGTM")[0]?.status).toBe("pass");
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
    expect(classifyPostToolEvidence("codex -s read-only -a never review --uncommitted", repoDir, 0, "LGTM")[0]?.status).toBe("pass");
    expect(classifyPostToolEvidence("codex -i a.png -m o3 review --uncommitted", repoDir, 0, "LGTM")[0]?.status).toBe("pass");
    expect(classifyPostToolEvidence("codex review --uncommitted", repoDir, 0, "LGTM")[0]?.kind).toBe("review");
    const codexCdEv = classifyPostToolEvidence("codex -C ../other-repo review --commit HEAD", repoDir, 0, "LGTM");
    expect(codexCdEv[0]?.kind).toBe("review");
    expect(codexCdEv[0]?.targetDir).toBe(otherRepoDir);
    expect(codexCdEv[0]?.pinnedRef).toBe("HEAD");
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
    expect(
      classifyPostToolEvidence("bun run check --cwd ../other-repo", repoDir, 0, "")[0]?.targetDir,
    ).toBe(otherRepoDir);
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
    expect(errUrlEv?.payload_json).toContain('"kind":"pr","status":"fail"');
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
    expect(attachEv?.payload_json).toContain('"kind":"pr","status":"pass"');
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

    // 3b. `codex review --commit=<old>` and `--commit HEAD~1` MUST pin to the older commit, NEVER live HEAD!
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
        tool_response: { exit_code: 0, output: "LGTM" },
      }).recorded,
    ).toBe(1);
    expect(
      handleLedgerHook(wb, {
        hook_event_name: "PostToolUse",
        cwd: repoDir,
        tool_name: "exec_command",
        tool_use_id: "tu-codex-tilde",
        tool_input: { command: "codex review --commit HEAD~1", workdir: repoDir },
        tool_response: { exit_code: 0, output: "LGTM" },
      }).recorded,
    ).toBe(1);
    const revCheckLedger = new Ledger(wb);
    const codexEvents = revCheckLedger
      .getTaskEvents("20261121-work")
      .filter((e) => e.tool_use_id?.startsWith("tu-codex-"));
    expect(codexEvents.length).toBe(2);
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
        .some((e) => e.tool_use_id?.startsWith("tu-pr-other") && e.payload_json.includes('"kind":"pr","status":"pass"')),
    ).toBe(true);
    ledgerCheck.closeDb();

    // 5. All 4 review roles hit credit_balance_exhausted via PostToolUse -> fallback recorded via documented CLI `--role <role>` -> task becomes READY and CLOSABLE!
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
    pre.closeDb();

    // Run documented wrapup CLI fallback command for all 4 roles!
    const ledgerSrc = join(import.meta.dir, "..", "src", "bin", "ledger.ts");
    for (const role of roles) {
      const proc = Bun.spawn(
        [
          process.execPath,
          ledgerSrc,
          "record",
          "20261121-work",
          "--kind",
          "review",
          "--status",
          "fallback",
          "--role",
          role,
          "--repo",
          "svc",
          "--sha",
          head,
          "--summary",
          `${role} native_fallback (credit_balance_exhausted)`,
        ],
        {
          env: { ...process.env, FORGE_WORKBENCH_ROOT: wb },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(await proc.exited).toBe(0);
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
