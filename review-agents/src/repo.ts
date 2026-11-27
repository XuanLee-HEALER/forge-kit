import { realpathSync } from "node:fs";
import { posix } from "node:path";

export function snapshotGitEnv() {
  const env = { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat" } as NodeJS.ProcessEnv;
  for (const key of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_PREFIX",
    "GIT_SHALLOW_FILE", "GIT_GRAFT_FILE", "GIT_REPLACE_REF_BASE", "GIT_EXTERNAL_DIFF", "GIT_DIFF_OPTS", "GIT_ATTR_SOURCE"]) delete env[key];
  return env;
}

const privateDirectories = new Set([".workbench", ".codex", ".agents", ".ssh"]);

export type Change = {
  path: string; oldPath: string; status: string; oldMode: string; newMode: string;
  oldOid: string; newOid: string; added: number | null; deleted: number | null;
};

export class Repo {
  root: string;
  base: string;
  head: string;
  files: string[];
  changes: Change[];
  excludedFiles: string[];
  constructor(root: string, base: string, head: string) {
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
    const privateChange = (c: Change) => isPrivatePath(c.path) || isPrivatePath(c.oldPath);
    this.excludedFiles = changes.filter(privateChange).map(c => c.path);
    this.changes = changes.filter(c => !privateChange(c));
    this.files = this.changes.map(c => c.path);
  }
  git(args: string[], allowNoMatch = false, maxBytes = 32 * 1024 * 1024) {
    const p = Bun.spawnSync(
      ["git", "-c", "core.quotePath=false", "-C", this.root, ...args],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...snapshotGitEnv(), ...(this.head && {GIT_ATTR_SOURCE:this.head}) },
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
  read(path: string, revision: "base" | "head", offset: number) {
    this.path(path);
    if (revision !== "base" && revision !== "head")
      throw new Error("Invalid revision");
    const sha = revision === "base" ? this.base : this.head;
    const result = this.page(
      this.git(["show", `${sha}:${path}`], false, 96 * 1024).split("\n"),
      offset,
    );
    return result;
  }
  trackedPaths() {
    return this.git(["ls-tree", "-r", "--name-only", "-z", this.head]).split("\0")
      .filter(p => p && !isInstructionFile(p) && !isPrivatePath(p));
  }

  private searchHits(terms: string[], globs: string[], maxPerFile?: number) {
    // Zero-delimited path and line fields keep literal colons in names unambiguous.
    const raw = this.git(["grep", "-n", "-z", "-I", "-F", ...(maxPerFile ? ["-m", String(maxPerFile)] : []),
      ...terms.flatMap(term => ["-e", term]), this.head, "--", ...globs,
      ...Array.from(privateDirectories, dir => ":(exclude,glob)**/" + dir + "/**"),
      ":(exclude)**/.env*", ":(exclude).env*", ":(exclude)**/config.toml", ":(exclude)config.toml",
      ":(exclude)*.pem", ":(exclude)*.key"], true, 96 * 1024);
    const hits: {path: string; line: number; text: string}[] = [];
    for (const row of raw.split("\n")) {
      const [name, line, text] = row.split("\0");
      if (!name?.startsWith(this.head + ":") || text === undefined) continue;
      const path = name.slice(this.head.length + 1);
      if (!isPrivatePath(path) && !isInstructionFile(path)) hits.push({path, line: Number(line), text});
    }
    return hits;
  }

  search(query: string, glob: string, offset: number) {
    if (typeof query !== "string" || typeof glob !== "string" || query.length > 200 || glob.length > 200)
      throw new Error("Invalid search");
    if (!query) {
      const matcher = new Bun.Glob(glob || "**");
      return this.page(this.trackedPaths().filter(p => matcher.match(p)), offset);
    }
    return this.page(this.searchHits([query], [glob || "*"]).map(h => h.path + ":" + h.line + ":" + h.text), offset);
  }

  context(diff: Record<string, string>) {
    const extensions = ["ts","tsx","js","jsx","mts","cts","mjs","cjs","go","py","rs","java","kt","swift","rb","c","cc","cpp","h","hpp"];
    const publicSource = (p: string) => extensions.includes(posix.extname(p).slice(1)) &&
      !/(^|\/)(?:\.workbench|\.agents|\.codex|\.ssh|node_modules|vendor)\//.test(p);
    const changedPaths = new Set(this.files);
    const changed = Object.keys(diff).filter(publicSource).slice(0, 8);
    const files: { path: string; text: string }[] = [];
    const omitted: string[] = [];
    if (!changed.length) return { revision: this.head, files, omitted };
    const paths = new Set(this.trackedPaths().filter(publicSource));
    const candidates = new Map<string, number>();
    const names = new Set<string>();
    for (const file of changed) {
      const patch = diff[file] ?? "";
      for (const m of patch.matchAll(/\b(?:function|class|interface|const|def|fn|func)\s+([A-Za-z_]\w{2,})/g))
        if (names.size < 24) names.add(m[1]);
      const stem = posix.parse(file).name;
      if (/^[a-zA-Z_]\w{2,}$/.test(stem) && !["index","main","mod"].includes(stem)) names.add(stem);
      if (!paths.has(file)) continue;
      let header = "";
      try { header = this.read(file, "head", 0).text; } catch { /* The patch still provides changed imports. */ }
      for (const m of (header + "\n" + patch).matchAll(/["'](\.\.?\/[^"'\s]+)["']/g)) {
        const target = posix.join(posix.dirname(file), m[1]);
        // TS sources commonly refer to a .js module in their emitted imports.
        const stem = target.replace(/\.[cm]?js$/, "");
        const dep = [target, ...["ts","tsx","js","jsx","mts","cts","mjs","cjs","py","rs"].flatMap(
          ext => [stem + "." + ext, posix.join(stem, "index." + ext)])].find(p => paths.has(p));
        if (dep && !changedPaths.has(dep) && candidates.size < 6) candidates.set(dep, 0);
      }
    }
    const hits = names.size ? this.searchHits([...names], extensions.map(ext => "*." + ext), 4) : [];
    const importLine = (text: string) => /^\s*(?:import\b|from\b.*\bimport\b|(?:const|let|var)\b.*\brequire\s*\()/.test(text);
    // Prefer the call site to its import when the two are far apart.
    hits.sort((a, b) => Number(importLine(a.text)) - Number(importLine(b.text)));
    for (const hit of hits) {
      if (!paths.has(hit.path) || changedPaths.has(hit.path) || candidates.has(hit.path)) continue;
      candidates.set(hit.path, Math.max(0, hit.line - 10));
      if (candidates.size >= 12) break;
    }
    for (const [path, offset] of candidates) {
      // Up to 4 KiB per excerpt, 12 files total. Keep complete numbered lines.
      let text: string;
      try { text = this.read(path, "head", offset).text; }
      catch { omitted.push(path); continue; }
      const lines: string[] = [];
      let bytes = 0;
      for (const line of text.split("\n")) {
        bytes += Buffer.byteLength(line) + 1;
        if (bytes > 4096) break;
        lines.push(line);
      }
      if (lines.length) files.push({path, text: lines.join("\n")});
      else omitted.push(path);
    }
    return { revision: this.head, files, omitted };
  }

}

function isInstructionFile(path: string) {
  return /(^|\/)(CLAUDE|AGENTS|SKILL|WORKBENCH)\.md$/i.test(path);
}

function isPrivatePath(path: string) {
  if (/(^|\/)(?:AGENTS\.local\.md(?:$|\/)|\.env(?:$|[./])|config\.toml$)|\.(?:pem|key)$/.test(path)) return true;
  const parts = path.split("/");
  const privateIndex = parts.findIndex(part => privateDirectories.has(part));
  if (privateIndex === -1) return false;
  // Only the public skill document itself may cross a private directory boundary.
  const [marker, container, id, file, ...rest] = parts.slice(privateIndex);
  return !(marker === ".agents" && container === "skills" && id && !privateDirectories.has(id) &&
    file === "SKILL.md" && rest.length === 0);
}
