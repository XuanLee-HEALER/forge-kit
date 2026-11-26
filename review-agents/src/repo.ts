import { realpathSync } from "node:fs";
import { posix } from "node:path";

export function snapshotGitEnv() {
  const env = { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat" } as NodeJS.ProcessEnv;
  for (const key of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_PREFIX",
    "GIT_SHALLOW_FILE", "GIT_GRAFT_FILE", "GIT_REPLACE_REF_BASE"]) delete env[key];
  return env;
}

const privateDirectories = new Set([".workbench", ".codex", ".agents", ".ssh"]);

export const DIFF_BYTE_LIMIT = 1_500_000;

export class Repo {
  root: string;
  base: string;
  head: string;
  files: string[];
  coverage = new Map<string, Set<number>>();
  diffs = new Map<string, string[]>();
  excludedFiles: string[];
  readFiles = new Set<string>();
  private lineCounts = new Map<string, number>();
  searches = 0;
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
    this.files = this.git([
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      this.base,
      this.head,
      "--",
    ])
      .split("\0")
      .filter(Boolean);
    this.excludedFiles = this.files.filter(isPrivatePath);
    this.files = this.files.filter((p) => !isPrivatePath(p));
  }
  git(args: string[], allowNoMatch = false, maxBytes = 32 * 1024 * 1024) {
    const p = Bun.spawnSync(
      ["git", "-c", "core.quotePath=false", "-C", this.root, ...args],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: snapshotGitEnv(),
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
  lineCount(path: string) {
    const cached = this.lineCounts.get(path);
    if (cached !== undefined) return cached;
    this.path(path);
    const headEntry = this.git(["--literal-pathspecs", "ls-tree", "-z", this.head, "--", path]);
    // A file can be replaced by a directory. Its deleted lines belong to base.
    const entry = !headEntry || /^040000 tree /.test(headEntry)
      ? this.git(["--literal-pathspecs", "ls-tree", "-z", this.base, "--", path]) : headEntry;
    const blob = /^\d+ blob ([0-9a-f]+)\t/.exec(entry);
    const content = blob ? this.git(["cat-file", "blob", blob[1]], false, DIFF_BYTE_LIMIT) : "";
    let lines = content.length && !content.endsWith("\n") ? 1 : 0;
    for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) lines++;
    this.lineCounts.set(path, lines);
    return lines;
  }
  diff(path: string, offset = 0, remainingBytes = DIFF_BYTE_LIMIT) {
    this.path(path);
    if (!this.files.includes(path))
      throw new Error("Path outside changed files");
    let lines = this.diffs.get(path);
    if (!lines) {
      // Cap Git's blob inputs as well as its output. A tiny textual change in a
      // very large blob can otherwise allocate much more than the prompt budget.
      for (const rev of [this.base, this.head]) {
        const entry = this.git(["--literal-pathspecs", "ls-tree", "-l", "-z", rev, "--", path]);
        const blobSize = /^\d+ blob [0-9a-f]+ +([0-9]+)\t/.exec(entry);
        if (blobSize && Number(blobSize[1]) > DIFF_BYTE_LIMIT) throw Error("Changed blob exceeds review material limit");
      }
      lines = this.git([
        "--literal-pathspecs", "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--unified=5",
        this.base,
        this.head,
        "--",
        path,
      ], false, remainingBytes).split("\n");
      this.diffs.set(path, lines);
    }
    const page = this.page(lines, offset);
    const seen = this.coverage.get(path) ?? new Set<number>();
    for (let i = offset; i < page.nextOffset; i++) seen.add(i);
    this.coverage.set(path, seen);
    return page;
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
      this.git(["show", `${sha}:${path}`]).split("\n"),
      offset,
    );
    this.readFiles.add(`${revision}:${path}`);
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
      ":(exclude)*.pem", ":(exclude)*.key"], true);
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
    this.searches++;
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
    const changed = this.files.filter(publicSource).slice(0, 8);
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
      const header = this.read(file, "head", 0).text;
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
  missing() {
    return this.files.filter(
      (f) =>
        !this.diffs.has(f) ||
        this.coverage.get(f)?.size !== this.diffs.get(f)!.length ||
        this.diffs.get(f)!.some((l) => l.startsWith("Binary files ")),
    );
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
