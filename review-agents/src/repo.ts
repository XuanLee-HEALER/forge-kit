import { realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";

export function snapshotGitEnv(isolated = true) {
  const env = { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat",
    ...(isolated && {GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1"}) } as NodeJS.ProcessEnv;
  for (const key of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_PREFIX",
    "GIT_SHALLOW_FILE", "GIT_GRAFT_FILE", "GIT_REPLACE_REF_BASE", "GIT_EXTERNAL_DIFF", "GIT_DIFF_OPTS", "GIT_ATTR_SOURCE", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT"]) delete env[key];
  return env;
}

const privateDirectories = new Set([".workbench", ".codex", ".agents", ".ssh"]);

export type Change = {
  path: string; oldPath: string; status: string; oldMode: string; newMode: string;
  oldOid: string; newOid: string; added: number | null; deleted: number | null;
};

export class Repo {
  root: string;
  private isolated = false;
  base: string;
  head: string;
  files: string[] = [];
  changes: Change[] = [];
  excludedFiles: string[] = [];
  constructor(root: string, base: string, head: string, deferInventory = false) {
    this.root = realpathSync(root);
    this.base = this.git([
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${base}^{commit}`,
    ]).trim();
    this.head = this.git([
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${head}^{commit}`,
    ]).trim();
    // Validate ancestry against the source repository (also respects shallow
    // boundaries). Use only its object database for all subsequent evidence.
    this.git(["merge-base", "--is-ancestor", this.base, this.head]);
    if (!deferInventory) this.loadInventory();
  }

  usePinnedObjectView(materialDir: string) {
    const objects = this.git(["rev-parse", "--path-format=absolute", "--git-path", "objects"]).trimEnd();
    const bare = join(materialDir, "pinned.git");
    this.git(["init", "--quiet", "--bare", "--template=", "--object-format=" + (this.head.length === 64 ? "sha256" : "sha1"), bare]);
    symlinkSync(objects, join(materialDir, "source-objects"), "dir");
    writeFileSync(join(bare, "objects/info/alternates"), "../../source-objects\n");
    this.root = bare;
    this.isolated = true;
  }

  loadInventory() {
    const fields = this.git(["diff", "--raw", "--numstat", "--no-abbrev", "--find-renames", "-l0", "--no-ext-diff",
      "--no-textconv", "--ignore-submodules=none", "-z", this.base, this.head, "--"]).split("\0");
    const changes: Change[] = [];
    let n = 0;
    while (fields[n]?.startsWith(":")) {
      const [oldMode, newMode, oldOid, newOid, status] = fields[n++].slice(1).split(" ");
      const oldPath = fields[n++];
      const path = /^[RC]/.test(status) ? fields[n++] : oldPath;
      changes.push({ path, oldPath, status, oldMode, newMode, oldOid, newOid, added: null, deleted: null });
    }
    for (const change of changes) {
      const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(fields[n++]);
      if (!match) throw Error("Incomplete Git change statistics");
      const oldPath = match[3] || fields[n++];
      const path = match[3] || fields[n++];
      if (oldPath !== change.oldPath || path !== change.path) throw Error("Inconsistent Git change inventory");
      change.added = match[1] === "-" ? null : Number(match[1]);
      change.deleted = match[2] === "-" ? null : Number(match[2]);
    }
    if (fields[n] !== "" || n !== fields.length - 1) throw Error("Unexpected Git change inventory");
    this.changes = [];
    this.excludedFiles = [];
    for (const change of changes) {
      const privateOld = isPrivatePath(change.oldPath), privateNew = isPrivatePath(change.path);
      if (!privateOld && !privateNew) { this.changes.push(change); continue; }
      this.excludedFiles.push(privateNew ? change.path : change.oldPath);
      if (privateOld === privateNew) continue;
      // Re-diff the public endpoint as a whole addition/deletion. A paired
      // rename's numstat describes only edits between the private/public blobs.
      const path = privateOld ? change.path : change.oldPath;
      const stats = this.git(["--literal-pathspecs", "diff", "--no-renames", "--no-textconv", "--no-ext-diff",
        "--numstat", "-z", this.base, this.head, "--", path]);
      const row = stats.split("\0").map(s => /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(s)).find(m => m?.[3] === path);
      if (!row) throw Error("Missing public rename statistics");
      const zeroOid = "0".repeat(change.oldOid.length);
      this.changes.push({...change, path, oldPath:path, added:row[1] === "-" ? null : Number(row[1]),
        deleted:row[2] === "-" ? null : Number(row[2]), ...(privateOld ?
          {status:"A", oldOid:zeroOid, oldMode:"000000"} : {status:"D", newOid:zeroOid, newMode:"000000"})});
    }
    this.files = this.changes.map(c => c.path);
  }
  git(args: string[], allowNoMatch = false, maxBytes = 32 * 1024 * 1024) {
    const p = Bun.spawnSync(
      ["git", "-c", "core.attributesFile=/dev/null", "-c", "core.quotePath=false", "-C", this.root, ...args],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...snapshotGitEnv(this.isolated), ...(this.head && {GIT_ATTR_SOURCE:this.head}) },
        timeout: 20000,
        maxBuffer: maxBytes + 1,
      },
    );
    if (p.stdout.byteLength > maxBytes) throw Error("Git output exceeds review material limit");
    if (p.exitCode !== 0 && !(allowNoMatch && p.exitCode === 1))
      throw new Error("Git read failed; verify repository, revision and path");
    return p.stdout.toString();
  }
  path(path: string) {
    if (
      !path ||
      path.startsWith("/") ||
      path.includes("\\") ||
      path.split("/").some((x) => x === ".." || x === ".git") ||
      /[\0\r\n]/.test(path)
    )
      throw new Error("Invalid repository-relative path");
    if (isPrivatePath(path)) throw new Error("Private file excluded");
    return path;
  }
  page(lines: string[], offset: number) {
    if (!Number.isInteger(offset) || offset < 0 || offset > lines.length)
      throw new Error("Invalid offset");
    let end = offset,
      bytes = 0;
    while (
      end < lines.length &&
      end - offset < 160 &&
      bytes + lines[end].length < 24000
    ) {
      bytes += lines[end].length;
      end++;
    }
    if (end === offset && end < lines.length)
      throw new Error(
        "Single line exceeds tool limit; report uncovered content",
      );
    return {
      text: lines
        .slice(offset, end)
        .map((x, i) => `${offset + i + 1}: ${x}`)
        .join("\n"),
      nextOffset: end,
      totalLines: lines.length,
      truncated: end < lines.length,
    };
  }
  private pinnedLines(path: string, revision: "base" | "head") {
    this.path(path);
    if (revision !== "base" && revision !== "head")
      throw new Error("Invalid revision");
    const sha = revision === "base" ? this.base : this.head;
    return this.git(["show", `${sha}:${path}`], false, 96 * 1024).split("\n");
  }
  read(path: string, revision: "base" | "head", offset: number) {
    return this.page(this.pinnedLines(path, revision), offset);
  }
  trackedPaths() {
    return this.git(["ls-tree", "-r", "--name-only", "-z", this.head]).split("\0")
      .filter(p => p && !isInstructionFile(p) && !isPrivatePath(p));
  }

  private grepArgs(terms: string[], globs: string[], maxPerFile?: number) {
    return ["grep", "-n", "-z", "-I", "-F", ...(maxPerFile ? ["-w", "-m", String(maxPerFile)] : []),
      ...terms.flatMap(term => ["-e", term]), this.head, "--", ...globs,
      ...Array.from(privateDirectories, dir => ":(exclude,glob)**/" + dir + "/**"),
      ":(exclude)**/.env*", ":(exclude).env*", ":(exclude)**/config.toml", ":(exclude)config.toml",
      ":(exclude)*.pem", ":(exclude)*.key"];
  }

  private parseHits(raw: string) {
    // Zero-delimited path and line fields keep literal colons in names unambiguous.
    const hits: {path: string; line: number; text: string}[] = [];
    for (const row of raw.split("\n")) {
      const [name, line, text] = row.split("\0");
      if (!name?.startsWith(this.head + ":") || text === undefined) continue;
      const path = name.slice(this.head.length + 1);
      if (!isPrivatePath(path) && !isInstructionFile(path)) hits.push({path, line: Number(line), text});
    }
    return hits;
  }

  private async callerHits(terms: string[], globs: string[]) {
    // Caller snippets are sampled. Drain Git to its actual exit status even
    // when common identifiers produce many more matches than fit in a prompt.
    const proc = Bun.spawn(["git", "-c", "core.attributesFile=/dev/null", "-C", this.root, ...this.grepArgs(terms, globs, 16)], {
      stdout:"pipe", stderr:"ignore", stdin:"ignore", timeout:20_000,
      env:{...snapshotGitEnv(), GIT_ATTR_SOURCE:this.head},
    });
    const prefix = Buffer.alloc(96 * 1024);
    let used = 0, truncated = false;
    for await (const part of proc.stdout) {
      const n = Math.min(part.length, prefix.length - used);
      prefix.set(part.subarray(0, n), used);
      used += n;
      if (n < part.length) truncated = true;
    }
    const code = await proc.exited;
    if (code !== 0 && code !== 1) throw Error("Cannot search pinned caller context");
    const end = truncated ? prefix.lastIndexOf(10) + 1 : used;
    return this.parseHits(prefix.toString("utf8", 0, end));
  }

  search(query: string, glob: string, offset: number) {
    if (typeof query !== "string" || typeof glob !== "string" || query.length > 200 || glob.length > 200)
      throw new Error("Invalid search");
    if (!query) {
      const matcher = new Bun.Glob(glob || "**");
      return this.page(this.trackedPaths().filter(p => matcher.match(p)), offset);
    }
    return this.page(this.parseHits(this.git(this.grepArgs([query], [glob || "*"]), true, 96 * 1024)).map(h => h.path + ":" + h.line + ":" + h.text), offset);
  }

  async context(diff: Record<string, string>) {
    const extensions = ["ts","tsx","js","jsx","mts","cts","mjs","cjs","go","py","rs","java","kt","swift","rb","c","cc","cpp","h","hpp"];
    const publicSource = (p: string) => extensions.includes(posix.extname(p).slice(1)) &&
      !/(^|\/)(?:\.workbench|\.agents|\.codex|\.ssh|node_modules|vendor)\//.test(p);
    const delivered = new Set(Object.keys(diff));
    const changed = Object.keys(diff).filter(publicSource).slice(0, 8);
    const files: { path: string; text: string }[] = [];
    const omitted: string[] = [];
    if (!changed.length) return { revision: this.head, files, omitted };
    const paths = new Set(this.trackedPaths().filter(publicSource));
    const candidates = new Map<string, number>();
    const dependencies = new Map<string, Map<string, number>>();
    const callerNames = new Map<string, number>();
    for (const file of changed) {
      const patch = diff[file] ?? "";
      // Public declarations generally identify callers much more precisely
      // than local variables introduced in the same function body.
      const publicName = /\b(?:export\s+(?:async\s+)?(?:function|class|interface|type|const)|def|fn|func)\s+([A-Za-z_]\w{2,})/g;
      const added = patch.split("\n").filter(line=>line.startsWith("+")).join("\n");
      const removed = patch.split("\n").filter(line=>line.startsWith("-")).join("\n");
      const oldExports = new Set([...removed.matchAll(publicName)].map(m=>m[1]));
      const remember = (name:string, rank:number) => callerNames.set(name, Math.max(rank, callerNames.get(name) ?? 0));
      for (const m of patch.matchAll(/\b(?:function|class|interface|const)\s+([A-Za-z_]\w{2,})/g)) remember(m[1], 1);
      for (const m of patch.matchAll(publicName)) remember(m[1], 2);
      for (const m of added.matchAll(publicName)) remember(m[1], oldExports.has(m[1]) ? 3 : 4);
      const stem = posix.parse(file).name;
      if (/^[a-zA-Z_]\w{2,}$/.test(stem) && !["index","main","mod"].includes(stem)) remember(stem, 1);
      if (!paths.has(file)) continue;
      let header = "";
      try { header = this.read(file, "head", 0).text; } catch { omitted.push(file); }
      const source = header.replace(/^\d+: /gm, "") + "\n" + patch.replace(/^[+ -]/gm, "");
      const references = patchReferences(patch);
      const bindings = new Map<string, Map<string,string>>();
      for (const [, names, specifier] of source.matchAll(/\bimport\s+(?:type\s+)?\{([^{};"']+)\}\s*from\s*["']([^"']+)["']/g)) {
        const bound = bindings.get(specifier) ?? new Map<string,string>();
        for (const field of names.split(",")) {
          const pair = /^(?:type\s+)?(\w+)(?:\s+as\s+(\w+))?$/.exec(field.trim());
          if (pair) bound.set(pair[1], pair[2] ?? pair[1]);
        }
        bindings.set(specifier,bound);
      }
      for (const m of (header + "\n" + patch).matchAll(/["'](\.\.?\/[^"'\s]+)["']/g)) {
        const target = posix.join(posix.dirname(file), m[1]);
        // TS sources commonly refer to a .js module in their emitted imports.
        const stem = target.replace(/\.[cm]?js$/, "");
        const dep = [target, ...["ts","tsx","js","jsx","mts","cts","mjs","cjs","py","rs"].flatMap(
          ext => [stem + "." + ext, posix.join(stem, "index." + ext)])].find(p => paths.has(p));
        if (!dep || delivered.has(dep)) continue;
        const symbols = dependencies.get(dep) ?? new Map<string, number>();
        const bound = bindings.get(m[1]);
        if (bound) {
          for (const [original,local] of bound) symbols.set(original, Math.max(symbols.get(original) ?? 0, references.get(local) ?? 0));
        } else {
          for (const [name, weight] of references) symbols.set(name, Math.max(symbols.get(name) ?? 0, weight));
        }
        dependencies.set(dep, symbols);

      }
    }
    const modified = new Set(this.files);
    const relevance = (refs:Map<string,number>) => Math.max(0, ...refs.values());
    const rankedDeps = [...dependencies].sort(([pa,a],[pb,b]) => relevance(b) - relevance(a) || Number(modified.has(pb)) - Number(modified.has(pa)));
    for (const [path] of rankedDeps.slice(0,6)) candidates.set(path, 0);

    const names = [...callerNames].sort((a,b) => b[1] - a[1]).slice(0,24);
    const exported = names.filter(([,rank])=>rank >= 2);
    const hits = names.length ? await this.callerHits((exported.length ? exported : names).map(([name])=>name), extensions.map(ext => "*." + ext)) : [];
    // Prefer calls to a changed declaration over imports and incidental text.
    const callRank = (line:string) => {
      let rank = 0;
      for (const [,name] of line.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) rank = Math.max(rank,callerNames.get(name) ?? 0);
      return rank;
    };
    hits.sort((a, b) => callRank(b.text) - callRank(a.text) || Number(modified.has(b.path)) - Number(modified.has(a.path)));
    for (const hit of hits) {
      if (!paths.has(hit.path) || delivered.has(hit.path) || candidates.has(hit.path)) continue;
      candidates.set(hit.path, hit.line - 1);
      if (candidates.size >= 12) break;
    }
    for (const [path, offset] of candidates) {
      try {
        const lines = this.pinnedLines(path, "head");
        const definitions: { anchor:number; weight:number }[] = [];
        const references = dependencies.get(path);
        if (references) {
          for (const [i, line] of lines.entries()) {
            const declaration = /\b(?:function|class|interface|const|let|var|type|enum|struct|trait|def|fn|func)\s+([A-Za-z_]\w*)/.exec(line);
            const weight = declaration ? references.get(declaration[1]) ?? 0 : 0;
            if (weight) definitions.push({anchor:i, weight});
          }
        }
        definitions.sort((a,b) => b.weight - a.weight);
        const anchors = definitions.length ? definitions.filter(d=>d.weight === definitions[0].weight).slice(0,8).map(d=>d.anchor) : [offset];
        const cap = Math.floor(4096/anchors.length) - 1;
        const text = anchors.map(anchor=>contextExcerpt(lines,anchor,cap)).filter(Boolean).join("\n");
        if (text) files.push({path, text});
        else omitted.push(path);
      } catch { omitted.push(path); }
    }
    return { revision: this.head, files, omitted };
  }

}

// Prefer symbols invoked by added lines, then calls in surrounding patch
// context.
function patchReferences(patch: string) {
  const names = new Map<string, number>();
  for (const line of patch.split("\n")) {
    if (!/^[+ -]/.test(line) || /^(?:\+\+\+|---)/.test(line)) continue;
    for (const match of line.matchAll(/\b([A-Za-z_]\w*)\b(\s*\()?/g)) {
      const rank = 1 + Number(line.startsWith("+")) + (match[2] ? 2 : 0);
      names.set(match[1], Math.max(rank, names.get(match[1]) ?? 0));
    }
  }
  // A newly added named import is stronger evidence than an incidental
  // existing call in a large hunk. Multiline imports often use one name per line.
  for (const [, name] of patch.matchAll(/^\+\s*([A-Za-z_]\w*)\s*(?:as\s+\w+)?\s*,\s*$/gm)) {
    if ((names.get(name) ?? 0) > 2) names.set(name, 5);
  }
  return names;
}

function contextExcerpt(lines: string[], anchor: number, limit: number) {
  if (anchor >= lines.length) return "";
  const numbered = (i: number) => (i + 1) + ": " + lines[i];
  const excerpt = [numbered(anchor)];
  let bytes = Buffer.byteLength(excerpt[0]);
  if (bytes > limit) return "";
  // Keep the anchor visible even when preceding source lines are very long.
  for (let i = anchor - 1; i >= Math.max(0, anchor - 8); i--) {
    const line = numbered(i), size = Buffer.byteLength(line) + 1;
    if (bytes + size > limit / 2) break;
    excerpt.unshift(line);
    bytes += size;
  }
  for (let i = anchor + 1; i < lines.length && excerpt.length < 160; i++) {
    const line = numbered(i), size = Buffer.byteLength(line) + 1;
    if (bytes + size > limit) break;
    excerpt.push(line);
    bytes += size;
  }
  return excerpt.join("\n");
}

function isInstructionFile(path: string) {
  return /(^|\/)(CLAUDE|AGENTS|SKILL|WORKBENCH)\.md$/i.test(path);
}

export function isPrivatePath(path: string) {
  if (/(^|\/)(?:AGENTS\.local\.md(?:$|\/)|\.env(?:$|[./])|config\.toml$)|\.(?:pem|key)$/.test(path)) return true;
  const parts = path.split("/");
  const privateIndex = parts.findIndex(part => privateDirectories.has(part));
  if (privateIndex === -1) return false;
  // Only the public skill document itself may cross a private directory boundary.
  const [marker, container, id, file, ...rest] = parts.slice(privateIndex);
  return !(marker === ".agents" && container === "skills" && id && !privateDirectories.has(id) &&
    file === "SKILL.md" && rest.length === 0);
}
