import { beforeEach, afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, realpathSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendEventInTx } from "../src/ledger/transactions";
import { Ledger } from "../src/ledger";
import { resolveTaskCheckout } from "../src/ledger/checkout";
import { runGit, withinProcessDeadline } from "../src/git";
import { inspectPr } from "../src/ledger/pr";
import { isolateHome } from "./helpers/hermetic";
import { nativeReview } from "./helpers/native-review";

isolateHome();
let root: string, repo: string, bin: string, base: string, ledger: Ledger;
const cli = join(import.meta.dir, "../src/bin/cli.ts");
function git(...args: string[]) {
  const result = runGit(repo, args);
  if (result.code) throw new Error(result.stderr);
  return result.stdout.trim();
}
function commit(message: string) {
  writeFileSync(join(repo, "revision.txt"), message);
  git("add", "-A"); git("commit", "-m", message);
  return git("rev-parse", "HEAD");
}
function tool(name: string, body: string) {
  const file = join(bin, name);
  writeFileSync(file, "#!/bin/sh\nset -eu\n" + body);
  chmodSync(file, 0o755);
}
function invoke(args: string[], extra: Record<string, string> = {}) {
  return Bun.spawnSync([process.execPath, cli, "ledger", ...args], { cwd: root, env: { ...process.env,
    FORGE_WORKBENCH_ROOT: root, PATH: bin + ":" + process.env.PATH, ...extra } });
}
function open(endpoint: "pr" | "local", worktree?: string) {
  ledger.openTask({ workflow_version: "0.4", task_id: "fix", title: "Review delivery", repo: "svc", branch: "feature", endpoint,
    depth: "targeted", base_sha: base, head_sha: git("rev-parse", "feature"), worktree });
}
function verification(head: string) {
  ledger.recordEvidence({ task_id: "fix", repo: "svc", sha: head, kind: "test", status: "pass", source: "tool", summary: "tests passed" });
}
function readiness(head: string) {
  return ledger.checkPushReadiness({ task_id: "fix", repo: "svc", head_sha: head, checkEndpoint: true });
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "forge-delivery-"));
  repo = join(root, "svc"); bin = join(root, "bin");
  mkdirSync(repo); mkdirSync(bin);
  git("init", "-b", "main"); git("config", "user.name", "Dev"); git("config", "user.email", "dev@example.org");
  git("remote", "add", "origin", "https://github.com/acme/svc.git");
  base = commit("base"); git("switch", "-c", "feature");
  const docs = join(root, ".workbench/specs/fix");
  mkdirSync(docs, { recursive: true });
  for (const name of ["ssot", "tech-spec", "test-spec"]) writeFileSync(join(docs, name + ".md"), name);
  ledger = new Ledger(root);
});
afterEach(() => { ledger.closeDb(); rmSync(root, { recursive: true, force: true }); });
function review(head: string, from = base, task = "fix") {
  return nativeReview(ledger, task, { repo: "svc", branch: "feature", base: from, head });
}

test("v0.5 rejects the legacy native review before executing Codex or writing evidence", () => {
  ledger.openTask({ task_id:"fix", title:"Modern review", repo:"svc", branch:"feature",
    endpoint:"local", depth:"targeted", base_sha:base, head_sha:base });
  const marker = join(root, "native-started");
  tool("codex", 'touch "$NATIVE_MARKER"');
  const tip = ledger.getTask("fix")!.tip_hash;
  const result = invoke(["review-native", "--task", "fix", "--repo", "svc", "--base", base], {NATIVE_MARKER:marker});
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toMatch(/review-native|forge review/i);
  expect(existsSync(marker)).toBe(false);
  expect(ledger.getTask("fix")!.tip_hash).toBe(tip);
});

test("reattaching a branch preserves the baseline required by native review", () => {
  open("local");
  expect(ledger.getTaskRepos("fix")[0].base_sha).toBe(base);
  const middle = commit("middle");
  ledger.detachRepo({ task_id: "fix", repo: "svc", branch: "feature", reason: "temporary" });
  ledger.attachRepo({ task_id: "fix", repo: "svc", branch: "feature" });
  expect(ledger.getTaskRepos("fix")[0].base_sha).toBe(base);
  const head = commit("head");
  ledger.freezeSpec({ task_id: "fix" });
  verification(head);
  review(head, middle);
  expect(readiness(head).ready).toBe(false);
  review(head);
  expect(readiness(head).ready).toBe(true);
});

