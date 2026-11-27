import { isolateHome } from "./helpers/hermetic";
import { nativeReview } from "./helpers/native-review";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "../src/git";
import { evaluatePreToolUse } from "../src/guard";
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
    - 'gh api.*(?:PATCH|DELETE|POST|PUT).*repos/acme/svc/(?:git/refs|releases|pulls)'
    - 'kubectl.*(?:rollout restart|delete deploy).*'
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
    "gh api -X PATCH repos/acme/svc/git/refs/heads/test", "gh api -X POST repos/acme/svc/releases -f tag_name=v1",
    "gh api -X PUT repos/acme/svc/pulls/42/merge", "gh api -X DELETE repos/acme/svc/releases/1",
    "example-admin purge", "redis-cli FLUSHALL"]) expect(evaluatePreToolUse(wb, shellInput(cmd))).toBeTruthy();
  for (const cmd of ['env -S "gh api -X GET repos/acme/app/issues"', "gh api --hostname git.example repos/acme/svc/forge/atomic-pr/v1/pulls/42/merge",
    "gh api -X HEAD repos/acme/svc/forge/atomic-pr/v1/pulls/42/merge", "gh api repos/acme/svc/pulls/42/merge", "gh api https://api.github.com/repos/acme/svc/pulls/1/merge", "gh api repos/acme/svc/releases/1 -iX GET", "gh api -iH 'Accept: application/json' repos/acme/svc/releases",
    "gh api -X GET repos/acme/svc/pulls/42/merge", "gh api -iXHEAD repos/acme/svc/pulls/42/merge", "kubectl get pods", "gh api repos/acme/svc/releases", "gh api -X POST repos/acme/releases/issues", "gh api -X GET repos/acme/app/releases -f per_page=1", "gh api graphql -f 'query=query { viewer { login } }'", "gh api graphql -f 'query=query Repo($name: String!) { repository(name: $name, owner: \"acme\") { id } }' -f name=app", "gh api graphql -f 'query=query { search(query: \"subscription\", type: ISSUE, first: 1) { issueCount } }'", "gh api graphql -f 'query=query Nodes($ids: [ID!]!) { nodes(ids: $ids) { id } }' -F 'ids[]=abc'", "redis-cli PING"])
    expect(evaluatePreToolUse(wb, shellInput(cmd))).toBeNull();
});

describe("Tier 1 Physical Fuses & Fail-Closed", () => {
  test("guard binary fails closed on malformed JSON stdin", async () => {
    const guardSrc = join(import.meta.dir, "..", "src", "bin", "cli.ts");
    const proc = Bun.spawn([process.execPath, guardSrc, "guard"], {
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
        shellInput(`echo '*** Begin Patch' && git -C app-api push --force`),
      ),
    ).toContain("强制");
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

  test("read-only command combinations may read policy, specs and ledger source", () => {
    for (const command of [
      "cat .workbench/ship-policy.yaml; git diff -- .workbench/specs/task/ssot.md",
      "rg -n freeze src/ledger | head -20",
      "cat .workbench/specs/task/test-spec.md | rg 'git reset --hard'",
    ]) {
      expect(evaluatePreToolUse(wb, shellInput(command)), command).toBeNull();
    }
    for (const force of ["--force", "--force-with-lease", "-f", "+HEAD:refs/heads/feature"]) {
      const command = `cat .workbench/ship-policy.yaml; git -C app-api push origin ${force}`;
      expect(evaluatePreToolUse(wb, shellInput(command)), command).toMatch(/force|强制|强推|保险丝/i);
    }
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
    test(`force protection applies to branch and tag refs with ledger enabled=${enabled}`, () => {
      appendFileSync(join(wb, ".workbench", "workbench.yaml"), `ledger:\n  enabled: ${enabled}\n`);
      for (const namespace of ["heads", "tags"]) {
        const ref = `refs/${namespace}/*`;
        expect(evaluatePreToolUse(wb, shellInput(`git -C app-api push origin '+${ref}:${ref}'`))).toContain("物理保险丝");
      }
    });
  }

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
      "custom_block_patterns",
    );
    expect(evaluatePreToolUse(wb, shellInput("kubectl get cm,secret -n prod"))).toContain("secret");
  });
});

