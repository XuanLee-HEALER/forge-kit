import { mergePinnedFat } from "../src/conditional-merge";
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
import { root, ledger, feature, git, remote, verifyFeature, useReleaseFixture } from "./helpers/release";

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
  expect(() => ledger.completeRunbook(rb.runbook_id)).toThrow("forge ship run --envelope " + id);
  expect(() => fastTrackCommand(ledger, ["revoke", id])).toThrow(`approving root session: send the entire message "快轨撤销 ${id}"`);
  expect(human("快轨撤销 " + id, {agent_id:"worker"})).toBeUndefined();
  expect(human("快轨撤销 " + id, { session_id: "different-session" })).toContain("refused");
  expect(ledger.getRunbook(rb.runbook_id)?.status).toBe("APPROVED");
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
    const policy = { ...loadShipPolicy(root).policy, forbid_db_rw: true, max_lines_changed: 2 };
    const paths = path.endsWith("package.json") ? ["./package.json"] : ["src/**"];
    expect(() => deliveryDiff(policy, paths)(f.repo, f.wt, f.base, head)).toThrow(why);
  });
}
test("rename checks source and destination; gitlinks are outside file budget", () => {
  const f = feature("api", 1),
    policy = loadShipPolicy(root).policy;
  mkdirSync(join(f.wt, "src"), { recursive: true });
  git(f.wt, "mv", "tracked.sql", "src/renamed.ts");
  git(f.wt, "commit", "-m", "rename");
  expect(() =>
    diffScope(f.wt, { repo: f.repo, base_sha: f.base }, "HEAD", true, ["src/**"], policy, new Set()),
  ).toThrow();
  git(f.wt, "update-index", "--add", "--cacheinfo", "160000", f.base, "src/nested");
  git(f.wt, "commit", "-m", "gitlink");
  expect(() => deliveryDiff(policy, ["src/**"])(f.repo, f.wt, "HEAD^", "HEAD")).toThrow("Submodule");
});

test("conditional Git merge protects the advertised base and preserves divergent history", () => {
  const f = feature("api", 1),
    bare = join(root, "api.git");
  const url = git(f.dir, "remote", "get-url", "origin");
  git(f.dir, "remote", "set-url", "--push", "origin", url);
  git(f.wt, "commit", "--allow-empty", "-m", "next change");
  const head = git(f.wt, "rev-parse", "HEAD");
  // Both the intervening commit and the authorized head fast-forward the
  // target. Ordinary non-forced Git push alone would accept the stale plan.
  git(f.wt, "push", bare, f.head + ":refs/heads/intermediate");
  git(bare, "update-ref", "refs/heads/fat", f.base);
  const binary = Bun.which("git")!;
  writeFileSync(
    join(root, "bin/git"),
    `#!/usr/bin/env bun
const args=process.argv.slice(2);
if(args.includes("push")) {
  const index=args.indexOf(${JSON.stringify(url)});
  if(index>=0) args[index]=${JSON.stringify(bare)};
}
const result=Bun.spawnSync([${JSON.stringify(binary)},...args],{stdin:"inherit",stdout:"inherit",stderr:"inherit"});process.exit(result.exitCode);
`,
    { mode: 0o755 },
  );
  expect(() =>
    mergePinnedFat(
      f.wt,
      f.base,
      head,
      () => {},
      () => {
        git(bare, "update-ref", "refs/heads/fat", f.head, f.base);
      },
    ),
  ).toThrow("Conditional FAT update refused");
  expect(git(bare, "rev-parse", "fat")).toBe(f.head);
  git(f.dir, "commit", "--allow-empty", "-m", "independent main change");
  const diverged = git(f.dir, "rev-parse", "main");
  git(f.dir, "push", bare, diverged + ":refs/heads/staging");
  git(bare, "update-ref", "refs/heads/fat", diverged, f.head);
  const target = mergePinnedFat(
    f.wt,
    diverged,
    head,
    () => {},
    () => {},
  );
  expect(git(bare, "rev-parse", "fat")).toBe(target);
  expect(git(bare, "show", "-s", "--format=%P", target)).toBe(diverged + " " + head);
  expect(git(f.wt, "rev-parse", "HEAD")).toBe(head);
}, 30_000);