test("PR follow-up requires remote confirmation for the new branch head", () => {
  const first = commit("initial PR"); open("pr");
  tool("gh", 'printf "%s" "$TEST_PR"');
  const sync = (sha: string) => invoke(["pr-sync", "fix", "--repo", "svc", "--pr", "23"], { TEST_PR: JSON.stringify({
    headRepository: { name: "svc" }, headRepositoryOwner: { login: "acme" }, headRefName: "feature", headRefOid: sha, isCrossRepository: false, state: "OPEN", url: "https://github.com/acme/svc/pull/23" }) });
  expect(sync(first).exitCode).toBe(0);
  const next = commit("follow-up");
  ledger.freezeSpec({ task_id: "fix" });
  verification(next); review(next);
  expect(sync(first).exitCode).not.toBe(0); expect(readiness(next).ready).toBe(false);
  for (const actor of ["manual", "operator", "hook"]) {
    appendEventInTx(ledger.db, { task_id: "fix", event_type: "EVIDENCE_CAPTURED", actor, repo: "svc", branch: "feature",
      sha: next, payload: { kind: "pr", status: "pass", summary: "legacy PR" } });
  }
  expect(readiness(next).ready).toBe(false);
  expect(() => ledger.closeTask({ task_id: "fix" })).toThrow("forge ledger pr-sync");
  expect(sync(next).exitCode).toBe(0);
  expect(JSON.parse(ledger.getTaskEvents("fix").at(-1)!.payload_json).meta).toMatchObject({ pr_url: "https://github.com/acme/svc/pull/23", pr_head_oid: next });
  expect(ledger.getTaskRepos("fix")[0].head_sha).toBe(next);
  git("branch", "second", next);
  ledger.attachRepo({ task_id: "fix", repo: "svc", branch: "second", head_sha: next, base_sha: base });
  expect(ledger.checkPushReadiness({ task_id: "fix", repo: "svc", branch: "second", head_sha: next, checkEndpoint: true }).ready).toBe(false);
  ledger.detachRepo({ task_id: "fix", repo: "svc", branch: "second", reason: "fixture finished" });
  git("switch", "main"); git("branch", "-D", "feature"); git("update-ref", "refs/remotes/origin/main", next);
  expect(ledger.closeTask({ task_id: "fix", archive: false }).task.status).toBe("CLOSED");
});

test("explicit contracts under build remain locked through worktree cleanup", () => {
  git("switch", "main");
  const worktree = join(root, "linked"); git("worktree", "add", worktree, "feature");
  const rel = "tests/build/payment.hurl", file = join(worktree, rel);
  mkdirSync(join(worktree, "tests/build"), { recursive: true }); writeFileSync(file, "contract");
  git("-C", worktree, "add", rel); git("-C", worktree, "commit", "-m", "add contract");
  const head = git("rev-parse", "feature"); open("local");
  expect(() => ledger.freezeSpec({ task_id: "fix", locked_test_globs: ["tests/build/missing.hurl"] })).toThrow("requested test");
  ledger.freezeSpec({ task_id: "fix", locked_test_globs: [rel] });
  for (const edit of [() => writeFileSync(file, "changed"), () => rmSync(file)]) {
    edit();
    expect(readiness(head).missing.join(" ")).toContain(rel);
    expect(() => ledger.closeTask({ task_id: "fix" })).toThrow(rel);
  }
  writeFileSync(file, "contract"); verification(head); review(head);
  writeFileSync(file, "drift"); git("-C", worktree, "commit", "-am", "drift");
  git("worktree", "remove", worktree);
  expect(() => ledger.closeTask({ task_id: "fix" })).toThrow(rel);
  git("branch", "-f", "feature", head);
  git("merge", "--ff-only", head);
  writeFileSync(join(repo, rel), "unrelated dirty main");
  expect(readiness(head).ready).toBe(true);
  expect(ledger.closeTask({ task_id: "fix", archive: false }).task.status).toBe("CLOSED");
});

