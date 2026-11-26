import { realpathSync } from "node:fs";
import { localPath } from "./instance";
import type { GitRunResult } from "./git";

type IsolatedGit = (cwd: string, args: string[]) => GitRunResult;

// Fetch the commit and its tree from the supplied local object store. This
// intentionally gives the verifier no other refs, remotes or commit history.
export function checkoutLocalRevision(source: string, target: string, oid: string, git: IsolatedGit) {
  const format = oid.length === 64 ? ["--object-format=sha256"] : [];
  const init = git(target, ["init", "--quiet", "--template=", ...format]);
  if (init.code) throw Error("Cannot initialize isolated checkout: " + init.stderr);
  const fetch = git(target, ["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--depth=1", "--", source, oid]);
  if (fetch.code) throw Error("Cannot fetch local objects for " + oid + ": " + fetch.stderr);
  const select = git(target, ["checkout", "--quiet", "--no-recurse-submodules", "--detach", oid]);
  if (select.code) throw Error("Cannot check out local revision " + oid + ": " + select.stderr);
}

// The committed tree supplies paths and OIDs. A locally initialized worktree
// supplies objects, never its mutable files or the URL in .gitmodules.
export function materializeGitlinks(source: string, checkout: string, revision: string, git: IsolatedGit) {
  const tree = git(checkout, ["ls-tree", "-r", "-z", revision]);
  if (tree.code) throw Error("Cannot enumerate gitlinks at " + revision);
  for (const entry of tree.stdout.split("\0")) {
    const link = /^160000 commit ([0-9a-f]+)\t([\s\S]+)$/.exec(entry);
    if (!link) continue;
    const [, oid, path] = link;
    const from = localPath(source, path);
    const target = localPath(checkout, path);
    const top = git(from, ["rev-parse", "--show-toplevel"]);
    if (top.code || top.stdout.replace(/\n$/, "") !== realpathSync(from))
      throw Error("Missing local gitlink checkout for " + path + " at " + oid);
    checkoutLocalRevision(from, target, oid, git);
    materializeGitlinks(from, target, oid, git);
  }
}
