import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { localPath, readRequired } from "./instance";

export type Asset = { bytes: Buffer; mode: number };
export const hash = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
export interface InstallLock {
  kit_name: string;
  kit_version: string;
  kit_root: string;
  kit_commit: string | null;
  workbench_name: string;
  packs?: string[];
  review_agents_enabled?: boolean;
  updated_at: string;
  managed_files?: Record<string, string>;
  skill_overrides?: Record<string, string>;
}
export function wrapper(name: string) {
  return `#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
BUN="\${BUN_BIN:-$(command -v bun || echo "$HOME/.bun/bin/bun")}"
exec "$BUN" "$DIR/${name === "forge" ? "cli" : name}.js" "$@"
`;
}
function managedPath(root: string, path: string) {
  if (path.split("/").some((part) => !part || part === "." || part === ".."))
    throw Error("Invalid managed path: " + path);
  if (
    path !== "AGENTS.md" &&
    path !== ".workbench/kit-lock.json" &&
    !/^\.codex\/(?:config\.toml|hooks\.json|agents\/[\w-]+\.toml)$/.test(path) &&
    !/^\.agents\/skills\/[\w-]+(?:\/(?:[\w. ()-]|[^\x00-\x7f\p{C}])+)*$/u.test(path) &&
    !/^\.workbench\/bin\/[\w.-]+$/.test(path)
  )
    throw Error("Unexpected managed path: " + path);
  // Inspect the leaf itself so ownership checks never follow a symlink.
  return join(localPath(root, dirname(path)), basename(path));
}
function state(path: string) {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (!st) return null;
  if (st.isSymbolicLink()) return "link:" + readlinkSync(path);
  if (!st.isFile()) return "directory";
  return hash(readRequired(path));
}
type Operation = { path: string; before: string | null; after: string | null; mode?: number };
const journalRel = ".workbench/sync-journal";
export function checkMigration(root: string) {
  if (existsSync(localPath(root, journalRel)))
    throw Error("An interrupted migration is pending. From the forge-kit release directory, run ./bin/forge sync " + Bun.$.escape(root));
}

function readOperations(journal: string): Operation[] {
  const ops = JSON.parse(readRequired(localPath(journal, "operations.json")).toString()) as Operation[];
  if (!Array.isArray(ops) || ops.at(-1)?.path !== ".workbench/kit-lock.json")
    throw Error("Invalid migration journal: " + journal);
  return ops;
}

function assertSupportedLock(lock: InstallLock) {
  if (/^0\.4\./.test(lock?.kit_version))
    throw Error("Direct upgrade from forge-kit " + lock.kit_version + " is unsupported. Migrate this workbench manually before running sync.");
  if (!lock?.kit_version || lock.kit_name !== "forge-kit" || !lock.managed_files ||
      typeof lock.managed_files !== "object" || Array.isArray(lock.managed_files))
    throw Error("Unsupported or invalid .workbench/kit-lock.json; restore the recorded release metadata");
}

export function missingLockRecovery(root: string, path: string): string {
  const recovery = existsSync(localPath(root, journalRel))
    ? "Resume the interrupted sync from the release directory."
    : "For an existing installation, restore its matching kit-lock.json from backup and rerun sync from the release directory. For a new workbench, run forge init.";
  return "Missing " + path + ". " + recovery;
}

export function checkInstallSource(root: string, command: "init" | "sync", inspectPending = false) {
  const path = localPath(root, ".workbench/kit-lock.json");
  const current = existsSync(path) ? readRequired(path) : undefined;
  if (current) {
    assertSupportedLock(JSON.parse(current.toString()));
    // Another sync may be retiring its journal until we hold the configuration lock.
    if (!inspectPending) return;
  }
  const journal = localPath(root, journalRel);
  if (!existsSync(journal)) {
    if (!current && command === "sync") throw Error(missingLockRecovery(root, path));
    return;
  }

  // Recovery may publish other assets before the lock. Check its staged versions first.
  const ops = readOperations(journal);
  const index = ops.length - 1;
  const lock = ops[index];
  if (current && hash(current) === lock.after) return;
  if (!current && lock.before !== null) {
    const original = stagedBytes(localPath(journal, index + ".old"), path, lock.before);
    assertSupportedLock(JSON.parse(original.toString()));
  }
  const pending = stagedBytes(localPath(journal, index + ".new"), path, lock.after);
  assertSupportedLock(JSON.parse(pending.toString()));
}

function stagedBytes(src: string, dest: string, digest: string | null) {
  if (!existsSync(src))
    throw Error("Missing staged file " + src + " for " + dest + "; restore the staged bytes with SHA-256 " + digest + " and retry sync");
  const bytes = readRequired(src);
  if (hash(bytes) !== digest) throw Error("Damaged staged file for " + dest);
  return bytes;
}

