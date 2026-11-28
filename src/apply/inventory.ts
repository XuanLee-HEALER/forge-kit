import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, type Stats } from "node:fs";
import { dirname, join, relative } from "node:path";
import { byPath, hasRepositoryMarker, inspectScanPath, relativeApplyPath, scanExcluded, type ApplyRepo } from "./catalog";

const maxFocusDepth = 4;
const maxFocusPaths = 400;
const maxSkeletonPaths = 80;
const maxEntries = 3000;
const maxManifestBytes = 256 * 1024;

type EntryType = "directory" | "file" | "symlink";
type TreeEntry = { path: string; type: EntryType; direct_files?: number; recursive_files?: number; counts_complete?: boolean };
type DirectoryCounts = { direct_files: number; recursive_files: number; counts_complete: boolean };
type Directory = { path: string; absolute: string; stat: Stats };
type Inspection = { absolute: string; stat: Stats; type: EntryType };

export const childPath = (dir: string, name: string) => dir === "." ? name : dir + "/" + name;
export const pathIsIn = (parent: string, path: string) => parent === "." || parent === path || path.startsWith(parent + "/");

export function readApplyManifest(repo: Pick<ApplyRepo, "dir" | "boundaries">, path: string) {
  const present = inspectScanPath(repo, path);
  if (!present.stat?.isFile() || !(present.stat.mode & 0o444) || present.stat.size > maxManifestBytes)
    throw Error("Manifest is inaccessible or exceeds the read limit.");
  const fd = openSync(present.path, constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_RDONLY);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || !(opened.mode & 0o444) || opened.dev !== present.stat.dev ||
        opened.ino !== present.stat.ino || opened.size > maxManifestBytes)
      throw Error("Manifest changed before it could be read.");
    const contents = Buffer.allocUnsafe(maxManifestBytes + 1);
    let length = 0;
    while (length < contents.length) {
      const copied = readSync(fd, contents, length, contents.length - length, null);
      if (!copied) break;
      length += copied;
    }
    if (length > maxManifestBytes || fstatSync(fd).size > maxManifestBytes)
      throw Error("Manifest grew beyond the read limit.");
    return contents.toString("utf8", 0, length);
  } finally {
    closeSync(fd);
  }
}

function entryType(stat: Stats) {
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  if (stat.isSymbolicLink()) return "symlink";
}

function inspectChild(absolute: string, boundaries: ReadonlySet<string>): Inspection | undefined {
  if (boundaries.has(absolute)) return;
  const stat = lstatSync(absolute, { throwIfNoEntry: false });
  if (!stat) return;
  const type = entryType(stat);
  if (type) return { absolute, stat, type };
}

function listDirectory({ absolute, stat }: Directory) {
  if (!(stat.mode & 0o444) || !(stat.mode & 0o111)) throw Error("Directory is inaccessible.");
  return readdirSync(absolute).filter(name => {
    if (scanExcluded(name)) return false;
    try { return relativeApplyPath(name) === name; }
    catch { return false; }
  }).sort(byPath);
}