test("tracked contracts inside pruned dependency fixtures remain locked by wildcard", () => {
  const rel = "fixture/node_modules/sample/contract.hurl";
  mkdirSync(join(repo, "fixture/node_modules/sample"), { recursive: true });
  writeFileSync(join(repo, rel), "contract");
  git("add", "-f", rel);
  const head = commit("tracked fixture");
  open("local");
  ledger.freezeSpec({ task_id: "fix", locked_test_globs: ["**/*.hurl"] });
  writeFileSync(join(repo, rel), "modified");
  expect(readiness(head).missing.join(" ")).toContain(rel);
  rmSync(join(repo, rel));
  expect(readiness(head).missing.join(" ")).toContain(rel);
});

test("an older review completion cannot satisfy an amended freeze", () => {
  open("local");
  const head = commit("review target");
  const before = ledger.freezeSpec({ task_id: "fix" }).spec;
  review(head);
  ledger.amendSpec({ task_id: "fix", scope: "requirement", reason: "changed invariant" });
  const after = ledger.freezeSpec({ task_id: "fix" }).spec;
  expect(after.evidence_floor_seq.review).toBeGreaterThan(before.evidence_floor_seq.review);
  verification(head);
  expect(readiness(head).recordedReviewRoles).not.toContain("quality");
  expect(readiness(head).ready).toBe(false);
  review(head);
  expect(readiness(head).ready).toBe(true);
});

test("a replacement task requires its own native review for the shared revision", () => {
  const head = commit("shared revision");
  open("local");
  ledger.freezeSpec({ task_id: "fix" });
  review(head);
  ledger.cancelTask({ task_id: "fix", reason: "new task" });
  const task_id = "replacement";
  ledger.openTask({ workflow_version: "0.4", task_id, title: task_id, repo: "svc", branch: "feature", base_sha: base, head_sha: head, endpoint: "local", depth: "targeted" });
  const specs = join(root, ".workbench/specs", task_id);
  mkdirSync(specs);
  for (const name of ["ssot", "tech-spec", "test-spec"]) writeFileSync(join(specs, name + ".md"), name);
  ledger.freezeSpec({ task_id });
  const roles = () => ledger.checkPushReadiness({ task_id, repo: "svc", head_sha: head }).recordedReviewRoles;
  expect(roles()).toEqual([]);
  review(head, base, task_id);
  expect(roles()).toContain("quality");
});

test("reviewing from an older ancestor cannot credit the task diff", () => {
  const ancestor = base;
  base = commit("enable check");
  open("local");
  git("revert", "--no-edit", base);
  const head = git("rev-parse", "HEAD");
  expect(git("diff", "--name-only", ancestor, head)).toBe("");
  ledger.freezeSpec({ task_id: "fix" });
  verification(head);
  expect(() => review(head, ancestor)).toThrow("within the task baseline");
  expect(readiness(head).ready).toBe(false);
  review(head);
  expect(readiness(head).ready).toBe(true);
});

test("frozen executable mode survives delivery and separate worktree removal", () => {
  git("switch", "main");
  open("pr");
  expect(ledger.getTaskRepos("fix")[0].worktree).toBeNull();
  const worktree = join(root, "linked");
  git("worktree", "add", worktree, "feature");
  const rel = "check.sh", file = join(worktree, rel);
  writeFileSync(file, "#!/bin/sh\n", { mode: 0o755 });
  git("-C", worktree, "add", rel); git("-C", worktree, "commit", "-m", "add test");
  const head = git("rev-parse", "feature");
  ledger.recordEvidence({ task_id: "fix", kind: "commit", branch: "feature", repo: "svc", sha: head, status: "pass", source: "hook", summary: "delivered" });
  ledger.freezeSpec({ task_id: "fix", locked_test_globs: [rel] });
  chmodSync(file, 0o644);
  expect(readiness(head).missing.join(" ")).toContain(rel);
  expect(() => ledger.closeTask({ task_id: "fix" })).toThrow(rel);
  git("-C", worktree, "commit", "-am", "remove executable bit");
  const changed = git("rev-parse", "feature");
  chmodSync(file, 0o755);
  expect(readiness(changed).missing.join(" ")).toContain(rel);
  expect(() => ledger.closeTask({ task_id: "fix" })).toThrow(rel);
  git("-C", worktree, "reset", "--hard", head);
  verification(head); review(head);
  ledger.recordEvidence({ task_id: "fix", repo: "svc", branch: "feature", sha: head, kind: "pr", status: "pass", source: "tool", summary: "confirmed PR", meta: { pr_url: "https://github.com/acme/svc/pull/9", pr_head_oid: head } });
  git("merge", "--ff-only", head); git("update-ref", "refs/remotes/origin/main", head);
  git("worktree", "remove", worktree); git("branch", "-d", "feature");
  writeFileSync(join(repo, rel), "unrelated main edit");
  expect(ledger.closeTask({ task_id: "fix", archive: false }).task.status).toBe("CLOSED");
});

