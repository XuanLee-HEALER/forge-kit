import { test, expect } from "bun:test";
import { join } from "node:path";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { collectProdDbHosts, loadWorkbenchConfig } from "../src/config";
import { checkProdDb } from "../src/guard/sql-http";
import { doctorWorkbench, initWorkbench } from "../src/cli";
import { formatDbCred } from "../src/dbcred";
import { executorFixture } from "./helpers/executor";
const f = executorFixture();
test("credentials select the requested account, protect production aliases and warn on legacy entries", () => {
  initWorkbench({targetDir:f.root});
  const ro = { user: "reader", password: "a@b" },
    rw = { user: "writer", password: "x:y" };
  writeFileSync(
    join(f.root, ".workbench/env/environments.json"),
    JSON.stringify({
      failover: { host: "LIVE.DB:5432, standby.db:5433", ro, rw },
      rooted: { host: "LIVE.DB.:5432", ro, rw },
      alias: { host: "LIVE.DB", ro, rw },
      production: { user: "old", password: "legacy" },
      dev: { ro, rw },
      prodBad: { rw },
      prodOnly: { host: "live.db", rw, user: "legacy_writer" },
      analytics_prod: { host: "analytics.db", ro, rw },
      archive_prod: {host:"archives.db:5432, backup.db:5433", ro, rw},
      main_db: { host: "ANALYTICS.DB", ro, rw },
    }),
  );
  const hosts = collectProdDbHosts(f.root, loadWorkbenchConfig(f.root));
  expect(hosts).toContain("backup.db");
  expect(checkProdDb("psql -h dev.db,backup.db:5433 -c \"UPDATE t SET a=1\"", hosts, f.repo)).not.toBeNull();
  expect(formatDbCred(f.root, "alias")).toBe("reader:a%40b");
  expect(formatDbCred(f.root, "production")).toBe("old:legacy");
  expect(doctorWorkbench(f.root).issues.some((i) => i.level === "warn" && i.check === "db-credentials")).toBe(
    true,
  );
  const get = (name: string, ...args: string[]) =>
    f.cli("dbcred", [name, ...args], { FORGE_SESSION_ID: "session", CODEX_SESSION_ID: undefined });
  expect(get("dev", "--rw").stdout.toString()).toBe("writer:x%3Ay");
  expect(get("prodOnly").exitCode).toBe(1);
  expect(get("main_db", "--rw").exitCode).toBe(1);
  expect(get("alias", "--rw").exitCode).toBe(1);
  expect(get("rooted", "--rw").exitCode).toBe(1);
  const sql = join(f.root, "change.sql");
  writeFileSync(sql, "SELECT 1;");
  f.ledger.createRunbook({
    runbook_id: "rb-release",
    title: "fixture",
    actions: { sql_files: [{ host: "live.db", path: sql, sha256: "" }] },
  });
  const args = ["--rw", "--runbook", "rb-release", "--session", "session"];
  const update = (status: string, expires: string) =>
    f.ledger.db
      .query("UPDATE runbooks SET status=?,expires_at=?,approved_session_id='session'")
      .run(status, expires);
  const future = new Date(Date.now() + 3600000).toISOString();
  for (const status of ["PENDING", "REVOKED", "COMPLETED"]) {
    update(status, future);
    expect(get("alias", ...args).exitCode).toBe(1);
  }
  update("APPROVED", new Date(0).toISOString());
  expect(get("alias", ...args).exitCode).toBe(1);
  update("APPROVED", future);
  expect(get("alias", ...args).stdout.length).toBe(0);
  expect(get("alias", ...args.slice(0, 3)).exitCode).toBe(1);
  expect(f.cli("dbcred", ["alias", ...args], {FORGE_SESSION_ID:undefined, CODEX_SESSION_ID:"session"}).exitCode).toBe(1);
  expect(f.cli("dbcred", ["alias", ...args], {FORGE_SESSION_ID:undefined, CODEX_SESSION_ID:undefined}).exitCode).toBe(1);
  expect(f.cli("dbcred", ["alias", ...args], {FORGE_SESSION_ID:"", CODEX_SESSION_ID:"session"}).exitCode).toBe(1);
  expect(get("failover", "--rw").exitCode).toBe(1);
  expect(get("failover", ...args).exitCode).toBe(1);
  f.ledger.createRunbook({runbook_id:"rb-both", title:"failover", actions:{sql_files:
    ["live.db","standby.db"].map(host => ({host, path:sql, sha256:""}))}});
  update("APPROVED", future);
  expect(get("failover", "--rw", "--runbook", "rb-both").stdout.length).toBe(0);
  expect(get("alias", ...args.slice(0, -1), "other").exitCode).toBe(1);
  expect(get("prodBad", ...args).exitCode).toBe(1);
  expect(
    f.cli("dbcred", ["alias", ...args], { FORGE_SESSION_ID: undefined, CODEX_SESSION_ID: "session-B" })
      .exitCode,
  ).toBe(1);
  f.ledger.db.query("UPDATE runbooks SET approved_session_id=NULL").run();
  expect(get("alias", ...args).exitCode).toBe(1);
  update("APPROVED", future);
  const legacy = join(f.root, ".agents/skills/dbop");
  mkdirSync(legacy, { recursive: true });
  renameSync(join(f.root, ".workbench/env/environments.json"), join(legacy, "environments.json"));
  expect(doctorWorkbench(f.root).issues.some((i) => i.check === "db-credentials")).toBe(true);
  writeFileSync(
    join(f.root, ".workbench/env/environments.json"),
    JSON.stringify({ prod: { host: "another.db", ro, rw } }),
  );
  const denied = get("prod", ...args);
  expect(denied.exitCode).toBe(1);
  expect(denied.stdout.length).toBe(0);
  expect(denied.stderr.toString()).not.toContain(rw.password);
  expect(denied.stderr.toString()).toContain("forge dbcred <env> --ro");
  expect(denied.stderr.toString()).toContain("forge ship");
  expect(denied.stderr.toString()).not.toContain("--runbook");
});
