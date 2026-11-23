import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "../src/git";
import { evaluatePreToolUse } from "../src/guard";
import { Ledger } from "../src/ledger";

let wb: string;
let repoDir: string;

function shellInput(command: string, workdir?: string) {
  return {
    hook_event_name: "PreToolUse",
    cwd: wb,
    tool_name: "exec_command",
    tool_input: { command, ...(workdir ? { workdir } : {}) },
  };
}

beforeEach(() => {
  wb = mkdtempSync(join(tmpdir(), "forge-guard-test-"));
  mkdirSync(join(wb, ".workbench", "ledger"), { recursive: true });
  mkdirSync(join(wb, ".workbench", "env"), { recursive: true });
  writeFileSync(
    join(wb, ".workbench", "workbench.yaml"),
    `name: "test-wb"
repos:
  - app-api
guard:
  prod_db_hosts:
    - "pg-prod.internal"
    - "mysql-prod.internal"
    - "ck-prod.internal"
  protected_branches:
    - "main"
  prod_tag_patterns:
    - "^api-v"
    - "^release-v"
`,
  );

  repoDir = join(wb, "app-api");
  mkdirSync(repoDir, { recursive: true });
  runGit(repoDir, ["init", "-b", "main"]);
  runGit(repoDir, ["config", "user.email", "dev@example.com"]);
  runGit(repoDir, ["config", "user.name", "Dev"]);
  writeFileSync(join(repoDir, "README.md"), "# app\n");
  runGit(repoDir, ["add", "README.md"]);
  runGit(repoDir, ["commit", "-m", "chore: init"]);
  runGit(repoDir, ["checkout", "-b", "feat/demo"]);
});

afterEach(() => {
  rmSync(wb, { recursive: true, force: true });
});

