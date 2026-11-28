import { expect, test } from "bun:test";
import { mkdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { auditFixture, timestamp } from "./helpers/audit-cli";
import { withRuntime, type RtFixture } from "./helpers/rt-cli";

function initRepo(f: RtFixture, path: string, subject: string) {
  mkdirSync(path, { recursive: true });
  f.s.git(path, "init", "-b", "main");
  f.s.git(path, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "commit", "--allow-empty", "-m", subject);
  return f.s.git(path, "rev-parse", "HEAD").trim();
}

function register(f: RtFixture, repos: string[]) {
  const path = ".workbench/workbench.yaml";
  f.s.privateFile(path, stringify({ ...parse(f.s.read(path)), repos }));
}

function appendHistory(f: RtFixture, repo: string, task: string) {
  const audit = auditFixture(f.s);
  audit.open(task);
  audit.db(db => db.query(`INSERT INTO events
    (task_id,seq,ts,event_type,actor,repo,payload_json,prev_hash,entry_hash) VALUES
    (?,2,?,'EVIDENCE_CAPTURED','fixture',?,'{"kind":"deploy","status":"pass"}','fixture','fixture')`)
    .run(task, timestamp(0), repo));
}

test("changes keeps checkout and historical identities attached to their registered names", withRuntime(f => {
  const alpha = join(f.s.work, "alpha");
  const beta = join(f.s.work, "beta");
  const former = join(f.s.root, "former");
  const foreign = join(f.s.root, "foreign");
  initRepo(f, alpha, "original-alpha");
  const betaSha = initRepo(f, beta, "local-beta");
  const foreignSha = initRepo(f, foreign, "foreign-history");
  register(f, [alpha, "./beta/"]);
  f.configure({ status: f.bound, changes: f.bound });
  symlinkSync(beta, join(f.s.work, "alias"));
  appendHistory(f, "./beta/", "historical-beta");
  appendHistory(f, "alias", "foreign-alias");
  appendHistory(f, "alpha", "historical-alpha");

  expect(f.success("changes", "--repo", beta).data).toMatchObject({
    repo: "beta", git: { to_sha: betaSha }, ledger: { records: [{ task_id: "historical-beta" }] },
  });
  f.rejected("changes", "--repo", "alias");

  renameSync(alpha, former);
  symlinkSync(beta, alpha);
  f.rejected("changes", "--repo", "./alpha/");
  expect(f.success("changes", "--repo", "beta").data.ledger.records.map((item: { task_id: string }) => item.task_id))
    .toEqual(["historical-beta"]);

  rmSync(alpha);
  symlinkSync(foreign, alpha);
  const rejection = f.rejected("changes", "--repo", alpha, "--live", "--env", "fixture", "--with-adapter");
  expect(rejection.out + rejection.err).not.toContain(foreignSha);
  expect(rejection.out + rejection.err).not.toContain("foreign-history");
  expect(rejection.json.data).toBeNull();
  expect(f.calls()).toHaveLength(0);
}));

test("changes rejects redirected Git metadata and reads standard absorbed submodules", withRuntime(f => {
  const alpha = join(f.s.work, "alpha");
  const beta = join(f.s.work, "beta");
  const metadata = join(alpha, ".git");
  const original = join(f.s.root, "alpha-git");
  initRepo(f, alpha, "original-alpha");
  const betaSha = initRepo(f, beta, "local-beta");
  register(f, ["alpha", "beta"]);
  renameSync(metadata, original);

  symlinkSync(join(beta, ".git"), metadata);
  f.rejected("changes", "--repo", "alpha");
  rmSync(metadata);
  f.s.privateFile("alpha/.git", "gitdir: ../beta/.git\n");
  f.rejected("changes", "--repo", "alpha");
  rmSync(metadata);
  renameSync(original, metadata);
  f.s.privateFile("alpha/.git/commondir", join(beta, ".git") + "\n");
  f.rejected("changes", "--repo", "alpha");
  rmSync(join(metadata, "commondir"));
  renameSync(join(metadata, "objects"), join(metadata, "original-objects"));
  symlinkSync(join(beta, ".git", "objects"), join(metadata, "objects"));
  f.rejected("changes", "--repo", "alpha");
  expect(f.success("changes", "--repo", "beta").data.git.to_sha).toBe(betaSha);

  f.s.git(f.s.work, "init", "-b", "main");
  f.s.git(f.s.work, "-c", "protocol.file.allow=always", "submodule", "add", "--name", "local-library", beta, "library");
  register(f, ["./library/"]);
  expect(f.success("changes").data).toMatchObject({ repo: "library", git: { to_sha: betaSha } });
  f.s.git(f.s.work, "clone", "--shared", beta, "shared");
  register(f, ["library", "shared"]);
  expect(f.success("changes", "--repo", "shared").data).toMatchObject({ repo: "shared", git: { to_sha: betaSha } });
}));

test("changes rechecks the selected checkout after a live observation", withRuntime(f => {
  const alpha = join(f.s.work, "alpha");
  const replacement = join(f.s.root, "replacement");
  const former = join(f.s.root, "former");
  initRepo(f, alpha, "original-alpha");
  const replacementSha = initRepo(f, replacement, "replacement-alpha");
  register(f, ["alpha"]);
  const stub = f.s.privateFile("swap-checkout.ts", [
    'import { renameSync } from "node:fs";',
    `renameSync(${JSON.stringify(alpha)}, ${JSON.stringify(former)});`,
    `renameSync(${JSON.stringify(replacement)}, ${JSON.stringify(alpha)});`,
    `console.log(${JSON.stringify(JSON.stringify({ git_sha: replacementSha }))});`,
  ].join("\n"));
  f.configure({ status: f.bound }, { ...f.defaultAction, argv: ["bun", stub] });

  const result = f.rejected("changes", "--live", "--env", "fixture");
  expect(result.json.data).toBeNull();
  expect(result.out + result.err).not.toContain(replacementSha);
  expect(result.out + result.err).toContain("changed during local observation");
}));