test("base refs resolve on open and legacy unknown or invalid bases require audited recovery", () => {
  expect(invoke(["open", "--id", "fix", "--title", "baseline", "--repo", "svc", "--branch", "feature", "--base", "missing"]).exitCode).not.toBe(0);
  expect(invoke(["open", "--id", "fix", "--title", "baseline", "--repo", "svc", "--branch", "feature", "--base", "main"]).exitCode).toBe(0);
  expect(ledger.getTaskRepos("fix")[0].base_sha).toBe(base);
  for (const legacy of [null, "not-a-sha", "deadbee"]) {
    const branch = legacy ? "legacy-" + legacy : "unknown";
    git("branch", branch);
    appendEventInTx(ledger.db, { task_id: "fix", repo: "svc", branch, event_type: "REPO_ATTACHED", actor: "agent", payload: { base_sha: legacy } });
    if (legacy) ledger.db.query("INSERT INTO task_repos(repo,branch,task_id,base_sha,attached_at) VALUES(?,?,?,?,?)")
      .run("svc", branch, "fix", legacy, new Date().toISOString());
    const args = ["attach", "fix", "--repo", "svc", "--branch", branch];
    expect(invoke(args).stderr.toString()).toContain("--base");
    expect(invoke([...args, "--base", "main"]).exitCode).toBe(0);
    expect(ledger.getTaskRepos("fix").find(r => r.branch === branch)?.base_sha).toBe(base);
    expect(JSON.parse(ledger.getTaskEvents("fix").at(-1)!.payload_json).base_sha).toBe(base);
  }
});

test("checkout-relative base and role floor follow the feature branch across a worktree move", () => {
  const head = commit("feature");
  git("switch", "main");
  const first = join(root, "linked"), moved = join(root, "renamed");
  git("worktree", "add", first, "feature");
  const opened = invoke(["open", "--id", "fix", "--title", "linked", "--repo", "svc", "--branch", "feature", "--base", "HEAD"]);
  expect(opened.exitCode).toBe(0);
  expect(ledger.getTaskRepos("fix")[0].base_sha).toBe(head);
  const floor = ledger.freezeSpec({ task_id: "fix" }).spec.evidence_floor_seq.review;
  git("worktree", "move", first, moved);
  const result = invoke(["reviews", "fix"]);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual([]);
  expect(resolveTaskCheckout(root, ledger.getTaskRepos("fix")[0]).dir).toBe(realpathSync(moved));
  expect(ledger.getSpecState("fix").evidence_floor_seq.review).toBe(floor);
});

test("attaching an initialized submodule uses its working tree", () => {
  const child = join(root, "module-source");
  git("clone", repo, child);
  git("-c", "protocol.file.allow=always", "submodule", "add", child, "module");
  const nested = new Ledger(repo);
  try {
    nested.openTask({ workflow_version: "0.4", task_id: "submodule", title: "module", endpoint: "local", depth: "targeted", repo: "module", branch: "feature", base_sha: "HEAD" });
    expect(nested.getTaskRepos("submodule")[0].worktree).toBe(git("-C", "module", "rev-parse", "--show-toplevel"));
  } finally { nested.closeDb(); }
});

