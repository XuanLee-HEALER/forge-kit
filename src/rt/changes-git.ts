import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalRepoPath } from "../config";
import { isOid, offlineGitInvocation } from "../git";

export type ChangesRepo = { repo: string; cwd: string };

export class ChangesError extends Error {
  constructor(readonly kind: "parameter" | "git", message: string) {
    super(message);
  }
}

type GitResult = { ok: boolean; status: number | null; truncated: boolean; stdout: Buffer };
const timeoutMs = 5000;
const maxBytes = 131072;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function git(cwd: string, args: string[]): GitResult {
  const { argv: [program, ...invocation], env } = offlineGitInvocation(cwd, args);
  delete env.GIT_EXEC_PATH;
  const result = spawnSync(program, invocation, {
    env, stdio: ["ignore", "pipe", "ignore"], timeout: timeoutMs,
    maxBuffer: maxBytes, killSignal: "SIGKILL",
  });
  const truncated = (result.error as NodeJS.ErrnoException | undefined)?.code === "ENOBUFS"
    || (result.stdout?.length ?? 0) > maxBytes;
  return {
    ok: !result.error && result.status === 0, status: result.status, truncated,
    stdout: result.stdout?.subarray(0, maxBytes) ?? Buffer.alloc(0),
  };
}

function line(result: GitResult): string | null {
  if (!result.ok || result.truncated) return null;
  try { return utf8.decode(result.stdout).replace(/\n$/, ""); }
  catch { return null; }
}

export function selectChangesRepo(root: string, repos: readonly string[], requested?: string): ChangesRepo {
  const registered = new Set(repos);
  if (requested === undefined && registered.size !== 1) {
    throw new ChangesError("parameter", "Select a registered repository with --repo.");
  }
  let repo: string;
  try { repo = requested === undefined ? [...registered][0] : canonicalRepoPath(root, requested); }
  catch { throw new ChangesError("parameter", "--repo must identify a registered repository."); }
  if (!registered.has(repo)) throw new ChangesError("parameter", "--repo must identify a registered repository.");
  try {
    const cwd = realpathSync(resolve(root, repo));
    const marker = statSync(resolve(cwd, ".git"));
    if (!statSync(cwd).isDirectory() || !(marker.isDirectory() || marker.isFile())) throw Error();
    const top = line(git(cwd, ["rev-parse", "--show-toplevel"]));
    if (top && realpathSync(top) === cwd) return { repo, cwd };
  } catch {
    // Git and filesystem diagnostics may include absolute paths.
  }
  throw new ChangesError("git", "The registered repository has no accessible Git checkout at its configured root.");
}

function resolveCommit(cwd: string, ref: string): string | null {
  if (!ref || ref.length > 4096 || /\p{Cc}/u.test(ref)) return null;
  const sha = line(git(cwd, ["rev-parse", "--verify", "--end-of-options", ref + "^{commit}"]));
  return sha && isOid(sha) ? sha : null;
}

function isUnbornEmpty(cwd: string): boolean {
  const ref = line(git(cwd, ["symbolic-ref", "--quiet", "HEAD"]));
  if (!ref?.startsWith("refs/heads/")) return false;
  const found = git(cwd, ["show-ref", "--verify", "--quiet", ref]);
  return found.status === 1 && line(git(cwd, ["rev-list", "--max-count=1", "--all"])) === "";
}

type Commit = { sha: string; ts: string; subject: string };
type Summary = { files_changed: number; insertions: number; deletions: number };

function readCommits(cwd: string, range: string, limit: number) {
  // NUL framing lets us retain complete commits if a large subject exhausts the byte budget.
  const log = git(cwd, ["log", "-z", "--no-show-signature", "--no-notes", "--no-decorate", "--no-patch",
    "--encoding=UTF-8", "--format=%H%x00%cI%x00%P%x00%s", "--max-count=" + limit, range, "--"]);
  const commits: Commit[] = [];
  let oldestParent: string | null = null;
  let incomplete = !log.ok || log.truncated;
  if (log.ok || log.truncated) {
    let start = 0;
    let fields: Buffer[] = [];
    for (let i = 0; i < log.stdout.length; i++) {
      if (log.stdout[i] !== 0) continue;
      fields.push(log.stdout.subarray(start, i));
      start = i + 1;
      if (fields.length < 4) continue;
      try {
        const [sha, ts, parents, subject] = fields.map(field => utf8.decode(field));
        const parent = parents.split(" ", 1)[0];
        if (!isOid(sha) || !Number.isFinite(Date.parse(ts)) || (parent && !isOid(parent))) throw Error();
        commits.push({ sha, ts, subject });
        oldestParent = parent || null;
      } catch { incomplete = true; }
      fields = [];
    }
    if (fields.length || start !== log.stdout.length) incomplete = true;
  }
  return { commits, oldestParent, incomplete, truncated: log.truncated };
}

