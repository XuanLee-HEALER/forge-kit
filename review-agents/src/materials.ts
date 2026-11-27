import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, writeFileSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { Repo, snapshotGitEnv } from "./repo";

const CHUNK_BYTES = 12_000;
const INDEX_BYTES = 20_000;
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export type Chunk = {
  id: string; receiptId: string; path: string; oldStart: number; oldEnd: number; newStart: number; newEnd: number;
  deletedRanges: [number, number][]; continued: boolean; size: number;
};
export type Material = ReturnType<typeof prepareMaterials>;

function gitToFile(dir: string, args: string[], file: string, allowed: number[]) {
  const fd = openSync(file, "w", 0o600);
  try {
    const result = spawnSync("git", args, { cwd: dir, stdio: ["ignore", fd, "ignore"], env: snapshotGitEnv(), timeout: 120_000 });
    if (!allowed.includes(result.status ?? -1)) throw Error("Unable to read pinned Git patch");
  } finally { closeSync(fd); }
}

// Stream even a single unterminated source line in bounded UTF-8 pieces.
function* pieces(file: string) {
  const fd = openSync(file, "r");
  const buffer = Buffer.alloc(2048);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  try {
    let n: number, pending = "";
    do {
      n = readSync(fd, buffer);
      const text = decoder.decode(buffer.subarray(0, n), {stream: n > 0});
      for (const [part] of text.matchAll(/[^\n]*\n|[^\n]+$/g)) {
        pending += part;
        if (part.endsWith("\n") || Buffer.byteLength(pending) >= 4096) {
          yield pending;
          pending = "";
        }
      }
    } while (n);
    if (pending) yield pending;
  } finally { closeSync(fd); }
}

function* patchChunks(file: string) {
  let text = "", bytes = 0, continued = false;
  let old = 0, head = 0, oldStart = 0, oldEnd = 0, newStart = 0, newEnd = 0;
  let kind = "", header = "", atLineStart = true, inHunk = false;
  let deletedRanges: [number, number][] = [];
  function take() {
    const value = {patch: text, oldStart, oldEnd, newStart, newEnd, deletedRanges, continued};
    deletedRanges = [];
    text = ""; bytes = oldStart = oldEnd = newStart = newEnd = 0;
    return value;
  }
  for (const part of pieces(file)) {
    if (atLineStart) {
      kind = part[0];
      if (kind === "@") {
        if (text && inHunk) yield take();
        header = "";
        continued = false;
      }
    }
    if (kind === "@") {
      header = (header + part).slice(0, 160);
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header);
      if (hunk) { old = Number(hunk[1]); head = Number(hunk[2]); inHunk = true; }
    }
    const length = Buffer.byteLength(JSON.stringify(part)) - 2;
    if (bytes + length > CHUNK_BYTES && text) {
      yield take();
      continued = !atLineStart;
    }
    if (inHunk && kind === "-") {
      const last = deletedRanges.at(-1);
      if (last && old <= last[1] + 1) last[1] = old;
      else deletedRanges.push([old, old]);
    }
    if (inHunk && (kind === " " || kind === "-")) { oldStart ||= old; oldEnd = old; }
    if (inHunk && (kind === " " || kind === "+")) { newStart ||= head; newEnd = head; }
    text += part;
    bytes += length;
    atLineStart = part.endsWith("\n");
    if (atLineStart && inHunk) {
      if (kind === " " || kind === "-") old++;
      if (kind === " " || kind === "+") head++;
    }
  }
  if (text) yield take();
}

function moduleKey(path: string) {
  return basename(path).replace(/\.[^.]+$/, "").replace(/(?:[._-](?:spec|tests?))$/i, "").replace(/^test[_-]/i, "").toLowerCase();
}