test("an explicit PR can verify the recorded head after branch cleanup", () => {
  const head = commit("delivered");
  open("pr");
  ledger.freezeSpec({ task_id: "fix" });
  verification(head); review(head);
  git("switch", "main"); git("branch", "-D", "feature");
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
  git("update-ref", "refs/remotes/origin/main", head);
  tool("gh", 'printf "%s" "$TEST_PR"');
  const url = "https://github.com/acme/svc/pull/23";
  const sync = (selector: string[], oid = head, state = "MERGED") => invoke(["pr-sync", "fix", "--repo", "svc", ...selector],
    { TEST_PR: JSON.stringify({ url, state, headRefName: "feature", headRefOid: oid, isCrossRepository: false,
      headRepository: { name: "svc" }, headRepositoryOwner: { login: "acme" } }) });
  expect(sync(["--pr", url]).exitCode).not.toBe(0);
  git("update-ref", "refs/remotes/origin/feature", head);
  expect(() => ledger.closeTask({ task_id: "fix" })).toThrow("pr-sync");
  expect(sync(["--pr", "23"], head, "OPEN").exitCode).toBe(0);
  git("update-ref", "-d", "refs/remotes/origin/feature");
  git("update-ref", "refs/remotes/origin/trunk", head);
  expect(sync([]).exitCode).not.toBe(0);
  expect(sync(["--pr", "23"], base).exitCode).not.toBe(0);
  expect(sync(["--pr", url]).exitCode).toBe(0);
  expect(ledger.closeTask({ task_id: "fix", archive: false }).task.status).toBe("CLOSED");
});

test("a child attachment cannot sync its enclosing repository's PR", () => {
  open("pr");
  mkdirSync(join(repo, "docs"));
  const child = { repo: "svc/docs", branch: "feature", worktree: null };
  ledger.db.query("UPDATE task_repos SET repo=?, worktree=NULL").run(child.repo);
  expect(() => resolveTaskCheckout(root, child)).toThrow("Git top level");
  expect(invoke(["pr-sync", "fix", "--repo", child.repo, "--pr", "23"]).stderr.toString()).toContain("Git top level");
  expect(ledger.getTaskEvents("fix").some(e => e.event_type === "EVIDENCE_CAPTURED")).toBe(false);
});