export function inventoryApplyRepo(repo: ApplyRepo, rootFiles: ReadonlySet<string>, warnings: string[],
  detailed: boolean) {
  const files = new Set<string>();
  const symlinks = new Set<string>();
  const unreadableFiles = new Set<string>();
  const dirs = new Set<string>(["."]);
  const boundaries = new Set(repo.boundaries);
  const counts = new Map<string, DirectoryCounts>();
  const root: Directory = { path: ".", absolute: repo.dir, stat: lstatSync(repo.dir) };
  const queue: Directory[] = [root];
  const incomplete = new Set<string>();
  let inspected = 0;
  let truncated = false;

  const markIncomplete = (path: string, message?: string) => {
    incomplete.add(path);
    truncated = true;
    if (detailed && message) warnings.push(message + JSON.stringify(path));
  };
  const visit = (parent: Directory, name: string) => {
    inspected++;
    const path = childPath(parent.path, name);
    try {
      const item = inspectChild(join(parent.absolute, name), boundaries);
      if (!item) return;
      if (item.type === "directory") {
        if ((item.stat.mode & 0o111) && hasRepositoryMarker(item.absolute, true)) {
          boundaries.add(item.absolute);
          return;
        }
        dirs.add(path);
        queue.push({ path, absolute: item.absolute, stat: item.stat });
      } else if (item.type === "file") {
        files.add(path);
        if (!(item.stat.mode & 0o444)) unreadableFiles.add(path);
      }
      else symlinks.add(path);
    } catch {
      markIncomplete(parent.path);
      if (detailed) warnings.push("Could not inspect path: " + JSON.stringify(path));
    }
  };

  for (let i = 0; i < queue.length; i++) {
    const dir = queue[i];
    if (inspected >= maxEntries) {
      markIncomplete(dir.path);
      continue;
    }
    try {
      let found = listDirectory(dir);
      if (dir.path === ".") {
        // Reserve these probes using names from the listing so that an insensitive
        // filesystem cannot report one manifest under several alternate names.
        const ordinary = found.filter(name => name !== "src" && !rootFiles.has(name));
        found = [...found.filter(name => name === "src"), ...found.filter(name => rootFiles.has(name)), ...ordinary];
      }
      const attempted = found.slice(0, Math.min(maxEntries, maxEntries - inspected));
      if (attempted.length < found.length) markIncomplete(dir.path);
      for (const name of attempted) visit(dir, name);
    } catch {
      markIncomplete(dir.path, "Could not scan directory: ");
    }
  }

  for (const path of dirs)
    counts.set(path, { direct_files: 0, recursive_files: 0, counts_complete: !incomplete.has(path) });
  for (const path of files) counts.get(dirname(path))!.direct_files++;
  for (let i = queue.length - 1; i >= 0; i--) {
    const { path } = queue[i];
    const count = counts.get(path)!;
    count.recursive_files += count.direct_files;
    if (path === ".") continue;
    const parent = counts.get(dirname(path))!;
    parent.recursive_files += count.recursive_files;
    parent.counts_complete &&= count.counts_complete;
  }
  if (truncated) warnings.push("Repository inventory is incomplete at the scan entry or permissions limit.");
  return { files, symlinks, unreadableFiles, dirs, counts, boundaries, truncated };
}

export function skeletonApplyTree(
  inventory: ReturnType<typeof inventoryApplyRepo>, rootFiles: ReadonlySet<string>, warnings: string[],
) {
  const entries = [...inventory.dirs].filter(path => path !== "." && path.split("/").length <= 2)
    .map(path => ({ path, type: "directory" as const, ...inventory.counts.get(path)! }));
  const rootEntries = [...inventory.files].filter(path => rootFiles.has(path))
    .map(path => ({ path, type: "file" as const }));
  const candidates: TreeEntry[] = [...rootEntries, ...entries].sort((a, b) => {
    const priority = (entry: TreeEntry) => entry.path === "src" ? 0 : rootFiles.has(entry.path) ? 1 :
      entry.path.includes("/") ? 3 : 2;
    return priority(a) - priority(b) || byPath(a.path, b.path);
  });
  const capped = candidates.length > maxSkeletonPaths;
  if (capped) warnings.push("Directory skeleton was truncated at the display limit.");
  return {
    tree: candidates.slice(0, maxSkeletonPaths).sort((a, b) => byPath(a.path, b.path)),
    tree_truncated: capped || inventory.truncated,
  };
}

