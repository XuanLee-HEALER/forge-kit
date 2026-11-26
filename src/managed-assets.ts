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
import legacyDigests from "./legacy-assets.json";
import { localPath, readRequired } from "./instance";

export type Asset = { bytes: Buffer; mode: number };
export const hash = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
// These SHA-256 values come from the core/pack blobs and frozen-lockfile Bun builds of the
// releases below. A release archive need not contain Git history or the previous installer.
const legacy: Record<string, Record<string, string[]>> = legacyDigests;
const reviewLinks = [
  "implementation-review",
  "simplicity-performance-review",
  "code-simplification-review",
  "comment-normalization-review",
];
const bins = [
  "forge",
  "ledger",
  "ledger-hook",
  "guard",
  "wb-git",
  "dbcred",
  "cmdfmt",
  "lang-check",
  "wb-verify",
  "forge-review",
  "forge-ship",
];
const packFiles: Record<string, string> = { dbop: "dbop", "work-communication": "comm-lark" };
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
}
export function wrapper(name: string) {
  return `#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
BUN="\${BUN_BIN:-$(command -v bun || echo "$HOME/.bun/bin/bun")}"
exec "$BUN" "$DIR/${name === "forge" ? "cli" : name}.js" "$@"
`;
}
const releases: Record<string, string[]> = {
  "0.4.0": ["3ffe431"],
  "0.4.1": ["eb139c1", "ce6afae"],
  "0.4.2": ["9b156b4"],
};
function installedRevisions(lock: InstallLock) {
  const revisions = releases[lock.kit_version] ?? [];
  const commit = lock.kit_commit?.slice(0, 7);
  return commit && revisions.includes(commit) ? [commit] : revisions;
}
function oldPaths(lock: InstallLock) {
  const found = Object.keys(legacy).filter((p) => {
    const pack = packFiles[p.split("/")[2]];
    return (
      (!pack || lock.packs?.includes(pack)) &&
      Object.values(legacy[p]).some((revs) => revs.some((rev) => installedRevisions(lock).includes(rev)))
    );
  });
  found.push(...bins.map((n) => ".workbench/bin/" + n));
  if (lock.review_agents_enabled) found.push(...reviewLinks.map((n) => ".agents/skills/" + n));
  return found;
}
function managedPath(root: string, path: string) {
  if (path.split("/").some((part) => !part || part === "." || part === ".."))
    throw Error("Invalid managed path: " + path);
  if (
    path !== "AGENTS.md" &&
    path !== ".workbench/kit-lock.json" &&
    !/^\.codex\/(?:config\.toml|hooks\.json|agents\/[\w-]+\.toml)$/.test(path) &&
    !/^\.agents\/skills\/[\w-]+(?:\/[\w. -]+)*$/.test(path) &&
    !/^\.workbench\/bin\/[\w.-]+$/.test(path)
  )
    throw Error("Unexpected managed path: " + path);
  // The leaf can be one of the historical skill links. Never traverse that link.
  return join(localPath(root, dirname(path)), basename(path));
}
function state(path: string) {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (!st) return null;
  if (st.isSymbolicLink()) return "link:" + readlinkSync(path);
  if (!st.isFile()) return "directory";
  return hash(readRequired(path));
}
// v0.4 rendered each of these two files from the same tier but did not retain its values.
const tierPeer: Record<string, string> = {
  ".codex/config.toml": ".codex/agents/dev.toml",
  ".codex/agents/dev.toml": ".codex/config.toml",
  ".codex/agents/analyst.toml": ".codex/agents/spec-reviewer.toml",
  ".codex/agents/spec-reviewer.toml": ".codex/agents/analyst.toml",
};
function tierTemplate(source: string, tier: string, model: string, effort: string) {
  return source
    .replace('model = "' + model + '"', 'model = "{{' + tier + '_MODEL}}"')
    .replace('model_reasoning_effort = "' + effort + '"', 'model_reasoning_effort = "{{' + tier + '_EFFORT}}"');
}

