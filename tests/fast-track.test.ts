import { beforeEach, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, rmSync } from "node:fs";
import { Ledger } from "../src/ledger";
import { appendEventInTx } from "../src/ledger/transactions";
import { handleLedgerHook } from "../src/ledger-hook";
import { evaluatePreToolUse } from "../src/guard";
import { loadShipPolicy } from "../src/config";
import { initWorkbench, syncWorkbench, doctorWorkbench } from "../src/cli";
import {
  root,
  ledger,
  feature,
  git,
  cmd,
  rejects,
  verifyFeature,
  remote,
  useReleaseFixture,
  type Feature,
} from "./helpers/release";

useReleaseFixture();
const template = readFileSync(join(import.meta.dir, "../templates/ship-policy.yaml"), "utf8");
const policy = () => join(root, ".workbench/ship-policy.yaml");
beforeEach(() => writeFileSync(policy(), template));
function freeze(f: Feature) {
  const dir = join(root, ".workbench/specs", f.task);
  mkdirSync(dir, { recursive: true });
  for (const file of ["ssot.md", "tech-spec.md", "test-spec.md"]) writeFileSync(join(dir, file), "contract");
  ledger.freezeSpec({ task_id: f.task, locked_test_globs: ["example.test.ts"] });
}
const prep = (f: Feature, to = "pr", paths = "src/**") =>
  cmd("fast-track", "prepare", f.task, "--to", to, "--paths", paths).envelope_id as string;
const hook = (prompt: string, extra = {}) =>
  handleLedgerHook(root, { hook_event_name: "UserPromptSubmit", session_id: "operator", prompt, ...extra })
    .userPromptContext;