export function prepareMaterials(repo: Repo, dir: string) {
  const chunks: Chunk[] = [];
  const missing = [...repo.excludedFiles];
  const limitations: string[] = [];
  const left = join(dir, "base"), right = join(dir, "head"), patchFile = join(dir, "patch");
  const changes = repo.changes.toSorted((a, b) => moduleKey(a.path).localeCompare(moduleKey(b.path)) || a.path.localeCompare(b.path));
  for (const change of changes) {
    try {
      if (change.added === null || change.deleted === null) throw Error("binary change");
      if ([change.oldMode, change.newMode].includes("160000")) throw Error("submodule content");
      for (const [oid, file] of [[change.oldOid, left], [change.newOid, right]]) {
        if (/^0+$/.test(oid)) writeFileSync(file, "");
        else gitToFile(repo.root, ["cat-file", "blob", oid], file, [0]);
      }
      gitToFile(dir, ["-c", "diff.noprefix=false", "diff", "--no-index", "--no-color", "--no-ext-diff", "--no-textconv",
        "--text", "--unified=5", "--", "base", "head"], patchFile, [0, 1]);
      let part = 0;
      function record(p: Omit<Chunk, "id" | "receiptId" | "size" | "path"> & {patch: string}) {
        const {patch, ...bounds} = p;
        const id = digest(JSON.stringify([repo.base, repo.head, change, part++, bounds, digest(patch)]));
        writeFileSync(join(dir, id), patch, {mode:0o600});
        // The full digest remains the storage and coverage key. The ordinal
        // makes receipt handles unique even when two digest prefixes coincide.
        const receiptId = (chunks.length + 1) + "-" + id.slice(0, 4);
        chunks.push({id, receiptId, path:change.path, ...bounds, size:Buffer.byteLength(JSON.stringify(patch))});
      }
      for (const p of patchChunks(patchFile)) record(p);
      if (!part) record({patch:JSON.stringify(change), oldStart:0, oldEnd:0, newStart:0, newEnd:0, deletedRanges:[], continued:false});
    } catch (error) {
      missing.push(change.path);
      limitations.push(change.path + " (" + (error instanceof Error ? error.message : "unreadable material") + ")");
    }
  }
  const manifest = repo.changes.map(({oldOid, newOid, ...change}) => change);
  const hash = digest(JSON.stringify(manifest));
  const summary = {files: manifest.length + repo.excludedFiles.length, excluded: repo.excludedFiles.length, digest: hash};
  const fullIndex = {...summary, changes:manifest};
  // Positions address the same immutable sequence in the full index, its
  // page directory, and the complete entries attached to individual batches.
  const byPath = new Map(repo.changes.map((c, position) => [c.path, {...c, position}]));
  if (Buffer.byteLength(JSON.stringify(fullIndex)) <= INDEX_BYTES)
    return {dir, chunks, missing, limitations, index:fullIndex, byPath};
  // The fixed Git inventory order is also the page order.
  const pageSize = Math.max(1, Math.ceil(manifest.length / 48));
  const pages = [];
  for (let i = 0; i < manifest.length; i += pageSize) {
    const page = manifest.slice(i, i + pageSize);
    const types: Record<string, number> = Object.create(null);
    let added = 0, deleted = 0;
    for (const change of page) {
      const type = change.status[0];
      types[type] = (types[type] ?? 0) + 1;
      added += change.added ?? 0;
      deleted += change.deleted ?? 0;
    }
    const first = page[0].path, last = page.at(-1)!.path;
    // Each of at most 48 pages uses two optional labels of at most 96 encoded
    // bytes. Ordinals still locate every range when paths require long labels.
    pages.push({offset:i, count:page.length, types, added, deleted,
      ...(Buffer.byteLength(JSON.stringify(first)) <= 96 && {first}),
      ...(Buffer.byteLength(JSON.stringify(last)) <= 96 && {last})});
  }
  const index = {...summary, pages};
  return {dir, chunks, missing, limitations, index, byPath};
}

// Give each related file a turn before taking the next chunk from the same file.
function* interleaveFiles(group: Chunk[]) {
  const files = new Map<string, Chunk[]>();
  for (const chunk of group) {
    const parts = files.get(chunk.path);
    if (parts) parts.push(chunk);
    else files.set(chunk.path, [chunk]);
  }
  let active = [...files.values()];
  for (let offset = 0; active.length; offset++) {
    for (const parts of active) yield parts[offset];
    active = active.filter(parts => parts.length > offset + 1);
  }
}

// Keep small source/test groups together even when the preceding batch is nearly full.
export function* batches(chunks: Chunk[]) {
  const maxBytes = 56_000, maxCount = 32;
  let pending: Chunk[] = [], bytes = 0;
  for (let i = 0; i < chunks.length;) {
    const start = i, group = moduleKey(chunks[i].path);
    let groupBytes = 0;
    do { groupBytes += chunks[i++].size; } while (i < chunks.length && moduleKey(chunks[i].path) === group);
    if (pending.length && (bytes + groupBytes > maxBytes || pending.length + i - start > maxCount)) {
      yield pending;
      pending = []; bytes = 0;
    }
    const groupChunks = chunks.slice(start, i);
    const ordered = groupBytes > maxBytes || groupChunks.length > maxCount ? interleaveFiles(groupChunks) : groupChunks;
    for (const chunk of ordered) {
      if (pending.length && (bytes + chunk.size > maxBytes || pending.length === maxCount)) {
        yield pending;
        pending = []; bytes = 0;
      }
      pending.push(chunk);
      bytes += chunk.size;
    }
  }
  if (pending.length) yield pending;
}

export function loadChunk(material: Material, chunk: Chunk) {
  const {id, receiptId, ...bounds} = chunk;
  return {id:receiptId, ...bounds, patch:readFileSync(join(material.dir, id), "utf8")};
}

export function batchChanges(byPath: Material["byPath"], chunks: Chunk[]) {
  return [...new Set(chunks.map(c => c.path))].map(path => byPath.get(path)!);
}
