import { pushFastForward } from "../src/conditional-merge";
import { canonicalJson, sha256String } from "../src/ledger/types";
import { diffScope } from "../src/ship-diff";
import { fastTrackCommand, envelope, validateScope } from "../src/ledger/fast-track";
import { beforeEach, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { Ledger } from "../src/ledger";
import { appendEventInTx } from "../src/ledger/transactions";
import { handleLedgerHook } from "../src/ledger-hook";
import { evaluatePreToolUse } from "../src/guard";
import { loadShipPolicy, loadWorkbenchConfig } from "../src/config";
import { initWorkbench, syncWorkbench, doctorWorkbench } from "../src/cli";
import { root, ledger, feature, git, remote, verifyFeature, useReleaseFixture, cmd, rejects } from "./helpers/release";

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
  expect(loadShipPolicy(dir).policy.forbid_db_rw).toBe(true);
  for (const command of [
    "mkdir -p .workbench/specs/archive",
    "echo archive > .workbench/specs/archive.md",
    "echo archive >> .workbench/specs/archive.md",
  ]) {
    expect(evaluatePreToolUse(dir,{hook_event_name:"PreToolUse",cwd:dir,tool_name:"Bash",tool_input:{command}})).toBeNull();
    const r=Bun.spawnSync(["sh","-c",command],{cwd:dir});
    expect(r.exitCode).toBe(0);
  }
  expect(readFileSync(join(dir,".workbench/specs/archive.md"),"utf8")).toBe("archive\narchive\n");
  const mention = "echo 'See .workbench/ship-policy.yaml for the archive policy' >> .workbench/specs/archive.md";
  expect(evaluatePreToolUse(dir,{hook_event_name:"PreToolUse",cwd:dir,tool_name:"Bash",tool_input:{command:mention}})).toBeNull();
  expect(Bun.spawnSync(["sh","-c",mention],{cwd:dir}).exitCode).toBe(0);
  expect(readFileSync(join(dir,".workbench/specs/archive.md"),"utf8")).toContain("See .workbench/ship-policy.yaml");
  expect(readFileSync(p,"utf8")).toBe(template);

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
    const check = () => diffScope(f.wt, {repo:f.repo,base_sha:f.base}, head, true, paths, policy, new Set());
    if (why === "cap") expect(check()).toBeGreaterThan(policy.max_lines_changed);
    else expect(check).toThrow(why);
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
  expect(() => diffScope(f.wt, {repo:f.repo, base_sha:"HEAD^"}, "HEAD", true, ["src/**"], policy, new Set())).toThrow("Submodule");
});