function oldOwner(
  root: string,
  rel: string,
  current: string,
  lock: InstallLock,
  vars: Record<string, string>,
) {
  if (!/^0\.4\./.test(lock.kit_version)) return false;
  if (reviewLinks.includes(basename(rel)))
    return current === "link:../../review-agents/skills/" + basename(rel);
  if (current === "directory" || current.startsWith("link:")) return false;
  const bin = bins.find((n) => rel === ".workbench/bin/" + n);
  if (bin) return current === hash(wrapper(bin));
  const versions = legacy[rel];
  if (!versions) return false;
  const matches = (digest: string) =>
    versions[digest]?.some((commit) => installedRevisions(lock).includes(commit)) === true;
  if (matches(current)) return true;
  if (rel.startsWith(".workbench/bin/") && rel.endsWith(".js")) {
    // Bun annotates module boundaries with the relative install path, including external dependency caches.
    const bytes = readRequired(managedPath(root, rel)).toString();
    const portable = bytes.replace(
      /^\/\/ (?:[^\r\n]*\/)?node_modules\/yaml\/dist\//gm,
      "// node_modules/yaml/dist/",
    );
    return matches(hash(portable));
  }
  if (rel.endsWith(".toml") || rel === "AGENTS.md" || rel === ".codex/hooks.json") {
    let source = readRequired(managedPath(root, rel)).toString();
    if (rel === "AGENTS.md")
      source = source.replace("# " + lock.workbench_name + " 工作台", "# {{WORKBENCH_NAME}} 工作台");
    if (rel === ".codex/hooks.json")
      source = source.replaceAll(root + "/.workbench/bin/", "{{WORKBENCH_ROOT}}/.workbench/bin/");
    const tier = rel.includes("scanner")
      ? "MECHANICAL"
      : /analyst|spec-reviewer/.test(rel)
        ? "DEEP"
        : "STANDARD";
    if (matches(hash(tierTemplate(source, tier, vars[tier + "_MODEL"], vars[tier + "_EFFORT"])))) return true;
    const peer = tierPeer[rel];
    if (!peer) return false;
    const peerPath = managedPath(root, peer);
    if (!lstatSync(peerPath, { throwIfNoEntry: false })?.isFile()) return false;
    const peerSource = readRequired(peerPath).toString();
    // The private mapping can be newer than the last sync. Accept the previous values only
    // when both complete projections reproduce their templates from the same supported release.
    let values: Record<string, unknown>;
    try {
      values = Bun.TOML.parse(source) as Record<string, unknown>;
    } catch {
      return false;
    }
    const { model, model_reasoning_effort: effort } = values;
    if (typeof model !== "string" || typeof effort !== "string") return false;
    const selfRevs = versions[hash(tierTemplate(source, tier, model, effort))];
    const peerRevs = legacy[peer]?.[hash(tierTemplate(peerSource, tier, model, effort))];
    return installedRevisions(lock).some(rev => selfRevs?.includes(rev) && peerRevs?.includes(rev));
  }
  return false;
}

type Operation = { path: string; before: string | null; after: string | null; mode?: number };
const journalRel = ".workbench/sync-journal";
export function checkMigration(root: string) {
  if (existsSync(localPath(root, journalRel)))
    throw Error("An interrupted migration is pending. From the forge-kit release directory, run ./bin/forge sync " + Bun.$.escape(root));
}

function resume(root: string) {
  const journal = localPath(root, journalRel);
  if (!existsSync(journal)) return;
  const ops = JSON.parse(readRequired(localPath(journal, "operations.json")).toString()) as Operation[];
  if (!Array.isArray(ops) || ops.at(-1)?.path !== ".workbench/kit-lock.json")
    throw Error("Invalid migration journal: " + journal);
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
    if (hash(readRequired(src)) !== op.after) throw Error("Damaged staged file for " + dest);
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(src, dest);
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

export function recoverInstall(root: string) {
  resume(root);
}

// A same-filesystem rename publishes the complete plan and all backups before touching any installed file.
export function installAssets(
  root: string,
  assets: Map<string, Asset>,
  lock: InstallLock,
  previous: InstallLock | undefined,
  vars: Record<string, string>,
  force: boolean,
) {
  if (
    previous &&
    (!previous.kit_version ||
      previous.kit_name !== "forge-kit" ||
      (previous.managed_files === undefined && !releases[previous.kit_version]))
  )
    throw Error("Unsupported or invalid .workbench/kit-lock.json; restore the recorded release metadata");
  const previousFiles = previous?.managed_files ?? {};
  const paths = new Set([
    ...Object.keys(previousFiles),
    ...(previous && !previous.managed_files ? oldPaths(previous) : []),
    ...assets.keys(),
  ]);
  const ops: Operation[] = [];
  const preserved: string[] = [];
  for (const rel of paths) {
    const dest = managedPath(root, rel),
      before = state(dest),
      item = assets.get(rel);
    const after = item ? hash(item.bytes) : null;
    if (before === null && !item) continue;
    const tracked = Object.hasOwn(previousFiles, rel) && previousFiles[rel] === before;
    const historical =
      previous && !previous.managed_files && before !== null && oldOwner(root, rel, before, previous, vars);
    if (
      before !== null &&
      !tracked &&
      !historical &&
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
  resume(root);
  return preserved;
}