test("supplied and remembered worktrees must share the target repository's object store", () => {
  const foreign = join(root, "foreign");
  git("clone", repo, foreign);
  const gitDir = process.env.GIT_DIR;
  process.env.GIT_DIR = join(foreign, ".git");
  try { expect(() => open("pr", foreign)).toThrow("different repository"); }
  finally { if (gitDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = gitDir; }
  expect(() => open("pr", foreign)).toThrow("different repository");
  open("pr");
  expect(() => ledger.attachRepo({ task_id: "fix", repo: "svc", branch: "feature", worktree: foreign })).toThrow("different repository");
  ledger.db.query("UPDATE task_repos SET worktree=? WHERE task_id='fix'").run(foreign);
  expect(invoke(["pr-sync", "fix", "--repo", "svc", "--pr", "23"]).stderr.toString()).toContain("different repository");
  expect(() => ledger.closeTask({ task_id: "fix" })).toThrow("different repository");
});

test("verified checkout paths preserve trailing spaces beside another repository", () => {
  const sibling = join(root, "linked"), linked = sibling + " ";
  git("clone", repo, sibling);
  git("switch", "main"); git("worktree", "add", linked, "feature");
  open("pr", linked);
  expect(ledger.getTaskRepos("fix")[0].worktree).toBe(realpathSync(linked));
  git("-C", linked, "commit", "--allow-empty", "-m", "feature only");
  const head = git("rev-parse", "feature");
  tool("gh", 'printf "%s" "$TEST_PR"');
  const result = invoke(["pr-sync", "fix", "--repo", "svc", "--pr", "23"], { TEST_PR: JSON.stringify({
    headRepository: { name: "svc" }, headRepositoryOwner: { login: "acme" }, headRefName: "feature", headRefOid: head,
    isCrossRepository: false, state: "OPEN", url: "https://github.com/acme/svc/pull/23" }) });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(ledger.getTaskRepos("fix")[0].head_sha).toBe(head);
});

test("fetching a superseded base cannot reverse an audited repair", () => {
  open("local");
  const foreign = join(root, "fork"); git("clone", repo, foreign);
  git("-C", foreign, "-c", "user.name=Dev", "-c", "user.email=dev@example.org", "commit", "--allow-empty", "-m", "old base");
  const wrong = git("-C", foreign, "rev-parse", "HEAD");
  const branch = "legacy"; git("branch", branch);
  appendEventInTx(ledger.db, { task_id: "fix", repo: "svc", branch, event_type: "REPO_ATTACHED", actor: "agent", payload: { base_sha: wrong } });
  const corrected = ledger.attachRepo({ task_id: "fix", repo: "svc", branch, base_sha: base });
  expect(JSON.parse(corrected.payload_json)).toMatchObject({ base_sha: base, base_repair: { supersedes: wrong } });
  ledger.detachRepo({ task_id: "fix", repo: "svc", branch, reason: "cleanup" });
  git("fetch", foreign, "feature");
  expect(git("rev-parse", "--verify", wrong + "^{commit}")).toBe(wrong);
  ledger.attachRepo({ task_id: "fix", repo: "svc", branch });
  expect(ledger.getTaskRepos("fix").find(r => r.branch === branch)?.base_sha).toBe(base);
});

test("PR lookup reports silent failures and obeys the caller's remaining deadline", () => {
  const env = { ...process.env, PATH: bin + ":" + process.env.PATH };
  const view = () => inspectPr(repo, "feature", undefined, env);
  tool("gh", "exit 23");
  expect(view).toThrow("gh pr view exited with code 23");
  tool("gh", "kill -TERM $$");
  expect(view).toThrow(/terminated by SIGTERM/);
  tool("gh", "exec sleep 15");
  const start = Date.now();
  expect(() => withinProcessDeadline(start + 400, view)).toThrow(/timed out/);
  expect(Date.now() - start).toBeLessThan(2500);
});

test("a v0.5 task can close at the PR endpoint only with confirmed membership in remote main", () => {
  const head = commit("change");
  ledger.openTask({task_id:"fix",title:"Ship reviewed revision",repo:"svc",branch:"feature",endpoint:"pr",depth:"targeted",base_sha:base,head_sha:head});
  const specs = join(root, ".workbench/specs/fix");
  for (const name of ["ssot", "tech-spec", "test-spec"]) rmSync(join(specs, name + ".md"));
  writeFileSync(join(specs, "scope.md"), "Fix one covered behavior.");
  ledger.freezeSpec({task_id:"fix"});
  tool("gh", 'if [ "$1" = pr ]; then printf "%s" "$TEST_PR"; elif [ "$6" = .object.sha ]; then printf "%s" "$MAIN_OID"; else printf "%s" "$COMPARISON"; fi');
  const url="https://github.com/acme/svc/pull/23";
  const sync=(state:string,target:string,tip:string,comparison="behind")=>invoke(["pr-sync","fix","--repo","svc","--pr","23"],{
    MAIN_OID:tip,COMPARISON:comparison,TEST_PR:JSON.stringify({url,state,baseRefName:target,headRefName:"feature",headRefOid:head,isCrossRepository:false,headRepository:{name:"svc"},headRepositoryOwner:{login:"acme"}}),
  });
  const lacksEndpoint=()=>readiness(head).missing.some(reason=>reason.includes('endpoint "pr"'));
  expect(sync("OPEN","main",base).exitCode).toBe(0);
  expect(lacksEndpoint()).toBe(true);
  expect(sync("MERGED","integration",head).exitCode).toBe(0);
  expect(lacksEndpoint()).toBe(true);
  expect(sync("MERGED","main",base).exitCode).not.toBe(0);
  expect(lacksEndpoint()).toBe(true);
  expect(sync("MERGED","main",head).exitCode).toBe(0);
  expect(lacksEndpoint()).toBe(false);
  expect(JSON.parse(ledger.getTaskEvents("fix").at(-1)!.payload_json).meta).toMatchObject({base_branch:"main",target_oid:head,state:"MERGED"});
});