describe("Tier 1 Physical Fuses & Fail-Closed", () => {
  test("guard binary fails closed on malformed JSON stdin", async () => {
    const guardSrc = join(import.meta.dir, "..", "src", "bin", "guard.ts");
    const proc = Bun.spawn([process.execPath, guardSrc], {
      stdin: new Response("{broken json"),
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    const out = await new Response(proc.stdout).text();
    expect(code).toBe(0);
    expect(out).toContain('"permissionDecision":"deny"');
    expect(out).toContain("fail-closed");
  });

  test("apply_patch is NEVER treated as shell; blocks ledger Move to: while allowing doc edits mentioning git push --tags", () => {
    // Editing a runbook doc that mentions `git push --tags` via Codex apply_patch (which uses tool_input.command)
    expect(
      evaluatePreToolUse(wb, {
        hook_event_name: "PreToolUse",
        cwd: wb,
        tool_name: "apply_patch",
        tool_input: {
          command: `*** Begin Patch\n*** Update File: app-api/README.md\n@@\n-old\n+Never run git push --tags without approval\n*** End Patch`,
        },
      }),
    ).toBeNull();

    // Moving a file into .workbench/ledger/ via `*** Move to:` MUST be blocked!
    expect(
      evaluatePreToolUse(wb, {
        hook_event_name: "PreToolUse",
        cwd: wb,
        tool_name: "apply_patch",
        tool_input: {
          command: `*** Begin Patch\n*** Update File: foo.txt\n*** Move to: .workbench/ledger/ledger.sqlite\n*** End Patch`,
        },
      }),
    ).toContain("禁止直接修改");

    // Regression: a known shell tool containing `*** Begin Patch` in args MUST STILL hit shell guards!
    expect(
      evaluatePreToolUse(
        wb,
        shellInput(`echo '*** Begin Patch' && git -C app-api push --tags`),
      ),
    ).toContain("tag");
  });

  test("corrupted environments.json fails closed instead of silently skipping prod DB guard", () => {
    writeFileSync(join(wb, ".workbench", "env", "environments.json"), "{broken json");
    expect(() =>
      evaluatePreToolUse(wb, shellInput('usql "postgres://u@pg-prod.internal/db" -c "SELECT 1"')),
    ).toThrow("Failed to parse DB environments");
  });

  test("blocks sqlite3 write to ledger while allowing read-only sqlite3 SELECT", () => {
    expect(
      evaluatePreToolUse(
        wb,
        shellInput("sqlite3 .workbench/ledger/ledger.sqlite 'SELECT count(*) FROM tasks;'"),
      ),
    ).toBeNull();
    expect(
      evaluatePreToolUse(
        wb,
        shellInput("sqlite3 .workbench/ledger/ledger.sqlite 'DELETE FROM events;'"),
      ),
    ).toContain("物理保险丝");
  });

  test("blocks mutating shared-worktree git ops while allowing read-only git stash list/show", () => {
    expect(evaluatePreToolUse(wb, shellInput("git -C app-api stash list"))).toBeNull();
    expect(evaluatePreToolUse(wb, shellInput("git -C app-api stash show -p"))).toBeNull();

    for (const cmd of [
      "git -C app-api stash",
      "git -C app-api stash push",
      "git -C app-api restore README.md",
      "git -C app-api reset --hard HEAD~1",
      "git -C app-api checkout -- README.md",
      "git -C app-api add -A",
      "git -C app-api add .",
      "git -C app-api commit --amend -m 'x'",
      "git -C app-api clean -fd",
    ]) {
      expect(evaluatePreToolUse(wb, shellInput(cmd))).toContain("共享工作树");
    }
  });

  test("blocks prod tag push, explicit & implicit main push, and gh pr merge", () => {
    expect(evaluatePreToolUse(wb, shellInput("git -C app-api push --tags"))).toContain("tag");
    expect(evaluatePreToolUse(wb, shellInput("git -C app-api push origin api-v1.2.3"))).toContain(
      "tag",
    );
    expect(evaluatePreToolUse(wb, shellInput("git -C app-api push origin main"))).toContain(
      "主分支",
    );
    expect(evaluatePreToolUse(wb, shellInput("gh pr merge 42 --squash"))).toContain("gh pr merge");

    // Implicit `git push` while checked out on main MUST be blocked!
    runGit(repoDir, ["checkout", "main"]);
    expect(evaluatePreToolUse(wb, shellInput("git -C app-api push"))).toContain("主分支");
  });

  test("blocks prod DB writes while allowing SELECT with < comparison operator", () => {
    // Regression test for `<` false positive inside SQL string!
    expect(
      evaluatePreToolUse(
        wb,
        shellInput('usql "postgres://u@pg-prod.internal:5432/db" -c "SELECT * FROM orders WHERE amount < 100"'),
      ),
    ).toBeNull();
    expect(
      evaluatePreToolUse(
        wb,
        shellInput('usql "postgres://u@pg-prod.internal:5432/db" < script.sql'),
      ),
    ).toContain("文件或标准输入");
    expect(
      evaluatePreToolUse(
        wb,
        shellInput('mysql -h mysql-prod.internal -e "DELETE FROM orders WHERE id=1"'),
      ),
    ).toContain("DELETE");
    expect(
      evaluatePreToolUse(
        wb,
        shellInput('curl -s -X POST "http://ck-prod.internal:8123/" -d "ALTER TABLE t DROP PARTITION p"'),
      ),
    ).toContain("prod 数据库");
  });

  test("blocks non-readonly kubectl and comma-separated secret access", () => {
    expect(evaluatePreToolUse(wb, shellInput("kubectl get pods -n prod"))).toBeNull();
    expect(evaluatePreToolUse(wb, shellInput("kubectl rollout restart deploy/api -n prod"))).toContain(
      "非只读",
    );
    expect(evaluatePreToolUse(wb, shellInput("kubectl get cm,secret -n prod"))).toContain("secret");
  });
});

describe("Tier 2 Passive Dev Ledger Gate & Detached FAT Support", () => {
  test("tightened exemption blocks code changes even if README exempt exists on branch, and push checks exact SHA", () => {
    const ledger = new Ledger(wb);
    ledger.addExemption({
      repo: "app-api",
      branch: "feat/demo",
      reason: "README typo",
    });
    ledger.closeDb();

    // README edit is allowed under exemption
    writeFileSync(join(repoDir, "README.md"), "# app updated\n");
    runGit(repoDir, ["add", "README.md"]);
    expect(
      evaluatePreToolUse(wb, shellInput('git -C app-api commit -m "docs: typo" -- README.md')),
    ).toBeNull();
    runGit(repoDir, ["commit", "-m", "docs: typo", "--", "README.md"]);
    const docSha = runGit(repoDir, ["rev-parse", "HEAD"]).stdout.trim();

    // Push blocked until exemption bound to exact docSha
    expect(
      evaluatePreToolUse(wb, shellInput("git -C app-api push origin feat/demo")),
    ).toContain("尚未绑定");

    // Bind exemption to docSha -> push allowed
    const ledger2 = new Ledger(wb);
    const ex = ledger2.findActiveExemption("app-api", "feat/demo")!;
    ledger2.bindExemptionHeadSha(ex.id, docSha);
    ledger2.closeDb();
    expect(
      evaluatePreToolUse(wb, shellInput("git -C app-api push origin feat/demo")),
    ).toBeNull();

    // Now switch to modifying protected business code (.ts) on the SAME branch -> BLOCKED despite existing exemption!
    writeFileSync(join(repoDir, "billing.ts"), "export const fee = 10;\n");
    runGit(repoDir, ["add", "billing.ts"]);
    expect(
      evaluatePreToolUse(wb, shellInput('git -C app-api commit -m "feat: fee" -- billing.ts')),
    ).toContain("不可沿用或静默豁免");

    // Even if someone manually binds exemption --sha to a business code commit, push MUST verify commit diff and reject!
    runGit(repoDir, ["commit", "-m", "feat: fee", "--", "billing.ts"]);
    const codeSha = runGit(repoDir, ["rev-parse", "HEAD"]).stdout.trim();
    const ledger3 = new Ledger(wb);
    ledger3.addExemption({
      repo: "app-api",
      branch: "feat/demo",
      head_sha: codeSha,
      reason: "attempt to smuggle business code",
    });
    ledger3.closeDb();
    expect(
      evaluatePreToolUse(wb, shellInput("git -C app-api push origin feat/demo")),
    ).toContain("实际提交改动不满足免账本豁免条件");

    // Even if a trailing README commit is added on top of the business code commit, branch diff still blocks exemption!
    writeFileSync(join(repoDir, "README.md"), "# demo\ntypo 2\n");
    runGit(repoDir, ["add", "README.md"]);
    runGit(repoDir, ["commit", "-m", "docs: trailing readme", "--", "README.md"]);
    const trailingSha = runGit(repoDir, ["rev-parse", "HEAD"]).stdout.trim();
    const ledger4 = new Ledger(wb);
    ledger4.addExemption({
      repo: "app-api",
      branch: "feat/demo",
      head_sha: trailingSha,
      reason: "attempt to hide business commit behind readme",
    });
    ledger4.closeDb();
    expect(
      evaluatePreToolUse(wb, shellInput("git -C app-api push -o ci.skip origin feat/demo")),
    ).toContain("实际提交改动不满足免账本豁免条件");

    // Push option `-o` before origin main must still hit Tier 1 protected branch fuse
    expect(
      evaluatePreToolUse(wb, shellInput("git -C app-api push -o ci.skip origin feat/demo:main")),
    ).toContain("受保护主分支");
  });

  test("detached external FAT merge worktree traces back to OPEN task and verifies readiness", () => {
    // Create fat branch at base
    runGit(repoDir, ["branch", "fat", "main"]);
    writeFileSync(join(repoDir, "feat.ts"), "export const ok = true;\n");
    runGit(repoDir, ["add", "feat.ts"]);
    runGit(repoDir, ["commit", "-m", "feat: ok", "--", "feat.ts"]);
    const featSha = runGit(repoDir, ["rev-parse", "HEAD"]).stdout.trim();

    const ledger = new Ledger(wb);
    ledger.openTask({
      task_id: "20261121-fat-flow",
      title: "FAT detached merge test",
      endpoint: "fat",
      depth: "targeted",
      repo: "app-api",
      branch: "feat/demo",
      base_sha: featSha,
      head_sha: featSha,
    });
    ledger.closeDb();

    // Create external detached worktree in /tmp (exact `ship` FAT workflow!)
    const tmpWt = mkdtempSync(join(tmpdir(), "fat-merge-wt-"));
    rmSync(tmpWt, { recursive: true, force: true });
    try {
      runGit(repoDir, ["worktree", "add", "--detach", tmpWt, "fat"]);
      runGit(tmpWt, ["merge", "--no-ff", "feat/demo", "-m", "merge feat/demo into fat"]);

      // Unverified task -> detached FAT push MUST be blocked!
      expect(
        evaluatePreToolUse(wb, shellInput(`git -C ${tmpWt} push origin HEAD:fat`)),
      ).toContain("尚未满足交付前检查");

      // Record passing test on featSha -> detached FAT push now ALLOWED!
      const ledger2 = new Ledger(wb);
      ledger2.recordEvidence({
        task_id: "20261121-fat-flow",
        kind: "test",
        status: "pass",
        summary: "bun test",
        repo: "app-api",
        branch: "feat/demo",
        sha: featSha,
      });
      ledger2.closeDb();

      expect(
        evaluatePreToolUse(wb, shellInput(`git -C ${tmpWt} push origin HEAD:fat`)),
      ).toBeNull();

      // Regression: if merged HEAD itself has a FAILED test recorded, NEVER fall back to parent feature SHA!
      const mergedHead = runGit(tmpWt, ["rev-parse", "HEAD"]).stdout.trim();
      const ledger3 = new Ledger(wb);
      ledger3.recordEvidence({
        task_id: "20261121-fat-flow",
        kind: "test",
        status: "fail",
        summary: "merge conflict broke test",
        repo: "app-api",
        sha: mergedHead,
      });
      ledger3.closeDb();
      expect(
        evaluatePreToolUse(wb, shellInput(`git -C ${tmpWt} push origin HEAD:fat`)),
      ).toContain("latest test failed");
    } finally {
      runGit(repoDir, ["worktree", "remove", "--force", tmpWt]);
    }
  });

  test("blocks --repo= push to main, --all push, dynamic shell var path, cross-fork PR head, and ClickHouse HTTP under require_prod_db_hosts", () => {
    // 1. `--repo=origin` must NOT swallow first positional refspec `feat/demo:main`!
    expect(
      evaluatePreToolUse(wb, shellInput("git -C app-api push --repo=origin feat/demo:main")),
    ).toContain("受保护主分支");

    // 2. `git push --all` blocked
    expect(
      evaluatePreToolUse(wb, shellInput("git -C app-api push --all")),
    ).toContain("--all");

    // 3. Unexpanded shell variable path fails closed
    expect(
      evaluatePreToolUse(wb, shellInput('git -C "$REPO" push origin feat/demo')),
    ).toContain("未展开的 shell 变量路径");
    expect(
      evaluatePreToolUse(wb, shellInput('cd "$REPO" && git push origin feat/demo')),
    ).toContain("未展开的 shell 变量路径");

    // 4. Cross-fork PR head owner mismatch, `-R other-owner/same-repo`, AND `-R other-host/same-owner/same-repo` fail closed
    runGit(repoDir, ["remote", "add", "origin", "git@github.com:acme/app-api.git"]);
    expect(
      evaluatePreToolUse(wb, shellInput("cd app-api && gh pr create --head evilfork:feat/demo --title t --body b")),
    ).toContain("owner 与当前仓 origin 不匹配");
    expect(
      evaluatePreToolUse(wb, shellInput("cd app-api && gh pr create -R other-org/app-api --title t --body b")),
    ).toContain("与当前仓 origin (github.com/acme/app-api) 不一致");
    expect(
      evaluatePreToolUse(wb, shellInput("cd app-api && gh pr create -R ghe.internal/acme/app-api --title t --body b")),
    ).toContain("与当前仓 origin (github.com/acme/app-api) 不一致");
    expect(
      evaluatePreToolUse(wb, shellInput("cd app-api && gh pr create -Rother-org/app-api --title t --body b")),
    ).toContain("与当前仓 origin (github.com/acme/app-api) 不一致");

    // 4b. Diverged remote tracking ref `origin/feat/demo` fails closed on `gh pr create`
    const headSha = runGit(repoDir, ["rev-parse", "HEAD"]).stdout.trim();
    runGit(repoDir, ["update-ref", "refs/remotes/origin/feat/demo", headSha]);
    writeFileSync(join(repoDir, "extra.ts"), "export const x = 1;\n");
    runGit(repoDir, ["add", "extra.ts"]);
    runGit(repoDir, ["commit", "-m", "feat: ahead of origin"]);
    expect(
      evaluatePreToolUse(wb, shellInput("cd app-api && gh pr create --head feat/demo --title t --body b")),
    ).toContain("已分叉");

    // 5. `require_prod_db_hosts: true` with empty hosts blocks ALL curl/wget/http write spellings!
    writeFileSync(
      join(wb, ".workbench", "workbench.yaml"),
      `name: "ch-strict"\nrepos:\n  - app-api\nguard:\n  require_prod_db_hosts: true\n  prod_db_hosts: []\n`,
    );
    expect(
      evaluatePreToolUse(wb, shellInput('curl -X POST "http://10.0.0.5:8123/?query=DROP%20TABLE%20t"')),
    ).toContain("require_prod_db_hosts");
    expect(
      evaluatePreToolUse(wb, shellInput('curl --request POST -d @drop.sql "http://10.0.0.5:9000/sql"')),
    ).toContain("require_prod_db_hosts");
    expect(
      evaluatePreToolUse(wb, shellInput('curl --data-ascii "DROP TABLE t" "http://10.0.0.5:9000/sql"')),
    ).toContain("require_prod_db_hosts");
    expect(
      evaluatePreToolUse(wb, shellInput('curl -d@drop.sql "http://10.0.0.5:9000/sql"')),
    ).toContain("require_prod_db_hosts");
    expect(
      evaluatePreToolUse(wb, shellInput('curl -XPOST "http://10.0.0.5:9000/sql"')),
    ).toContain("require_prod_db_hosts");
    // Shell-wrapped HTTP writes (`bash -c 'curl ...'`) MUST also be blocked!
    expect(
      evaluatePreToolUse(wb, shellInput(`bash -c 'curl -XPOST "http://10.0.0.5:9000/sql"'`)),
    ).toContain("require_prod_db_hosts");
    expect(
      evaluatePreToolUse(wb, shellInput(`sh -lc 'curl --data-ascii "DROP TABLE t" "http://10.0.0.5:9000/sql"'`)),
    ).toContain("require_prod_db_hosts");
    // Shell-wrapped read-only GET (not ClickHouse port/query) stays allowed
    expect(
      evaluatePreToolUse(wb, shellInput(`bash -c 'curl -XGET "http://10.0.0.5:9000/health"'`)),
    ).toBeNull();
  });

  test("physically locks frozen spec documents and locked test globs across apply_patch, shell redirects, and inline scripts, unlocking strictly per amend scope", () => {
    const head = runGit(repoDir, ["rev-parse", "HEAD"]).stdout.trim();
    const specDir = join(wb, ".workbench", "specs", "20261123-spec");
    mkdirSync(specDir, { recursive: true });
    writeFileSync(join(specDir, "ssot.md"), "# SSOT\nINV-1: server decides price\n");
    writeFileSync(join(specDir, "tech-spec.md"), "# Tech Spec\nUse SQLite WAL\n");
    writeFileSync(join(specDir, "test-spec.md"), "# Test Spec\nHurl case for INV-1\n");
    mkdirSync(join(repoDir, "tests"), { recursive: true });
    writeFileSync(join(repoDir, "tests", "api.hurl"), "GET http://localhost/health\nHTTP 200\n");

    const ledger = new Ledger(wb);
    ledger.openTask({
      task_id: "20261123-spec",
      title: "Spec lock guard test",
      endpoint: "local",
      depth: "full",
      repo: "app-api",
      branch: "feat/demo",
      base_sha: head,
      head_sha: head,
    });
    ledger.freezeSpec({
      task_id: "20261123-spec",
      locked_test_globs: ["*.hurl"],
    });
    ledger.closeDb();

    // 1. Frozen specs are physically locked against apply_patch, shell redirection, and inline script writes!
    expect(
      evaluatePreToolUse(wb, {
        hook_event_name: "PreToolUse",
        cwd: wb,
        tool_name: "apply_patch",
        tool_input: {
          patch:
            "*** Begin Patch\n*** Update File: .workbench/specs/20261123-spec/ssot.md\n@@\n-INV-1\n+INV-1 modified\n*** End Patch",
        },
      }),
    ).toContain("冻结 Spec 保护");
    expect(
      evaluatePreToolUse(
        wb,
        shellInput('echo "tamper" >> .workbench/specs/20261123-spec/tech-spec.md'),
      ),
    ).toContain("冻结 Spec 保护");
    expect(
      evaluatePreToolUse(
        wb,
        shellInput(`python3 -c 'open(".workbench/specs/20261123-spec/test-spec.md","w").write("x")'`),
      ),
    ).toContain("冻结 Spec 保护");

    // 2. Locked *.hurl test files inside the task repo are physically locked, while read-only `hurl` execution and app `.ts` edits are ALLOWED!
    expect(
      evaluatePreToolUse(wb, {
        hook_event_name: "PreToolUse",
        cwd: repoDir,
        tool_name: "apply_patch",
        tool_input: {
          patch: "*** Begin Patch\n*** Update File: tests/api.hurl\n@@\n-HTTP 200\n+HTTP 500\n*** End Patch",
        },
      }),
    ).toContain("冻结测试防篡改");
    expect(
      evaluatePreToolUse(wb, shellInput('echo "HTTP 500" > app-api/tests/api.hurl')),
    ).toContain("冻结测试防篡改");
    expect(
      evaluatePreToolUse(wb, shellInput("hurl app-api/tests/api.hurl")),
    ).toBeNull();
    expect(
      evaluatePreToolUse(wb, {
        hook_event_name: "PreToolUse",
        cwd: repoDir,
        tool_name: "apply_patch",
        tool_input: {
          patch: "*** Begin Patch\n*** Update File: src/app.ts\n@@\n+export const x = 1;\n*** End Patch",
        },
      }),
    ).toBeNull();

    // 3. `ledger amend --scope tech_spec` unlocks ONLY tech-spec.md while keeping ssot.md, test-spec.md, and *.hurl locked!
    const ledger2 = new Ledger(wb);
    ledger2.amendSpec({
      task_id: "20261123-spec",
      scope: "tech_spec",
      reason: "switch cache key format",
    });
    ledger2.closeDb();

    expect(
      evaluatePreToolUse(
        wb,
        shellInput('echo "revised" >> .workbench/specs/20261123-spec/tech-spec.md'),
      ),
    ).toBeNull();
    expect(
      evaluatePreToolUse(
        wb,
        shellInput('echo "tamper" >> .workbench/specs/20261123-spec/ssot.md'),
      ),
    ).toContain("冻结 Spec 保护");
    expect(
      evaluatePreToolUse(wb, shellInput('echo "HTTP 500" > app-api/tests/api.hurl')),
    ).toContain("冻结测试防篡改");

    // 4. Re-freeze, then `ledger amend --scope test_spec` unlocks ONLY test-spec.md & *.hurl while keeping ssot.md & tech-spec.md locked!
    const ledger3 = new Ledger(wb);
    ledger3.freezeSpec({ task_id: "20261123-spec" });
    ledger3.amendSpec({
      task_id: "20261123-spec",
      scope: "test_spec",
      reason: "fix wrong Hurl status assertion",
    });
    ledger3.closeDb();

    expect(
      evaluatePreToolUse(wb, shellInput('echo "HTTP 201" > app-api/tests/api.hurl')),
    ).toBeNull();
    expect(
      evaluatePreToolUse(
        wb,
        shellInput('echo "tamper" >> .workbench/specs/20261123-spec/tech-spec.md'),
      ),
    ).toContain("冻结 Spec 保护");
    expect(
      evaluatePreToolUse(
        wb,
        shellInput('echo "tamper" >> .workbench/specs/20261123-spec/ssot.md'),
      ),
    ).toContain("冻结 Spec 保护");

    // 5. Consecutive un-refrozen amends (test_spec + tech_spec) unlock the union while keeping ssot.md locked
    const ledger4 = new Ledger(wb);
    ledger4.amendSpec({
      task_id: "20261123-spec",
      scope: "tech_spec",
      reason: "also adjust endpoint note",
    });
    ledger4.closeDb();
    expect(
      evaluatePreToolUse(
        wb,
        shellInput('echo "ok" >> .workbench/specs/20261123-spec/tech-spec.md'),
      ),
    ).toBeNull();
    expect(
      evaluatePreToolUse(wb, shellInput('echo "HTTP 201" > app-api/tests/api.hurl')),
    ).toBeNull();
    expect(
      evaluatePreToolUse(
        wb,
        shellInput('echo "tamper" >> .workbench/specs/20261123-spec/ssot.md'),
      ),
    ).toContain("冻结 Spec 保护");
  });

  test("guard lock hardening: catches install/dd/clobber/patch/env/ruby/sh/git, matches recursive globs & bound worktrees without sibling false positives or read-only blocks", () => {
    const wtFeat = join(wb, "app-api.worktrees", "feat");
    const wtOther = join(wb, "app-api.worktrees", "other");
    mkdirSync(join(wb, "app-api.worktrees"), { recursive: true });
    mkdirSync(join(repoDir, "tests", "sub"), { recursive: true });
    writeFileSync(join(repoDir, "tests", "smoke.hurl"), "GET http://localhost/health\nHTTP 200\n");
    writeFileSync(join(repoDir, "tests", "sub", "a.hurl"), "GET http://localhost/a\nHTTP 200\n");
    runGit(repoDir, ["add", "tests"]);
    runGit(repoDir, ["commit", "-m", "chore: add hurl tests"]);
    runGit(repoDir, ["worktree", "add", "-b", "feat/wt", wtFeat, "HEAD"]);
    runGit(repoDir, ["worktree", "add", "-b", "feat/other", wtOther, "HEAD"]);

    const specDir = join(wb, ".workbench", "specs", "20261123-wt");
    mkdirSync(specDir, { recursive: true });
    writeFileSync(join(specDir, "ssot.md"), "# SSOT\nINV-1: immutable\n");
    writeFileSync(join(specDir, "tech-spec.md"), "# Tech\nok\n");
    writeFileSync(join(specDir, "test-spec.md"), "# Test\nok\n");

    const ledger = new Ledger(wb);
    ledger.openTask({
      task_id: "20261123-wt",
      title: "Worktree & shell mutation lock test",
      endpoint: "local",
      depth: "full",
      repo: "app-api",
      branch: "feat/wt",
      worktree: wtFeat,
    });
    ledger.freezeSpec({
      task_id: "20261123-wt",
      locked_test_globs: ["tests/**/*.hurl"],
    });
    ledger.closeDb();

    // 1. Shell mutation forms on frozen ssot.md MUST all be denied
    const patchFile = join(wb, "tamper.patch");
    writeFileSync(
      patchFile,
      `--- .workbench/specs/20261123-wt/ssot.md\n+++ .workbench/specs/20261123-wt/ssot.md\n@@ -1 +1 @@\n-# SSOT\n+# HACKED\n`,
    );
    const mustDenySpec = [
      `install /tmp/x .workbench/specs/20261123-wt/ssot.md`,
      `dd if=/dev/zero of=.workbench/specs/20261123-wt/ssot.md`,
      `echo bad >| .workbench/specs/20261123-wt/ssot.md`,
      `patch -p0 -i ${patchFile}`,
      `env python3 -c 'open(".workbench/specs/20261123-wt/ssot.md","w").write("x")'`,
      `ruby -e 'File.write(".workbench/specs/20261123-wt/ssot.md","x")'`,
      `sh -c 'echo bad > .workbench/specs/20261123-wt/ssot.md'`,
      `bash -lc 'cp /tmp/x .workbench/specs/20261123-wt/ssot.md'`,
    ];
    for (const c of mustDenySpec) {
      expect(
        evaluatePreToolUse(wb, {
          hook_event_name: "PreToolUse",
          cwd: wb,
          tool_name: "exec_command",
          tool_input: { command: c },
        }),
      ).toContain("冻结 Spec 保护");
    }

    // 2. Recursive glob `tests/**/*.hurl` inside bound worktree catches 0, 1, and 2+ nested dirs
    for (const rel of ["tests/smoke.hurl", "tests/sub/a.hurl", "tests/a/b/a.hurl"]) {
      expect(
        evaluatePreToolUse(wb, {
          hook_event_name: "PreToolUse",
          cwd: wtFeat,
          tool_name: "apply_patch",
          tool_input: {
            patch: `*** Begin Patch\n*** Update File: ${rel}\n@@\n-HTTP 200\n+HTTP 500\n*** End Patch`,
          },
        }),
      ).toContain("冻结测试防篡改");
    }
    // `git checkout --` on locked hurl inside bound worktree caught by lock layer
    expect(
      evaluatePreToolUse(wb, {
        hook_event_name: "PreToolUse",
        cwd: wtFeat,
        tool_name: "exec_command",
        tool_input: { command: "git checkout -- tests/sub/a.hurl" },
      }),
    ).toContain("冻结测试防篡改");

    // 3. Sibling worktree (belonging to another branch/task) MUST NOT be blocked by wtFeat's lock!
    expect(
      evaluatePreToolUse(wb, {
        hook_event_name: "PreToolUse",
        cwd: wtOther,
        tool_name: "apply_patch",
        tool_input: {
          patch: "*** Begin Patch\n*** Update File: tests/smoke.hurl\n@@\n-HTTP 200\n+HTTP 201\n*** End Patch",
        },
      }),
    ).toBeNull();

    // 4. Read-only operations MUST NOT false-positive!
    const mustAllowReadOnly = [
      `sed -n '1,5p' .workbench/specs/20261123-wt/ssot.md`,
      `cp .workbench/specs/20261123-wt/ssot.md /tmp/backup-ssot.md`,
      `dd if=.workbench/specs/20261123-wt/ssot.md of=/tmp/backup-ssot.md`,
      `node -e 'console.log("example.hurl")'`,
      `sh -c 'cat .workbench/specs/20261123-wt/ssot.md'`,
      `patch --dry-run -p0 -i ${patchFile}`,
      `git apply --check ${patchFile}`,
    ];
    for (const c of mustAllowReadOnly) {
      expect(
        evaluatePreToolUse(wb, {
          hook_event_name: "PreToolUse",
          cwd: wb,
          tool_name: "exec_command",
          tool_input: { command: c },
        }),
      ).toBeNull();
    }

    // Writing unrelated text mentioning "example.hurl" to /tmp/out inside wtFeat MUST be allowed
    // while dynamic path construction targeting .hurl inside wtFeat MUST still be denied!
    expect(
      evaluatePreToolUse(wb, {
        hook_event_name: "PreToolUse",
        cwd: wtFeat,
        tool_name: "exec_command",
        tool_input: {
          command: `node -e 'require("fs").writeFileSync("/tmp/out.txt", "example.hurl")'`,
        },
      }),
    ).toBeNull();
    expect(
      evaluatePreToolUse(wb, {
        hook_event_name: "PreToolUse",
        cwd: wtFeat,
        tool_name: "exec_command",
        tool_input: {
          command: `node -e 'require("fs").writeFileSync("tests/" + "a.hurl", "HTTP 500")'`,
        },
      }),
    ).toContain("冻结测试防篡改");

    // Uninspectable / oversized (>4 MiB) or missing patch file targeting a locked dir MUST fail closed!
    const missingPatch = join(wb, "missing-or-fifo.patch");
    expect(
      evaluatePreToolUse(wb, {
        hook_event_name: "PreToolUse",
        cwd: wtFeat,
        tool_name: "exec_command",
        tool_input: { command: `git apply ${missingPatch}` },
      }),
    ).toContain("冻结测试防篡改");
    expect(
      evaluatePreToolUse(wb, {
        hook_event_name: "PreToolUse",
        cwd: specDir,
        tool_name: "exec_command",
        tool_input: { command: `patch -p0 -i ${missingPatch}` },
      }),
    ).toContain("冻结 Spec 保护");

    // Round 3 regressions:
    // 1. `git apply --stat --apply` (and `--apply --check`) ACTUALLY applies -> MUST be denied!
    const gitSpecPatch = join(wb, "git-spec.patch");
    writeFileSync(
      gitSpecPatch,
      `--- a/.workbench/specs/20261123-wt/ssot.md\n+++ b/.workbench/specs/20261123-wt/ssot.md\n@@ -1 +1 @@\n-# SSOT\n+# HACKED\n`,
    );
    expect(
      evaluatePreToolUse(wb, {
        hook_event_name: "PreToolUse",
        cwd: wb,
        tool_name: "exec_command",
        tool_input: { command: `git apply --stat --apply ${gitSpecPatch}` },
      }),
    ).toContain("冻结 Spec 保护");
    expect(
      evaluatePreToolUse(wb, {
        hook_event_name: "PreToolUse",
        cwd: wb,
        tool_name: "exec_command",
        tool_input: { command: `git apply -p0 --apply --check ${patchFile}` },
      }),
    ).toContain("冻结 Spec 保护");

    // 2. Metadata-only Git rename patch (no `---`/`+++` headers) targeting locked Hurl MUST be caught!
    const renamePatch = join(wb, "rename.patch");
    writeFileSync(
      renamePatch,
      `diff --git a/tests/smoke.hurl b/tests/renamed.hurl\nsimilarity index 100%\nrename from tests/smoke.hurl\nrename to tests/renamed.hurl\n`,
    );
    expect(
      evaluatePreToolUse(wb, {
        hook_event_name: "PreToolUse",
        cwd: wtFeat,
        tool_name: "exec_command",
        tool_input: { command: `git apply ${renamePatch}` },
      }),
    ).toContain("冻结测试防篡改");

    // 3. Readable patch with unrecognized/empty headers MUST fail closed on locked dir!
    const unknownPatch = join(wb, "unknown.patch");
    writeFileSync(unknownPatch, "GIT binary patch\nliteral 0\n");
    expect(
      evaluatePreToolUse(wb, {
        hook_event_name: "PreToolUse",
        cwd: wtFeat,
        tool_name: "exec_command",
        tool_input: { command: `git apply ${unknownPatch}` },
      }),
    ).toContain("冻结测试防篡改");

    // Round 4 regressions:
    // 4. Mode-only Git patch with spaces in filename targeting locked Hurl MUST be caught!
    const spacedModePatch = join(wb, "spaced-mode.patch");
    writeFileSync(
      spacedModePatch,
      `diff --git a/tests/smoke case.hurl b/tests/smoke case.hurl\nold mode 100644\nnew mode 100755\n`,
    );
    expect(
      evaluatePreToolUse(wb, {
        hook_event_name: "PreToolUse",
        cwd: wtFeat,
        tool_name: "exec_command",
        tool_input: { command: `git apply ${spacedModePatch}` },
      }),
    ).toContain("冻结测试防篡改");

    // 5. `--build-fake-ancestor` destination file is checked against lock matching (both spaced & `=` forms)!
    const benignPatch = join(wb, "benign.patch");
    writeFileSync(
      benignPatch,
      `--- a/notes.txt\n+++ b/notes.txt\n@@ -1 +1 @@\n-old\n+new\n`,
    );
    expect(
      evaluatePreToolUse(wb, {
        hook_event_name: "PreToolUse",
        cwd: wb,
        tool_name: "exec_command",
        tool_input: {
          command: `git apply --build-fake-ancestor .workbench/specs/20261123-wt/ssot.md ${benignPatch}`,
        },
      }),
    ).toContain("冻结 Spec 保护");
    expect(
      evaluatePreToolUse(wb, {
        hook_event_name: "PreToolUse",
        cwd: wb,
        tool_name: "exec_command",
        tool_input: {
          command: `git apply --build-fake-ancestor=.workbench/specs/20261123-wt/ssot.md ${benignPatch}`,
        },
      }),
    ).toContain("冻结 Spec 保护");

    // 6. Spaced `git apply --directory app-api` resolves benign patch cleanly without false denial!
    expect(
      evaluatePreToolUse(wb, {
        hook_event_name: "PreToolUse",
        cwd: wb,
        tool_name: "exec_command",
        tool_input: { command: `git apply --directory app-api ${benignPatch}` },
      }),
    ).toBeNull();

    // Round 5 regressions:
    // 7. Ambiguous section #1 is NOT cleared by explicit `---`/`+++` headers in section #2!
    const multiSectionAmbigPatch = join(wb, "multi-ambig.patch");
    writeFileSync(
      multiSectionAmbigPatch,
      [
        "diff --git old/tests/smoke case.hurl newer/tests/smoke case.hurl",
        "old mode 100644",
        "new mode 100755",
        "diff --git a/readme.md b/readme.md",
        "--- a/readme.md",
        "+++ b/readme.md",
        "@@ -1 +1 @@",
        "-a",
        "+b",
      ].join("\n") + "\n",
    );
    expect(
      evaluatePreToolUse(wb, {
        hook_event_name: "PreToolUse",
        cwd: wtFeat,
        tool_name: "exec_command",
        tool_input: { command: `git apply ${multiSectionAmbigPatch}` },
      }),
    ).toContain("冻结测试防篡改");

    // 8. C-quoted octal UTF-8 filename in mode-only `diff --git` decodes to `café.hurl` and hits lock!
    const utf8ModePatch = join(wb, "utf8-mode.patch");
    writeFileSync(
      utf8ModePatch,
      'diff --git "a/tests/caf\\303\\251.hurl" "b/tests/caf\\303\\251.hurl"\nold mode 100644\nnew mode 100755\n',
    );
    expect(
      evaluatePreToolUse(wb, {
        hook_event_name: "PreToolUse",
        cwd: wtFeat,
        tool_name: "exec_command",
        tool_input: { command: `git apply ${utf8ModePatch}` },
      }),
    ).toContain("冻结测试防篡改");

    // Round 6 regressions:
    // 9. Mixed-format patch (ambiguous mode-only section + blank line + traditional `---`/`+++`) fails closed!
    const mixedFormatPatch = join(wb, "mixed-format.patch");
    writeFileSync(
      mixedFormatPatch,
      [
        "diff --git old/plan notes.md newer/plan notes.md",
        "old mode 100644",
        "new mode 100755",
        "",
        "--- a/readme.md",
        "+++ b/readme.md",
        "@@ -1 +1 @@",
        "-a",
        "+b",
      ].join("\n") + "\n",
    );
    expect(
      evaluatePreToolUse(wb, {
        hook_event_name: "PreToolUse",
        cwd: wtFeat,
        tool_name: "exec_command",
        tool_input: { command: `git apply ${mixedFormatPatch}` },
      }),
    ).toContain("冻结测试防篡改");

    // 10. Invalid UTF-8 octal (`\377`), literal NUL byte, and malformed `\q` header followed by `---`/`+++` ALL fail closed!
    const badUtf8Patch = join(wb, "bad-utf8.patch");
    writeFileSync(
      badUtf8Patch,
      'diff --git "a/x\\377.md" "b/x\\377.md"\nold mode 100644\nnew mode 100755\n',
    );
    expect(
      evaluatePreToolUse(wb, {
        hook_event_name: "PreToolUse",
        cwd: wtFeat,
        tool_name: "exec_command",
        tool_input: { command: `git apply ${badUtf8Patch}` },
      }),
    ).toContain("冻结测试防篡改");

    const litNulPatch = join(wb, "lit-nul.patch");
    writeFileSync(
      litNulPatch,
      'diff --git "a/x\0z.md" "b/x\0z.md"\nold mode 100644\nnew mode 100755\n',
    );
    expect(
      evaluatePreToolUse(wb, {
        hook_event_name: "PreToolUse",
        cwd: wtFeat,
        tool_name: "exec_command",
        tool_input: { command: `git apply ${litNulPatch}` },
      }),
    ).toContain("冻结测试防篡改");

    const badEscWithStdPatch = join(wb, "bad-esc-std.patch");
    writeFileSync(
      badEscWithStdPatch,
      'diff --git "a/\\q.md" "b/\\q.md"\n--- a/readme.md\n+++ b/readme.md\n@@ -1 +1 @@\n-a\n+b\n',
    );
    expect(
      evaluatePreToolUse(wb, {
        hook_event_name: "PreToolUse",
        cwd: wtFeat,
        tool_name: "exec_command",
        tool_input: { command: `git apply ${badEscWithStdPatch}` },
      }),
    ).toContain("冻结测试防篡改");

    // 11. Trailing space in quoted filename is preserved (does NOT silently match `tests/café.hurl` without space!)
    const trailingSpacePatch = join(wb, "trailing-space.patch");
    writeFileSync(
      trailingSpacePatch,
      'diff --git "a/tests/caf\\303\\251.hurl " "b/tests/caf\\303\\251.hurl "\nold mode 100644\nnew mode 100755\n',
    );
    expect(
      evaluatePreToolUse(wb, {
        hook_event_name: "PreToolUse",
        cwd: wtFeat,
        tool_name: "exec_command",
        tool_input: { command: `git apply ${trailingSpacePatch}` },
      }),
    ).toBeNull();
  });
});
