import { diffScope, deliveryDiff } from "../src/ship-diff";
import { fastTrackCommand } from "../src/ledger/fast-track";
import { beforeEach, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { Ledger } from "../src/ledger";
import { appendEventInTx } from "../src/ledger/transactions";
import { handleLedgerHook } from "../src/ledger-hook";
import { evaluatePreToolUse } from "../src/guard";
import { loadShipPolicy } from "../src/config";
import { initWorkbench, syncWorkbench, doctorWorkbench } from "../src/cli";
import { root, ledger, feature, git, remote, useReleaseFixture } from "./helpers/release";

useReleaseFixture();
const template = readFileSync(join(import.meta.dir, "../templates/ship-policy.yaml"), "utf8");
const policy = () => join(root, ".workbench/ship-policy.yaml");
beforeEach(() => writeFileSync(policy(), template));
test("v4 migrates additively with release history, FTS and valid FK/hash chains", () => {
  const path = join(root, "old.db"),
    db = new Database(path);
  db.exec(readFileSync(join(import.meta.dir, "fixtures/ledger-v4.sql"), "utf8"));
  db.exec(
    "INSERT INTO tasks VALUES('old','title','HANDED_OFF','pr','targeted',0,NULL,'GENESIS','t','t',NULL); INSERT INTO task_repos VALUES('api','feat',NULL,'old',NULL,NULL,'t'); INSERT INTO task_blockers VALUES('old','b','CLOSED','done','t','t'); INSERT INTO runbooks(runbook_id,title,status,actions_json,actions_hash,created_at) VALUES('rb-history','title','COMPLETED','{}','h','t');INSERT INTO releases VALUES('rel','release','VERIFIED','rb-history','[]',NULL,'t','t',NULL);INSERT INTO release_items VALUES('rel','old','api','feat','main',1,'url','head','head','tip','VERIFIED',1); INSERT INTO task_handoffs VALUES('old','t','tip','[]','[]',NULL)",
  );
  appendEventInTx(db, { task_id: "old", event_type: "NOTE", actor: "tool", payload: { summary: "sentinel" } });
  const tables = [
    "tasks",
    "task_repos",
    "task_blockers",
    "events",
    "events_fts",
    "task_handoffs",
    "runbooks",
    "releases",
    "release_items",
  ];
  const dump = (db: Database) => tables.map((t) => db.query("SELECT rowid,* FROM " + t).all());
  const before = dump(db);
  db.close();
  const migrated = new Ledger(root, { dbPath: path });
  try {
    expect(dump(migrated.db)).toEqual(before);
    expect(migrated.db.query("pragma user_version").get()).toEqual({ user_version: 6 });
    expect(migrated.db.query("pragma foreign_key_check").all()).toEqual([]);
    expect(migrated.verify().ok).toBe(true);
    expect(
      migrated.db.query("SELECT rowid FROM events_fts WHERE events_fts MATCH 'sentinel'").all(),
    ).toHaveLength(1);
  } finally {
    migrated.closeDb();
  }
});
test("init installs the policy and runner, sync preserves edits, doctor and tamper guard inspect them", () => {
  const dir = join(root, "kit-test");
  initWorkbench({ targetDir: dir, kitRoot: join(import.meta.dir, "..") });
  const p = join(dir, ".workbench/ship-policy.yaml");
  expect(readFileSync(p, "utf8")).toBe(template);
  writeFileSync(p, template.replace("enabled: true", "enabled: false"));
  syncWorkbench({ targetDir: dir });
  expect(loadShipPolicy(dir).policy.enabled).toBe(false);
  expect(existsSync(join(dir, ".workbench/bin/forge"))).toBe(true);
  expect(doctorWorkbench(dir).issues.filter((i) => ["bins", "ship-policy"].includes(i.check))).toEqual([]);
  for (const command of [
    "rm .workbench/ship-policy.yaml",
    "echo x > .workbench/ship-policy.yaml",
    "truncate -s 0 .workbench/ship-policy.yaml",
    "mv .workbench moved",
    "rsync -a backup/ .workbench/",
    "tar -xf backup.tar -C .workbench",
    "find .workbench -delete",
    "find .workbench -print",
    "git diff -- .workbench/ship-policy.yaml",
    "cat .workbench/ship-policy.yaml",
    "ls .workbench/ship-policy.yaml",
  ]) {
    const deny = evaluatePreToolUse(dir, {
      hook_event_name: "PreToolUse",
      cwd: dir,
      tool_name: "Bash",
      tool_input: { command },
    });
    if (/^(ls|cat|git diff)|-print$/.test(command)) expect(deny).toBeNull();
    else expect(deny).toBeTruthy();
  }
  expect(
    evaluatePreToolUse(dir, {
      hook_event_name: "PreToolUse",
      cwd: dir,
      tool_name: "Edit",
      tool_input: { file_path: p },
    }),
  ).toBeTruthy();
  for (const duplicate of ["allow_prod: true", "forbidden_paths: []"]) {
    writeFileSync(p, template + "\n  " + duplicate + "\n");
    expect(() => loadShipPolicy(dir)).toThrow();
  }
  writeFileSync(p, "fast_track: {}");
  expect(() => loadShipPolicy(dir)).toThrow();
});
function exactFixture() {
  initWorkbench({ targetDir: root, kitRoot: join(import.meta.dir, "..") });
  const f = feature("api", 1);
  const specs = join(root, ".workbench/specs", f.task);
  mkdirSync(specs, { recursive: true });
  writeFileSync(join(specs, "scope.md"), "Existing behavior has coverage. Add a regression check.");
  ledger.freezeSpec({ task_id: f.task });
  remote(f.n, { baseRefOid: f.base });
  const rb = ledger.createRunbook({
    task_id: f.task,
    title: "Merge reviewed PR",
    actions: { prs: [{ repo: f.repo, number: f.n }] },
    exact_stages: [],
  });
  const prep = (paths = "src/**", ...rest: string[]) =>
    fastTrackCommand(ledger, [
      "prepare",
      f.task,
      "--runbook",
      rb.runbook_id,
      "--to",
      "pr",
      "--paths",
      paths,
      ...rest,
    ]) as { envelope_id: string };
  return { f, prep, rb };
}
function human(prompt: string, extra = {}) {
  return handleLedgerHook(root, {
    hook_event_name: "UserPromptSubmit",
    session_id: "test-session",
    prompt,
    ...extra,
  }).userPromptContext;
}
test("scope-bound runbook activation requires the exact root prompt", () => {
  const { prep, f, rb } = exactFixture();
  expect(() => fastTrackCommand(ledger, ["prepare", f.task, "--to", "pr", "--paths", "src/**"])).toThrow(
    "runbook",
  );
  expect(() => prep("**")).toThrow("unrestricted");
  expect(() => prep("../src")).toThrow();
  expect(() => prep("src/migrations/**")).toThrow();
  expect(() => prep("src/**", "--ttl", "241")).toThrow("TTL");
  const { envelope_id: id } = prep();
  for (const prompt of ["不要快轨批准 " + id, "快轨批准 " + id + "?", "快轨批准 " + id + "\n", "approve " + id])
    human(prompt);
  human("快轨批准 " + id, { agent_id: "worker" });
  expect(ledger.getRunbook(rb.runbook_id)?.status).toBe("PENDING");
  writeFileSync(policy(), template + "\n");
  expect(human("快轨批准 " + id)).toContain("refused");
  writeFileSync(policy(), template);
  expect(human("快轨批准 " + id)).toContain("ACTIVE");
  expect(ledger.getRunbook(rb.runbook_id)?.approved_session_id).toBe("test-session");
  expect(human("快轨撤销 " + id)).toContain("REVOKED");
}, 30_000);

for (const [path, content, why] of [
  ["other/file", "doc", "scope"],
  ["src/auth/session", "code", "Forbidden"],
  ["src/a.sql", "SELECT 1", "SQL"],
  ["src/b", "a\nb\nc", "cap"],
  ["src/c", "\0binary", "Binary"],
  ["src/package.json", "{}", "scope"],
]) {
  test("delivery diff checks exact paths and change limits: " + path, () => {
    const f = feature("api", 1);
    mkdirSync(join(f.wt, path, ".."), { recursive: true });
    writeFileSync(join(f.wt, path), content);
    git(f.wt, "add", "--", path);
    git(f.wt, "commit", "-m", "change", "--", path);
    const head = git(f.wt, "rev-parse", "HEAD");
    const policy = { ...loadShipPolicy(root).policy, max_lines_changed: 2 };
    const paths = path.endsWith("package.json") ? ["./package.json"] : ["src/**"];
    expect(() => deliveryDiff(policy, paths)(f.repo, f.wt, f.base, head)).toThrow(why);
  });
}
test("rename checks source and destination; gitlinks are outside file budget", () => {
  const f = feature("api", 1),
    policy = loadShipPolicy(root).policy;
  mkdirSync(join(f.wt, "src"));
  git(f.wt, "mv", "tracked.sql", "src/renamed.ts");
  git(f.wt, "commit", "-m", "rename");
  expect(() =>
    diffScope(f.wt, { repo: f.repo, base_sha: f.base }, "HEAD", true, ["src/**"], policy, new Set()),
  ).toThrow();
  git(f.wt, "update-index", "--add", "--cacheinfo", "160000", f.base, "src/nested");
  git(f.wt, "commit", "-m", "gitlink");
  expect(() => deliveryDiff(policy, ["src/**"])(f.repo, f.wt, "HEAD^", "HEAD")).toThrow("Submodule");
});