export function recoverInstall(root: string) {
  const journal = localPath(root, journalRel);
  if (!existsSync(journal)) return;
  const ops = readOperations(journal);
  for (const [i, op] of ops.entries()) {
    const dest = managedPath(root, op.path),
      current = state(dest);
    if (current === op.after && (current === null || (lstatSync(dest).mode & 0o777) === op.mode)) continue;
    if (current !== op.before) {
      const recovery = ["Migration conflict at " + dest + ". Preserve any conflicting path by moving it aside."];
      if (op.before?.startsWith("link:"))
        recovery.push("Restore the symlink at " + dest + " with its original target " + JSON.stringify(op.before.slice(5)) + ".");
      else if (op.before !== null)
        recovery.push("Copy the saved file " + join(journal, i + ".old") + " back to " + dest + ".");
      recovery.push("From the forge-kit release directory, retry ./bin/forge sync " + Bun.$.escape(root));
      throw Error(recovery.join(" "));
    }
    if (op.after === null) {
      rmSync(dest);
      continue;
    }
    const src = localPath(journal, i + ".new");
    const bytes = stagedBytes(src, dest, op.after);
    mkdirSync(dirname(dest), { recursive: true });
    // Retain .new until the entire journal is retired. A later conflict may require
    // the operator to restore .old and replay this already-published replacement.
    const pending = localPath(journal, "publish-" + randomUUID());
    writeFileSync(pending, bytes, { flag: "wx", mode: op.mode });
    chmodSync(pending, op.mode!);
    renameSync(pending, dest);
  }
  // Remove only empty, previously managed skill directories. Private neighbors keep their directory.
  for (const op of ops.filter((op) => op.after === null && op.path.startsWith(".agents/skills/"))) {
    let dir = dirname(op.path);
    while (dir.startsWith(".agents/skills/")) {
      try {
        rmdirSync(localPath(root, dir));
      } catch {
        break;
      }
      dir = dirname(dir);
    }
  }
  // Unpublish the completed journal before cleanup so an interruption cannot damage recovery data.
  const done = journal + "-done-" + randomUUID();
  renameSync(journal, done);
  rmSync(done, { recursive: true });
}

// A same-filesystem rename publishes the complete plan and all backups before touching any installed file.
export function installAssets(
  root: string,
  assets: Map<string, Asset>,
  lock: InstallLock,
  previous: InstallLock | undefined,
  force: boolean,
) {
  if (previous) assertSupportedLock(previous);
  const previousFiles = previous?.managed_files ?? {};
  const paths = new Set([...Object.keys(previousFiles), ...assets.keys()]);
  const ops: Operation[] = [];
  const preserved: string[] = [];
  for (const rel of paths) {
    const dest = managedPath(root, rel),
      before = state(dest),
      item = assets.get(rel);
    const after = item ? hash(item.bytes) : null;
    if (before === null && !item) continue;
    const tracked = Object.hasOwn(previousFiles, rel) && previousFiles[rel] === before;
    if (
      before !== null &&
      !tracked &&
      !(force && !previous && before !== "directory" && !before.startsWith("link:"))
    ) {
      if (!item && rel.startsWith(".agents/skills/")) {
        preserved.push(rel);
        continue;
      }
      throw Error("Ownership conflict at " + dest + "; move the local copy aside and retry");
    }
    if (before === after && (!item || (lstatSync(dest).mode & 0o777) === item.mode)) continue;
    ops.push({ path: rel, before, after, mode: item?.mode });
  }
  lock.managed_files = Object.fromEntries([...assets].map(([p, a]) => [p, hash(a.bytes)]));
  const lockPath = ".workbench/kit-lock.json",
    lockBytes = Buffer.from(JSON.stringify(lock, null, 2) + "\n");
  assets.set(lockPath, { bytes: lockBytes, mode: 0o644 });
  ops.push({
    path: lockPath,
    before: state(managedPath(root, lockPath)),
    after: hash(lockBytes),
    mode: 0o644,
  });
  const tmp = mkdtempSync(localPath(root, ".workbench/sync-stage-"));
  try {
    for (const [i, op] of ops.entries()) {
      if (op.before && !op.before.startsWith("link:")) {
        const dest = managedPath(root, op.path);
        writeFileSync(join(tmp, i + ".old"), readRequired(dest), { mode: lstatSync(dest).mode & 0o777 });
      }
      const item = assets.get(op.path);
      if (item) {
        writeFileSync(join(tmp, i + ".new"), item.bytes);
        chmodSync(join(tmp, i + ".new"), item.mode);
      }
    }
    writeFileSync(join(tmp, "operations.json"), JSON.stringify(ops));
    renameSync(tmp, localPath(root, journalRel));
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true });
  }
  recoverInstall(root);
  return preserved;
}
