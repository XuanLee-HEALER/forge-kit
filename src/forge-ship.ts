import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { findWorkbenchRoot, canonicalRepoPath, type ShipPolicy } from "./config";
import { runGit, runProcess, checkoutEnvironment } from "./git";
import { matchesGlob } from "./shared/path";
import { Ledger } from "./ledger/store";
import { envelope, validateScope, trackEvent, progress, type Envelope } from "./ledger/fast-track";
import { resolveTaskCheckout, reachableFromRefs } from "./ledger/checkout";
import { inspectPr, verifyTagBase } from "./ledger/pr";
import { coversReviewBase, reviewMeetsFloor } from "./ledger/review-range";
import {
  normalizeReviewRole,
  canonicalJson,
  nowIso,
  type TaskRepoRecord,
  type RunbookTagAction,
  type RunbookPrAction,
} from "./ledger/types";
import { withImmediateTx } from "./ledger/transactions";
import { syncPr } from "./ledger/delivery-tools";
import { handoff } from "./ledger/handoff";
import { fatMerge } from "./ledger/fat-merge";

function git(dir: string, args: string[], env?: Record<string, string | undefined>) {
  const r = env ? runProcess(["git", "-C", dir, ...args], { env }) : runGit(dir, args);
  if (r.code) throw Error("git " + args[0] + " failed: " + r.stderr);
  return r.stdout;
}
function live(e: Envelope) {
  const forge = process.env.FORGE_SESSION_ID,
    codex = process.env.CODEX_SESSION_ID;
  if (forge && codex && forge !== codex) throw Error("Conflicting runtime session identifiers");
  const sid = forge || codex;
  if (!sid || sid !== e.approved_session_id) throw Error("Session does not match human approval");
  if (!e.expires_at || !(Date.parse(e.expires_at) >= Date.now())) throw Error("Envelope expired");
}
function checkEvidence(
  ledger: Ledger,
  e: Envelope,
  row: TaskRepoRecord,
  dir: string,
  head: string,
  policy: ShipPolicy,
) {
  const check = ledger.checkPushReadiness({
    task_id: e.task_id,
    repo: row.repo,
    branch: row.branch,
    checkoutDir: dir,
    head_sha: head,
  });
  if (!check.ready) throw Error(check.missing.join(", "));
  const reviewFloor = ledger.getSpecState(e.task_id).evidence_floor_seq.review;
  const kinds = new Map<string, string>(),
    roles = new Map<string, string>();
  for (const ev of ledger.getTaskEvents(e.task_id)) {
    if (
      ev.event_type !== "EVIDENCE_CAPTURED" ||
      ev.seq <= e.freeze_seq ||
      !ev.repo ||
      canonicalRepoPath(ledger.workbenchRoot, ev.repo) !== row.repo ||
      ev.branch !== row.branch ||
      ev.sha !== head
    )
      continue;
    const p = JSON.parse(ev.payload_json);
    if (p.source !== "tool") continue;
    if (
      p.kind === "review" &&
      coversReviewBase(ledger.workbenchRoot, row, p.meta?.base) &&
      reviewMeetsFloor(p.status, p.meta, e.task_id, reviewFloor, undefined, "tool")
    )
      roles.set(normalizeReviewRole(p.meta?.role), p.status);
    else if (["lint", "test", "build", "hurl"].includes(p.kind)) kinds.set(p.kind, p.status);
  }
  if ([...roles.values()].includes("fail")) throw Error("Unresolved branch-local review failure");
  const full = ledger.getTask(e.task_id)?.verification_depth === "full";
  if (
    [...kinds.values()].some((status) => status !== "pass") ||
    ![...kinds.values()].includes("pass") ||
    (full && (kinds.get("lint") !== "pass" || !["test", "hurl", "build"].some((k) => kinds.get(k) === "pass")))
  )
    throw Error("Missing tool-backed verification at frozen HEAD");
  if (
    (policy.require_independent_review || e.target_endpoint === "pr" || full) &&
    ![...roles].some(
      ([role, status]) =>
        status === "pass" && (!full || ["quality", "business-review", "codex-review", "default"].includes(role)),
    )
  )
    throw Error("Missing independent tool review at frozen HEAD");
}
function diffScope(
  dir: string,
  row: Pick<TaskRepoRecord, "repo" | "base_sha">,
  head: string,
  allowed: boolean,
  paths: string[],
  policy: ShipPolicy,
  files: Set<string>,
  env?: Record<string, string | undefined>,
) {
  const range = row.base_sha + ".." + head;
  const common = ["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "-z"];
  const tokens = git(
    dir,
    [...common, "--raw", "--no-abbrev", "--no-renames", "-M", "-l0", range, "--"],
    env,
  ).split("\0");
  for (let i = 0; i < tokens.length - 1; ) {
    const header = /^:(\d{6}) (\d{6}) [a-f0-9]+ [a-f0-9]+ ([ADMT]|R\d+)$/.exec(tokens[i++]);
    if (!header) throw Error("Unsupported Git diff record");
    if (header[1] === "160000" || header[2] === "160000") throw Error("Submodule changes require manual delivery");
    for (let n = header[3].startsWith("R") ? 2 : 1; n > 0; n--) {
      const path = tokens[i++];
      if (!path || path.includes("\ufffd") || path.includes("\\")) throw Error("Invalid Git path");
      if (policy.forbidden_paths.some((g) => matchesGlob(path.toLowerCase(), g.toLowerCase())))
        throw Error("Forbidden path: " + path);
      if (!allowed || !paths.some((g) => matchesGlob(path, g, true)))
        throw Error("Change outside allowed scope: " + row.repo + "/" + path);
      if (/\.sql$/i.test(path)) throw Error("Fast-track cannot authorize SQL migrations: " + path);
      files.add(JSON.stringify([row.repo, path]));
    }
  }
  let lines = 0;
  for (const entry of git(dir, [...common, "--numstat", "--no-renames", range, "--"], env)
    .split("\0")
    .filter(Boolean)) {
    const m = /^(\d+)\t(\d+)\t/.exec(entry);
    if (!m) throw Error("Binary or unreadable diff in " + row.repo);
    lines += Number(m[1]) + Number(m[2]);
  }
  return lines;
}
function deliveryPr(dir: string, branch: string, head: string, base: string, prod: boolean, ci: boolean) {
  const bin = (prod && process.env.FORGE_GH_BIN) || "gh";
  const view = (selector?: string) =>
    inspectPr(dir, branch, selector, process.env, 3000, { bin, mergeability: prod, baseOid: true });
  const pr = view();
  const verify = (data: typeof pr) => {
    if (data.headRefOid !== head || !data.baseRefName || data.baseRefName !== pr.baseRefName)
      throw Error("Production PR head or target changed");
    if (data.baseRefOid !== pr.baseRefOid || data.state !== pr.state)
      throw Error("PR target changed during evaluation");
    const ref = "refs/remotes/origin/" + data.baseRefName;
    if (
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(data.baseRefOid) ||
      runGit(dir, ["merge-base", "--is-ancestor", base, data.baseRefOid]).code ||
      !reachableFromRefs(dir, base, [ref])
    )
      throw Error("Approved diff base is outside PR target; refresh origin refs");
    if (
      data.state === "MERGED"
        ? !reachableFromRefs(dir, head, [ref]) ||
          Boolean(runGit(dir, ["merge-base", "--is-ancestor", head, data.baseRefOid]).code)
        : prod &&
          (data.mergeable !== "MERGEABLE" || ["DIRTY", "BLOCKED", "UNKNOWN"].includes(data.mergeStateStatus))
    )
      throw Error("Production PR is not verifiably mergeable or merged on its target");
  };
  verify(pr);
  if (prod) {
    if (!ci) throw Error("Production fast-track requires green CI");
    const checks = runProcess([bin, "pr", "checks", pr.url, "--required", "--json", "name,bucket"], {
      cwd: dir,
      env: checkoutEnvironment(),
      timeoutMs: 3000,
    });
    if (checks.code) throw Error("Required CI checks failed or unavailable: " + checks.stderr);
    const rows = JSON.parse(checks.stdout);
    if (!Array.isArray(rows) || !rows.length || rows.some((r) => !r.name || r.bucket !== "pass"))
      throw Error("Required CI checks are missing, pending or failing");
    verify(view(pr.url));
  }
  let from = git(dir, ["merge-base", pr.baseRefOid, head]).trim(),
    to = head;
  if (pr.state === "MERGED") {
    const merge = pr.mergeCommit?.oid;
    if (
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(merge) ||
      runGit(dir, ["merge-base", "--is-ancestor", merge, pr.baseRefOid]).code ||
      runGit(dir, ["rev-parse", "--verify", merge + "^2"]).stdout.trim() !== head
    )
      throw Error("Cannot verify deployed merge parents for rollback");
    from = git(dir, ["rev-parse", merge + "^1"]).trim();
    to = merge;
  }
  return {
    from,
    to,
    baseOid: String(pr.baseRefOid),
    url: String(pr.url),
    number: Number(pr.url.split("/").pop()),
    base: String(pr.baseRefName),
    state: String(pr.state),
  };
}
// Simulate the merge in a temporary object store, preserving the caller's refs, index and objects.
function inspectMerge(
  repo: string,
  dir: string,
  target: string,
  head: string,
  check: ReturnType<typeof deliveryDiff>,
) {
  if (!runGit(dir, ["merge-base", "--is-ancestor", target, head]).code) return check(repo, dir, target, head);
  const original = git(dir, ["rev-parse", "--path-format=absolute", "--git-path", "objects"]).trim();
  const objects = mkdtempSync(join(tmpdir(), "forge-ship-objects-"));
  try {
    const env = {
      ...checkoutEnvironment(),
      GIT_OBJECT_DIRECTORY: objects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: original,
    };
    const result = git(dir, ["merge-tree", "--write-tree", target, head], env).trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(result)) throw Error("Cannot verify prospective merge tree");
    check(repo, dir, target, result, env);
  } finally {
    rmSync(objects, { recursive: true, force: true });
  }
}
function deliveryDiff(policy: ShipPolicy, paths: string[]) {
  const files = new Set<string>();
  let lines = 0;
  return (repo: string, dir: string, from: string, to: string, env?: Record<string, string | undefined>) => {
    lines += diffScope(dir, { repo, base_sha: from }, to, true, paths, policy, files, env);
    if (files.size > policy.max_files_changed || lines > policy.max_lines_changed)
      throw Error("Delivery diff exceeds policy cap");
  };
}
function fatDestination(dir: string) {
  const fetch = git(dir, ["remote", "get-url", "--all", "origin"]).trim();
  const push = git(dir, ["remote", "get-url", "--push", "--all", "origin"]).trim();
  if (!fetch || fetch.includes("\n") || fetch !== push)
    throw Error("FAT requires one matching origin fetch and push URL");
  const match = /^([0-9a-f]{40}|[0-9a-f]{64})\s+refs\/heads\/fat$/.exec(
    git(dir, ["ls-remote", "--exit-code", "origin", "refs/heads/fat"]).trim(),
  );
  if (!match) throw Error("Cannot verify live FAT destination");
  return match[1];
}
function pendingSql(ledger: Ledger, e: Envelope) {
  return ledger.db
    .query(
      "SELECT 1 FROM runbooks WHERE task_id=? AND status IN ('PENDING','APPROVED') AND json_array_length(actions_json,'$.sql_files')>0 LIMIT 1",
    )
    .get(e.task_id);
}
export function evaluateFastTrackEnvelope(ledger: Ledger, e: Envelope, tagSpecs: string[] = []) {
  if (e.status !== "ACTIVE") throw Error("Envelope is " + e.status);
  live(e);
  const policy = validateScope(ledger, e);
  const approved = ledger
    .getTaskEvents(e.task_id)
    .findLast(
      (ev) => ev.event_type === "FAST_TRACK_APPROVED" && JSON.parse(ev.payload_json).envelope_id === e.envelope_id,
    );
  if (
    !approved ||
    approved.session_id !== e.approved_session_id ||
    JSON.parse(approved.payload_json).expires_at !== e.expires_at
  )
    throw Error("Invalid ledger approval binding");
  if (pendingSql(ledger, e)) throw Error("Task has pending SQL actions; human takeover required");
  const allowed = JSON.parse(e.allowed_repos_json) as string[],
    paths = JSON.parse(e.allowed_path_globs_json) as string[];
  const files = new Set<string>();
  const checkDelivery = deliveryDiff(policy, paths);
  const checkedHeads: Record<string, string> = {};
  let lines = 0;
  const items: Array<{
    repo: string;
    branch: string;
    head: string;
    base: string;
    dir: string;
    pr: ReturnType<typeof deliveryPr> | null;
  }> = [];
  for (const row of ledger.getTaskRepos(e.task_id)) {
    const { dir, registered } = resolveTaskCheckout(ledger.workbenchRoot, row);
    if (
      !registered ||
      git(dir, ["status", "--porcelain", "-z", "--untracked-files=all", "--ignore-submodules=none"])
    )
      throw Error("Expected a clean attached worktree: " + row.repo + ":" + row.branch);
    const head = git(dir, ["rev-parse", "--verify", "refs/heads/" + row.branch + "^{commit}"]).trim();
    if (
      head !== git(dir, ["rev-parse", "HEAD"]).trim() ||
      runGit(dir, ["merge-base", "--is-ancestor", row.base_sha!, head]).code
    )
      throw Error("Branch is outside its verified base");
    checkedHeads[JSON.stringify([row.repo, row.branch])] = head;
    lines += diffScope(dir, row, head, allowed.includes(row.repo), paths, policy, files);
    if (files.size > policy.max_files_changed || lines > policy.max_lines_changed)
      throw Error("Changed-file or line cap exceeded");
    if (!allowed.includes(row.repo)) {
      if (e.target_endpoint === "pr") throw Error("PR handoff requires all attached repos in scope");
      continue;
    }
    checkEvidence(ledger, e, row, dir, head, policy);
    const pr =
      e.target_endpoint !== "fat"
        ? deliveryPr(
            dir,
            row.branch,
            head,
            row.base_sha!,
            e.target_endpoint === "prod",
            policy.require_ci_green_for_prod,
          )
        : null;
    if (pr?.state === "OPEN") inspectMerge(row.repo, dir, pr.baseOid, head, checkDelivery);
    else if (pr) checkDelivery(row.repo, dir, pr.from, pr.to);
    else {
      const target = fatDestination(dir);
      if (runGit(dir, ["merge-base", "--is-ancestor", row.base_sha!, target]).code)
        throw Error("Refresh FAT tracking refs to verify destination base");
      inspectMerge(row.repo, dir, target, head, checkDelivery);
    }
    items.push({ repo: row.repo, branch: row.branch, base: row.base_sha!, dir, head, pr });
  }
  if (!items.length) throw Error("No authorized delivery items");
  const tagRemotes = new Map<string, string>();
  const checkTagDiff = deliveryDiff(policy, paths);
  const tags: RunbookTagAction[] = tagSpecs.map((spec) => {
    const [repo, tag, ...extra] = spec.split(":");
    const targets = items.filter((i) => i.repo === repo);
    if (
      e.target_endpoint !== "prod" ||
      targets.length !== 1 ||
      extra.length ||
      !tag ||
      tag.startsWith("-") ||
      runGit(targets[0].dir, ["check-ref-format", "refs/tags/" + tag]).code
    )
      throw Error("Invalid tag or ambiguous tag target: " + spec);
    const target = targets[0],
      pr = target.pr!;
    let remote = tagRemotes.get(repo);
    if (!remote) {
      remote = verifyTagBase(target.dir, pr.base, pr.baseOid, target.head);
      checkTagDiff(repo, target.dir, pr.baseOid, target.head);
      tagRemotes.set(repo, remote);
    }
    return { repo, tag, sha: target.head, remote };
  });
  const prs: RunbookPrAction[] = items.flatMap((i) =>
    i.pr
      ? [
          {
            repo: i.repo,
            number: i.pr.number,
            pin: {
              url: i.pr.url,
              branch: i.branch,
              base: i.pr.base,
              base_oid: i.pr.baseOid,
              head: i.head,
              ...(i.pr.state === "MERGED" && { merged_oid: i.pr.to }),
            },
          },
        ]
      : [],
  );
  const openTargets = items
    .filter((i) => i.pr?.state === "OPEN")
    .map((i) => [i.pr!.url.split("/pull/")[0].toLowerCase(), i.pr!.base].join(":"));
  if (e.target_endpoint === "prod" && new Set(openTargets).size !== openTargets.length)
    throw Error("Production PRs share a target; prepare separate envelopes after each merge");
  const runbook =
    e.target_endpoint === "prod"
      ? {
          task_id: e.task_id,
          title: "Fast-track " + e.envelope_id,
          actions: { prs, tags, sql_files: [], kubectl_commands: [] },
        }
      : null;
  live(e);
  const steps =
    e.target_endpoint === "fat"
      ? items.map((i) => ["wb-git", "fat-merge", i.repo, i.branch, "--fat-branch", "fat", "--task", e.task_id])
      : e.target_endpoint === "pr"
        ? [
            ...items.map((i) => [
              "ledger",
              "pr-sync",
              e.task_id,
              "--repo",
              i.repo,
              "--branch",
              i.branch,
              "--pr",
              i.pr!.url,
            ]),
            ["ledger", "handoff", e.task_id],
          ]
        : [["create-approved-runbook", e.envelope_id]];
  return {
    endpoint: e.target_endpoint,
    items,
    tags,
    steps,
    checkedHeads,
    runbook,
    changed_files: files.size,
    changed_lines: lines,
  };
}
type Plan = ReturnType<typeof evaluateFastTrackEnvelope>;
function halted(ledger: Ledger, e: Envelope) {
  return {
    ok: false,
    status: e.status,
    reason: e.degraded_reason,
    delivery: e.target_endpoint === "fat" ? progress(ledger, e) : [],
    takeover:
      e.status === "PENDING"
        ? "Await human approval."
        : e.run_token && e.status === "ACTIVE"
          ? "Redemption claimed; inspect the delivery receipts and revoke before manual recovery."
          : "Use manual delivery or prepare a new envelope.",
  };
}
function failure(ledger: Ledger, e: Envelope, why: unknown) {
  const reason = { message: why instanceof Error ? why.message : String(why) };
  const status = e.expires_at && Date.now() > Date.parse(e.expires_at) ? "EXPIRED" : "DEGRADED";
  const changed = ledger.db
    .query(
      "UPDATE fast_track_envelopes SET status=?,degraded_reason=?,updated_at=? WHERE envelope_id=? AND status='ACTIVE'",
    )
    .run(status, canonicalJson(reason), nowIso(), e.envelope_id).changes;
  if (!changed) return halted(ledger, envelope(ledger, e.envelope_id));
  trackEvent(ledger, e, "FAST_TRACK_DEGRADED", { status, reason });
  return { ...halted(ledger, envelope(ledger, e.envelope_id)), reason };
}
function complete(ledger: Ledger, e: Envelope, plan: Plan, runbook: string | null = null) {
  const ts = nowIso();
  ledger.db
    .query(
      "UPDATE fast_track_envelopes SET status='REDEEMED',redeemed_at=?,updated_at=?,redeemed_runbook_id=? WHERE envelope_id=?",
    )
    .run(ts, ts, runbook, e.envelope_id);
  trackEvent(ledger, e, "FAST_TRACK_REDEEMED", {
    scope_hash: e.scope_hash,
    heads: plan.items.map(({ repo, branch, head }) => ({ repo, branch, head })),
    runbook_id: runbook,
  });
}
function recheck(ledger: Ledger, e: Envelope, plan: Plan, token: string | null) {
  const current = envelope(ledger, e.envelope_id);
  if (current.status !== "ACTIVE" || current.run_token !== token) throw Error("Redemption no longer active");
  live(current);
  const policy = validateScope(ledger, current);
  if (ledger.getTaskBlockers(e.task_id).some((b) => b.status === "OPEN") || pendingSql(ledger, e))
    throw Error("Open blocker or pending SQL action");
  for (const row of ledger.getTaskRepos(e.task_id)) {
    const i = plan.items.find((item) => item.repo === row.repo && item.branch === row.branch);
    const { dir, registered } = resolveTaskCheckout(ledger.workbenchRoot, row);
    const head = plan.checkedHeads[JSON.stringify([row.repo, row.branch])];
    if (
      !registered ||
      git(dir, ["rev-parse", "HEAD"]).trim() !== head ||
      git(dir, ["rev-parse", "refs/heads/" + row.branch]).trim() !== head ||
      git(dir, ["status", "--porcelain", "-z", "--untracked-files=all", "--ignore-submodules=none"])
    )
      throw Error("Checkout changed during redemption");
    if (i) checkEvidence(ledger, e, row, dir, i.head, policy);
  }
}
function rollbackCommand(i: Plan["items"][number]) {
  const url = "'" + i.pr!.url.replaceAll("'", "'\\''") + "'";
  return (
    "merge=$(gh pr view " +
    url +
    ' --json mergeCommit --jq .mergeCommit.oid) && test "$(git rev-parse --verify "$merge^2")" = ' +
    i.head +
    ' && git merge-base --is-ancestor "$merge" HEAD && git revert -m 1 "$merge"'
  );
}
function deliver(ledger: Ledger, e: Envelope, plan: Plan, token: string) {
  const check = () => recheck(ledger, e, plan, token);
  const tx = <T>(fn: () => T) => withImmediateTx(ledger.db, fn);
  if (e.target_endpoint === "fat") {
    const checkDelivery = deliveryDiff(validateScope(ledger, e), JSON.parse(e.allowed_path_globs_json));
    for (const i of plan.items) {
      const pushed = fatMerge(
        ledger,
        i.repo,
        i.branch,
        "fat",
        e.task_id,
        false,
        false,
        undefined,
        (head, target, newSha) => {
          if (head !== i.head || runGit(i.dir, ["merge-base", "--is-ancestor", i.base, target]).code)
            throw Error("FAT source or destination outside approved range");
          checkDelivery(i.repo, i.dir, target, newSha);
          if (fatDestination(i.dir) !== target) throw Error("FAT destination changed before push");
          tx(() => {
            check();
            trackEvent(ledger, e, "FAST_TRACK_PUSH_INTENT", {
              repo: i.repo,
              branch: i.branch,
              ref: "refs/heads/fat",
              old_sha: target,
              new_sha: newSha,
            });
          });
        },
        i.dir,
      );
      if (fatDestination(i.dir) !== pushed.fat_sha) throw Error("Cannot confirm FAT ref after push");
      tx(() =>
        trackEvent(ledger, e, "FAST_TRACK_PUSH_CONFIRMED", {
          repo: i.repo,
          branch: i.branch,
          new_sha: pushed.fat_sha,
        }),
      );
    }
    tx(() => {
      check();
      complete(ledger, e, plan);
    });
    return { ok: true, status: "REDEEMED", result: progress(ledger, e) };
  }
  if (e.target_endpoint === "pr") {
    tx(() => {
      check();
      if (!["pr", "prod"].includes(ledger.getTask(e.task_id)!.endpoint))
        ledger.updateEndpoint({ task_id: e.task_id, endpoint: "pr" });
    });
    for (const i of plan.items) syncPr(ledger, e.task_id, i.repo, i.pr!.url, i.branch, check);
    const result = handoff(ledger, e.task_id, [], undefined, {
      verifyTarget(repo, branch, oid, state) {
        const pin = plan.items.find((i) => i.repo === repo && i.branch === branch)?.pr;
        if (!pin || pin.baseOid !== oid || pin.state !== state)
          throw Error("Live PR target changed during handoff");
      },
      beforeRecord(items) {
        check();
        if (
          items.some(
            (item) =>
              !plan.items.some(
                (i) =>
                  i.repo === item.repo &&
                  i.branch === item.branch &&
                  i.head === item.verified_head &&
                  i.pr!.url === item.pr_url &&
                  i.pr!.base === item.base_branch,
              ),
          )
        )
          throw Error("Handoff scope changed");
      },
      afterRecord() {
        complete(ledger, e, plan);
      },
    });
    return { ok: true, status: "REDEEMED", result };
  }
  const policy = validateScope(ledger, e);
  for (const i of plan.items) {
    const refreshed = deliveryPr(i.dir, i.branch, i.head, i.base, true, policy.require_ci_green_for_prod);
    if (canonicalJson(refreshed) !== canonicalJson(i.pr))
      throw Error("Live production PR changed during redemption");
    if (plan.tags.some((tag) => tag.repo === i.repo))
      verifyTagBase(i.dir, refreshed.base, refreshed.baseOid, i.head);
  }
  return tx(() => {
    check();
    const rb = ledger.createRunbook(plan.runbook!);
    ledger.db
      .query(
        "UPDATE runbooks SET status='APPROVED',approved_at=?,approved_session_id=?,expires_at=? WHERE runbook_id=? AND status='PENDING'",
      )
      .run(nowIso(), e.approved_session_id, e.expires_at, rb.runbook_id);
    trackEvent(ledger, e, "ENVELOPE_REDEEMED", { runbook_id: rb.runbook_id, actions_hash: rb.actions_hash });
    complete(ledger, e, plan, rb.runbook_id);
    return {
      ok: true,
      status: "REDEEMED",
      runbook_id: rb.runbook_id,
      result: {
        runbook: ledger.getRunbook(rb.runbook_id),
        rollback: plan.items.map((i) => ({ repo: i.repo, command: rollbackCommand(i) })),
      },
    };
  });
}
export function shipCli(argv: string[]) {
  const [cmd, ...args] = argv;
  if (!["evaluate", "run"].includes(cmd)) throw Error("Expected forge-ship evaluate|run --envelope <id>");
  const { values: v } = parseArgs({
    args,
    options: {
      envelope: { type: "string" },
      json: { type: "boolean" },
      "dry-run": { type: "boolean" },
      tag: { type: "string", multiple: true },
    },
  });
  if (!v.envelope || (cmd === "evaluate" && v["dry-run"])) throw Error("Invalid forge-ship arguments");
  const ledger = new Ledger(findWorkbenchRoot());
  try {
    const id = v.envelope;
    // Persist a one-use claim before the first external push. A crash leaves the claim for human recovery.
    const token = randomUUID();
    const execute = cmd === "run" && !v["dry-run"];
    const e = envelope(ledger, id);
    if (e.run_token || e.status !== "ACTIVE") return halted(ledger, e);
    try {
      const tip = ledger.getTask(e.task_id)?.tip_hash;
      const plan = evaluateFastTrackEnvelope(ledger, e, v.tag);
      const claim = withImmediateTx(ledger.db, () => {
        const current = envelope(ledger, id);
        if (current.status !== "ACTIVE" || current.run_token) return false;
        if (ledger.getTask(e.task_id)?.tip_hash !== tip) throw Error("Task evidence changed during evaluation");
        recheck(ledger, e, plan, null);
        if (execute) {
          ledger.db.query("UPDATE fast_track_envelopes SET run_token=? WHERE envelope_id=?").run(token, id);
          trackEvent(ledger, e, "FAST_TRACK_CLAIMED", {
            items: plan.items.map(({ repo, branch, head }) => ({ repo, branch, head })),
          });
        }
        return true;
      });
      if (!claim) return halted(ledger, envelope(ledger, id));
      if (!execute) return { ok: true, status: "ELIGIBLE", plan };
      return deliver(ledger, e, plan, token);
    } catch (error) {
      return withImmediateTx(ledger.db, () => {
        const current = envelope(ledger, id);
        if (current.status !== "ACTIVE" || (current.run_token && current.run_token !== token))
          return halted(ledger, current);
        return failure(ledger, current, error);
      });
    }
  } finally {
    ledger.closeDb();
  }
}