test("runbook manifest positions the merge at the declared ship slot and retains its instance override", () => {
  const { f } = exactFixture();
  const config = join(root, ".workbench/workbench.yaml");
  const base = readFileSync(config, "utf8");
  function order(override: boolean) {
    writeFileSync(
      config,
      base +
        `
extensions:
  delivery: {endpoint: rollout, stages: [precheck, ship, postcheck]}
  stages:
    precheck: {action: inspect, observe: readback}
    postcheck: {action: inspect, observe: readback}
    ${override ? "ship: {action: inspect, observe: readback}" : ""}
  actions:
    inspect: {argv: ["bun", "-e", "console.log('test')"], cwd: ".", purpose: deliver, inputs: []}
    readback: {argv: ["bun", "-e", "console.log(1)"], purpose: observe, inputs: []}
`,
    );
    const stages = override ? ["precheck", "ship", "postcheck"] : ["precheck", "postcheck"];
    const rb = ledger.createRunbook({
      task_id: f.task,
      title: "Ordered rollout",
      actions: { prs: [{ repo: f.repo, number: f.n }] },
      exact_stages: stages,
    });
    const plan = JSON.parse(rb.actions_json).exact;
    expect(plan.endpoint).toBe("rollout");
    return plan.actions.map((action: { kind: string; stage?: string }) => action.stage ?? action.kind);
  }
  expect(order(false)).toEqual(["precheck", "pr", "postcheck"]);
  expect(order(true)).toEqual(["precheck", "ship", "pr", "postcheck"]);
}, 30_000);