export function focusApplyTree(repo: ApplyRepo, focus: string[], boundaries: Set<string>, metadata: ReadonlySet<string>,
  warnings: string[]) {
  const entries = new Map<string, TreeEntry>();
  const visited = new Map<string, number>();
  const files = new Set<string>();
  const dirs = new Set<string>();
  const symlinks = new Set<string>();
  const unreadableFiles = new Set<string>();
  const ancestors = new Set<string>();
  let inspected = 0;
  let truncated = false;

  const observe = (item: Inspection) => {
    const path = relative(repo.dir, item.absolute) || ".";
    if (item.type === "directory") dirs.add(path);
    else if (item.type === "symlink") symlinks.add(path);
    else {
      files.add(path);
      if (!(item.stat.mode & 0o444)) unreadableFiles.add(path);
    }
  };
  const visit = (path: string, item: Inspection, remaining: number) => {
    if ((visited.get(path) ?? -1) >= remaining) return;
    visited.set(path, remaining);
    observe(item);
    if (path !== ".") entries.set(path, { path, type: item.type });
    if (item.type !== "directory") return;
    try {
      const names = listDirectory({ path, absolute: item.absolute, stat: item.stat });
      if (!names.length && focus.includes(path)) warnings.push("Empty directory: " + JSON.stringify(path));
      if (remaining === 0) {
        if (names.length) truncated = true;
        return;
      }
      for (const name of names.slice(0, maxEntries)) {
        if (inspected >= maxEntries) {
          truncated = true;
          break;
        }
        const child = childPath(path, name);
        if ((visited.get(child) ?? -1) >= remaining - 1) continue;
        inspected++;
        try {
          const next = inspectChild(join(item.absolute, name), boundaries);
          if (!next) continue;
          if (next.type === "directory" && (next.stat.mode & 0o111) && hasRepositoryMarker(next.absolute, true)) {
            boundaries.add(next.absolute);
            continue;
          }
          visit(child, next, remaining - 1);
        } catch {
          warnings.push("Could not inspect path: " + JSON.stringify(child));
          truncated = true;
        }
      }
      if (names.length > maxEntries) truncated = true;
    } catch {
      warnings.push("Could not scan directory: " + JSON.stringify(path));
      truncated = true;
    }
  };

  for (const path of focus) {
    if (inspected >= maxEntries) {
      truncated = true;
      break;
    }
    if (visited.get(path) === maxFocusDepth) continue;
    inspected++;
    try {
      const selected = inspectScanPath(repo, path, { followSymlinks: true });
      if (selected.excluded) {
        warnings.push("Focus path is excluded from scanning.");
        continue;
      }
      if (selected.inaccessible) {
        warnings.push("Could not scan directory: " + JSON.stringify(path));
        truncated = true;
        continue;
      }
      const resolved = relative(repo.dir, selected.path) || ".";
      let parent = selected.stat?.isDirectory() ? resolved : dirname(resolved);
      while (!ancestors.has(parent)) {
        ancestors.add(parent);
        if (parent === ".") break;
        parent = dirname(parent);
      }
      const type = selected.stat && entryType(selected.stat);
      if (selected.stat && type) visit(path, { absolute: selected.path, stat: selected.stat, type }, maxFocusDepth);
      else if (!selected.stat) warnings.push("Focus path is absent from the worktree: " + JSON.stringify(path));
    } catch {
      warnings.push("Could not inspect focus path.");
      truncated = true;
    }
  }

  let probes = 0;
  let metadataLimited = false;
  probe: for (const path of ancestors) {
    if (probes >= maxEntries) { metadataLimited = true; break; }
    probes++;
    try {
      const item = inspectScanPath(repo, path);
      if (item.inaccessible) throw Error();
      if (!item.stat?.isDirectory()) continue;
      const names = listDirectory({ path, absolute: item.path, stat: item.stat });
      for (const name of names) {
        if (!metadata.has(name)) continue;
        if (probes >= maxEntries) { metadataLimited = true; break probe; }
        probes++;
        try {
          const entry = inspectChild(join(item.path, name), boundaries);
          if (entry && entry.type !== "directory") observe(entry);
        } catch { warnings.push("Could not inspect focus metadata: " + JSON.stringify(childPath(path, name))); }
      }
    } catch {
      warnings.push("Could not inspect focus ancestor metadata: " + JSON.stringify(path));
    }
  }
  if (metadataLimited) warnings.push("Focus metadata checks reached the scan limit.");
  if (entries.size > maxFocusPaths) truncated = true;
  if (truncated) warnings.push("Directory skeleton was truncated at the scan depth, entry, or permissions limit.");
  return {
    tree: [...entries.values()].sort((a, b) => byPath(a.path, b.path)).slice(0, maxFocusPaths),
    tree_truncated: truncated,
    files, dirs, symlinks, unreadableFiles,
  };
}
