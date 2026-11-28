import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";

// Append instance exclusions after user rules so an earlier negation cannot expose private files.
export function ensurePrivateIgnored(root: string, directories: readonly string[]): void {
  const dir = join(root, ".workbench");
  if (!lstatSync(dir).isDirectory()) throw Error("Expected a workbench directory");
  const file = join(dir, ".gitignore");
  const fd = openSync(file, constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_CREAT |
    constants.O_RDWR | constants.O_APPEND, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw Error("Invalid workbench .gitignore");
    const previous = readFileSync(fd, "utf8");
    const suffix = directories.map(name => "/" + name + "/").join("\n");
    if (previous.trimEnd().split("\n").slice(-directories.length).join("\n") === suffix) return;
    writeSync(fd, (previous && !previous.endsWith("\n") ? "\n" : "") + suffix + "\n");
  } finally {
    closeSync(fd);
  }
}