for (const outcome of ["success", "drift", "legacy-reviewed", "legacy-no-review", "legacy-stale-review", "legacy-policy-off"]) {
  test(
    "FAT-only conditional delivery to a local bare remote: " + outcome,
    () => {
      initWorkbench({ targetDir: root, kitRoot: join(import.meta.dir, "..") });
      const f = feature("api", 1, outcome.startsWith("legacy") ? "0.4" : "0.5"),
        bare = join(root, "api.git");
      const missingReview = outcome === "legacy-no-review" || outcome === "legacy-stale-review";
      if (outcome === "legacy-policy-off") {
        writeFileSync(policy(), template.replace("require_independent_review: true", "require_independent_review: false"));
      }
      git(f.dir, "remote", "set-url", "origin", bare);
      git(f.dir, "push", "origin", f.base + ":refs/heads/fat");
      writeFileSync(
        join(root, ".workbench/workbench.yaml"),
        "name: fixture\nrepos: [api]\nextensions:\n  delivery: {endpoint: fat, stages: [ship]}\n",
      );
      ledger.updateEndpoint({ task_id: f.task, endpoint: "fat", reason: "Isolated test branch only" });
      if (outcome.startsWith("legacy")) {
        const spec = join(root, ".workbench/specs", f.task);
        mkdirSync(spec, {recursive: true});
        for (const file of ["ssot.md", "tech-spec.md", "test-spec.md"]) {
          writeFileSync(join(spec, file), "Deliver the feature commit only to the FAT ref.");
        }
      }
      if (outcome === "legacy-stale-review") {
        verifyFeature(f);
        ledger.amendSpec({ task_id: f.task, scope: "requirement", reason: "Operator changed the approved scope" });
      }
      verifyFeature(f, { review: !missingReview && outcome !== "legacy-policy-off" });
      const rb = ledger.createRunbook({
        task_id: f.task,
        title: "Update the exact test branch",
        actions: {},
        exact_stages: [],
        exact_fat: ["api:fat"],
      });
      const { envelope_id: id } = fastTrackCommand(ledger, [
        "prepare",
        f.task,
        "--runbook",
        rb.runbook_id,
        "--to",
        "fat",
        "--paths",
        "src/**",
      ]) as { envelope_id: string };
      expect(human("快轨批准 " + id)).toContain("ACTIVE");
      let expected = missingReview ? f.base : f.head;
      if (outcome === "drift") {
        git(f.dir, "commit", "--allow-empty", "-m", "external target change");
        expected = git(f.dir, "rev-parse", "HEAD");
        git(f.dir, "push", "origin", expected + ":refs/heads/fat");
      }
      const trace = join(root, "ship-git.trace");
      const cli = () =>
        Bun.spawnSync(
          [process.execPath, join(import.meta.dir, "../src/bin/cli.ts"), "ship", "run", "--envelope", id],
          {
            cwd: root,
            env: {
              ...process.env,
              GIT_TRACE: trace,
              FORGE_WORKBENCH_ROOT: root,
              FORGE_SESSION_ID: "test-session",
              CODEX_SESSION_ID: "test-session",
            },
          },
        );
      const result = cli(),
        json = JSON.parse(result.stdout.toString());
      expect(json.ok, result.stderr.toString() + result.stdout.toString()).toBe(outcome !== "drift" && !missingReview);
      expect(git(bare, "rev-parse", "main")).toBe(f.base);
      expect(git(bare, "rev-parse", "fat")).toBe(expected);
      const remoteCall = /built-in: git (?:ls-remote|fetch|push) /;
      const calls = readFileSync(trace, "utf8");
      if (missingReview) {
        expect(calls).not.toMatch(remoteCall);
        expect(json.reason.message).toContain("independent review");
        expect(json.receipts).toHaveLength(0);
      } else if (outcome !== "drift") {
        expect(calls).toMatch(remoteCall);
        expect(json.receipts).toHaveLength(1);
        expect(JSON.parse(cli().stdout.toString()).receipts).toEqual(json.receipts);
        const receipts = ledger
          .getTaskEvents(f.task)
          .map((e) => JSON.parse(e.payload_json))
          .filter((p) => p.meta?.envelope_id === id);
        expect(receipts.map((p) => p.kind)).toEqual(["fat"]);
        expect(receipts[0].meta).toMatchObject({
          ref: "refs/heads/fat",
          old_sha: f.base,
          new_sha: f.head,
          delivery_endpoint: "fat",
        });
      } else {
        expect(json.receipts).toHaveLength(0);
        expect(json.reason.message).toContain("FAT target changed");
      }
    },
    60_000,
  );
}

test("prune previews and removes ordinary closed tasks while retaining exact authorizations and audit history", () => {
  const { f, prep } = exactFixture();
  const { envelope_id } = prep();
  const ordinary = "prune-ordinary";
  ledger.openTask({ task_id: ordinary, title: "old work", depth: "targeted", endpoint: "local" });
  for (const id of [ordinary, f.task]) ledger.cancelTask({ task_id: id, reason: "completed fixture" });
  ledger.db
    .query("UPDATE tasks SET closed_at=? WHERE task_id IN (?,?)")
    .run("2000-01-01T00:00:00.000Z", ordinary, f.task);
  const before = ledger.getTaskEvents(f.task);
  for (const apply of [false, true]) {
    const result = ledger.prune({ beforeDays: 90, apply });
    expect(result.candidates).toEqual([ordinary]);
    expect(result.deleted).toEqual(apply ? [ordinary] : []);
  }
  expect(ledger.getTaskEvents(f.task)).toEqual(before);
  expect(
    ledger.db.query("SELECT envelope_id FROM exact_ship_envelopes WHERE envelope_id=?").get(envelope_id),
  ).toEqual({ envelope_id });
  expect(ledger.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
}, 30_000);