test("exact fast-forward rejects a concurrent old-value change and a divergent target", () => {
  const f = feature("api", 1), bare = join(root, "api.git");
  git(f.dir, "remote", "set-url", "origin", bare);
  git(f.wt, "push", bare, f.head + ":refs/heads/feature-fixture");
  git(f.wt, "commit", "--allow-empty", "-m", "second feature change");
  const head = git(f.wt, "rev-parse", "HEAD");
  const action = {kind:"push" as const, repo:f.repo,remote:"origin" as const,ref:"refs/heads/main",
    baseOid:f.base,head,originHash:sha256String(canonicalJson([bare,bare]))};
  expect(() => pushFastForward(f.wt, action, () => git(bare,"update-ref",action.ref,f.head,f.base))).toThrow();
  expect(git(bare, "rev-parse", "main")).toBe(f.head);
  git(f.dir, "commit", "--allow-empty", "-m", "independent main change");
  const divergent = git(f.dir, "rev-parse", "HEAD");
  git(f.dir, "push", bare, divergent + ":refs/heads/other");
  git(bare,"update-ref",action.ref,divergent,f.head);
  expect(() => pushFastForward(f.wt, {...action,baseOid:divergent}, () => {})).toThrow();
  expect(git(bare, "rev-parse", "main")).toBe(divergent);
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

for (const outcome of ["success", "drift", "legacy-native-review", "legacy-tool-review", "legacy-no-review", "legacy-stale-review", "legacy-policy-off"] as const) {
  test(
    "protected fast-forward delivery to a local bare remote: " + outcome,
    () => {
      initWorkbench({ targetDir: root, kitRoot: join(import.meta.dir, "..") });
      const f = feature("api", 1, outcome.startsWith("legacy") ? "0.4" : "0.5"),
        bare = join(root, "api.git");
      const missingReview = ["legacy-tool-review", "legacy-no-review", "legacy-stale-review", "legacy-policy-off"].includes(outcome);
      if (outcome === "legacy-policy-off") {
        writeFileSync(policy(), template.replace("require_independent_review: true", "require_independent_review: false"));
      }
      git(f.dir, "remote", "set-url", "origin", bare);
      git(f.dir, "push", "origin", f.base + ":refs/heads/release");
      writeFileSync(
        join(root, ".workbench/workbench.yaml"),
        "name: fixture\nrepos: [api]\nguard: {protected_branches: [release], allow_protected_ff: [release]}\nextensions:\n  delivery: {endpoint: push, stages: [ship]}\n",
      );
      ledger.updateEndpoint({ task_id: f.task, endpoint: "push", reason: "Isolated test branch only" });
      if (outcome.startsWith("legacy")) {
        const spec = join(root, ".workbench/specs", f.task);
        mkdirSync(spec, {recursive: true});
        for (const file of ["ssot.md", "tech-spec.md", "test-spec.md"]) {
          writeFileSync(join(spec, file), "Deliver the feature commit only to the release branch.");
        }
      }
      if (outcome === "legacy-stale-review") {
        verifyFeature(f);
        ledger.amendSpec({ task_id: f.task, scope: "requirement", reason: "Operator changed the approved scope" });
      }
      verifyFeature(f, { review: outcome === "legacy-tool-review" ? "historical" : !missingReview });
      const rb = ledger.createRunbook({
        task_id: f.task,
        title: "Update the exact test branch",
        actions: {},
        exact_stages: [],
        exact_push: ["api:release"],
      });
      const { envelope_id: id } = fastTrackCommand(ledger, [
        "prepare",
        f.task,
        "--runbook",
        rb.runbook_id,
        "--to",
        "push",
        "--paths",
        "src/**",
      ]) as { envelope_id: string };
      expect(human("快轨批准 " + id)).toContain("ACTIVE");
      let expected = missingReview ? f.base : f.head;
      if (outcome === "drift") {
        git(f.dir, "commit", "--allow-empty", "-m", "external target change");
        expected = git(f.dir, "rev-parse", "HEAD");
        git(f.dir, "push", "origin", expected + ":refs/heads/release");
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
      expect(git(bare, "rev-parse", "release")).toBe(expected);
      const remoteCall = /built-in: git (?:ls-remote|fetch|push) /;
      const calls = readFileSync(trace, "utf8");
      if (missingReview) {
        expect(calls).not.toMatch(remoteCall);
        expect(json.reason.message).toMatch(/independent review/i);
        expect(json.receipts).toHaveLength(0);
      } else if (outcome !== "drift") {
        expect(calls).toMatch(remoteCall);
        expect(json.receipts).toHaveLength(1);
        expect(JSON.parse(cli().stdout.toString()).receipts).toEqual(json.receipts);
        const receipts = ledger
          .getTaskEvents(f.task)
          .map((e) => JSON.parse(e.payload_json))
          .filter((p) => p.meta?.envelope_id === id);
        expect(receipts).toHaveLength(1);
        expect(receipts[0].meta).toMatchObject({
          ref: "refs/heads/release",
          old_sha: f.base,
          new_sha: f.head,
          delivery_endpoint: "push",
        });
      } else {
        expect(json.receipts).toHaveLength(0);
        expect(json.reason.message).toMatch(/changed|drift|mismatch/i);
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

test("single-user instance may explicitly empty the protected-branch list", () => {
  initWorkbench({targetDir:root,kitRoot:join(import.meta.dir,"..")});
  writeFileSync(join(root,".workbench/workbench.yaml"),"name: single\nrepos: []\nguard: {protected_branches: []}\n");
  syncWorkbench({targetDir:root});
  expect(doctorWorkbench(root).ok).toBe(true);
  expect(loadWorkbenchConfig(root).guard.protected_branches).toEqual([]);
});

test("pre-code approval covers B..C when remote main is A and only additive test locks preserve it", () => {
  initWorkbench({targetDir:root,kitRoot:join(import.meta.dir,"..")});
  const earlier=feature("api",1);
  // A..B contains a historical change outside the new task's approved path.
  const a=earlier.base, b=earlier.head;
  expect(git(join(root,"api.git"),"rev-parse","main")).toBe(a);
  git(earlier.wt,"switch","-c","next-task");
  const task="next-task";
  const scope=join(root,".workbench/specs",task);
  mkdirSync(scope,{recursive:true});
  writeFileSync(join(scope,"scope.md"),"Review the change to src/next.ts.\n");
  cmd("open","--id",task,"--title","new scope","--repo","api","--branch","next-task","--worktree",earlier.wt,
    "--base",b,"--head",b,"--endpoint","pr","--depth","targeted");
  cmd("freeze",task,"--lock-tests","example.test.ts");
  const id=cmd("fast-track","prepare",task,"--to","pr","--paths","src/next.ts").envelope_id;
  expect(human("快轨批准 "+id)).toContain("ACTIVE");
  writeFileSync(join(earlier.wt,"src/next.ts"),"export const next = 3;\n");
  git(earlier.wt,"add","--","src/next.ts");
  git(earlier.wt,"commit","-qm","new task","--","src/next.ts");
  const c=git(earlier.wt,"rev-parse","HEAD");
  const target={...earlier,task,branch:"next-task",base:b,head:c};
  verifyFeature(target);
  const locks=["example.test.ts","value.js"];
  cmd("freeze",task,...locks.flatMap(path=>["--lock-tests",path]));
  const policy=validateScope(ledger,envelope(ledger,id));
  const paths=new Set<string>();
  expect(diffScope(target.wt,{repo:"api",base_sha:b},c,true,["src/next.ts"],policy,paths)).toBe(1);
  expect(paths.size).toBe(1);
  expect(()=>diffScope(target.wt,{repo:"api",base_sha:a},c,true,["src/next.ts"],policy,new Set())).toThrow(/scope/i);
  expect(git(join(root,"api.git"),"rev-parse","main")).toBe(a);
  const missing=ledger.checkPushReadiness({task_id:task,repo:"api",branch:"next-task",head_sha:c});
  expect(missing.ready).toBe(false);
  verifyFeature(target,{review:false});
  const staleReview=ledger.checkPushReadiness({task_id:task,repo:"api",branch:"next-task",head_sha:c});
  expect(staleReview.ready).toBe(false);
  expect(staleReview.missing.join(" ")).toMatch(/review/i);
  verifyFeature(target);
  expect(ledger.checkPushReadiness({task_id:task,repo:"api",branch:"next-task",head_sha:c}).ready).toBe(true);
  expect(()=>validateScope(ledger,envelope(ledger,id))).not.toThrow();
  cmd("amend",task,"--scope","test_spec","--reason","operator revises the test locks");
  cmd("freeze",task,"--lock-tests","value.js");
  expect(()=>validateScope(ledger,envelope(ledger,id))).toThrow();
},60_000);

test("an approved push node performs a fast-forward without a second branch allow-list",()=>{
  initWorkbench({targetDir:root,kitRoot:join(import.meta.dir,"..")});
  const f=feature("api",1),bare=join(root,"api.git");
  git(f.dir,"remote","set-url","origin",bare);
  writeFileSync(join(root,".workbench/workbench.yaml"),"name: fixture\nrepos: [api]\nguard: {protected_branches: [main], allow_protected_ff: [other]}\nextensions: {delivery: {endpoint: push, stages: [ship]}}\n");
  ledger.updateEndpoint({task_id:f.task,endpoint:"push",reason:"single-user protected branch"});
  verifyFeature(f);
  const book=cmd("runbook","create","--task",f.task,"--exact","--push","api:main","--title","main");
  const id=cmd("fast-track","prepare",f.task,"--to","push","--runbook",book.runbook_id,"--paths","src/**").envelope_id;
  const run=()=>Bun.spawnSync([process.execPath,join(import.meta.dir,"../src/bin/cli.ts"),"ship","run","--envelope",id],{
    cwd:root,env:{...process.env,FORGE_WORKBENCH_ROOT:root,FORGE_SESSION_ID:"test-session",CODEX_SESSION_ID:"test-session"}
  });
  expect(run().exitCode).not.toBe(0);
  expect(git(bare,"rev-parse","main")).toBe(f.base);
  expect(human("快轨批准 "+id)).toContain("ACTIVE");
  const result = run();
  expect(result.exitCode, result.stderr.toString() + result.stdout.toString()).toBe(0);
  expect(git(bare,"rev-parse","main")).toBe(f.head);
},30_000);