function summarize(cwd: string, from: string, to: string): Summary | null {
  const stat = line(git(cwd, ["diff", "--shortstat", "--no-ext-diff", "--no-textconv", "--no-renames",
    "--ignore-submodules=dirty", "--submodule=short", from, to, "--"]));
  if (stat === null) return null;
  const values = [
    /([0-9]+) files? changed/.exec(stat)?.[1],
    /([0-9]+) insertions?\(\+\)/.exec(stat)?.[1],
    /([0-9]+) deletions?\(-\)/.exec(stat)?.[1],
  ];
  if (stat && !values[0]) return null;
  const [files_changed, insertions, deletions] = values.map(value => Number(value ?? 0));
  return { files_changed, insertions, deletions };
}

type RefOptions = { fromSha?: string; toRef?: string };

export function resolveChangesRefs({ cwd }: ChangesRepo, options: RefOptions) {
  const explicit = options.fromSha === undefined ? null : resolveCommit(cwd, options.fromSha);
  if (options.fromSha !== undefined && !explicit) {
    throw new ChangesError("parameter", "--from-sha must resolve to a locally available commit.");
  }
  const toRef = options.toRef ?? "HEAD";
  const to_sha = resolveCommit(cwd, toRef);
  if (!to_sha && (toRef !== "HEAD" || !isUnbornEmpty(cwd))) {
    throw new ChangesError(options.toRef === undefined ? "git" : "parameter",
      options.toRef === undefined ? "Git HEAD is unavailable." : "--to-ref must resolve to a locally available commit.");
  }
  return { explicit, to_sha };
}

type GitOptions = RefOptions & {
  refs?: ReturnType<typeof resolveChangesRefs>; liveSha?: unknown; live?: boolean; limit: number;
};

export function readChangesGit(repo: ChangesRepo, options: GitOptions) {
  const { cwd } = repo;
  const warnings: string[] = [];
  const { explicit, to_sha } = options.refs ?? resolveChangesRefs(repo, options);
  const liveOid = typeof options.liveSha === "string" ? options.liveSha.toLowerCase() : "";
  const live = options.live && isOid(liveOid) && resolveCommit(cwd, liveOid) === liveOid ? liveOid : null;
  const from_sha = explicit ?? live;
  const anchor = explicit ? "explicit" : live ? "live" : "none";
  if (options.live && !live) warnings.push("Live status could not be anchored to a locally available Git commit.");
  if (!from_sha) warnings.push("No running Git version anchor. Showing recent local commits.");
  if (!to_sha) warnings.push("The local Git repository has no commits.");

  const gitResult: {
    from_sha: string | null; to_sha: string | null; anchor: "explicit" | "live" | "none";
    coverage: "available" | "partial" | "empty"; commits: Commit[]; summary: Summary | null;
  } = { from_sha, to_sha, anchor, coverage: to_sha ? "available" : "empty", commits: [], summary: null };
  if (!to_sha) return { git: gitResult, live_anchored: Boolean(live), warnings, truncated: false };

  const history = readCommits(cwd, from_sha ? from_sha + ".." + to_sha : to_sha, options.limit);
  gitResult.commits = history.commits;
  if (history.incomplete) {
    gitResult.coverage = "partial";
    warnings.push("Git commit history could only be read in part.");
  }
  let summaryBase = from_sha;
  if (!summaryBase && !history.incomplete && history.commits.length) {
    summaryBase = history.oldestParent;
    if (!summaryBase && line(git(cwd, ["rev-parse", "--is-shallow-repository"])) === "false") {
      const emptyTree = line(git(cwd, ["hash-object", "-t", "tree", "--stdin"]));
      if (emptyTree && isOid(emptyTree)) summaryBase = emptyTree;
    }
  }
  if (summaryBase) gitResult.summary = summarize(cwd, summaryBase, to_sha);
  if (!gitResult.summary) {
    gitResult.coverage = "partial";
    warnings.push("Git change summary is unavailable for the selected history.");
  }
  return { git: gitResult, live_anchored: Boolean(live), warnings, truncated: history.truncated };
}
