import { expect, test } from "bun:test";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { auditFixture, timestamp } from "./helpers/audit-cli";
import { snapshot } from "./helpers/ledger-snapshot";
import { withRuntime, type RtFixture } from "./helpers/rt-cli";

const sqlite = ".workbench/ledger/ledger.sqlite";
const marker = "private-history-must-not-be-projected";
type Evidence = { ts: string; repo: string; release_id: string | null; sha: string | null; sha_known: boolean };

function repository(f: RtFixture, name: string, count: number) {
  const {s} = f;
  const cwd = join(s.work, name);
  mkdirSync(cwd, { recursive: true });
  s.git(cwd, "init", "-b", "main");
  s.git(cwd, "config", "user.name", "Forge Fixture");
  s.git(cwd, "config", "user.email", "fixture@example.invalid");
  s.ok([s.forge, "add-repo", cwd, "--workbench", s.work]);
  return Array.from({ length: count }, (_, index) => {
    const file = "file-" + (index + 1) + ".txt";
    s.privateFile(join(name, file), name + " change " + (index + 1) + "\n");
    s.git(cwd, "add", "--", file);
    s.git(cwd, "commit", "-m", name + " local change " + (index + 1));
    return s.git(cwd, "rev-parse", "HEAD").trim();
  });
}

const diagnostic = (result: {out: string; err: string}) => result.out + result.err;
const commits = (data: {git: { commits: { sha: string }[] }}) => data.git.commits.map(item => item.sha);

test("C01 changes selects a registered repository and reports bounded local Git ranges", withRuntime(f => {
  const [base, middle, latest] = repository(f, ".", 3);
  const cwd = f.s.work;
  f.s.git(cwd, "tag", "release", middle);
  f.configure({ status: f.bound, changes: f.bound });
  const range = f.success("changes", "--from-sha", base, "--to-ref", "release");
  expect(range.data).toMatchObject({ repo: ".", git: { from_sha: base, to_sha: middle } });
  expect(commits(range.data)).toEqual([middle]);
  expect(range.data.git.summary).toMatchObject({ files_changed: 1, insertions: 1, deletions: 0 });
  const head = f.success("changes", "--from-sha", base);
  expect(head.data.git.to_sha).toBe(latest);
  expect(commits(head.data)).toEqual([latest, middle]);
  expect(head.data.git.summary).toMatchObject({ files_changed: 2, insertions: 2, deletions: 0 });
  const overview = f.success("changes");
  expect(commits(overview.data)).toEqual([latest, middle, base]);
  expect(JSON.stringify(overview.warnings)).toMatch(/(?:anchor|running version|锚点|运行版本)/i);
  expect(commits(f.success("changes", "--limit", "1").data)).toEqual([latest]);
  expect(commits(f.success("changes", "--limit", "500").data)).toEqual([latest, middle, base]);
  for (const limit of ["0", "501"]) expect(diagnostic(f.rejected("changes", "--limit", limit))).toMatch(/limit/i);
  for (const [args, pattern] of [
    [["--from-sha", "a".repeat(40)], /from-sha|base|基点/i],
    [["--to-ref", "no-such-ref"], /to-ref|no-such-ref|终点/i],
    [["--repo", "unknown-repo"], /unknown-repo|repo|仓库/i],
  ] as const) expect(diagnostic(f.rejected("changes", ...args))).toMatch(pattern);
  const [neighbor] = repository(f, "neighbor", 1);
  f.s.git(join(cwd, "neighbor"), "tag", "release", neighbor);
  expect(diagnostic(f.rejected("changes"))).toMatch(/--repo|选择仓库/i);
  expect(commits(f.success("changes", "--repo", ".", "--to-ref", "release", "--from-sha", base).data)).toEqual([middle]);
  expect(commits(f.success("changes", "--repo", "neighbor", "--to-ref", "release").data)).toEqual([neighbor]);
  expect(f.calls()).toHaveLength(0);
}));

