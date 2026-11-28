import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";

// Preserve instance rules and give the private audit directory the final matching rule.
export function ensureAuditIgnored(root: string): void {
  const dir = join(root, ".workbench");
  if (!lstatSync(dir).isDirectory()) throw Error("Expected a workbench directory");
  const file = join(dir, ".gitignore");
  const fd = openSync(file, constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_CREAT |
    constants.O_RDWR | constants.O_APPEND, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw Error("Invalid workbench .gitignore");
    const previous = readFileSync(fd, "utf8");
    if (previous.trimEnd().split("\n").at(-1) === "/audit/") return;
    writeSync(fd, (previous && !previous.endsWith("\n") ? "\n" : "") + "/audit/\n");
  } finally {
    closeSync(fd);
  }
}
