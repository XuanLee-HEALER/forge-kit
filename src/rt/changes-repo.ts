import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

// Registration identifies a workbench slot. Following symlinks would give that
// slot a different name after a directory is moved or replaced.
export function registeredRepoName(root: string, value: unknown): string | null {
  if (typeof value !== "string" || !value || /[\\\p{Cc}]/u.test(value)) return null;
  const path = resolve(root, value);
  const repo = relative(root, path);
  if (repo !== ".." && !repo.includes("/") && !isAbsolute(repo)) return repo || ".";
  if (isAbsolute(value)) {
    try {
      // Absolute spellings can use a system alias for the workbench path (e.g. /var).
      // Only resolve the container, never the registered repository's final component.
      const parent = realpathSync(dirname(path));
      if (parent === root) return basename(path);
      if (parent === dirname(root) && basename(path) === basename(root)) return ".";
    } catch { /* The absolute path cannot be attributed to this workbench. */ }
  }
  return null;
}