test("C02 changes merges only selected-repo ledger evidence and never writes its sources", withRuntime(f => {
  const [alpha, alphaNext] = repository(f, "alpha", 2);
  const [beta, betaNext] = repository(f, "beta", 2);
  repository(f, "unborn", 0);
  const hasLedger = () => existsSync(join(f.s.work, sqlite));
  expect(hasLedger()).toBe(true);
  const moved = ["", "-wal", "-shm"].filter(suffix => existsSync(join(f.s.work, sqlite + suffix)));
  for (const suffix of moved) renameSync(join(f.s.work, sqlite + suffix), join(f.s.root, "initial-ledger" + suffix));
  try {
    expect(hasLedger()).toBe(false);
    const empty = f.success("changes", "--repo", "unborn");
    expect(commits(empty.data)).toEqual([]);
    expect(JSON.stringify(empty.warnings)).toMatch(/ledger|history|账本|历史/i);
    expect(hasLedger()).toBe(false);
    const local = f.success("changes", "--repo", "alpha");
    expect(commits(local.data)).toEqual([alphaNext, alpha]);
    expect(JSON.stringify(local.warnings)).toMatch(/ledger|账本/i);
    expect(hasLedger()).toBe(false);
  } finally {
    for (const suffix of moved) renameSync(join(f.s.root, "initial-ledger" + suffix), join(f.s.work, sqlite + suffix));
  }

  const audit = auditFixture(f.s);
  audit.open("joint", ["--repo", "alpha", "--branch", "main"], marker);
  audit.json("attach", "joint", "--repo", "beta", "--branch", "main");
  f.s.git(join(f.s.work, "beta"), "branch", "beta-evidence", betaNext);
  audit.open("beta-only", ["--repo", "beta", "--branch", "beta-evidence"], marker);
  audit.db(db => {
    const handoff = [
      { repo: "alpha", branch: "main", base_branch: "main", verified_head: alpha, pr_number: 1, pr_url: marker },
      { repo: "beta", branch: "main", base_branch: "main", verified_head: beta, pr_number: 2, pr_url: marker },
    ];
    const event = db.query(`INSERT INTO events
      (task_id, seq, ts, event_type, actor, repo, branch, sha, payload_json, prev_hash, entry_hash)
      VALUES (?, ?, ?, ?, 'fixture', ?, ?, ?, ?, 'synthetic-prev', 'synthetic-hash')`);
    const push = (task: string, seconds: number, type: string, repo: string | null, sha: string | null, payload: object) =>
      event.run(task, seconds + 20, timestamp(seconds), type, repo,
        repo && (task === "beta-only" ? "beta-evidence" : "main"), sha, JSON.stringify(payload));
    push("joint", 1, "HANDOFF_RECORDED", null, null, { items: handoff, summary: marker });
    db.query(`INSERT INTO task_handoffs (task_id, handed_off_at, ledger_tip, items_json, sql_files_json, rollback_plan)
      VALUES ('joint', ?, 'synthetic-handoff-tip', ?, '[]', ?)`).run(timestamp(1), JSON.stringify(handoff), marker);
    db.query(`INSERT INTO releases
      (release_id, title, status, sql_files_json, created_at, updated_at, completed_at)
      VALUES ('release-fixture', ?, 'COMPLETED', '[]', ?, ?, ?)`).run(marker, timestamp(2), timestamp(3), timestamp(3));
    const item = db.query(`INSERT INTO release_items (release_id, task_id, repo, branch, base_branch,
      pr_number, pr_url, expected_head_sha, verified_head_sha, ledger_tip, status, merge_order)
      VALUES ('release-fixture','joint',?,'main','main',?, ?,?,?,'synthetic-release-tip',?,?)`);
    item.run("alpha", 1, marker, alphaNext, alphaNext, "MERGED", 1);
    item.run("beta", 2, marker, betaNext, betaNext, "VERIFIED", 2);
    push("joint", 4, "EVIDENCE_CAPTURED", "alpha", alphaNext, { kind: "deploy", status: "pass", summary: marker });
    push("joint", 5, "TASK_CLOSED", null, null, { summary: marker });
    db.query("UPDATE tasks SET status='CLOSED', closed_at=? WHERE task_id='joint'").run(timestamp(5));
    push("beta-only", 6, "EVIDENCE_CAPTURED", "beta", betaNext, { kind: "prod", status: "fail", summary: marker });
    push("beta-only", 7, "TASK_CLOSED", null, null, { summary: marker });
    db.query("UPDATE tasks SET status='CLOSED', closed_at=? WHERE task_id='beta-only'").run(timestamp(7));
  });
  const before = snapshot(f.s.work);
  const projection = (repo: string, limit: string) => {
    const response = f.call("changes", "--repo", repo, "--limit", limit);
    expect(response.code, diagnostic(response)).toBe(0);
    expect(diagnostic(response)).not.toContain(marker);
    const ledger = response.json.data.ledger;
    const records: Evidence[] = ledger.records;
    for (const record of records) {
      expect(record.repo).toBe(repo);
      const keys = ["release_id", "repo", "sha", "sha_known", "status", "task_id", "ts", "type"];
      if (record.release_id) keys.push("expected_head_sha", "item_status", "verified_head_sha");
      expect(Object.keys(record).sort()).toEqual(keys.sort());
    }
    return { records, response };
  };
  const time = (record: Evidence) => record.ts;
  const latest = projection("alpha", "3");
  expect(latest.records.map(time)).toEqual([timestamp(5), timestamp(4), timestamp(3)]);
  expect(JSON.stringify(latest.records[0])).toMatch(/clos/i);
  expect(latest.records[0]).toMatchObject({ type: "TASK_CLOSED", sha: null, sha_known: false });
  expect(JSON.stringify(latest.records[1])).toMatch(/deploy/i);
  expect(JSON.stringify(latest.records[1])).toContain(alphaNext);
  expect(JSON.stringify(latest.records[2])).toMatch(/release-fixture/i);
  expect(latest.records[2]).toMatchObject({ sha: alphaNext, expected_head_sha: alphaNext, verified_head_sha: alphaNext, item_status: "MERGED" });
  expect(diagnostic(latest.response)).toMatch(/(?:history|historical|ledger evidence|历史|账本证据)/i);
  const all = projection("alpha", "20").records;
  expect(all.map(time)).toEqual([timestamp(5), timestamp(4), timestamp(3), timestamp(1)]);
  expect(JSON.stringify(all.at(-1))).toMatch(/handoff/i);
  expect(JSON.stringify(all.at(-1))).toContain(alpha);
  for (const foreign of [beta, betaNext, "beta-only"]) expect(JSON.stringify(all)).not.toContain(foreign);
  const other = projection("beta", "20").records;
  const prod = other.find(record => time(record) === timestamp(6));
  expect(JSON.stringify(prod)).toMatch(/prod/i);
  expect(JSON.stringify(prod)).toContain(betaNext);
  expect(JSON.stringify(prod)).toMatch(/fail/i);
  expect(other.find(record => record.release_id)).toMatchObject({ sha: betaNext, item_status: "VERIFIED" });
  expect(JSON.stringify(other)).not.toContain(alphaNext);
  expect(snapshot(f.s.work)).toEqual(before);
}), 15_000);