const activate = (f: Feature, to = "pr") => {
  const id = prep(f, to);
  expect(hook("快轨批准 " + id)).toContain("ACTIVE");
  return id;
};
function ship(
  id: string,
  action = "evaluate",
  flags: string[] = [],
  sid = "operator",
  ok = true,
  codexSession = "",
) {
  const r = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, "../src/bin/forge-ship.ts"), action, "--envelope", id, ...flags],
    {
      cwd: root,
      env: { ...process.env, FORGE_WORKBENCH_ROOT: root, FORGE_SESSION_ID: sid, CODEX_SESSION_ID: codexSession },
    },
  );
  const out = r.stdout.toString() || r.stderr.toString();
  expect(r.exitCode, out).toBe(ok ? 0 : 1);
  return JSON.parse(out);
}
function commitFile(f: Feature, path: string, content = "export const a=1;") {
  const filename = join(f.wt, path);
  mkdirSync(join(filename, ".."), { recursive: true });
  writeFileSync(filename, content);
  git(f.wt, "add", ".");
  git(f.wt, "commit", "-m", "change");
  f.head = git(f.wt, "rev-parse", "HEAD");
  remote(f.n, { headRefOid: f.head });
}
function gh(f: Feature, firstViewDelayMs = 0) {
  writeFileSync(join(root, "checks"), JSON.stringify([{ name: "CI", bucket: "pass" }]));
  writeFileSync(join(root, "target-" + f.repo), f.base);
  remote(f.n, { baseRefOid: f.base, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" });
  const script = `#!/usr/bin/env bun
const [group, command, selector, endpoint] = process.argv.slice(2);
const root = ${JSON.stringify(root)};
const marker = root + "/first-view";
if (command === "view" && ${firstViewDelayMs} && !await Bun.file(marker).exists()) {
  await Bun.write(marker, "");
  await Bun.sleep(${firstViewDelayMs});
}
if (group === "api") await Bun.write(root + "/api-call", endpoint);
const key = group === "api" ? "target-" + endpoint.split("/")[2] :
  command === "checks" ? "checks" : "pr-" + selector.split("/").pop();
console.log(await Bun.file(root + "/" + key).text());`;
  writeFileSync(join(root, "bin/gh"), script, { mode: 0o755 });
}
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
    expect(migrated.db.query("pragma user_version").get()).toEqual({ user_version: 5 });
    expect(migrated.db.query("pragma foreign_key_check").all()).toEqual([]);
    expect(migrated.verify().ok).toBe(true);
    expect(migrated.db.query("SELECT rowid FROM events_fts WHERE events_fts MATCH 'sentinel'").all()).toHaveLength(
      1,
    );
  } finally {
    migrated.closeDb();
  }
});
test("init installs the policy and runner, sync preserves edits, doctor and tamper guard inspect them", () => {
  const dir = join(root, "kit-test");
  initWorkbench({ targetDir: dir, kitRoot: join(import.meta.dir, ".."), skipReviewAgents: true });
  const p = join(dir, ".workbench/ship-policy.yaml");
  expect(readFileSync(p, "utf8")).toBe(template);
  writeFileSync(p, template.replace("enabled: true", "enabled: false"));
  syncWorkbench({ targetDir: dir });
  expect(loadShipPolicy(dir).policy.enabled).toBe(false);
  expect(existsSync(join(dir, ".workbench/bin/forge-ship"))).toBe(true);
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
test("prepare enforces a frozen scope, endpoint ceiling, policy, relative paths and bounded TTL; only a root human directive activates", () => {
  const f = feature("api", 1);
  const bad = (to: string, paths: string, ...args: string[]) =>
    rejects("fast-track", "prepare", f.task, "--to", to, "--paths", paths, ...args);
  expect(bad("pr", "src/**")).toContain("frozen");
  freeze(f);
  for (const path of ["**", "../src", "/tmp/x", "infra/**", "./infra/**", "src/migrations/**"])
    expect(bad("pr", path)).toMatch(/glob|scope/);
  expect(bad("prod", "src/**")).toContain("ceiling");
  expect(bad("pr", "src/**", "--ttl", "241")).toContain("TTL");
  writeFileSync(policy(), template.replace("max_endpoint: pr", "max_endpoint: fat"));
  expect(bad("pr", "src/**")).toContain("ceiling");
  writeFileSync(policy(), template);
  const id = prep(f);
  for (const message of [
    "不要快轨批准 " + id,
    "快轨批准 " + id + "?",
    '"快轨批准 ' + id + '"',
    "快轨批准 " + id + "\n",
    "approve " + id,
  ])
    hook(message);
  hook("快轨批准 " + id, { agent_id: "worker" });
  expect(cmd("fast-track", "status", id)[0].status).toBe("PENDING");
  expect(rejects("fast-track", "approve", id)).toContain("approval");
  writeFileSync(policy(), template + "\n");
  expect(hook("快轨批准 " + id)).toContain("refused");
  writeFileSync(policy(), template);
  expect(hook("fast-track approve " + id)).toContain("ACTIVE");
  expect(hook("快轨撤销 " + id)).toContain("REVOKED");
  ship(id, "run", [], "operator", false);
  const other = prep(f);
  expect(hook("fast-track revoke " + other)).toContain("REVOKED");
  cmd("amend", f.task, "--scope", "test_spec", "--reason", "new contract");
  expect(bad("pr", "src/**")).toContain("frozen");
}, 30000);
test("session, expiration, policy, frozen-test drift and blockers fail closed", () => {
  const f = feature("api", 1);
  freeze(f);
  for (const sid of ["", "other"]) {
    const id = activate(f);
    expect(ship(id, "evaluate", [], sid, false).status).toBe("DEGRADED");
  }
  let id = activate(f);
  ledger.db.query("UPDATE fast_track_envelopes SET expires_at='2000-01-01T00:00:00Z' WHERE envelope_id=?").run(id);
  expect(ship(id, "evaluate", [], "operator", false).status).toBe("EXPIRED");
  id = activate(f);
  writeFileSync(policy(), template + "\n");
  expect(ship(id, "evaluate", [], "operator", false).reason.message).toContain("Policy");
  writeFileSync(policy(), template);
  id = activate(f);
  const locked = join(f.wt, "example.test.ts"),
    original = readFileSync(locked);
  writeFileSync(locked, "drift");
  expect(ship(id, "evaluate", [], "operator", false).reason.message).toContain("frozen");
  writeFileSync(locked, original);
  id = activate(f);
  expect(ship(id, "evaluate", [], "operator", false).status).toBe("DEGRADED");
  verifyFeature(f);
  id = activate(f);
  cmd("blocker", f.task, "open", "--id", "b", "--summary", "blocked");
  expect(ship(id, "run", [], "operator", false).reason.message).toContain("blocker");
}, 30000);
test("changed files must fit path, rename, SQL, binary and blast radius limits", () => {
  const f = feature("api", 1);
  freeze(f);
  const cases = [
    ["other/x", "x", "scope"],
    ["src/auth/session", "x", "Forbidden"],
    ["src/a.sql", "SELECT 1", "SQL"],
    ["src/b", "a\nb\nc", "cap"],
    ["src/c", "\0binary", "Binary"],
  ];
  writeFileSync(policy(), template.replace("max_lines_changed: 800", "max_lines_changed: 2"));
  for (const [path, content, why] of cases) {
    const id = activate(f);
    commitFile(f, path, content);
    expect(ship(id, "evaluate", [], "operator", false).reason.message).toContain(why);
    git(f.wt, "reset", "--hard", f.base);
  }
  writeFileSync(policy(), template.replace("max_files_changed: 25", "max_files_changed: 1"));
  const id = activate(f);
  commitFile(f, "src/a");
  commitFile(f, "src/b");
  expect(ship(id, "evaluate", [], "operator", false).reason.message).toContain("cap");
  git(f.wt, "reset", "--hard", f.base);
  const renamed = activate(f);
  mkdirSync(join(f.wt, "src"), { recursive: true });
  git(f.wt, "mv", "tracked.sql", "src/safe.ts");
  git(f.wt, "commit", "-m", "rename");
  expect(ship(renamed, "evaluate", [], "operator", false).status).toBe("DEGRADED");
}, 30000);
for (const endpoint of ["pr", "fat", "prod"] as const)
  test(
    "single-use " + endpoint + " fast-track",
    () => {
      const f = feature("api", 1);
      freeze(f);
      commitFile(f, "src/new.ts");
      if (endpoint === "prod") commitFile(f, "src/second.ts");
      gh(f, endpoint === "pr" ? 3500 : 0);
      if (endpoint === "prod")
        writeFileSync(
          policy(),
          template
            .replace("max_endpoint: pr", "max_endpoint: prod")
            .replace("allow_prod: false", "allow_prod: true"),
        );
      if (endpoint === "fat") {
        git(f.dir, "remote", "set-url", "origin", join(root, "api.git"));
        git(f.dir, "push", "origin", f.base + ":refs/heads/fat");
      }
      verifyFeature(f);
      if (endpoint === "prod")
        for (const bucket of ["pending", "fail"]) {
          const bad = activate(f, "prod");
          writeFileSync(join(root, "checks"), JSON.stringify([{ name: "CI", bucket }]));
          expect(ship(bad, "run", [], "operator", false).status).toBe("DEGRADED");
        }
      writeFileSync(join(root, "checks"), JSON.stringify([{ name: "CI", bucket: "pass" }]));
      const id = activate(f, endpoint),
        flags = endpoint === "prod" ? ["--tag", "api:v1"] : [];
      const preview = ship(id, "run", ["--dry-run", ...flags]);
      expect(preview.status).toBe("ELIGIBLE");
      const out = ship(id, "run", flags);
      expect(out.status).toBe("REDEEMED");
      expect(ship(id, "run", flags, "operator", false).status).toBe("REDEEMED");
      if (endpoint === "pr") {
        expect(out.result.trailers[0]).toContain("Verified-Head: " + f.head);
        expect(ledger.getTask(f.task)?.status).toBe("HANDED_OFF");
        expect(cmd("release", "create", "--from-handoffs", "--title", "train").items).toHaveLength(1);
      }
      if (endpoint === "fat") expect(git(join(root, "api.git"), "rev-parse", "fat")).toBe(f.head);
      if (endpoint === "prod") {
        const rb = ledger.getRunbook(out.runbook_id)!;
        expect(rb.status).toBe("APPROVED");
        expect(rb.approved_session_id).toBe("operator");
        expect(JSON.parse(rb.actions_json)).toMatchObject({
          sql_files: [],
          tags: [{ sha: f.head }],
          prs: [{ pin: { head: f.head } }],
        });
        expect(preview.plan.runbook.actions).toEqual(JSON.parse(rb.actions_json));
        const origin = "https://github.com/acme/api.git";
        git(f.dir, "config", "extensions.worktreeConfig", "true");
        git(f.dir, "config", "--unset-all", "remote.origin.url");
        git(f.dir, "config", "--unset-all", "remote.origin.pushurl");
        git(f.dir, "config", "--worktree", "remote.origin.url", "https://github.com/acme/other.git");
        git(f.wt, "config", "--worktree", "remote.origin.url", origin);
        git(f.wt, "tag", "v1", f.head);
        const guard = (command: string) =>
          evaluatePreToolUse(root, {
            hook_event_name: "PreToolUse",
            session_id: "operator",
            cwd: f.wt,
            tool_name: "Bash",
            tool_input: { command },
          });
        const observed = join(root, "api-call");
        rmSync(observed, { force: true });
        expect(guard("git status")).toBeNull();
        expect(existsSync(observed)).toBe(false);
        const push = () => guard("git push origin refs/tags/v1");
        expect(push()).toBeNull();
        expect(readFileSync(observed, "utf8")).toBe("repos/acme/api/branches/main");
        git(f.dir, "commit", "--allow-empty", "-m", "advance production target");
        const advanced = git(f.dir, "rev-parse", "HEAD");
        git(f.dir, "push", join(root, "api.git"), "main");
        writeFileSync(join(root, "target-api"), advanced);
        expect(push()).toBeTruthy();
        writeFileSync(join(root, "target-api"), f.base);
        git(f.wt, "config", "--worktree", "remote.origin.url", "https://github.com/other/api.git");
        expect(push()).toBeTruthy();
        const prior = git(f.dir, "rev-parse", "HEAD^{tree}");
        git(f.dir, "merge", "--no-ff", f.branch, "-m", "release");
        writeFileSync(join(root, "bin/gh"), "#!/bin/sh\necho " + git(f.dir, "rev-parse", "HEAD") + "\n");
        const undo = Bun.spawnSync(["sh", "-c", out.result.rollback[0].command], {
          cwd: f.dir,
          env: { ...process.env, GIT_EDITOR: "true" },
        });
        expect(undo.exitCode, undo.stderr.toString()).toBe(0);
        expect(git(f.dir, "rev-parse", "HEAD^{tree}")).toBe(prior);
      }
      expect(ledger.verify().ok).toBe(true);
    },
    30000,
  );

test("passing executable evidence still needs independent review, and amendment invalidates an approved scope", () => {
  const f = feature("api", 1);
  freeze(f);
  commitFile(f, "src/module.ts");
  const run = Bun.spawnSync(
    [
      process.execPath,
      join(import.meta.dir, "../src/bin/wb-verify.ts"),
      "--task",
      f.task,
      "--cwd",
      f.wt,
      "--kind",
      "test",
      "--",
      process.execPath,
      "test",
    ],
    { cwd: root, env: { ...process.env, FORGE_WORKBENCH_ROOT: root } },
  );
  expect(run.exitCode, run.stderr.toString()).toBe(0);
  writeFileSync(
    policy(),
    template.replace("require_independent_review: true", "require_independent_review: false"),
  );
  const missing = activate(f);
  expect(ship(missing, "run", [], "operator", false).reason.message).toMatch(/review/i);
  const amended = activate(f);
  cmd("amend", f.task, "--scope", "test_spec", "--reason", "new contract");
  expect(ship(amended, "run", [], "operator", false).reason.message).toMatch(/frozen|spec/i);
  const events = ledger
    .getTaskEvents(f.task)
    .filter((e) => e.event_type === "FAST_TRACK_DEGRADED")
    .map((e) => JSON.parse(e.payload_json).envelope_id);
  expect(events).toEqual([missing, amended]);
}, 30000);
test("PR rejects a live target outside the approved base even with stale tracking refs", () => {
  const f = feature("api", 1);
  freeze(f);
  commitFile(f, "src/module.ts");
  gh(f);
  verifyFeature(f);
  remote(f.n, { baseRefOid: git(f.dir, "commit-tree", f.base + "^{tree}", "-m", "unrelated") });
  expect(ship(activate(f), "run", [], "operator", false).reason.message).toContain("base");
}, 30000);
test("partial FAT delivery retains durable per-repository push receipts", () => {
  const a = feature("api", 1),
    b = feature("web", 2);
  ledger.cancelTask({ task_id: b.task, reason: "combine delivery" });
  ledger.attachRepo({ task_id: a.task, repo: b.repo, branch: b.branch, worktree: b.wt, base_sha: b.base });
  freeze(a);
  for (const f of [a, b]) {
    commitFile(f, "src/module.ts");
    git(f.dir, "remote", "set-url", "origin", join(root, f.repo + ".git"));
    git(f.dir, "push", "origin", f.base + ":refs/heads/fat");
    verifyFeature({ ...f, task: a.task });
  }
  writeFileSync(join(root, "web.git/hooks/pre-receive"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const result = ship(activate(a, "fat"), "run", [], "operator", false);
  expect(result.status).toBe("DEGRADED");
  expect(result.delivery).toMatchObject([
    { repo: a.repo, state: "confirmed", old_sha: a.base, new_sha: a.head },
    { repo: b.repo, state: "inspect_remote", old_sha: b.base, new_sha: b.head },
  ]);
  expect(git(join(root, "api.git"), "rev-parse", "fat")).toBe(a.head);
  expect(git(join(root, "web.git"), "rev-parse", "fat")).toBe(b.base);
  expect(ledger.verify().ok).toBe(true);
}, 60000);

for (const pause of ["fetch origin", "push --no-follow-tags"])
  test(
    "FAT revocation before " + pause,
    async () => {
      const f = feature("api", 1);
      freeze(f);
      commitFile(f, "src/module.ts");
      const bare = join(root, "api.git");
      git(f.dir, "remote", "set-url", "origin", bare);
      git(f.dir, "push", "origin", f.base + ":refs/heads/fat");
      verifyFeature(f);
      const id = activate(f, "fat"),
        signal = join(root, "paused"),
        resume = join(root, "resume");
      const realGit = Bun.which("git");
      writeFileSync(
        join(root, "bin/git"),
        '#!/bin/sh\ncase " $* " in *\' ' +
          pause +
          " '*) touch '" +
          signal +
          "'; while [ ! -f '" +
          resume +
          "' ]; do sleep .05; done;; esac\nexec '" +
          realGit +
          '\' "$@"\n',
        { mode: 0o755 },
      );
      const run = Bun.spawn(
        [process.execPath, join(import.meta.dir, "../src/bin/forge-ship.ts"), "run", "--envelope", id],
        {
          cwd: root,
          env: {
            ...process.env,
            FORGE_WORKBENCH_ROOT: root,
            FORGE_SESSION_ID: "operator",
            CODEX_SESSION_ID: "operator",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      try {
        const until = Date.now() + 12000;
        while (!existsSync(signal) && Date.now() < until) await Bun.sleep(50);
        expect(existsSync(signal)).toBe(true);
        expect(ship(id, "run", [], "operator", false).status).toBe("ACTIVE");
        const revocation = hook("fast-track revoke " + id);
        expect(revocation).toContain("REVOKED");
        if (pause.startsWith("push")) {
          expect(revocation).toContain("previously authorized push");
          expect(revocation).toContain(f.head);
        }
      } finally {
        writeFileSync(resume, "");
        await run.exited;
      }
      expect(run.exitCode).toBe(1);
      expect(git(bare, "rev-parse", "fat")).toBe(pause.startsWith("push") ? f.head : f.base);
    },
    30000,
  );

test("root-scoped paths do not match nested manifests and FAT refuses split remotes", () => {
  const f = feature("api", 1);
  freeze(f);
  commitFile(f, "packages/tool/package.json", "{}");
  let id = prep(f, "pr", "./package.json");
  hook("fast-track approve " + id);
  expect(ship(id, "evaluate", [], "operator", false).reason.message).toContain("scope");
  verifyFeature(f);
  id = prep(f, "fat", "packages/**");
  hook("fast-track approve " + id);
  expect(ship(id, "run", [], "operator", false).reason.message).toContain("push URL");
}, 30000);
for (const endpoint of ["pr", "fat"])
  test(
    "checks actual " + endpoint + " diff when target contains intermediate forbidden change",
    () => {
      const f = feature("api", 1);
      freeze(f);
      commitFile(f, "src/auth/intermediate.ts");
      const target = f.head;
      git(f.wt, "revert", "--no-edit", target);
      commitFile(f, "src/shipping.ts");
      verifyFeature(f);
      if (endpoint === "fat") {
        git(f.dir, "remote", "set-url", "origin", join(root, "api.git"));
        git(f.dir, "push", "origin", target + ":refs/heads/fat");
      } else {
        gh(f);
        remote(f.n, { baseRefOid: target });
      }
      const id = activate(f, endpoint);
      expect(ship(id, "run", [], "operator", false).reason.message).toContain("Forbidden");
    },
    30000,
  );

test("a sibling's passing result at the same commit cannot clear a local executable failure", () => {
  const f = feature("api", 1);
  commitFile(f, "src/module.ts");
  const sibling = join(root, "api.worktrees", "sibling"),
    branch = "feature/sibling";
  git(f.dir, "worktree", "add", "-b", branch, sibling, f.head);
  ledger.attachRepo({
    task_id: f.task,
    repo: f.repo,
    branch,
    worktree: sibling,
    base_sha: f.base,
    head_sha: f.head,
  });
  freeze(f);
  verifyFeature(f);
  verifyFeature({ ...f, branch, wt: sibling });
  for (const [which, kind, status] of [
    [f.branch, "lint", "pass"],
    [f.branch, "test", "fail"],
    [branch, "test", "pass"],
  ]) {
    appendEventInTx(ledger.db, {
      task_id: f.task,
      event_type: "EVIDENCE_CAPTURED",
      actor: "tool",
      repo: f.repo,
      branch: which,
      sha: f.head,
      payload: { source: "tool", kind, status },
    });
  }
  expect(ship(activate(f), "evaluate", [], "operator", false).reason.message).toMatch(/verification|test/i);
  const floor = ledger.getSpecState(f.task).evidence_floor_seq.review;
  for (const [which, kind, status] of [
    [f.branch, "test", "pass"],
    [f.branch, "review", "fail"],
    [branch, "review", "pass"],
  ]) {
    appendEventInTx(ledger.db, {
      task_id: f.task,
      event_type: "EVIDENCE_CAPTURED",
      actor: "tool",
      repo: f.repo,
      branch: which,
      sha: f.head,
      payload: {
        source: "tool",
        kind,
        status,
        meta: { role: "business-review", base: f.base, review_task_id: f.task, review_floor_seq: floor },
      },
    });
  }
  expect(ship(activate(f), "evaluate", [], "operator", false).reason.message).toMatch(/review/i);
}, 30000);

for (const endpoint of ["pr", "prod"])
  test(
    "prospective " + endpoint + " merge resolves target-side renames before authorizing",
    () => {
      const f = feature("api", 1);
      const p = join(f.dir, "src");
      mkdirSync(p, { recursive: true });
      writeFileSync(join(p, "session.ts"), "original content\\n");
      git(f.dir, "add", ".");
      git(f.dir, "commit", "-m", "seed");
      git(f.dir, "push", "origin", "main");
      const seeded = feature("api", 3);
      freeze(seeded);
      commitFile(seeded, "src/session.ts", "feature change");
      gh(seeded);
      mkdirSync(join(f.dir, "auth"));
      git(f.dir, "mv", "src/session.ts", "auth/session.ts");
      git(f.dir, "commit", "-m", "move session");
      git(f.dir, "push", "origin", "main");
      remote(seeded.n, { baseRefOid: git(f.dir, "rev-parse", "HEAD") });
      verifyFeature(seeded);
      if (endpoint === "prod")
        writeFileSync(
          policy(),
          template
            .replace("max_endpoint: pr", "max_endpoint: prod")
            .replace("allow_prod: false", "allow_prod: true"),
        );
      expect(ship(activate(seeded, endpoint), "run", [], "operator", false).reason.message).toMatch(/Forbidden/);
    },
    30000,
  );

test("FAT selects the approved feature worktree transport when primary origin differs", () => {
  const f = feature("api", 1);
  freeze(f);
  commitFile(f, "src/module.ts");
  verifyFeature(f);
  const approved = join(root, "api.git"),
    other = join(root, "mirror.git");
  git(f.dir, "push", "origin", f.base + ":refs/heads/fat");
  git(root, "clone", "--bare", approved, other);
  git(f.dir, "config", "extensions.worktreeConfig", "true");
  git(f.dir, "remote", "set-url", "origin", other);
  git(f.dir, "remote", "set-url", "--push", "origin", other);
  // Replace the common URLs with independent, worktree-local origins.
  git(f.dir, "config", "--unset-all", "remote.origin.url");
  git(f.dir, "config", "--unset-all", "remote.origin.pushurl");
  for (const [dir, dest] of [
    [f.dir, other],
    [f.wt, approved],
  ])
    git(dir, "config", "--worktree", "remote.origin.url", dest);
  expect(ship(activate(f, "fat"), "run").status).toBe("REDEEMED");
  expect(git(approved, "rev-parse", "fat")).toBe(f.head);
  expect(git(other, "rev-parse", "fat")).toBe(f.base);
}, 30000);
test("merged production PR previews its receipt and rejects a tag behind the target", () => {
  const f = feature("api", 1);
  freeze(f);
  commitFile(f, "src/module.ts");
  verifyFeature(f);
  gh(f);
  git(f.dir, "merge", "--no-ff", f.branch, "-m", "release");
  git(f.dir, "push", "origin", "main");
  const sha = git(f.dir, "rev-parse", "HEAD");
  writeFileSync(join(root, "target-api"), sha);
  remote(f.n, { state: "MERGED", baseRefOid: sha, mergeCommit: { oid: sha } });
  writeFileSync(
    policy(),
    template.replace("max_endpoint: pr", "max_endpoint: prod").replace("allow_prod: false", "allow_prod: true"),
  );
  expect(ship(activate(f, "prod"), "run", ["--tag", "api:v1"], "operator", false).reason.message).toContain(
    "live target",
  );
  const id = activate(f, "prod"),
    plan = ship(id, "run", ["--dry-run"]).plan;
  expect(plan.steps).toEqual([["create-approved-runbook", id]]);
  expect(plan.runbook.actions.prs[0].pin.merged_oid).toBe(sha);
  expect(plan.runbook.actions.tags).toEqual([]);
  expect(JSON.parse(ship(id, "run").result.runbook.actions_json)).toEqual(plan.runbook.actions);
}, 30000);
test("two production PRs targeting the same branch require separate approvals", () => {
  const a = feature("api", 1),
    b = feature("api", 2);
  ledger.cancelTask({ task_id: b.task, reason: "combined delivery" });
  ledger.attachRepo({ task_id: a.task, repo: b.repo, branch: b.branch, worktree: b.wt, base_sha: b.base });
  freeze(a);
  for (const f of [a, b]) {
    commitFile(f, "src/module" + f.n + ".ts");
    verifyFeature({ ...f, task: a.task });
    gh(f);
  }
  writeFileSync(
    policy(),
    template.replace("max_endpoint: pr", "max_endpoint: prod").replace("allow_prod: false", "allow_prod: true"),
  );
  const id = activate(a, "prod");
  expect(ship(id, "run", [], "operator", false).reason.message).toContain("share a target");
  expect(ledger.db.query("SELECT count(*) AS n FROM runbooks").get()).toEqual({ n: 0 });
}, 30000);

test("pending evaluation and delivery preserve the approval and conflicting sessions reject active envelopes", () => {
  const f = feature("api", 1);
  freeze(f);
  commitFile(f, "src/a.ts");
  gh(f);
  verifyFeature(f);
  const id = prep(f);
  for (const action of ["evaluate", "run"]) expect(ship(id, action, [], "operator", false).status).toBe("PENDING");
  expect(ledger.getTaskEvents(f.task).some((e) => e.event_type === "FAST_TRACK_DEGRADED")).toBe(false);
  expect(hook("fast-track approve " + id)).toContain("ACTIVE");
  expect(ship(id, "evaluate", [], "operator", true, "operator").status).toBe("ELIGIBLE");
  for (const action of ["evaluate", "run"]) {
    const rejected = ship(
      action === "evaluate" ? id : activate(f),
      action,
      [],
      "operator",
      false,
      action === "evaluate" ? "different" : "operator ",
    );
    expect(rejected.status).toBe("DEGRADED");
    expect(rejected.reason.message).toContain("Conflicting");
  }
}, 30000);
test("production cannot disable required green CI", () => {
  const f = feature("api", 1);
  freeze(f);
  const prod = template
    .replace("allow_prod: false", "allow_prod: true")
    .replace("max_endpoint: pr", "max_endpoint: prod");
  writeFileSync(policy(), prod);
  const id = activate(f, "prod");
  writeFileSync(policy(), prod.replace("require_ci_green_for_prod: true", "require_ci_green_for_prod: false"));
  expect(() => loadShipPolicy(root)).toThrow(/green CI/);
  expect(rejects("fast-track", "prepare", f.task, "--to", "prod", "--paths", "src/**")).toContain("green CI");
  expect(ship(id, "run", [], "operator", false).reason.message).toContain("green CI");
});
test("prepare rejects a stored parent repository identity", () => {
  const f = feature("api", 1);
  freeze(f);
  ledger.db.query("UPDATE task_repos SET repo='..' WHERE task_id=?").run(f.task);
  expect(rejects("fast-track", "prepare", f.task, "--to", "pr", "--paths", "src/**")).toContain(
    "Invalid attached repository",
  );
});
test("a new in-scope file may match the bytes of an unchanged out-of-scope source", () => {
  const f = feature("api", 1);
  freeze(f);
  commitFile(f, "src/copied.ts", readFileSync(join(f.wt, "tracked.sql"), "utf8"));
  gh(f);
  verifyFeature(f);
  expect(ship(activate(f)).status).toBe("ELIGIBLE");
}, 30000);
test("gitlinks are rejected on either side of a diff", () => {
  const f = feature("api", 1);
  const lib = join(f.wt, "src/lib");
  git(f.wt, "clone", f.dir, lib);
  git(lib, "checkout", "--detach", f.base);
  git(f.wt, "update-index", "--add", "--cacheinfo", "160000," + f.base + ",src/lib");
  git(f.wt, "commit", "-m", "link");
  freeze(f);
  expect(ship(activate(f), "evaluate", [], "operator", false).reason.message).toMatch(/Submodule/);
  git(f.dir, "merge", "--ff-only", f.branch);
  git(f.dir, "push", "origin", "main");
  const g = feature("api", 3);
  git(g.wt, "rm", "--cached", "src/lib");
  git(g.wt, "commit", "-m", "unlink");
  freeze(g);
  expect(ship(activate(g), "evaluate", [], "operator", false).reason.message).toMatch(/Submodule/);
}, 30000);
test("a production tag cannot omit an independent commit on its live target", () => {
  const f = feature("api", 1);
  freeze(f);
  commitFile(f, "src/tag.ts");
  verifyFeature(f);
  gh(f);
  writeFileSync(join(f.dir, "newer.txt"), "new target content");
  git(f.dir, "add", ".");
  git(f.dir, "commit", "-m", "new main");
  git(f.dir, "push", "origin", "main");
  const target = git(f.dir, "rev-parse", "HEAD");
  remote(f.n, { baseRefOid: target });
  writeFileSync(join(root, "target-api"), target);
  writeFileSync(
    policy(),
    template.replace("max_endpoint: pr", "max_endpoint: prod").replace("allow_prod: false", "allow_prod: true"),
  );
  const id = activate(f, "prod");
  expect(ship(id).status).toBe("ELIGIBLE");
  const rejected = ship(id, "run", ["--tag", "api:v1"], "operator", false);
  expect(rejected.status).toBe("DEGRADED");
  expect(rejected.reason.message).toContain("live target");
  expect(ledger.db.query("SELECT count(*) AS n FROM runbooks").get()).toEqual({ n: 0 });
}, 30000);

test("renames check both source and destination against forbidden paths", () => {
  const seed = feature("api", 1);
  mkdirSync(join(seed.dir, "src/auth"), { recursive: true });
  writeFileSync(join(seed.dir, "src/auth/private.ts"), "private");
  writeFileSync(join(seed.dir, "src/public.ts"), "public");
  git(seed.dir, "add", "src");
  git(seed.dir, "commit", "-m", "seed rename sources");
  const f = feature("api", 3);
  freeze(f);
  for (const [from, to] of [
    ["src/auth/private.ts", "src/moved.ts"],
    ["src/public.ts", "src/auth/moved.ts"],
  ]) {
    const id = activate(f);
    git(f.wt, "mv", from, to);
    git(f.wt, "commit", "-m", "move");
    expect(ship(id, "evaluate", [], "operator", false).reason.message).toContain("Forbidden");
    git(f.wt, "reset", "--hard", f.base);
  }
}, 30000);

test("an in-scope 401-line rename counts only edited lines", () => {
  const seed = feature("api", 1);
  const original = Array.from({ length: 401 }, (_, i) => "line " + i + "\n").join("");
  mkdirSync(join(seed.dir, "src"));
  writeFileSync(join(seed.dir, "src/old.ts"), original);
  git(seed.dir, "add", "src");
  git(seed.dir, "commit", "-m", "seed large file");
  git(seed.dir, "push", "origin", "main");
  const f = feature("api", 3);
  freeze(f);
  const to = "src/new\tname.ts";
  git(f.wt, "mv", "src/old.ts", to);
  for (const [expected, content] of [
    [0, original],
    [2, original.replace("line 200\n", "edited\n")],
  ] as const) {
    commitFile(f, to, content);
    gh(f);
    verifyFeature(f);
    expect(ship(activate(f)).plan.changed_lines).toBe(expected);
  }
}, 30000);
