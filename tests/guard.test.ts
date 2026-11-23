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

    // 4. `ledger amend --scope test_spec` unlocks test-spec.md and *.hurl while keeping ssot.md and tech-spec.md locked!
    const ledger3 = new Ledger(wb);
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
  });
});
