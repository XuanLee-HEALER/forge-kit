import { isolateHome } from "./helpers/hermetic";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "../src/git";
import { evaluatePreToolUse, resolveGhDefaultHost } from "../src/guard";
import { Ledger } from "../src/ledger";

isolateHome();

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
  custom_block_patterns:
    - "example-admin purge"
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

test("guard denies secret/raw, tunnels and release API writes and permits ordinary reads", () => {
  for (const cmd of ["kubectl get --raw /api/v1/secrets", "kubectl --raw=/api/v1/secrets",
    "kubectl port-forward service/db 8000:8000",
    "gh api -X PATCH repos/acme/svc/git/refs/heads/test", "gh api repos/acme/svc/releases -f tag_name=v1",
    "gh api repos/acme/svc/pulls/42/merge -f body=value",
    "gh api -X POST https://git.example/api/v3/repos/acme/svc/releases", "gh api -p sample -X DELETE repos/acme/svc/releases/1", "gh api --preview sample -X POST repos/acme/releases/releases", "gh api graphql -f 'query=mutation { mergePullRequest(input: {}) { clientMutationId } }'",
    "gh api repos/acme/svc/releases/1 -iX DELETE", "gh api -iXDELETE repos/acme/svc/releases/1",
    "gh api -iF tag=v1 repos/acme/svc/releases", "gh api repos/acme/svc/releases -if tag=v1",
    "gh api -iZ repos/acme/svc/releases", "gh api repos/acme/svc/pulls/42/merge -X PUT",
    "gh api /api/graphql -F query=@missing", "gh api -X POST repos/acme/app/releases", "example-admin purge", "redis-cli FLUSHALL"]) expect(evaluatePreToolUse(wb, shellInput(cmd))).toBeTruthy();
  for (const cmd of ["gh api repos/acme/svc/pulls/42/merge", "gh api https://api.github.com/repos/acme/svc/pulls/1/merge", "gh api repos/acme/svc/releases/1 -iX GET", "gh api -iH 'Accept: application/json' repos/acme/svc/releases",
    "gh api -X GET repos/acme/svc/pulls/42/merge", "gh api -iXHEAD repos/acme/svc/pulls/42/merge", "kubectl get pods", "gh api repos/acme/svc/releases", "gh api -X POST repos/acme/releases/issues", "gh api -X GET repos/acme/app/releases -f per_page=1", "gh api graphql -f 'query=query { viewer { login } }'", "gh api graphql -f 'query=query Repo($name: String!) { repository(name: $name, owner: \"acme\") { id } }' -f name=app", "gh api graphql -f 'query=query { search(query: \"subscription\", type: ISSUE, first: 1) { issueCount } }'", "gh api graphql -f 'query=query Nodes($ids: [ID!]!) { nodes(ids: $ids) { id } }' -F 'ids[]=abc'", "redis-cli PING"])
    expect(evaluatePreToolUse(wb, shellInput(cmd))).toBeNull();
});

