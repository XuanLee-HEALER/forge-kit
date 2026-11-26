import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ShipPolicy } from "./config";
import type { TaskRepoRecord } from "./ledger/types";
import { runGit, runProcess, checkoutEnvironment } from "./git";
import { matchesGlob } from "./shared/path";

export function git(dir: string, args: string[], env?: Record<string, string | undefined>) {
  const r = env ? runProcess(["git", "-C", dir, ...args], { env }) : runGit(dir, args);
  if (r.code) throw Error("git " + args[0] + " failed: " + r.stderr);
  return r.stdout;
}
export function diffScope(
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
  const renameDiff = [...common, "--no-renames", "-M", "-l0"];
  const tokens = git(dir, [...renameDiff, "--raw", "--no-abbrev", range, "--"], env).split("\0");
  for (let i = 0; i < tokens.length - 1; ) {
    const header = /^:(\d{6}) (\d{6}) [a-f0-9]+ [a-f0-9]+ ([ADMT]|R\d+)$/.exec(tokens[i++]);
    if (!header) throw Error("Unsupported Git diff record");
    if (header[1] === "160000" || header[2] === "160000")
      throw Error("Submodule changes require manual delivery");
    for (let n = header[3].startsWith("R") ? 2 : 1; n > 0; n--) {
      const path = tokens[i++];
      if (!path || path.includes("\ufffd") || path.includes("\\")) throw Error("Invalid Git path");
      if (policy.forbidden_paths.some((g) => matchesGlob(path.toLowerCase(), g.toLowerCase())))
        throw Error("Forbidden path: " + path);
      if (!allowed || !paths.some((g) => matchesGlob(path, g, true)))
        throw Error("Change outside allowed scope: " + row.repo + "/" + path);
      if (policy.forbid_db_rw && /\.sql$/i.test(path))
        throw Error("Fast-track cannot authorize SQL migrations: " + path);
      files.add(JSON.stringify([row.repo, path]));
    }
  }
  let lines = 0;
  const stats = git(dir, [...renameDiff, "--numstat", range, "--"], env).split("\0");
  for (let i = 0; i < stats.length - 1; i++) {
    const entry = stats[i];
    const m = /^(\d+)\t(\d+)\t/.exec(entry);
    if (!m) throw Error("Binary or unreadable diff in " + row.repo);
    // With -z, a rename's count header has an empty path followed by two NUL-terminated names.
    if (entry === m[0]) {
      if (!stats[i + 1] || !stats[i + 2]) throw Error("Incomplete rename in " + row.repo);
      i += 2;
    }
    lines += Number(m[1]) + Number(m[2]);
  }
  return lines;
}
// Simulate the merge in a temporary object store, preserving the caller's refs, index and objects.
export function inspectMerge(
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
export function deliveryDiff(policy: ShipPolicy, paths: string[]) {
  const files = new Set<string>();
  let lines = 0;
  return (repo: string, dir: string, from: string, to: string, env?: Record<string, string | undefined>) => {
    lines += diffScope(dir, { repo, base_sha: from }, to, true, paths, policy, files, env);
    if (files.size > policy.max_files_changed || lines > policy.max_lines_changed)
      throw Error("Delivery diff exceeds policy cap");
  };
}
