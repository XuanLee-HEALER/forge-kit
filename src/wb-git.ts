import { appendFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { findWorkbenchRoot, loadWorkbenchConfig } from "./config";
import { listWorkbenchRepos, runGit, runProcess } from "./git";
import { fatMerge } from "./ledger/fat-merge";
import { Ledger } from "./ledger";

export interface WorktreeInfo {
  path: string;
  relPath: string;
  branch: string | null;
  prunable: boolean;
}

export interface RepoGitFact {
  repo: string;
  defaultBranch: string;
  branch: string | null;
  dirtyCount: number;
  worktrees: WorktreeInfo[];
  mergedLocal: Array<{ branch: string; date: string; inWorktree: boolean }>;
  mergedRemote: Array<{ branch: string; date: string; sha: string }>;
  prStatus: "ok" | "skipped" | "no-remote" | "unknown";
  prs?: Array<{
    number: number;
    title: string;
    headRefName: string;
    baseRefName: string;
    isDraft: boolean;
  }> | null;
}

const DEFAULT_KEEP_RE = "^(main|master|fat)$";

export function collectGitFacts(
  workbenchRoot: string,
  opts?: { withPrs?: boolean; onlyRepo?: string; includeUnregistered?: boolean },
): { at: string; repos: RepoGitFact[] } {
  const canonicalRoot = existsSync(workbenchRoot)
    ? realpathSync(workbenchRoot)
    : workbenchRoot;
  const cfg = loadWorkbenchConfig(canonicalRoot);
  const discovered = listWorkbenchRepos(canonicalRoot);
  // Strict scope: when `repos` is empty, only inspect discovered repos if explicitly opted in.
  const repoNames = opts?.includeUnregistered
    ? [...new Set([...cfg.repos, ...discovered])].filter((r) =>
        existsSync(join(canonicalRoot, r, ".git")),
      )
    : cfg.repos.filter((r) => existsSync(join(canonicalRoot, r, ".git")));

  const targets = opts?.onlyRepo
    ? repoNames.filter((r) => r === opts.onlyRepo)
    : repoNames;

  const out: RepoGitFact[] = [];
  for (const name of targets) {
    const repoPath = join(canonicalRoot, name);
    const sym = runGit(repoPath, [
      "symbolic-ref",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    const symRef = sym.code === 0 ? sym.stdout.replace(/\r?\n$/, "") : "";
    const headRef =
      symRef
        ? symRef
        : runGit(repoPath, ["rev-parse", "--verify", "refs/remotes/origin/main"]).code === 0
          ? "origin/main"
          : runGit(repoPath, ["rev-parse", "--verify", "refs/heads/main"]).code === 0
            ? "main"
            : "master";
    const defaultBranch = headRef.includes("/")
      ? headRef.split("/").slice(1).join("/")
      : headRef;
    const me = runGit(repoPath, ["config", "user.email"]).stdout.trim();

    const dirtyRaw = runGit(repoPath, ["status", "--porcelain"]).stdout.trim();
    const dirtyCount = dirtyRaw ? dirtyRaw.split("\n").length : 0;

    // Worktrees
    const wtRaw = runGit(repoPath, ["worktree", "list", "--porcelain"]).stdout;
    const wts: WorktreeInfo[] = [];
    let cur: Partial<WorktreeInfo> | null = null;
    for (const rawLine of [...wtRaw.split("\n"), ""]) {
      const line = rawLine.replace(/\r$/, "");
      if (line.startsWith("worktree ")) {
        const rawPath = line.slice(9);
        const fullPath = existsSync(rawPath) ? realpathSync(rawPath) : rawPath;
        cur = {
          path: fullPath,
          relPath: relative(canonicalRoot, fullPath),
          branch: null,
          prunable: false,
        };
      } else if (line.startsWith("branch ") && cur) {
        cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
      } else if (line.startsWith("prunable") && cur) {
        cur.prunable = true;
      } else if (line === "" && cur?.path) {
        wts.push(cur as WorktreeInfo);
        cur = null;
      }
    }

    const mainWt = wts[0];
    const extraWts = wts.slice(1);
    const busyBranches = new Set(
      wts.map((w) => w.branch).filter((b): b is string => Boolean(b)),
    );
    const keep = new Set([defaultBranch, "fat", "HEAD", ...cfg.guard.protected_branches]);
    const fmt =
      "--format=%(refname:short)|%(authoremail:trim)|%(committerdate:short)|%(objectname)";

    const localRaw = runGit(repoPath, [
      "for-each-ref",
      "--merged",
      headRef,
      fmt,
      "refs/heads",
    ]).stdout;
    const mergedLocal = localRaw
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("|"))
      .filter(([b]) => b && !keep.has(b))
      .map(([branch, , date]) => ({
        branch,
        date: date ?? "",
        inWorktree: busyBranches.has(branch),
      }));

    const remoteRaw = runGit(repoPath, [
      "for-each-ref",
      "--merged",
      headRef,
      fmt,
      "refs/remotes/origin",
    ]).stdout;
    const mergedRemote = remoteRaw
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("|"))
      .filter(([ref, mail]) => {
        if (!ref || !ref.includes("/")) return false;
        const short = ref.split("/").slice(1).join("/");
        return !keep.has(short) && Boolean(me) && mail === me;
      })
      .map(([ref, , date, sha]) => ({
        branch: ref.split("/").slice(1).join("/"),
        date: date ?? "",
        sha: sha ?? "",
      }));

    const item: RepoGitFact = {
      repo: name,
      defaultBranch,
      branch: mainWt?.branch ?? null,
      dirtyCount,
      worktrees: extraWts,
      mergedLocal,
      mergedRemote,
      prStatus: "skipped",
    };

    if (opts?.withPrs) {
      const originUrl = runGit(repoPath, ["remote", "get-url", "origin"]).stdout;
      if (!originUrl.includes("github.com")) {
        item.prStatus = "no-remote";
      } else {
        // Query ALL open PRs (not just @me) so teammates' open PR branches are never swept!
        const prRes = runProcess(
          [
            "gh",
            "pr",
            "list",
            "--state",
            "open",
            "--limit",
            "200",
            "--json",
            "number,title,headRefName,baseRefName,isDraft",
          ],
          { cwd: repoPath, timeoutMs: 20_000 },
        );
        if (prRes.code === 0 && prRes.stdout.trim()) {
          try {
            const parsed = JSON.parse(prRes.stdout);
            if (Array.isArray(parsed) && parsed.length < 200) {
              item.prs = parsed;
              item.prStatus = "ok";
            } else {
              // Truncated at --limit 200 (or unexpected shape): treat as unknown so sweep never deletes active PR branches
              item.prs = null;
              item.prStatus = "unknown";
            }
          } catch {
            item.prs = null;
            item.prStatus = "unknown";
          }
        } else {
          item.prs = null;
          item.prStatus = "unknown";
        }
      }
    }

    out.push(item);
  }

  return { at: new Date().toISOString(), repos: out };
}

export function printGitFacts(facts: { repos: RepoGitFact[] }): void {
  for (const r of facts.repos) {
    const bits: string[] = [];
    if (r.dirtyCount > 0) bits.push(`dirty ${r.dirtyCount}`);
    if (r.worktrees.length) bits.push(`worktree ${r.worktrees.length}`);
    if (r.mergedLocal.length) bits.push(`merged(local) ${r.mergedLocal.length}`);
    if (r.mergedRemote.length) bits.push(`merged(remote) ${r.mergedRemote.length}`);
    if (r.prStatus === "unknown") bits.push("PRs unknown");
    else if (r.prs?.length) bits.push(`open PR ${r.prs.length}`);
    console.log(
      `${r.repo} [${r.branch ?? "detached"}]  ${bits.join(", ") || "clean (no dirty files, no sweep candidates)"}`,
    );
    for (const w of r.worktrees) {
      console.log(
        `  wt  ${w.relPath}  (${w.branch ?? "detached"})${w.prunable ? "  [prunable]" : ""}`,
      );
    }
    for (const b of r.mergedLocal) {
      console.log(
        `  merged local  ${b.branch}  ${b.date}${b.inWorktree ? "  [in worktree]" : ""}`,
      );
    }
    for (const b of r.mergedRemote) {
      console.log(`  merged remote ${b.branch}  ${b.date}`);
    }
    for (const p of r.prs ?? []) {
      console.log(`  PR #${p.number} ${p.headRefName} -> ${p.baseRefName}  ${p.title}`);
    }
  }
}

function loadProtectedOpenTaskRefs(workbenchRoot: string): {
  branches: Set<string>;
  worktrees: Set<string>;
} {
  const branches = new Set<string>();
  const worktrees = new Set<string>();
  const ledgerPath = join(workbenchRoot, ".workbench", "ledger", "ledger.sqlite");
  if (!existsSync(ledgerPath)) return { branches, worktrees };
  const ledger = new Ledger(workbenchRoot);
  try {
    for (const task of ledger.listOpenTasks()) {
      for (const r of ledger.getTaskRepos(task.task_id)) {
        branches.add(`${r.repo}:${r.branch}`);
        if (r.worktree && existsSync(r.worktree)) {
          worktrees.add(realpathSync(r.worktree));
        } else if (r.worktree) {
          worktrees.add(r.worktree);
        }
      }
    }
  } finally {
    ledger.closeDb();
  }
  return { branches, worktrees };
}

export function sweepMergedBranches(
  workbenchRoot: string,
  opts: {
    apply: boolean;
    repo?: string;
    keepPattern?: string;
    fetch?: boolean;
    includeUnregistered?: boolean;
  },
): {
  deletedLocal: Array<{ repo: string; branch: string; sha: string }>;
  deletedRemote: Array<{ repo: string; branch: string; sha: string }>;
  plannedLocal: Array<{ repo: string; branch: string }>;
  plannedRemote: Array<{ repo: string; branch: string }>;
  skippedOpenTasks: string[];
  skippedFetchFailed: string[];
} {
  const canonicalRoot = existsSync(workbenchRoot)
    ? realpathSync(workbenchRoot)
    : workbenchRoot;
  const cfg = loadWorkbenchConfig(canonicalRoot);
  const keepRe = new RegExp(opts.keepPattern || DEFAULT_KEEP_RE);
  const protectedBranches = new Set(cfg.guard.protected_branches);
  const sweepLog = join(canonicalRoot, ".workbench", "sweep-log.jsonl");
  const openProtected = loadProtectedOpenTaskRefs(canonicalRoot);

  const initial = collectGitFacts(canonicalRoot, {
    onlyRepo: opts.repo,
    includeUnregistered: opts.includeUnregistered,
  });

  const skippedFetchFailed: string[] = [];
  if (opts.fetch !== false) {
    for (const r of initial.repos) {
      const repoPath = join(canonicalRoot, r.repo);
      if (runGit(repoPath, ["remote", "get-url", "origin"]).code === 0) {
        const res = runGit(repoPath, ["fetch", "origin", "--prune"], 60_000);
        if (res.code !== 0) {
          skippedFetchFailed.push(r.repo);
          console.log(`${r.repo}: git fetch failed, skipping sweep for safety`);
        }
      }
    }
  }
  const fetchFailedSet = new Set(skippedFetchFailed);
  const skippedOpenTasks: string[] = [];

  // Phase 1: release clean worktrees holding merged branches ONLY if NOT protected by OPEN ledger / keep / PR
  const firstPass = collectGitFacts(canonicalRoot, {
    withPrs: true,
    onlyRepo: opts.repo,
    includeUnregistered: opts.includeUnregistered,
  });
  for (const r of firstPass.repos) {
    if (fetchFailedSet.has(r.repo) || r.prStatus === "unknown") continue;
    const repoPath = join(canonicalRoot, r.repo);
    const openPrHeads = new Set((r.prs ?? []).map((p) => p.headRefName));
    if (opts.apply) runGit(repoPath, ["worktree", "prune"]);
    const mergedSet = new Set(r.mergedLocal.map((b) => b.branch));
    for (const wt of r.worktrees) {
      if (!wt.branch || !mergedSet.has(wt.branch) || wt.prunable) continue;
      if (keepRe.test(wt.branch) || protectedBranches.has(wt.branch)) continue;
      if (openPrHeads.has(wt.branch)) continue;
      const key = `${r.repo}:${wt.branch}`;
      if (openProtected.branches.has(key) || openProtected.worktrees.has(wt.path)) {
        skippedOpenTasks.push(key);
        console.log(`${r.repo}: worktree ${wt.relPath} (${wt.branch}) protected by OPEN task ledger, skipped`);
        continue;
      }
      const dirty = runGit(wt.path, ["status", "--porcelain"]).stdout.trim();
      if (dirty) {
        console.log(`${r.repo}: worktree ${wt.relPath} (${wt.branch}) dirty, skipped`);
      } else if (!opts.apply) {
        console.log(`${r.repo}: would remove clean worktree ${wt.relPath} (${wt.branch})`);
      } else {
        const res = runGit(repoPath, ["worktree", "remove", wt.path], 30_000);
        console.log(
          `${r.repo}: ${res.code === 0 ? "removed" : "failed to remove"} worktree ${wt.relPath} (${wt.branch})`,
        );
      }
    }
  }

  const facts = collectGitFacts(canonicalRoot, {
    withPrs: true,
    onlyRepo: opts.repo,
    includeUnregistered: opts.includeUnregistered,
  });

  const plannedLocal: Array<{ repo: string; branch: string }> = [];
  const plannedRemote: Array<{ repo: string; branch: string }> = [];
  const deletedLocal: Array<{ repo: string; branch: string; sha: string }> = [];
  const deletedRemote: Array<{ repo: string; branch: string; sha: string }> = [];

  const logEntry = (entry: Record<string, unknown>) => {
    mkdirSync(dirname(sweepLog), { recursive: true });
    appendFileSync(sweepLog, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  };

  for (const r of facts.repos) {
    if (fetchFailedSet.has(r.repo) || r.prStatus === "unknown") continue;
    const repoPath = join(canonicalRoot, r.repo);
    const originUrl = runGit(repoPath, ["remote", "get-url", "origin"]).stdout.trim();
    const openPrHeads = new Set((r.prs ?? []).map((p) => p.headRefName));

    const isProtected = (branch: string) => {
      const key = `${r.repo}:${branch}`;
      if (openProtected.branches.has(key)) {
        if (!skippedOpenTasks.includes(key)) skippedOpenTasks.push(key);
        return true;
      }
      return keepRe.test(branch) || protectedBranches.has(branch) || openPrHeads.has(branch);
    };

    const local = r.mergedLocal
      .filter((b) => !b.inWorktree && !isProtected(b.branch))
      .map((b) => b.branch);
    const held = new Set(r.mergedLocal.filter((b) => b.inWorktree).map((b) => b.branch));

    let remote: Array<{ branch: string; sha: string }> = [];
    const orgMatch = cfg.git_org ? originUrl.includes(`${cfg.git_org}/`) : false;
    if (orgMatch && r.prStatus === "ok" && r.prs !== null && r.prs !== undefined) {
      remote = r.mergedRemote
        .filter((b) => !held.has(b.branch) && !isProtected(b.branch) && Boolean(b.sha))
        .map((b) => ({ branch: b.branch, sha: b.sha }));
    }

    for (const b of local) plannedLocal.push({ repo: r.repo, branch: b });
    for (const b of remote) plannedRemote.push({ repo: r.repo, branch: b.branch });

    if (!opts.apply) {
      if (local.length || remote.length) {
        console.log(`${r.repo}: plan local=${local.length}, remote=${remote.length}`);
        for (const b of local) console.log(`  local  ${b}`);
        for (const b of remote) console.log(`  remote ${b.branch} (${b.sha.slice(0, 8)})`);
      }
      continue;
    }

    for (const b of local) {
      const sha = runGit(repoPath, ["rev-parse", `refs/heads/${b}`]).stdout.trim();
      let res = runGit(repoPath, ["branch", "-d", b]);
      const headRef =
        runGit(repoPath, ["rev-parse", "--verify", `origin/${r.defaultBranch}`]).code === 0
          ? `origin/${r.defaultBranch}`
          : r.defaultBranch;
      if (
        res.code !== 0 &&
        runGit(repoPath, ["merge-base", "--is-ancestor", sha, headRef]).code === 0
      ) {
        res = runGit(repoPath, ["branch", "-D", b]);
      }
      logEntry({ repo: r.repo, kind: "local", branch: b, sha, deleted: res.code === 0 });
      if (res.code === 0) deletedLocal.push({ repo: r.repo, branch: b, sha });
    }

    for (const b of remote) {
      // Lease uses the EXACT SHA verified as merged during planning (never re-read before delete!).
      const res = runGit(
        repoPath,
        [
          "push",
          "origin",
          `--force-with-lease=refs/heads/${b.branch}:${b.sha}`,
          `:refs/heads/${b.branch}`,
        ],
        60_000,
      );
      logEntry({
        repo: r.repo,
        kind: "remote",
        branch: b.branch,
        sha: b.sha,
        deleted: res.code === 0,
      });
      if (res.code === 0) deletedRemote.push({ repo: r.repo, branch: b.branch, sha: b.sha });
    }
  }

  if (!opts.apply) {
    console.log("Dry-run plan only. Pass --apply to delete; deletions are logged to .workbench/sweep-log.jsonl.");
  }
  return {
    deletedLocal,
    deletedRemote,
    plannedLocal,
    plannedRemote,
    skippedOpenTasks,
    skippedFetchFailed,
  };
}

export function runWbGitCli(): void {
  const [cmd, ...rest] = process.argv.slice(2);
  const root = findWorkbenchRoot();
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(`Usage: wb-git <status|sweep|fat-merge> [options]
  fat-merge <repo> <feature-branch> [--task ID] [--fat-branch fat] [--cherry-pick] [--no-push] [--verify-cmd COMMAND]
  status [--prs] [--json] [--repo <name>] [--all-discovered]
  sweep  [--apply] [--repo <name>] [--keep <regex>] [--no-fetch] [--all-discovered]`);
    process.exit(0);
  }
  if (cmd === "status" || cmd === "git") {
    const { values } = parseArgs({
      args: rest,
      options: {
        prs: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        repo: { type: "string" },
        "all-discovered": { type: "boolean", default: false },
      },
    });
    const facts = collectGitFacts(root, {
      withPrs: values.prs,
      onlyRepo: values.repo,
      includeUnregistered: Boolean(values["all-discovered"]),
    });
    if (values.json) console.log(JSON.stringify(facts, null, 2));
    else printGitFacts(facts);
  } else if (cmd === "fat-merge") {
    const {values, positionals} = parseArgs({args:rest, allowPositionals:true, options:{
      task:{type:"string"}, "verify-cmd":{type:"string"}, "fat-branch":{type:"string", default:"fat"}, "cherry-pick":{type:"boolean"}, "no-push":{type:"boolean"}
    }});
    if (positionals.length !== 2) throw Error("Expected <repo> <feature-branch>");
    const ledger = new Ledger(root);
    try { console.log(JSON.stringify(fatMerge(ledger,positionals[0],positionals[1],values["fat-branch"]!,values.task,values["cherry-pick"],values["no-push"],values["verify-cmd"]))); }
    finally { ledger.closeDb(); }
  } else if (cmd === "sweep") {
    const { values } = parseArgs({
      args: rest,
      options: {
        apply: { type: "boolean", default: false },
        repo: { type: "string" },
        keep: { type: "string" },
        "no-fetch": { type: "boolean", default: false },
        "all-discovered": { type: "boolean", default: false },
      },
    });
    sweepMergedBranches(root, {
      apply: Boolean(values.apply),
      repo: values.repo,
      keepPattern: values.keep,
      fetch: !values["no-fetch"],
      includeUnregistered: Boolean(values["all-discovered"]),
    });
  } else {
    console.error(`Unknown wb-git command: ${cmd}`);
    process.exit(1);
  }
}