describe("Tier 1 Physical Fuses & Fail-Closed", () => {
  test("guard binary fails closed on malformed JSON stdin", async () => {
    const guardSrc = join(import.meta.dir, "..", "src", "bin", "guard.ts");
    const proc = Bun.spawn([process.execPath, guardSrc], {
      env: process.env,
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

  for (const enabled of [false, true]) {
    test(`blocks wildcard refspecs at the physical fuse with ledger enabled=${enabled}`, () => {
      appendFileSync(join(wb, ".workbench", "workbench.yaml"), `ledger:\n  enabled: ${enabled}\n`);
      for (const namespace of ["heads", "tags"]) {
        const ref = `refs/${namespace}/*`;
        expect(evaluatePreToolUse(wb, shellInput(`git -C app-api push origin '${ref}:${ref}'`))).toContain("物理保险丝");
      }
    });
  }

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
    for (const ref of ["HEAD", "+HEAD", "@", "feat/demo:HEAD"]) {
      expect(evaluatePreToolUse(wb, shellInput(`git -C app-api push origin ${ref}`))).toContain("主分支");
    }
  });

  test("blocks prod DB writes while allowing SELECT with < comparison operator", () => {
    expect(evaluatePreToolUse(wb, shellInput("curl -fsS https://pg-prod.internal/health"))).toBeNull();
    expect(evaluatePreToolUse(wb, shellInput("curl -F field=value https://pg-prod.internal/api"))).toContain("prod 数据库");
    expect(evaluatePreToolUse(wb, shellInput("cat migration.sql | psql -h pg-prod.internal app"))).toContain("文件或标准输入");
    expect(evaluatePreToolUse(wb, shellInput("psql -h pg-prod.internal -c 'SELECT 1' | head"))).toBeNull();
    expect(evaluatePreToolUse(wb, shellInput("http https://pg-prod.internal/jobs enabled=true"))).toContain("prod 数据库");
    expect(evaluatePreToolUse(wb, shellInput("http https://pg-prod.internal/jobs limit==1"))).toBeNull();
    for (const command of ["http https://pg-prod.internal/jobs < request.json", "cat request.json | http https://pg-prod.internal/jobs"]) {
      expect(evaluatePreToolUse(wb, shellInput(command))).toContain("prod 数据库");
    }
    for (const opt of ["-af", "-ef", "-Xf", "-1f", "-v ON_ERROR_STOP=1 -af"]) {
      expect(evaluatePreToolUse(wb, shellInput(`psql -h pg-prod.internal ${opt} neutral.txt`))).toContain("文件或标准输入");
    }
    for (const query of ["SELECT 1", "SHOW TABLES", "DESCRIBE t", "EXPLAIN SELECT 1"]) {
      expect(evaluatePreToolUse(wb, shellInput(`curl -sS https://pg-prod.internal:8123 --data-binary '${query}'`))).toBeNull();
    }
    expect(evaluatePreToolUse(wb, shellInput("curl -H 'Content-Type: text/plain' https://pg-prod.internal --data-binary 'SELECT 1'"))).toBeNull();
    for (const query of ["DELETE FROM t", "@q.sql", "SELECT 1; DELETE FROM t", "arbitrary body"]) {
      expect(evaluatePreToolUse(wb, shellInput(`curl https://pg-prod.internal --data-binary '${query}'`))).toContain("prod 数据库");
    }
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

    const owner = new Ledger(wb);
    const task_id = "docs-exemption";
    try {
      owner.openTask({ task_id, title: "Docs", endpoint: "local", depth: "targeted", repo: "app-api", branch: "feat/demo" });
      const specs = join(wb, ".workbench/specs", task_id);
      mkdirSync(specs, { recursive: true });
      for (const name of ["ssot", "tech-spec", "test-spec"]) writeFileSync(join(specs, name + ".md"), name);
      const contract = join(repoDir, "frozen.hurl");
      writeFileSync(contract, "original");
      owner.freezeSpec({ task_id, locked_test_globs: ["*.hurl"] });
      writeFileSync(contract, "modified");
      expect(evaluatePreToolUse(wb, shellInput("git -C app-api push origin feat/demo"))).toContain("frozen.hurl");
      owner.cancelTask({ task_id, reason: "fixture complete" });
    } finally { owner.closeDb(); }

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

  test("explicit feature push allows clean sibling main and blocks dirty detached checkout", () => {
    const rel = "frozen.hurl", file = join(repoDir, rel);
    writeFileSync(file, "frozen"); runGit(repoDir, ["add", rel]); runGit(repoDir, ["commit", "-m", "contract"]);
    const head = runGit(repoDir, ["rev-parse", "HEAD"]).stdout.trim(), task_id = "detached-checkout";
    const ledger = new Ledger(wb);
    try {
      ledger.openTask({ task_id, title: task_id, endpoint: "fat", depth: "targeted", repo: "app-api", branch: "feat/demo", head_sha: head });
      const docs = join(wb, ".workbench/specs", task_id); mkdirSync(docs, { recursive: true });
      for (const name of ["ssot", "tech-spec", "test-spec"]) writeFileSync(join(docs, name + ".md"), name);
      ledger.freezeSpec({ task_id, locked_test_globs: [rel] });
      ledger.recordEvidence({ task_id, repo: "app-api", sha: head, kind: "test", status: "pass", source: "tool", summary: "pass" });
      const push = (ref = "HEAD:fat") => evaluatePreToolUse(wb, shellInput("git -C app-api push origin " + ref));
      const featureDir = join(wb, "feature-checkout");
      expect(runGit(repoDir, ["switch", "main"]).code).toBe(0);
      expect(runGit(repoDir, ["worktree", "add", featureDir, "feat/demo"]).code).toBe(0);
      expect(runGit(repoDir, ["status", "--porcelain"]).stdout).toBe("");
      expect(existsSync(file)).toBe(false);
      expect(push("feat/demo:feat/demo")).toBeNull();

      expect(runGit(repoDir, ["worktree", "remove", featureDir]).code).toBe(0);
      expect(runGit(repoDir, ["switch", "--detach", head]).code).toBe(0);
      expect(push("feat/demo:feat/demo")).toBeNull();
      expect(push()).toBeNull();
      writeFileSync(file, "dirty");
      expect(push()).toContain(rel);
      expect(push("feat/demo:feat/demo")).toContain(rel);
    } finally { ledger.closeDb(); }
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
        source: "hook",
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

      for (const ref of ["HEAD", "@"]) {
        expect(evaluatePreToolUse(wb, shellInput(`git -C app-api push origin ${ref}`))).toBeNull();
      }
      runGit(repoDir, ["remote", "add", "origin", "https://github.com/acme/app-api.git"]);
      const create = (opts: string) => evaluatePreToolUse(wb, shellInput(`gh pr create ${opts} -t t -b b`, repoDir));
      expect(create("")).toBeNull();
      runGit(repoDir, ["remote", "add", "Upstream", "https://github.com/other-org/app-api.git"]);
      expect(create("")).toContain("gh 默认目标仓");
      runGit(repoDir, ["remote", "set-url", "Upstream", "https://github.com/acme/app-api.git"]);
      runGit(repoDir, ["remote", "add", "UPSTREAM", "https://github.com/acme/app-api.git"]);
      expect(create("")).toContain("gh 默认目标仓");
      runGit(repoDir, ["remote", "remove", "UPSTREAM"]);
      runGit(repoDir, ["remote", "remove", "Upstream"]);
      runGit(repoDir, ["remote", "add", "upstream", "https://github.com/other-org/app-api.git"]);
      runGit(repoDir, ["config", "remote.upstream.gh-resolved", "base"]);
      expect(create("")).toContain("gh 默认目标仓");
      expect(create("-R acme/app-api")).toBeNull();

      runGit(repoDir, ["remote", "set-url", "origin", "https://ghe.example/acme/app-api.git"]);
      runGit(repoDir, ["config", "--unset", "remote.upstream.gh-resolved"]);
      runGit(repoDir, ["config", "remote.origin.gh-resolved", "acme/app-api"]);
      expect(create("")).toBeNull();
      runGit(repoDir, ["remote", "set-url", "upstream", "https://github.com/acme/app-api.git"]);
      runGit(repoDir, ["config", "remote.upstream.gh-resolved", "acme/app-api"]);
      expect(create("")).toContain("gh 默认目标仓");

      const ghConfig = join(wb, "gh-config");
      mkdirSync(ghConfig);
      writeFileSync(join(ghConfig, "hosts.yml"), "ghe.example:\n  user: demo\n");
      const configuredCreate = () => evaluatePreToolUse(wb, shellInput(
        `GH_HOST= GH_CONFIG_DIR='${ghConfig}' gh -R acme/app-api pr create -t t -b b`, repoDir));
      expect(configuredCreate()).toBeNull();
      runGit(repoDir, ["remote", "set-url", "origin", "https://github.com/acme/app-api.git"]);
      expect(configuredCreate()).toContain("不一致");
      writeFileSync(join(ghConfig, "hosts.yml"), "ghe-a.example: {}\nghe-b.example: {}\n");
      expect(resolveGhDefaultHost((key) => key === "GH_CONFIG_DIR" ? ghConfig : "")).toBe("github.com");
      expect(configuredCreate()).toBeNull();
      runGit(repoDir, ["remote", "set-url", "upstream", "https://ghe-a.example/acme/app-api.git"]);
      runGit(repoDir, ["config", "--unset", "remote.origin.gh-resolved"]);
      runGit(repoDir, ["config", "remote.upstream.gh-resolved", "github.com/acme/app-api"]);
      expect(create("")).toContain("gh 默认目标仓");
      runGit(repoDir, ["remote", "set-url", "origin", "https://ghe-a.example/acme/app-api.git"]);
      expect(configuredCreate()).toContain("不一致");
      runGit(repoDir, ["remote", "set-url", "origin", "https://ghe/acme/app-api.git"]);
      expect(evaluatePreToolUse(wb, shellInput("GH_HOST=ghe gh -R acme/app-api pr create -t t -b b", repoDir))).toBeNull();

      // A second attached feature has no parent in this merge.
      runGit(repoDir, ["switch", "-c", "feat/sibling"]);
      runGit(repoDir, ["commit", "--allow-empty", "-m", "sibling"]);
      const siblingHead = runGit(repoDir, ["rev-parse", "HEAD"]).stdout.trim();
      runGit(repoDir, ["switch", "feat/demo"]);
      const siblingLedger = new Ledger(wb);
      try {
        siblingLedger.attachRepo({
          task_id: "20261121-fat-flow",
          repo: "app-api",
          branch: "feat/sibling",
          base_sha: featSha,
          head_sha: siblingHead,
        });
      } finally {
        siblingLedger.closeDb();
      }
      expect(evaluatePreToolUse(wb, shellInput(`git -C ${tmpWt} push origin HEAD:fat`))).toBeNull();

      // Regression: if merged HEAD itself has a FAILED test recorded, NEVER fall back to parent feature SHA!
      const mergedHead = runGit(tmpWt, ["rev-parse", "HEAD"]).stdout.trim();
      const ledger3 = new Ledger(wb);
      const mergedCheck = (branch: string | null, status: "pass" | "fail") =>
        ledger3.recordEvidence({
          source: "hook",
          task_id: "20261121-fat-flow",
          kind: "test",
          status,
          summary: "verify merged checkout",
          repo: "app-api",
          branch,
          sha: mergedHead,
        });
      const push = () => evaluatePreToolUse(wb, shellInput(`git -C ${tmpWt} push origin HEAD:fat`));
      const task_id = "20261121-fat-flow";
      const repo = "app-api";
      const bind = (branch: string, head_sha: string) =>
        ledger3.attachRepo({ task_id, repo, branch, base_sha: featSha, head_sha });
      const detach = (branch: string) => ledger3.detachRepo({ task_id, repo, branch });
      const review = (status: "pass" | "fail", base: string) =>
        ledger3.recordEvidence({
          task_id, repo, branch: "feat/sibling", sha: mergedHead,
          kind: "review", source: "tool", status, summary: "merged review",
          meta: { role: "quality", base },
        });
      try {
        // An attachment at HEAD is distinct from the unique verified parent.
        bind("at-merge", mergedHead);
        expect(push()).toBeNull();
        bind("at-fat-parent", runGit(tmpWt, ["rev-parse", "HEAD^1"]).stdout.trim());
        expect(push()).toContain("尚未满足交付前检查");
        detach("at-fat-parent");
        detach("at-merge");

        review("fail", featSha);
        review("pass", mergedHead);
        detach("feat/sibling");
        expect(push()).toContain("latest review failed");
        bind("feat/sibling", siblingHead);
        review("pass", featSha);
        detach("feat/sibling");
        expect(push()).toBeNull();
        bind("feat/sibling", siblingHead);

        mergedCheck(null, "fail");
        expect(push()).toContain("latest test failed");
        mergedCheck(null, "pass");
        expect(push()).toBeNull();

        mergedCheck("feat/sibling", "fail");
        mergedCheck("feat/demo", "pass");
        expect(push()).toContain("latest test failed");
        mergedCheck("feat/sibling", "pass");
        expect(push()).toBeNull();

        mergedCheck("feat/sibling", "fail");
        ledger3.detachRepo({ task_id: "20261121-fat-flow", repo: "app-api", branch: "feat/sibling" });
        expect(push()).toContain("latest test failed");
      } finally {
        ledger3.closeDb();
      }
    } finally {
      runGit(repoDir, ["worktree", "remove", "--force", tmpWt]);
    }
  });

  test("checks delivery readiness after --no-delete and in env-selected checkouts", () => {
    for (const cmd of [
      "git -C app-api push --delete --no-delete origin HEAD:refs/heads/feat/demo",
      "git -C app-api push --delete --no-de origin HEAD:refs/heads/feat/demo",
      "env -C app-api gh pr create -t t -b b", "env -Capp-api gh pr create -t t -b b",
      "env -C app-api git push origin feat/demo",
    ]) expect(evaluatePreToolUse(wb, shellInput(cmd))).toContain("账本门禁");
    expect(evaluatePreToolUse(wb, shellInput('env -S "git -C app-api push origin HEAD"'))).toContain("无法解析 env");
    expect(evaluatePreToolUse(wb, shellInput('env -C "$REPO" gh pr create -t t -b b'))).toContain("未展开");
  });

  test("checks effective GH_REPO and GH_HOST for PR creation", () => {
    runGit(repoDir, ["remote", "add", "origin", "https://github.com/acme/app-api.git"]);
    const create = "gh pr create --head feat/demo -t t -b b";
    const check = (cmd: string) => evaluatePreToolUse(wb, shellInput(cmd, repoDir));
    expect(check(`GH_REPO=other-org/app-api ${create}`)).toContain("不一致");
    expect(check("GH_HOST=ghe.internal gh pr create -R acme/app-api -t t -b b")).toContain("不一致");
    expect(check(`GH_HOST=ghe.internal ${create}`)).toContain("不一致");
    const original = process.env.GH_REPO;
    try {
      process.env.GH_REPO = "other-org/app-api";
      expect(check(create)).toContain("不一致");
    } finally {
      if (original === undefined) delete process.env.GH_REPO;
      else process.env.GH_REPO = original;
    }
  });

  test("requires explicit refspecs for matching and configured remote pushes", () => {
    const push = (args: string) => evaluatePreToolUse(wb, shellInput(`git -C app-api ${args}`));
    const explicit = push("push origin feat/demo");
    runGit(repoDir, ["config", "push.default", "matching"]);
    expect(push("push origin")).toContain("push.default=matching");
    expect(push("push origin feat/demo")).toBe(explicit);
    runGit(repoDir, ["config", "--unset", "push.default"]);
    runGit(repoDir, ["config", "remote.origin.push", "refs/heads/feat/demo:refs/heads/main"]);
    expect(push("push origin")).toContain("remote.origin.push");
    expect(push("push --repo=other origin")).toContain("remote.origin.push");
    expect(push("push --repo origin")).toContain("remote.origin.push");
    expect(push("push origin feat/demo")).toContain("src:dst");
    expect(push("push origin feat/demo:feat/demo")).toBe(explicit);
  });

  test("inspects the sole push remote and recognizes abbreviated push options", () => {
    const push = (opts: string) => evaluatePreToolUse(wb, shellInput(`git -C app-api push ${opts}`));
    for (const [opt, reason] of [
      ["--mir", "--mirror"], ["--al", "--all"], ["--bran", "--branches"],
      ["--ta", "--tags"], ["--fo", "强推"], ["--fol", "--follow-tags"],
    ]) expect(push(opt)).toContain(reason);
    runGit(repoDir, ["remote", "add", "backup", "https://example.com/team/app.git"]);
    runGit(repoDir, ["config", "remote.backup.mirror", "true"]);
    expect(push("")).toContain("mirror");
  });

  test("blocks implicit mirror pushes and protected upstream destinations", () => {
    const push = (args: string) => evaluatePreToolUse(wb, shellInput(`git -C app-api ${args}`));
    runGit(repoDir, ["config", "remote.origin.mirror", "true"]);
    expect(push("push origin")).toContain("mirror");
    runGit(repoDir, ["config", "--unset", "remote.origin.mirror"]);
    runGit(repoDir, ["config", "branch.feat/demo.remote", "origin"]);
    runGit(repoDir, ["config", "branch.feat/demo.merge", "refs/heads/main"]);
    expect(push("-c push.default=upstream push origin")).toContain("上游");
    runGit(repoDir, ["config", "push.default", "upstream"]);
    expect(push("push")).toContain("上游");
  });

  test("blocks --repo= push to main, --all push, dynamic shell var path, cross-fork PR head, and ClickHouse HTTP under require_prod_db_hosts", () => {
    // The positional receiver overrides --repo.
    expect(
      evaluatePreToolUse(wb, shellInput("git -C app-api push --repo=origin origin feat/demo:main")),
    ).toContain("受保护主分支");

    // 2. `git push --all` blocked
    expect(
      evaluatePreToolUse(wb, shellInput("git -C app-api push --all")),
    ).toContain("--all");
    expect(
      evaluatePreToolUse(wb, shellInput("git -C app-api push --branches")),
    ).toContain("--branches");
    for (const refspec of [":", "+:"]) {
      expect(evaluatePreToolUse(wb, shellInput(`git -C app-api push origin ${refspec}`))).toContain("物理保险丝");
    }

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

    for (const command of ["gh -R other-org/app-api pr create", "gh pr -Rother-org/app-api new"]) {
      expect(evaluatePreToolUse(wb, shellInput(`cd app-api && ${command} --title t --body b`)))
        .toContain("与当前仓 origin (github.com/acme/app-api) 不一致");
    }

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
    expect(evaluatePreToolUse(wb, shellInput("curl -fsS https://db.example/health"))).toBeNull();
    // Shell-wrapped read-only GET (not ClickHouse port/query) stays allowed
    expect(
      evaluatePreToolUse(wb, shellInput(`bash -c 'curl -XGET "http://10.0.0.5:9000/health"'`)),
    ).toBeNull();
  });

  test("physically locks frozen spec documents and locked test globs across apply_patch, shell redirects, and simple writes, unlocking strictly per amend scope", () => {
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

    // 1. Frozen specs are physically locked against apply_patch, shell redirection, and simple writes!
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
        shellInput(`tee .workbench/specs/20261123-spec/test-spec.md`),
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

  test("recognizable writes and structured patches respect bound worktrees and recursive globs", () => {
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
    const target = ".workbench/specs/20261123-wt/ssot.md";
    const mustDenySpec = [
      `tee -a ${target}`, `rm ${target}`, `mv ${target} /tmp/old`, `cp /tmp/new ${target}`,
      `sed -i.bak 's/a/b/' ${target}`, `perl -pi -e 's/a/b/' ${target}`, `echo bad >>${target}`,
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

    for (const command of [
      "git mv tests/smoke.hurl moved.hurl", "git rm tests/smoke.hurl", "chmod -x tests/smoke.hurl",
      "cp src tests/smoke.hurl 2>err.log", `env -C '${wtFeat}' cp src tests/smoke.hurl`,
    ]) expect(evaluatePreToolUse(wb, shellInput(command, command.startsWith("env") ? wb : wtFeat))).toContain("冻结测试防篡改");
    expect(evaluatePreToolUse(wb, shellInput(`env -C '${wtOther}' true >tests/smoke.hurl`, wtFeat))).toContain("冻结测试防篡改");
    expect(evaluatePreToolUse(wb, shellInput(`env -C '${wtFeat}' true >tests/smoke.hurl`, wtOther))).toBeNull();

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

  });
});
