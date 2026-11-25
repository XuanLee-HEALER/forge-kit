import { resolveTaskCheckout } from "./checkout";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { runGit } from "../git";
import { matchesGlob } from "../shared/path";
import type { LedgerReader, LockedGitlinks, LockedTreeEntry } from "./types";

const excluded = new Set([".git", "node_modules", ".venv"]);

// Expand gitlinks at the exact revision pinned by the parent. All reads stay local.
function* treeEntries(dir: string, rev: string, globs: string[], repo: string, capture?: LockedGitlinks, archivedCache?: LockedGitlinks, uninitialized?: Set<string>, prefix = ""): Generator<LockedTreeEntry> {
  const tree = runGit(dir, ["ls-tree", "-rz", "--full-tree", rev]);
  if (tree.code) throw new Error("Cannot inspect locked tests at " + rev);
  for (const row of tree.stdout.split("\0")) {
    if (!row) continue;
    const tab = row.indexOf("\t");
    const rel = row.slice(tab + 1);
    const [mode, , oid] = row.slice(0, tab).split(" ");
    const path = prefix + rel;
    if (mode === "160000") {
      const reachable = globs.some(glob => {
        const pattern = glob.replace(/\\/g, "/").replace(/^\.\//, "").split("/");
        if (pattern.length === 1) return true;
        const parts = path.split("/");
        for (let i = 0; i < parts.length; i++) {
          if (pattern[i]?.includes("**")) return true;
          if (!pattern[i] || !matchesGlob(parts[i], pattern[i])) return false;
        }
        return pattern.length > parts.length;
      });
      if (!reachable) continue;
      const child = join(dir, rel);
      const key = JSON.stringify([repo, path, oid]);
      const emptyCheckout = !existsSync(child) || !readdirSync(child).length;
      if (emptyCheckout) uninitialized?.add(path + "/");
      if (archivedCache && !existsSync(join(child, ".git")) && Object.hasOwn(archivedCache, key)) {
        yield* archivedCache[key];
        continue;
      }
      let objects = child;
      if (!existsSync(join(child, ".git"))) {
        const stored = runGit(dir, ["rev-parse", "--path-format=absolute", "--git-path", "modules/" + rel]);
        if (!archivedCache || stored.code || !existsSync(stored.stdout.replace(/\n$/, ""))) {
          throw new Error("Initialize submodule to verify locked tests: " + path);
        }
        objects = stored.stdout.replace(/\n$/, "");
      }
      const entries = treeEntries(objects, oid, globs, repo, capture, archivedCache, uninitialized, path + "/");
      if (capture) capture[key] = [];
      for (const entry of entries) {
        if (capture && globs.some(glob => matchesGlob(entry.path, glob))) capture[key].push(entry);
        yield entry;
      }
    } else yield { path, mode, oid };
  }
}

type Hashes = Record<string, string>;
type ScanOptions = {
  frozen?: Hashes;
  frozenModes?: Hashes;
  frozenBlobs?: Hashes;
  delivery?: { repo: string; head_sha: string; checkoutDir?: string };
  closing?: boolean;
  gitlinks?: LockedGitlinks;
  frozenOids?: Hashes;
  freezeRefs?: Record<string, string[]>;
  amendedSnapshot?: boolean;
};

export function scanLockedTests(ledger: LedgerReader, task: string, globs: string[], options: ScanOptions = {}) {
  const { frozen, frozenBlobs = {}, delivery, closing, frozenOids = {}, freezeRefs = {}, amendedSnapshot } = options;
  const attachmentPaths = new Map<string, Set<string>>();
  const files: Record<string, string> = Object.create(null);
  const modes: Hashes = Object.create(null);
  const blobs: Record<string, string> = Object.create(null);
  const tracked: Record<string, string> = Object.create(null);
  const revisions: Record<string, string[]> = Object.create(null);
  const gitlinks: LockedGitlinks = Object.create(null);
  const formerlyTracked = Object.keys(frozenBlobs);
  const drift = new Set<string>();
  if (globs.length) for (const attachment of ledger.getTaskRepos(task)) {
    const prefix = attachment.repo + "/";
    const { dir, missingWorktree } = resolveTaskCheckout(ledger.workbenchRoot, attachment, true);
    const disk = new Set<string>();
    const byRepository = new Map<string, string[]>();
    const matches = (path: string) => globs.some(glob => matchesGlob(path, glob));
    const missingOnDisk = new Set<string>();
    function scanCheckout(root: string, capture: boolean) {
      const seen = new Set<string>();
      // Follow tracked paths and literal locks even inside otherwise pruned dependencies.
      const inspect = new Set<string>();
      const indexed = existsSync(join(root, ".git")) ? runGit(root, ["ls-files", "--recurse-submodules", "-z"]) : null;
      if (indexed?.code) throw new Error("Cannot enumerate tracked tests in " + root);
      const paths = [...(indexed?.stdout.split("\0") ?? []).filter(matches), ...globs.filter(g => !/[*?]/.test(g))];
      for (const rel of paths) {
        const parts = rel.replace(/^\.\//, "").split("/");
        for (let i = 1; i <= parts.length; i++) inspect.add(parts.slice(0, i).join("/"));
      }
      function visit(parent: string, gitRoot: string, pruned = false) {
        for (const entry of readdirSync(join(root, parent), { withFileTypes: true })) {
          const path = parent ? parent + "/" + entry.name : entry.name;
          const insideDependency = pruned || excluded.has(entry.name);
          if (entry.name === ".git" || (insideDependency && !inspect.has(path))) continue;
          if (entry.isDirectory()) {
            visit(path, existsSync(join(root, path, ".git")) ? path : gitRoot, insideDependency);
            continue;
          }
          if (!matches(path)) continue;
          const key = prefix + path;
          seen.add(key);
          if (!entry.isFile()) { drift.add(key); continue; }
          const mode = statSync(join(root, path)).mode & 0o100 ? "100755" : "100644";
          if ((modes[key] && modes[key] !== mode) || (options.frozenModes?.[key] && options.frozenModes[key] !== mode)) drift.add(key);
          const hash = createHash("sha256").update(readFileSync(join(root, path))).digest("hex");
          if ((files[key] !== undefined && files[key] !== hash) || (frozen && frozen[key] !== hash)) drift.add(key);
          if (capture) {
            modes[key] = mode;
            files[key] = hash;
            disk.add(path);
            const paths = byRepository.get(gitRoot) ?? [];
            paths.push(gitRoot ? path.slice(gitRoot.length + 1) : path);
            byRepository.set(gitRoot, paths);
          }
        }
      }
      if (existsSync(root)) visit("", "");
      for (const key of Object.keys(frozen ?? {})) {
        if (key.startsWith(prefix) && !seen.has(key)) (capture && archived ? missingOnDisk : drift).add(key);
      }
    }
    // Close separately verifies remote reachability and endpoint evidence for each deleted branch.
    const branchRef = "refs/heads/" + attachment.branch;
    const surviving = missingWorktree && runGit(dir, ["rev-parse", "--verify", branchRef]).stdout.trim();
    const delivered = surviving || attachment.head_sha;
    if (!frozen && missingWorktree && surviving && runGit(dir, ["rev-parse", "--verify", "HEAD"]).stdout.trim() !== surviving)
      throw new Error("Cannot capture a working-tree snapshot: restore the worktree for " + attachment.branch);
    const archived = delivered && existsSync(join(dir, ".git")) && ((frozen && missingWorktree && surviving) ||
      (closing && runGit(dir, ["show-ref", "--verify", "--quiet", branchRef]).code === 1));
    const scannedDiskPath = !archived && existsSync(dir) ? realpathSync(dir) : null;
    if (scannedDiskPath) scanCheckout(dir, true);
    if (!frozen) {
      const prior = attachmentPaths.get(attachment.repo);
      if (prior) {
        for (const path of new Set([...prior, ...disk])) {
          if (!prior.has(path) || !disk.has(path)) drift.add(prefix + path + " (" + attachment.branch + ")");
        }
      } else attachmentPaths.set(attachment.repo, disk);
    }
    const candidate = delivery?.repo === attachment.repo ? delivery : undefined;
    if (candidate?.checkoutDir && realpathSync(candidate.checkoutDir) !== scannedDiskPath) {
      scanCheckout(candidate.checkoutDir, false);
    }
    if (!existsSync(join(dir, ".git"))) {
      for (const key of formerlyTracked) if (key.startsWith(prefix)) drift.add(key);
      continue;
    }
    const refs = new Set<string>();
    for (const ref of archived ? [delivered!] : ["HEAD", "refs/heads/" + attachment.branch]) {
      const rev = runGit(dir, ["rev-parse", "--verify", "--quiet", ref]);
      if (!rev.code) refs.add(rev.stdout.trim());
      else if (rev.code !== 1) throw new Error("Cannot resolve locked test revision: " + ref);
    }
    revisions[attachment.repo] = [...new Set([...(revisions[attachment.repo] ?? []), ...refs])];
    if (candidate && /^[a-f0-9]{7,64}$/i.test(candidate.head_sha)) refs.add(candidate.head_sha);
    const workingOids = new Map<string, string>();
    for (const [gitRoot, paths] of byRepository) {
      for (let start = 0; start < paths.length; start += 128) {
        const batch = paths.slice(start, start + 128);
        const result = runGit(join(dir, gitRoot), ["hash-object", "--", ...batch]);
        if (result.code) throw new Error("Cannot normalize locked tests in " + attachment.repo);
        const ids = result.stdout.trim().split("\n");
        if (ids.length !== batch.length) throw new Error("Incomplete Git hashes for " + attachment.repo);
        batch.forEach((rel, i) => {
          const path = gitRoot ? gitRoot + "/" + rel : rel;
          workingOids.set(path, ids[i]);
          blobs[prefix + path] = ids[i];
        });
      }
    }
    for (const rev of refs) {
      const isDelivery = archived || rev === candidate?.head_sha;
      const seen = new Set<string>();
      const uninitialized = new Set<string>();
      for (const { path, mode, oid } of treeEntries(dir, rev, globs, attachment.repo, frozen ? undefined : gitlinks, archived ? options.gitlinks : undefined, uninitialized)) {
        if (!matches(path)) continue;
        const key = prefix + path;
        seen.add(key);
        const expectedMode = options.frozenModes?.[key] ?? modes[key];
        if (!amendedSnapshot && expectedMode && mode !== expectedMode) drift.add(key);
        if (archived || (missingOnDisk.has(key) && [...uninitialized].some(root => path.startsWith(root)))) {
          missingOnDisk.delete(key);
          if (!frozen?.[key] || !/^100(644|755)$/.test(mode) || frozenOids[key] !== oid) drift.add(key);
          else files[key] = frozen[key];
          continue;
        }
        if (amendedSnapshot) {
          if (disk.has(path)) tracked[key] = workingOids.get(path)!;
          continue;
        }
        if (!disk.has(path) || !/^100(644|755)$/.test(mode)) { drift.add(key); continue; }
        tracked[key] = oid;
        const expectedOid = isDelivery ? frozenOids[key] : frozenBlobs[key];
        if ((expectedOid && expectedOid !== oid) || workingOids.get(path) !== oid) drift.add(key);
      }
      // A file may be untracked at freeze, then committed and deleted before the next status check.
      const anchors = freezeRefs[attachment.repo] ?? [];
      if (frozen && !isDelivery && !anchors.includes(rev)) {
        const absent = Object.keys(frozen).filter(key => key.startsWith(prefix) && !seen.has(key) && !frozenBlobs[key]);
        if (absent.length) {
          const history = runGit(dir, ["--literal-pathspecs", "log", "--full-history", "-m", "--no-renames",
            "--diff-filter=D", "--format=", "--name-only", "-z", rev, ...anchors.map(sha => "^" + sha),
            "--", ...absent.map(key => key.slice(prefix.length))]);
          if (history.code) throw new Error("Cannot inspect locked test history at " + rev);
          for (const path of history.stdout.split("\0")) if (path) drift.add(prefix + path);
        }
      }
      for (const key of isDelivery ? Object.keys(frozen ?? {}) : formerlyTracked) {
        if (key.startsWith(prefix) && !seen.has(key)) drift.add(key);
      }
    }
    for (const key of missingOnDisk) drift.add(key);
    if (!refs.size) for (const key of formerlyTracked) if (key.startsWith(prefix)) drift.add(key);
  }
  return { files, modes, blobs, tracked, revisions, gitlinks, drift: [...drift].sort() };
}