test("C03 live changes use only explicit status SHA evidence and honor the supplied base", withRuntime(f => {
  const [base, middle, latest] = repository(f, ".", 3);
  f.s.git(f.s.work, "tag", "known-image-tag", base);
  f.configure({ status: f.bound });
  const args = ["changes", "--live", "--env", "sandbox", "--service", "worker"];
  f.scenario({ status: { json: { git_sha: base, image_tag: "known-image-tag" } } });
  expect(diagnostic(f.rejected("changes", "--live"))).toMatch(/--env|environment|环境/i);
  expect(f.calls()).toHaveLength(0);
  const anchored = f.success(...args);
  expect(anchored.data).toMatchObject({ live_anchored: true, git: { from_sha: base, to_sha: latest } });
  expect(commits(anchored.data)).toEqual([latest, middle]);
  expect(f.calls()).toHaveLength(1);
  expect(f.calls()[0].env).toMatchObject({ FORGE_RT_PRIMITIVE: "status", FORGE_RT_ENV: "sandbox", FORGE_RT_SERVICE: "worker" });
  const explicit = f.success(...args, "--from-sha", middle);
  expect(explicit.data.git.from_sha).toBe(middle);
  expect(commits(explicit.data)).toEqual([latest]);

  for (const status of [
    { json: { image_tag: "known-image-tag" } }, { json: { git_sha: "a".repeat(40) } }, { exit: 11, err: "fixture status failed" },
  ]) {
    f.scenario({ status });
    const callsBefore = f.calls().length;
    const result = f.call(...args);
    expect(f.calls()).toHaveLength(callsBefore + 1);
    expect(result.json.data?.live_anchored ?? false).toBe(false);
    expect(result.json.data?.git?.from_sha ?? null).toBeNull();
    expect(diagnostic(result)).toMatch(/(?:anchor|git_sha|锚定)/i);
  }
  f.configure({});
  const before = f.calls().length;
  const result = f.call(...args);
  expect(diagnostic(result)).toContain("extensions.runtime.status");
  expect(result.json.data?.live_anchored ?? false).toBe(false);
  expect(f.calls()).toHaveLength(before);

  f.configure({ status: f.bound });
  f.scenario({ status: { json: { git_sha: middle } } });
  expect(f.success(...args).data).toMatchObject({ live_anchored: true, git: { from_sha: middle } });
}));

