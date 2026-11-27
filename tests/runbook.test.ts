import { readFileSync } from "node:fs";
import { isolateHome } from "./helpers/hermetic";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluatePreToolUse } from "../src/guard";
import { Ledger } from "../src/ledger";
import { handleLedgerHook } from "../src/ledger-hook";

isolateHome();

let wbRoot: string;
let repoDir: string;
let mainSha: string;
let otherSha: string;
let sqlFile: string;

function git(cwd: string, args: string[]): string {
  const res = Bun.spawnSync(["git", ...args], { env: process.env, cwd });
  if (res.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr.toString()}`);
  }
  return res.stdout.toString().trim();
}

beforeEach(() => {
  wbRoot = mkdtempSync(join(tmpdir(), "forge-runbook-test-"));
  mkdirSync(join(wbRoot, ".workbench", "bin"), { recursive: true });
  writeFileSync(join(wbRoot, ".workbench", "bin", "forge"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(
    join(wbRoot, ".workbench", "workbench.yaml"),
    [
      'name: "demo-wb"',
      "repos:",
      "  - svc",
      "ledger:",
      "  enabled: true",
      "guard:",
      "  prod_db_hosts:",
      '    - "pg-prod.demo.internal"',
      '    - "pg-prod-b.demo.internal"',
      "  require_prod_db_hosts: true",
      "  protected_branches:",
      '    - "main"',
      "  prod_tag_patterns:",
      '    - "^release-v"',
      '    - "^api-v"',
      "  block_shared_worktree_ops: true",
      "  block_ledger_direct_edits: true",
      "",
    ].join("\n"),
    "utf8",
  );

  repoDir = join(wbRoot, "svc");
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, ["init", "-b", "main"]);
  git(repoDir, ["config", "user.email", "dev@demo.local"]);
  git(repoDir, ["config", "user.name", "Dev"]);
  git(repoDir, ["remote", "add", "origin", "git@github.com:acme/svc.git"]);

  writeFileSync(join(repoDir, "app.ts"), "export const v = 1;\n");
  git(repoDir, ["add", "app.ts"]);
  git(repoDir, ["commit", "-m", "feat: v1"]);
  mainSha = git(repoDir, ["rev-parse", "HEAD"]);

  writeFileSync(join(repoDir, "app.ts"), "export const v = 2;\n");
  git(repoDir, ["add", "app.ts"]);
  git(repoDir, ["commit", "-m", "feat: v2"]);
  otherSha = git(repoDir, ["rev-parse", "HEAD"]);

  // Tag release-v1.0.0 on mainSha, and release-v1.0.1-wrong on otherSha
  git(repoDir, ["tag", "-a", "release-v1.0.0", mainSha, "-m", "release v1.0.0"]);
  git(repoDir, ["tag", "-a", "release-v1.0.1", otherSha, "-m", "wrong target"]);

  sqlFile = join(repoDir, "migrate.sql");
  writeFileSync(sqlFile, "ALTER TABLE orders ADD COLUMN note text;\n");
});

afterEach(() => {
  rmSync(wbRoot, { recursive: true, force: true });
});

describe("Release Runbook approval via UserPromptSubmit + Guard enforcement", () => {
  test("only complete human approval directives activate pending runbooks", () => {
    const ledger = new Ledger(wbRoot);
    try {
      for (const id of ["rb-a", "rb-b", "rb-abcd1234", "rb-1123-demo"]) ledger.createRunbook({
        runbook_id: id, title: "Release", actions: { prs: [{ repo: "svc", number: 355 }] },
      });
      const prompt = (message: string) => handleLedgerHook(wbRoot, {
        hook_event_name: "UserPromptSubmit", session_id: "human", prompt: message,
      }).userPromptContext;
      for (const text of ["批准 rb-a\nrb-b", "批准 rb-a\r\n", "我不打算批准 rb-abcd1234", "先别急着批准 rb-abcd1234", "批准 rb-abcd1234 吗？有什么风险",
        "你刚才说『请回复 批准 rb-abcd1234』，我想先看看 diff", "I'm not going to approve rb-abcd1234 yet",
        "I won't approve rb-abcd1234", "Runbook 没问题，批准 rb-1123-demo，继续推吧", "看看 rb-a"]) {
        expect(prompt(text)).toContain("未识别");
        expect(ledger.listRunbooks("PENDING")).toHaveLength(4);
      }
      expect(prompt("批准 rb-abcd1234")).toContain("已在主会话批准");
      expect(prompt("approve rb-a rb-b")).toContain("rb-b");
      expect(ledger.listRunbooks("APPROVED")).toHaveLength(3);
      for (const id of ["rb-demo", "rb-demo-"]) ledger.createRunbook({ runbook_id: id, title: "Release", actions: { prs: [{ repo: "svc", number: 355 }] } });
      prompt("approve rb-demo rb-demo-");
      for (const text of ["Do not cancel rb-demo", "don't revoke rb-demo", "不要撤销 rb-demo", "别取消 rb-demo",
        "cancel rb-demo?", "撤销 rb-demo 吗？", "『请撤销 rb-demo』", '"cancel rb-demo"']) {
        prompt(text);
        expect(ledger.getRunbook("rb-demo")?.status).toBe("APPROVED");
      }
      prompt("请撤销 rb-demo-");
      expect(ledger.getRunbook("rb-demo-")?.status).toBe("REVOKED");
      expect(ledger.getRunbook("rb-demo")?.status).toBe("APPROVED");
      prompt("撤销：rb-demo");
      expect(ledger.getRunbook("rb-demo")?.status).toBe("REVOKED");
      for (const [id, command] of [["rb-colon", "撤销: rb-colon"], ["rb-english", "cancel: rb-english"], ["rb-polite", "please revoke rb-polite"]]) {
        ledger.createRunbook({ runbook_id: id, title: "Release", actions: { prs: [{ repo: "svc", number: 355 }] } });
        prompt("approve " + id); prompt(command);
        expect(ledger.getRunbook(id)?.status).toBe("REVOKED");
      }
      const mixed = prompt("请撤销 rb-a，同时批准 rb-1123-demo");
      expect(mixed).toContain("已撤销");
      expect(mixed).toContain("未识别");
      expect(ledger.getRunbook("rb-1123-demo")?.status).toBe("PENDING");
    } finally { ledger.closeDb(); }
  });

  test("production migration approval binds the registered host and exact writing matter", () => {
    const approved = "pg-prod.demo.internal";
    const other = "pg-prod-b.demo.internal";
    const ledger = new Ledger(wbRoot);
    try {
      ledger.createRunbook({ runbook_id: "rb-migration", title: "Add note to orders",
        actions: { sql_files: [{ host: approved, path: sqlFile, sha256: "" }] } });
    } finally { ledger.closeDb(); }
    const check = (command: string) => evaluatePreToolUse(wbRoot, {
      hook_event_name: "PreToolUse", session_id: "main", cwd: repoDir,
      tool_name: "Bash", tool_input: { command },
    });
    const write = (host: string, path: string) => check(`psql -h ${host} -f "${path}"`);
    expect(check(`psql -h ${approved} -c 'SELECT 1'`)).toBeNull();
    expect(write(approved, sqlFile)).toBeTruthy();
    handleLedgerHook(wbRoot, { hook_event_name: "UserPromptSubmit", session_id: "main", prompt: "批准 rb-migration" });
    expect(write(approved, sqlFile)).toBeNull();
    expect(write(other, sqlFile)).toBeTruthy();
    const otherMigration = join(repoDir, "other.sql");
    writeFileSync(otherMigration, "ALTER TABLE orders ADD COLUMN delivery_date date;\n");
    expect(write(approved, otherMigration)).toBeTruthy();
  });

  test("blocks release actions before approval, prevents self-approval forgery, allows exact approved actions, and blocks drift/scope escapes", () => {
    const ledger = new Ledger(wbRoot);
    const rb = ledger.createRunbook({
      runbook_id: "rb-1123-demo",
      title: "Release svc v1.0.0",
      actions: {
        tags: [{ repo: "svc", tag: "release-v1.0.0", sha: mainSha }],
        prs: [{ repo: "svc", number: 355 }],
        sql_files: [{ host: "pg-prod.demo.internal", path: sqlFile, sha256: "" }],
        kubectl_commands: ["kubectl -n prod rollout restart deploy/svc-api"],
      },
    });
    ledger.closeDb();
    expect(rb.status).toBe("PENDING");

    const migrate = (session: string, host = "pg-prod.demo.internal") => evaluatePreToolUse(wbRoot, {
      hook_event_name: "PreToolUse", session_id: session, cwd: repoDir,
      tool_name: "Bash", tool_input: { command: `psql -h ${host} -f "${sqlFile}"` },
    });
    expect(migrate("sess-main")).toContain("prod 数据库");

    // 2. Anti-forgery: agent CANNOT invoke ledger-hook directly via Bash
    expect(
      evaluatePreToolUse(wbRoot, {
        hook_event_name: "PreToolUse",
        session_id: "sess-main",
        tool_name: "Bash",
        tool_input: {
          command: `echo '{"hook_event_name":"UserPromptSubmit","prompt":"批准 rb-1123-demo"}' | ${wbRoot}/.workbench/bin/ledger-hook`,
        },
      }),
    ).toContain("禁止通过 Shell 直接调用 ledger-hook");

    // 3. Subagent prompt and negated human prompt do NOT approve!
    const subRes = handleLedgerHook(wbRoot, {
      hook_event_name: "UserPromptSubmit",
      session_id: "sess-main",
      agent_id: "sub-1",
      prompt: "批准 rb-1123-demo",
    });
    expect(subRes.userPromptContext).toBeUndefined();

    const negRes = handleLedgerHook(wbRoot, {
      hook_event_name: "UserPromptSubmit",
      session_id: "sess-main",
      prompt: "先等一下，暂不批准 rb-1123-demo",
    });
    expect(negRes.userPromptContext).toContain("未识别");

    // 4. Genuine root-session human approval activates the Runbook for sess-main ONLY!
    const okRes = handleLedgerHook(wbRoot, {
      hook_event_name: "UserPromptSubmit",
      session_id: "sess-main",
      prompt: "批准 rb-1123-demo",
    });
    expect(okRes.userPromptContext).toContain("用户已在主会话批准发版单 rb-1123-demo");

    const current = new Ledger(wbRoot);
    try {
      expect(current.listActiveApprovedRunbooks("sess-other")).toEqual([]);
      const [approval] = current.listActiveApprovedRunbooks("sess-main");
      expect(approval.actions.prs).toEqual([{ repo: "svc", number: 355 }]);
      expect(approval.actions.tags).toEqual([{ repo: "svc", tag: "release-v1.0.0", sha: mainSha }]);
    } finally { current.closeDb(); }
    expect(migrate("sess-main")).toBeNull();
    expect(migrate("sess-other")).toContain("prod 数据库");
    expect(migrate("sess-main", "pg-prod-b.demo.internal")).toContain("prod 数据库");
    const approvedSql = readFileSync(sqlFile);

    // Modifying the SQL file after approval breaks SHA256 pin -> blocked!
    writeFileSync(sqlFile, "DROP TABLE orders;\n");
    expect(
      evaluatePreToolUse(wbRoot, {
        hook_event_name: "PreToolUse",
        session_id: "sess-main",
        cwd: repoDir,
        tool_name: "Bash",
        tool_input: { command: `psql -h pg-prod.demo.internal -f ${sqlFile}` },
      }),
    ).toContain("prod 数据库");

    writeFileSync(sqlFile, approvedSql);
    expect(migrate("sess-main")).toBeNull();

    // 7. Revoking via chat prompt immediately cancels authorization
    const revRes = handleLedgerHook(wbRoot, {
      hook_event_name: "UserPromptSubmit",
      session_id: "sess-main",
      prompt: "请撤销 rb-1123-demo",
    });
    expect(revRes.userPromptContext).toContain("已撤销发版单 rb-1123-demo");
    expect(migrate("sess-main")).toContain("prod 数据库");
  }, 15_000);

  test("createRunbook rejects kubectl secret commands and shell chaining", () => {
    const ledger = new Ledger(wbRoot);
    try {
      expect(() =>
        ledger.createRunbook({
          title: "Bad secret read",
          actions: { kubectl_commands: ["kubectl get secret prod-env"] },
        }),
      ).toThrow("never access secrets");

      expect(() =>
        ledger.createRunbook({
          title: "Bad chained kubectl",
          actions: { kubectl_commands: ["kubectl rollout restart deploy/a && rm -rf /"] },
        }),
      ).toThrow("shell chaining/metacharacters forbidden");
    } finally {
      ledger.closeDb();
    }
  });

  test("checks inherited production host for SQL writes and runbook file approval", () => {
    const check = (command: string) => evaluatePreToolUse(wbRoot, {
      hook_event_name: "PreToolUse", session_id: "sess-env", tool_name: "Bash",
      tool_input: { command },
    });
    for (const client of ["psql", "usql"]) {
      expect(check(`${client} postgresql://%70g-prod.demo.internal/app -f '${sqlFile}'`)).toContain("prod 数据库");
    }
    expect(check(`psql 'postgresql://user:pass@localhost,%70g-prod.demo.internal/app' -f '${sqlFile}'`)).toContain("prod 数据库");
    for (const command of [
      `env -C. psql postgresql://%70g-prod.demo.internal/app -f '${sqlFile}'`,
      `env --unknown-flag psql postgresql://%70g-prod.demo.internal/app -f '${sqlFile}'`,
      `env -S "psql postgresql://%70g-prod.demo.internal/app -f '${sqlFile}'"`,
      `psql postgresql://,%70g-prod.demo.internal/app -f '${sqlFile}'`,
      `psql 'postgresql://localhost/app?host=,%70g-prod.demo.internal' -f '${sqlFile}'`,
      `psql 'postgresql://localhost/app?host=%zz,%70g-prod.demo.internal' -f '${sqlFile}'`,
    ]) expect(check(command)).toContain("prod 数据库");
    const oldMysql = process.env.MYSQL_HOST;
    try {
      process.env.MYSQL_HOST = "pg-prod.demo.internal";
      expect(check(`mysql -h localhost app < '${sqlFile}'`)).toBeNull();
      expect(check('mysql -h localhost --connect-timeout=5 app -e "DELETE FROM t"')).toBeNull();
      expect(check(`mysql --defaults-extra-file=/tmp/my.cnf -h localhost app < '${sqlFile}'`)).toContain("prod 数据库");
      expect(check(`mysql app < '${sqlFile}'`)).toContain("prod 数据库");
    } finally {
      if (oldMysql === undefined) delete process.env.MYSQL_HOST;
      else process.env.MYSQL_HOST = oldMysql;
    }
    const oldHost = process.env.PGHOST;
    try {
      process.env.PGHOST = "pg-prod.demo.internal";
      const fileCommand = `psql -f '${sqlFile}'`;
      expect(check(`env -u PAGER ${fileCommand}`)).toContain("prod 数据库");
      expect(check(`env --unset=PAGER ${fileCommand}`)).toContain("prod 数据库");
      expect(check(`env -u PGHOST ${fileCommand}`)).toBeNull();
      expect(check(`env -i psql -h localhost -f '${sqlFile}'`)).toBeNull();
      expect(check(fileCommand)).toContain("prod 数据库");
      expect(check("psql -c 'DROP TABLE orders'")).toContain("prod 数据库");
      const ledger = new Ledger(wbRoot);
      try {
        ledger.createRunbook({
          runbook_id: "rb-1124-env", title: "SQL migration",
          actions: { sql_files: [{ host: "pg-prod.demo.internal", path: sqlFile, sha256: "" }] },
        });
      } finally {
        ledger.closeDb();
      }
      handleLedgerHook(wbRoot, {
        hook_event_name: "UserPromptSubmit", session_id: "sess-env", prompt: "批准 rb-1124-env",
      });
      expect(check(fileCommand)).toBeNull();
      expect(check(`psql -h localhost -f '${sqlFile}'`)).toBeNull();
      expect(check(`psql postgresql://localhost/dev -f '${sqlFile}'`)).toBeNull();
      process.env.PGHOST = "localhost,pg-prod.demo.internal";
      expect(check(fileCommand)).toContain("prod 数据库");
      expect(check(`psql --host=localhost,pg-prod.demo.internal -f '${sqlFile}'`)).toContain("prod 数据库");
    } finally {
      if (oldHost === undefined) delete process.env.PGHOST;
      else process.env.PGHOST = oldHost;
    }
  });

  test("allows approved DSN and dbcred migrations and read-only inspection while blocking tampering", () => {
    const ledger = new Ledger(wbRoot);
    ledger.createRunbook({
      runbook_id: "rb-1124-chain",
      title: "Chained tag + dbcred migration",
      actions: {
        tags: [{ repo: "svc", tag: "release-v2.0.0", sha: mainSha }],
        sql_files: [{ host: "pg-prod.demo.internal", path: sqlFile, sha256: "" }],
      },
    });
    ledger.closeDb();

    handleLedgerHook(wbRoot, {
      hook_event_name: "UserPromptSubmit",
      session_id: "sess-chain",
      prompt: "批准 rb-1124-chain",
    });

    // 2. Approved SQL migration with double-quoted `dbcred` (root & child checkout) and single-quoted `&` DSN params passes!
    expect(
      evaluatePreToolUse(wbRoot, {
        hook_event_name: "PreToolUse",
        session_id: "sess-chain",
        cwd: wbRoot,
        tool_name: "Bash",
        tool_input: {
          command: `PGCONNECT_TIMEOUT=5 PGOPTIONS='-c statement_timeout=30000' usql "postgres://$(.workbench/bin/forge dbcred prod)@pg-prod.demo.internal:5432/app?sslmode=disable" -f "${sqlFile}" 2>&1`,
        },
      }),
    ).toBeNull();

    // Child checkout using `../.workbench/bin/dbcred` passes, while `.workbench/bin/dbcred` from child checkout or bare `dbcred` or unquoted `$()` fails!
    expect(
      evaluatePreToolUse(wbRoot, {
        hook_event_name: "PreToolUse",
        session_id: "sess-chain",
        cwd: repoDir,
        tool_name: "Bash",
        tool_input: {
          command: `usql "postgres://$(../.workbench/bin/forge dbcred prod)@pg-prod.demo.internal:5432/app?sslmode=disable" -f "${sqlFile}"`,
        },
      }),
    ).toBeNull();
    expect(
      evaluatePreToolUse(wbRoot, {
        hook_event_name: "PreToolUse",
        session_id: "sess-chain",
        cwd: repoDir,
        tool_name: "Bash",
        tool_input: {
          command: `usql "postgres://$(.workbench/bin/forge dbcred prod)@pg-prod.demo.internal:5432/app" -f "${sqlFile}"`,
        },
      }),
    ).toContain("prod 数据库");
    expect(
      evaluatePreToolUse(wbRoot, {
        hook_event_name: "PreToolUse",
        session_id: "sess-chain",
        cwd: wbRoot,
        tool_name: "Bash",
        tool_input: {
          command: `usql "postgres://$(dbcred prod)@pg-prod.demo.internal:5432/app" -f "${sqlFile}"`,
        },
      }),
    ).toContain("prod 数据库");
    expect(
      evaluatePreToolUse(wbRoot, {
        hook_event_name: "PreToolUse",
        session_id: "sess-chain",
        cwd: wbRoot,
        tool_name: "Bash",
        tool_input: {
          command: `usql postgres://$(.workbench/bin/forge dbcred prod)@pg-prod.demo.internal:5432/app -f "${sqlFile}"`,
        },
      }),
    ).toContain("prod 数据库");

    // Single-quoted DSN with `&` query params passes (no service override); `PGSERVICEFILE` / `service=` is blocked!
    expect(
      evaluatePreToolUse(wbRoot, {
        hook_event_name: "PreToolUse",
        session_id: "sess-chain",
        cwd: wbRoot,
        tool_name: "Bash",
        tool_input: {
          command: `PGPASSFILE=/tmp/p psql 'postgresql://pg-prod.demo.internal:5432/app?sslmode=disable&application_name=rel' -X -w -v ON_ERROR_STOP=1 -f '${sqlFile}'`,
        },
      }),
    ).toBeNull();
    expect(
      evaluatePreToolUse(wbRoot, {
        hook_event_name: "PreToolUse",
        session_id: "sess-chain",
        cwd: wbRoot,
        tool_name: "Bash",
        tool_input: {
          command: `PGSERVICEFILE=/tmp/s psql 'postgresql://pg-prod.demo.internal:5432/app?sslmode=disable&service=rel' -X -w -f '${sqlFile}'`,
        },
      }),
    ).toContain("prod 数据库");

    const checkMigration = (command: string) => evaluatePreToolUse(wbRoot, {
      hook_event_name: "PreToolUse",
      session_id: "sess-chain",
      cwd: wbRoot,
      tool_name: "Bash",
      tool_input: { command },
    });
    const dbEnv = join(wbRoot, ".workbench/env");
    mkdirSync(dbEnv, {recursive:true});
    writeFileSync(join(dbEnv, "environments.json"), JSON.stringify({prod: {host:"pg-prod.demo.internal.:5432",
      ro:{user:"reader"}, rw:{user:"writer"}}}));
    const rwMigration = (args: string) => `psql "postgresql://$(.workbench/bin/forge dbcred prod --rw --runbook ${args})@pg-prod.demo.internal/app" -f "${sqlFile}"`;
    expect(checkMigration(rwMigration("rb-1124-chain --session sess-chain"))).toContain("prod 数据库");
    expect(checkMigration(rwMigration("rb-other --session sess-chain"))).toContain("prod 数据库");
    expect(checkMigration(rwMigration("rb-1124-chain --session other"))).toContain("prod 数据库");
    const dsn = "'postgresql://pg-prod.demo.internal:5432/app'";
    const migration = `psql -d ${dsn} -f '${sqlFile}'`;
    for (const selectors of [`-d ${dsn} -d plaindb`, `--dbname=${dsn} plaindb`, `-d ${dsn} plaindb`]) {
      expect(checkMigration(`psql ${selectors} -f '${sqlFile}'`)).toContain("prod 数据库");
    }
    expect(checkMigration(`PGHOST=pg-prod.demo.internal PGHOST= psql -f '${sqlFile}'`)).toContain("prod 数据库");
    expect(checkMigration(`mysql -h pg-prod.demo.internal -u deploy -P3306 app < '${sqlFile}'`)).toBeNull();
    expect(checkMigration(`psql -h pg-prod.demo.internal -U deploy -p 5432 -f '${sqlFile}'`)).toBeNull();
    expect(checkMigration(`psql -h pg-prod.demo.internal 3< '${sqlFile}'`)).toContain("prod 数据库");
    for (const options of ["-1 -f", "-X1 -f", "-1v ON_ERROR_STOP=1 -f", "-af", "-ef", "-Wf", "-Hf", "-Xf", "-1f"]) {
      expect(checkMigration(`psql -h pg-prod.demo.internal ${options} '${sqlFile}'`)).toBeNull();
      expect(checkMigration(`psql -h pg-prod.demo.internal ${options} other.sql`)).toContain("prod 数据库");
    }
    expect(checkMigration("PGHOST=pg-prod.demo.internal psql postgresql://deploy@/app -af neutral.txt")).toContain("prod 数据库");
    expect(checkMigration("PGHOST=pg-prod.demo.internal psql -h localhost -f schema.sql")).toBeNull();
    expect(checkMigration("MYSQL_HOST=pg-prod.demo.internal mysql --host=localhost app <schema.sql")).toBeNull();
    expect(checkMigration("CLICKHOUSE_HOST=pg-prod.demo.internal clickhouse-client --host localhost --queries-file schema.sql")).toBeNull();
    expect(checkMigration("PGHOST=pg-prod.demo.internal psql -af schema.sql -h localhost")).toBeNull();
    expect(checkMigration("MYSQL_HOST=pg-prod.demo.internal mysql -u deploy -h localhost app <schema.sql")).toBeNull();
    expect(checkMigration("PGHOST=pg-prod.demo.internal psql --no-psqlrc -h localhost -f schema.sql")).toBeNull();
    const tlsCommand = `mysql --ssl-mode=VERIFY_IDENTITY -h pg-prod.demo.internal app < '${sqlFile}'`;
    expect(checkMigration(tlsCommand)).toBeNull();
    const approvedSql = readFileSync(sqlFile);
    try {
      writeFileSync(sqlFile, "-- changed migration");
      expect(checkMigration(tlsCommand)).toContain("prod 数据库");
    } finally { writeFileSync(sqlFile, approvedSql); }
    const previousHostAddr = process.env.PGHOSTADDR;
    try {
      process.env.PGHOSTADDR = "127.0.0.1";
      expect(checkMigration(migration)).toContain("prod 数据库");
      expect(checkMigration(`PGHOSTADDR= ${migration}`)).toBeNull();
      delete process.env.PGHOSTADDR;
      expect(checkMigration(migration)).toBeNull();
    } finally {
      if (previousHostAddr === undefined) delete process.env.PGHOSTADDR;
      else process.env.PGHOSTADDR = previousHostAddr;
    }

    // Host spoofing via `application_name`, clustered `-Xc`, attached unapproved `-fFILE`, and output redirection `>` MUST be blocked!
    expect(
      evaluatePreToolUse(wbRoot, {
        hook_event_name: "PreToolUse",
        session_id: "sess-chain",
        cwd: wbRoot,
        tool_name: "Bash",
        tool_input: {
          command: `psql 'postgresql://pg-prod-b.demo.internal:5432/app?application_name=pg-prod.demo.internal' -f '${sqlFile}'`,
        },
      }),
    ).toContain("prod 数据库");
    expect(
      evaluatePreToolUse(wbRoot, {
        hook_event_name: "PreToolUse",
        session_id: "sess-chain",
        cwd: wbRoot,
        tool_name: "Bash",
        tool_input: {
          command: `psql 'postgresql://pg-prod.demo.internal:5432/app' -Xc 'SELECT 1' -f '${sqlFile}'`,
        },
      }),
    ).toContain("prod 数据库");
    const unapprovedSql = join(repoDir, "unapproved.sql");
    writeFileSync(unapprovedSql, "SELECT 1;\n");
    expect(
      evaluatePreToolUse(wbRoot, {
        hook_event_name: "PreToolUse",
        session_id: "sess-chain",
        cwd: wbRoot,
        tool_name: "Bash",
        tool_input: {
          command: `psql 'postgresql://pg-prod.demo.internal:5432/app' -f${unapprovedSql}`,
        },
      }),
    ).toContain("prod 数据库");
    expect(
      evaluatePreToolUse(wbRoot, {
        hook_event_name: "PreToolUse",
        session_id: "sess-chain",
        cwd: wbRoot,
        tool_name: "Bash",
        tool_input: {
          command: `psql 'postgresql://pg-prod.demo.internal:5432/app' -f '${sqlFile}' > /tmp/sentinel-out.txt`,
        },
      }),
    ).toContain("prod 数据库");

    // Arbitrary command substitution, injected `;` inside dbcred, extra `-c`, or chaining MUST stay blocked!
    expect(
      evaluatePreToolUse(wbRoot, {
        hook_event_name: "PreToolUse",
        session_id: "sess-chain",
        cwd: wbRoot,
        tool_name: "Bash",
        tool_input: {
          command: `usql "postgres://$(cat /etc/passwd)@pg-prod.demo.internal:5432/app" -f "${sqlFile}"`,
        },
      }),
    ).toContain("prod 数据库");

    expect(
      evaluatePreToolUse(wbRoot, {
        hook_event_name: "PreToolUse",
        session_id: "sess-chain",
        cwd: wbRoot,
        tool_name: "Bash",
        tool_input: {
          command: `usql "postgres://$(.workbench/bin/forge dbcred prod; id)@pg-prod.demo.internal:5432/app" -f "${sqlFile}"`,
        },
      }),
    ).toContain("prod 数据库");

    expect(
      evaluatePreToolUse(wbRoot, {
        hook_event_name: "PreToolUse",
        session_id: "sess-chain",
        cwd: wbRoot,
        tool_name: "Bash",
        tool_input: {
          command: `psql 'postgresql://pg-prod.demo.internal:5432/app?a=1&b=2' -f '${sqlFile}' -c 'DROP TABLE x'`,
        },
      }),
    ).toContain("prod 数据库");

    // Cross-client env var (`MYSQL_HOST` on `psql`), lowercase `pghost`, numbered fd `3<`, and symlink-`..` traversal MUST be blocked!
    expect(
      evaluatePreToolUse(wbRoot, {
        hook_event_name: "PreToolUse",
        session_id: "sess-chain",
        cwd: wbRoot,
        tool_name: "Bash",
        tool_input: {
          command: `MYSQL_HOST=pg-prod.demo.internal psql -f '${sqlFile}'`,
        },
      }),
    ).toContain("prod 数据库");
    expect(
      evaluatePreToolUse(wbRoot, {
        hook_event_name: "PreToolUse",
        session_id: "sess-chain",
        cwd: wbRoot,
        tool_name: "Bash",
        tool_input: {
          command: `pghost=pg-prod.demo.internal psql -f '${sqlFile}'`,
        },
      }),
    ).toContain("prod 数据库");
    expect(
      evaluatePreToolUse(wbRoot, {
        hook_event_name: "PreToolUse",
        session_id: "sess-chain",
        cwd: wbRoot,
        tool_name: "Bash",
        tool_input: {
          command: `psql 'postgresql://pg-prod.demo.internal:5432/app' 3< '${sqlFile}'`,
        },
      }),
    ).toContain("prod 数据库");

    // Symlink `..` traversal: `svc/link` -> `other/child`, so `svc/link/../migrate.sql` opens `other/migrate.sql` (different digest!), NOT `svc/migrate.sql`!
    const otherDir = join(wbRoot, "other");
    mkdirSync(join(otherDir, "child"), { recursive: true });
    writeFileSync(join(otherDir, "migrate.sql"), "DROP TABLE orders;\n");
    writeFileSync(join(otherDir, "dbcred"), "#!/bin/sh\necho evil\n", { mode: 0o755 });
    symlinkSync(join(otherDir, "child"), join(repoDir, "link"));
    expect(
      evaluatePreToolUse(wbRoot, {
        hook_event_name: "PreToolUse",
        session_id: "sess-chain",
        cwd: repoDir,
        tool_name: "Bash",
        tool_input: {
          command: `psql 'postgresql://pg-prod.demo.internal:5432/app' -f link/../migrate.sql`,
        },
      }),
    ).toContain("prod 数据库");
    expect(
      evaluatePreToolUse(wbRoot, {
        hook_event_name: "PreToolUse",
        session_id: "sess-chain",
        cwd: repoDir,
        tool_name: "Bash",
        tool_input: {
          command: `usql "postgres://$(link/../dbcred prod)@pg-prod.demo.internal:5432/app" -f "${sqlFile}"`,
        },
      }),
    ).toContain("prod 数据库");

    // Runbook registration and execution resolve `link/../migrate.sql` to the SAME physical file (`other/migrate.sql`)!
    const ledgerSym = new Ledger(wbRoot);
    const symRb = ledgerSym.createRunbook({
      runbook_id: "rb-1124-sym",
      title: "Symlink parity test",
      actions: {
        sql_files: [{ host: "pg-prod.demo.internal", path: "svc/link/../migrate.sql", sha256: "" }],
      },
    });
    ledgerSym.closeDb();
    const symActions = JSON.parse(symRb.actions_json) as { sql_files: Array<{ path: string }> };
    expect(symActions.sql_files[0].path).toEndWith("/other/migrate.sql");

    // Libpq connstring with spaces around `=` OR empty comma-separated host entry (`,pg-prod.demo.internal`) MUST be blocked!
    expect(
      evaluatePreToolUse(wbRoot, {
        hook_event_name: "PreToolUse",
        session_id: "sess-chain",
        cwd: wbRoot,
        tool_name: "Bash",
        tool_input: {
          command: `psql -h pg-prod.demo.internal 'host = pg-prod-b.demo.internal dbname=app' -f '${sqlFile}'`,
        },
      }),
    ).toContain("prod 数据库");
    expect(
      evaluatePreToolUse(wbRoot, {
        hook_event_name: "PreToolUse",
        session_id: "sess-chain",
        cwd: wbRoot,
        tool_name: "Bash",
        tool_input: {
          command: `psql 'host=,pg-prod.demo.internal dbname=app' -f '${sqlFile}'`,
        },
      }),
    ).toContain("prod 数据库");
    expect(
      evaluatePreToolUse(wbRoot, {
        hook_event_name: "PreToolUse",
        session_id: "sess-chain",
        cwd: wbRoot,
        tool_name: "Bash",
        tool_input: {
          command: `psql 'postgresql://,pg-prod.demo.internal:5432/app' -f '${sqlFile}'`,
        },
      }),
    ).toContain("prod 数据库");

    // ANSI-C `$'...'` quoting MUST be rejected for approved SQL migrations!
    expect(
      evaluatePreToolUse(wbRoot, {
        hook_event_name: "PreToolUse",
        session_id: "sess-chain",
        cwd: repoDir,
        tool_name: "Bash",
        tool_input: {
          command: `psql 'postgresql://pg-prod.demo.internal:5432/app' -f $'migrate.sql'`,
        },
      }),
    ).toContain("prod 数据库");

    // 3. Read-only inspection on ledger-hook passes (including quoted `|` in regex), while pipes, untrusted paths, or write/helper flags stay blocked!
    expect(
      evaluatePreToolUse(wbRoot, {
        hook_event_name: "PreToolUse",
        session_id: "sess-chain",
        cwd: wbRoot,
        tool_name: "Bash",
        tool_input: {
          command: "ls -l .workbench/bin/guard .workbench/bin/ledger-hook",
        },
      }),
    ).toBeNull();
    expect(
      evaluatePreToolUse(wbRoot, {
        hook_event_name: "PreToolUse",
        session_id: "sess-chain",
        cwd: wbRoot,
        tool_name: "Bash",
        tool_input: {
          command: 'rg "foo|bar" .workbench/bin/ledger-hook',
        },
      }),
    ).toBeNull();

    expect(evaluatePreToolUse(wbRoot, {
      hook_event_name: "PreToolUse", cwd: wbRoot, tool_name: "Bash",
      tool_input: { command: "grep . .workbench/bin/ledger-hook | wc -l" },
    })).toBeNull();

    for (const badInspector of [
      "cat .workbench/bin/ledger-hook | sh",
      "bun .workbench/bin/ledger-hook.js",
    ]) {
      expect(
        evaluatePreToolUse(wbRoot, {
          hook_event_name: "PreToolUse",
          session_id: "sess-chain",
          cwd: wbRoot,
          tool_name: "Bash",
          tool_input: { command: badInspector },
        }),
      ).toContain("禁止通过 Shell 直接调用 ledger-hook");
    }
    // 4. Local `.workbench/bin/forge ledger runbook create --sql <prod-host>:<file>` and `ledger record` MUST NOT be falsely blocked by `checkProdDb` (even though `create` matches SQL_WRITE_RE!),
    //    while fake/chained/command-substituted invocations MUST stay blocked!
    expect(
      evaluatePreToolUse(wbRoot, {
        hook_event_name: "PreToolUse",
        session_id: "sess-chain",
        cwd: wbRoot,
        tool_name: "Bash",
        tool_input: {
          command: `.workbench/bin/forge ledger runbook create --title 'Backfill migration 159' --sql pg-prod.demo.internal:${sqlFile}`,
        },
      }),
    ).toBeNull();
    expect(
      evaluatePreToolUse(wbRoot, {
        hook_event_name: "PreToolUse",
        session_id: "sess-chain",
        cwd: repoDir,
        tool_name: "Bash",
        tool_input: {
          command: `../.workbench/bin/forge ledger record demo-1 --kind prod --status pass --summary 'ALTER/CREATE verified on pg-prod.demo.internal'`,
        },
      }),
    ).toBeNull();
    // Chained, substituted, redirected, or non-canonical ledger path MUST stay blocked!
    expect(
      evaluatePreToolUse(wbRoot, {
        hook_event_name: "PreToolUse",
        session_id: "sess-chain",
        cwd: wbRoot,
        tool_name: "Bash",
        tool_input: {
          command: `.workbench/bin/forge ledger runbook create --title 'x' --sql pg-prod.demo.internal:${sqlFile} && psql -h pg-prod.demo.internal -c 'DROP TABLE t'`,
        },
      }),
    ).toContain("prod 数据库");
    expect(
      evaluatePreToolUse(wbRoot, {
        hook_event_name: "PreToolUse",
        session_id: "sess-chain",
        cwd: wbRoot,
        tool_name: "Bash",
        tool_input: {
          command: `.workbench/bin/forge ledger runbook create --title "$(psql -h pg-prod.demo.internal -c 'CREATE TABLE t(id int)')"`,
        },
      }),
    ).toContain("prod 数据库");
    // Preparing a runbook definition cannot authorize a second production target.
    expect(evaluatePreToolUse(wbRoot, {
      hook_event_name: "PreToolUse", cwd: repoDir, session_id: "sess-chain", tool_name: "Bash",
      tool_input: { command: `psql -h pg-prod-b.demo.internal -f "${sqlFile}"` },
    })).toContain("prod 数据库");
  }, 15_000);
});