// v05-delivery.test.ts exercises permission, actual hosted target and version at the ship node.
describe("frozen evidence and delivery readiness", () => {
  test("explicit feature push allows clean sibling main and blocks dirty detached checkout", () => {
    const rel = "frozen.hurl", file = join(repoDir, rel);
    const base = runGit(repoDir, ["rev-parse", "HEAD"]).stdout.trim();
    writeFileSync(file, "frozen"); runGit(repoDir, ["add", rel]); runGit(repoDir, ["commit", "-m", "contract"]);
    const head = runGit(repoDir, ["rev-parse", "HEAD"]).stdout.trim(), task_id = "detached-checkout";
    const ledger = new Ledger(wb);
    try {
      ledger.openTask({ workflow_version: "0.4", task_id, title: task_id, endpoint: "fat", depth: "targeted", repo: "app-api", branch: "feat/demo", base_sha: base, head_sha: head });
      const docs = join(wb, ".workbench/specs", task_id); mkdirSync(docs, { recursive: true });
      for (const name of ["ssot", "tech-spec", "test-spec"]) writeFileSync(join(docs, name + ".md"), name);
      ledger.freezeSpec({ task_id, locked_test_globs: [rel] });
      nativeReview(ledger, task_id, { repo: "app-api", branch: "feat/demo", base, head });
      ledger.recordEvidence({ task_id, repo: "app-api", sha: head, kind: "test", status: "pass", source: "tool", summary: "pass" });
      const readiness = (checkoutDir: string) => ledger.checkPushReadiness({ task_id, repo: "app-api", branch: "feat/demo", head_sha: head, checkoutDir });
      const featureDir = join(wb, "feature-checkout");
      expect(runGit(repoDir, ["switch", "main"]).code).toBe(0);
      expect(runGit(repoDir, ["worktree", "add", featureDir, "feat/demo"]).code).toBe(0);
      expect(runGit(repoDir, ["status", "--porcelain"]).stdout).toBe("");
      expect(existsSync(file)).toBe(false);
      expect(readiness(featureDir).ready).toBe(true);

      expect(runGit(repoDir, ["worktree", "remove", featureDir]).code).toBe(0);
      expect(runGit(repoDir, ["switch", "--detach", head]).code).toBe(0);
      expect(readiness(repoDir).ready).toBe(true);
      writeFileSync(file, "dirty");
      expect(readiness(repoDir).missing.join(" ")).toContain(rel);
    } finally { ledger.closeDb(); }
  });
  test("an instance requiring production database registration rejects writes until configured", () => {
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
    ledger.openTask({ workflow_version: "0.4",
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
    ledger.openTask({ workflow_version: "0.4",
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

test("policy checks use the command's effective directory and copy destination", () => {
  const decision = (command: string) => evaluatePreToolUse(wb, shellInput(command));
  expect(decision("git -C .workbench diff -- ship-policy.yaml")).toBeNull();
  expect(decision("git -C .workbench add -- ship-policy.yaml")).toBeNull();
  expect(decision("cp --target-directory=.workbench ship-policy.yaml")).toContain("ship-policy.yaml");
  expect(decision("cp -t .workbench/specs archive")).toBeNull();
  expect(decision("tar -czf .workbench/specs/report.tgz -C .workbench/specs .")).toBeNull();
  expect(decision("rsync -a archive .workbench/specs/")).toBeNull();
  expect(decision("git rm -r .workbench")).toContain("ship-policy.yaml");
  expect(decision("git mv .workbench archived")).toContain("ship-policy.yaml");
  const spaced = join(wb, "bench with spaces");
  const spacedPolicy = join(spaced, ".workbench", "ship-policy.yaml");
  mkdirSync(join(spaced, ".workbench"), {recursive: true});
  expect(evaluatePreToolUse(spaced, {
    hook_event_name: "PreToolUse", cwd: spaced, tool_name: "Edit", tool_input: { file_path: spacedPolicy },
  })).toContain("ship-policy.yaml");
  const overwrite = "echo edited > ship-policy.yaml";
  expect(evaluatePreToolUse(wb, shellInput(overwrite, join(wb, ".workbench")))).toContain("ship-policy.yaml");
  expect(evaluatePreToolUse(wb, shellInput(overwrite, join(wb, ".workbench/specs")))).toBeNull();
});