test("C04 explicit changes supplementation reports independent adapter failure and retains local evidence", withRuntime(f => {
  const [base] = repository(f, ".", 3);
  f.configure({ changes: f.bound });
  const audit = auditFixture(f.s);
  audit.open("history", ["--repo", ".", "--branch", "main"]);
  audit.json("close", "history", "--no-archive");
  const before = snapshot(f.s.work);
  const baseArgs = ["changes", "--from-sha", base];
  const plain = f.success(...baseArgs);
  expect(f.calls()).toHaveLength(0);
  f.scenario({ changes: { json: { detail: "safe runtime supplement" } } });
  const supplemental = f.success(...baseArgs, "--with-adapter", "--env", "fixture");
  expect(supplemental.data).toMatchObject({ git: plain.data.git, ledger: plain.data.ledger, adapter: { ok: true } });
  expect(JSON.stringify(supplemental.data.adapter)).toContain("safe runtime supplement");
  expect(f.calls()).toHaveLength(1);
  expect(f.calls()[0].env).toMatchObject({ FORGE_RT_PRIMITIVE: "changes", FORGE_RT_ENV: "fixture" });
  const secret = "adapter-opaque-fixture-secret";
  f.scenario({ changes: { exit: 17, err: "fixture failure password=" + secret } });
  const failed = f.rejected(...baseArgs, "--with-adapter", "--env", "fixture");
  expect(failed.json.data).toMatchObject({git: plain.data.git, ledger: plain.data.ledger, adapter: {ok: false, exit_code: 17}});
  expect(failed.json.error).toBeDefined();
  expect(diagnostic(failed)).not.toContain(secret);
  f.scenario({ changes: { json: { detail: "safe recovery" } } });
  expect(f.success(...baseArgs, "--with-adapter", "--env", "fixture").data)
    .toMatchObject({git: plain.data.git, ledger: plain.data.ledger, adapter: {ok: true}});
  expect(f.calls()).toHaveLength(3);
  expect(snapshot(f.s.work)).toEqual(before);
}), 15_000);
