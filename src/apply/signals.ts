import { readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { applyGit, byPath, inspectScanPath, relativeApplyPath, type ApplyRepo } from "./catalog";
import { pathIsIn } from "./inventory";

type Signal = { path: string; kind: string };
const maxSignals = 24;

const conventions: [RegExp, string][] = [
  [/^\.?golangci\.(?:ya?ml|toml|json)$/, "golangci"],
  [/^biome\.jsonc?$/, "biome"],
  [/^(?:\.prettierrc(?:\.[\w.-]+)?|prettier\.config\.[\w.-]+|\.prettierignore)$/, "prettier"],
  [/^(?:\.eslintrc(?:\.[\w.-]+)?|eslint\.config\.[\w.-]+|\.eslintignore)$/, "eslint"],
  [/^tsconfig(?:\.[\w.-]+)?\.json$/, "tsconfig"],
  [/^\.?ruff\.toml$/, "ruff"],
  [/^\.?mypy\.ini$/, "mypy"],
  [/^\.?rustfmt\.toml$/, "rustfmt"],
  [/^\.editorconfig$/, "editorconfig"],
];
const documentFile = /\.(?:md|markdown|mdx|rst|adoc|asciidoc|txt|org|html)$/i;
const environmentTemplate = /^(?:\.env(?:\.[^/]+)?\.example|[^/]+\.example\.(?:env|ya?ml))$/i;
const composeFile = /^(?:docker-)?compose(?:\.[\w.-]+)?\.ya?ml$/i;
const orderSignal = (a: Signal, b: Signal) => byPath(a.path, b.path) || byPath(a.kind, b.kind);

function conventionKinds(file: string, readManifest: (path: string) => string, warnings: string[]) {
  const name = basename(file);
  const root = dirname(file) === ".";
  if ((root && /^(?:readme|contributing|agents|claude)(?:\.[a-z]+)?$/i.test(name) && (!name.includes(".") || documentFile.test(name))) ||
      (file.startsWith("docs/") && documentFile.test(name) &&
        (dirname(file) === "docs" || /convention|guideline|style|architecture/i.test(file)))) {
    return ["documentation"];
  }
  const known = conventions.find(([pattern]) => pattern.test(name));
  if (known) return [known[1]];
  if (!["pyproject.toml", "setup.cfg", "tox.ini"].includes(name)) return [];
  try {
    const text = readManifest(file);
    if (name === "pyproject.toml") {
      const { tool } = Bun.TOML.parse(text) as { tool?: Record<string, unknown> };
      return ["ruff", "mypy"].filter(kind => tool?.[kind] && typeof tool[kind] === "object" && !Array.isArray(tool[kind]));
    }
    return ["ruff", "mypy"].filter(kind =>
      new RegExp("^\\s*\\[(?:tool:)?" + kind + "(?:-[^\\]\\r\\n]+)?\\][ \\t]*(?:[#;].*)?\\r?$", "m").test(text));
  } catch {
    warnings.push("Could not inspect convention declaration: " + JSON.stringify(file));
    return [];
  }
}

function bounded(rows: Signal[], label: string, warnings: string[]) {
  const unique = [...new Map(rows.map(row => [row.path + "\0" + row.kind, row])).values()].sort(orderSignal);
  if (unique.length <= maxSignals) return unique;
  warnings.push(label + " index reached its entry limit.");
  const roots = unique.filter(({ path }) => dirname(path) === ".");
  const nested = unique.filter(({ path }) => dirname(path) !== ".");
  const ordered = [...roots, ...nested];
  const representatives = new Map<string, Signal>();
  for (const row of ordered) if (!representatives.has(row.kind)) representatives.set(row.kind, row);
  return [...new Set([...representatives.values(), ...ordered])].slice(0, maxSignals).sort(orderSignal);
}

function safeFixedPath(repo: ApplyRepo, path: string, kind: "directory" | "file", label: string, warnings: string[]) {
  try {
    const { stat, inaccessible } = inspectScanPath(repo, path);
    if (inaccessible) throw Error();
    if (!stat || (kind === "directory" ? !stat.isDirectory() : !stat.isFile())) return false;
    if (!(stat.mode & 0o444) || (kind === "directory" && !(stat.mode & 0o111))) throw Error();
    return true;
  } catch {
    warnings.push("Could not inspect " + label + ": " + JSON.stringify(path));
    return false;
  }
}

function githubWorkflows(repo: ApplyRepo, warnings: string[]): Signal[] {
  const directory = ".github/workflows";
  if (!safeFixedPath(repo, directory, "directory", "workflow directory", warnings)) return [];
  let names: string[];
  try { names = readdirSync(join(repo.dir, directory)).sort(byPath); }
  catch { warnings.push("Could not list workflow directory: " + JSON.stringify(directory)); return []; }
  const workflows: Signal[] = [];
  for (const name of names) {
    if (!/\.ya?ml$/i.test(name)) continue;
    const path = directory + "/" + name;
    try { if (relativeApplyPath(path) !== path) continue; }
    catch { continue; }
    if (safeFixedPath(repo, path, "file", "workflow file", warnings)) workflows.push({ path, kind: "github-actions" });
  }
  return workflows;
}

const longLived = /^(?:main|master|trunk|dev|develop|development|fat|staging|stage|prod|production|qa|uat|integration|stable|releases?(?:[/-].+)?)$/i;
const maxRecentTags = 30;
const versionTag = /^([a-z][a-z0-9._-]*?)\d+\.\d+(?:\.\d+)?(?:[-+][a-z0-9.+-]+)?$/i;
const hookManifests = ["lefthook", ".lefthook", "lefthook-local", ".lefthook-local"]
  .flatMap(name => ["yml", "yaml", "toml", "json"].map(ext => name + "." + ext));

function gitFlow(repo: ApplyRepo, warnings: string[]) {
  const branch = applyGit(repo.dir, ["symbolic-ref", "--quiet", "HEAD"]);
  const current_branch = !branch.code ? /^refs\/heads\/([^\p{Cc}]+)\n?$/u.exec(branch.stdout)?.[1] ?? null : null;
  const detached = branch.code === 1 && !branch.stderr && !branch.termination;
  if (current_branch === null && !detached) warnings.push("Could not read the current Git branch.");

  const refs = applyGit(repo.dir, ["for-each-ref", "--format=%(refname)%00%(symref)", "refs/heads", "refs/remotes"]);
  const long_lived_branches: { name: string; source: "local" | "remote" }[] = [];
  if (refs.code || refs.stderr) warnings.push("Could not fully read local Git branch references.");
  for (const line of refs.code ? [] : refs.stdout.split("\n")) {
    const [ref, symref] = line.split("\0");
    const match = /^refs\/(heads|remotes)\/([^\p{Cc}]+)$/u.exec(ref);
    if (!match || symref) continue;
    const [, namespace, name] = match;
    const source = namespace === "heads" ? "local" : "remote";
    const refBranch = source === "local" ? name : name.slice(name.indexOf("/") + 1);
    if (longLived.test(refBranch)) long_lived_branches.push({ name, source });
  }
  long_lived_branches.sort((a, b) => byPath(a.name, b.name) || byPath(a.source, b.source));

  const tags = applyGit(repo.dir, ["for-each-ref", "--sort=refname", "--sort=-creatordate", "--count=" + maxRecentTags,
    "--format=%(refname:strip=2)", "refs/tags"]);
  if (tags.code || tags.stderr) warnings.push("Could not fully read local Git tags.");
  const prefixes = tags.code ? [] : tags.stdout.split("\n").flatMap(tag => versionTag.exec(tag)?.[1] ?? []);
  const tag_prefixes = [...new Set(prefixes)].sort(byPath);
  const hook_paths = [
    ...[".husky", "scripts/hooks"].filter(path => safeFixedPath(repo, path, "directory", "hook directory", warnings)),
    ...hookManifests.filter(path => safeFixedPath(repo, path, "file", "hook configuration", warnings)),
  ].sort(byPath);
  const codeowners_paths = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]
    .filter(path => safeFixedPath(repo, path, "file", "CODEOWNERS file", warnings));
  return { current_branch, detached, long_lived_branches, tag_prefixes, hook_paths, codeowners_paths };
}

export function scanSignals(
  repo: ApplyRepo,
  paths: { files: Iterable<string>; dirs: Iterable<string> },
  focus: string[],
  warnings: string[],
  readManifest: (path: string) => string,
  focusRequested = focus.length > 0,
) {
  const convention: Signal[] = [];
  const entry: Signal[] = [];
  const persistence: Signal[] = [];
  const matchesFocus = (path: string) => !focusRequested || focus.some(scope => pathIsIn(scope, path) || pathIsIn(path, scope));
  for (const [sources, directory] of [[paths.files, false], [paths.dirs, true]] as const) {
    for (const path of sources) {
      if (path === ".") continue;
      const name = basename(path).toLowerCase();
      const stem = directory ? name : name.split(".")[0];
      if (!directory && (matchesFocus(path) || dirname(path) === "." || path.startsWith("docs/"))) {
        for (const kind of conventionKinds(path, readManifest, warnings)) convention.push({ path, kind });
      }
      if (!directory && documentFile.test(name)) continue;
      if (matchesFocus(path)) {
        if (/^(?:api|proto|routes|handlers|controllers)$/.test(stem) || /\.proto$/.test(name) || /^openapi/.test(name))
          entry.push({ path, kind: "http-rpc" });
        if (/^(?:consumers|workers|jobs)$/.test(stem) || /^cron/.test(name))
          entry.push({ path, kind: "async" });
        if (/^(?:cmd|bin)$/.test(stem) || (!directory && /(?:^|\/)server\/index\.[^/]+$/i.test(path)))
          entry.push({ path, kind: "executable" });

        if (/^migrations?$/.test(stem)) persistence.push({ path, kind: "migration" });
        if (stem === "prisma" || (!directory && name.endsWith(".prisma"))) persistence.push({ path, kind: "prisma" });
        if (/^schemas?$/.test(stem)) persistence.push({ path, kind: "schema" });
        if (/^(?:orm|models)$/.test(stem)) persistence.push({ path, kind: "orm" });
      }
      if (!directory && (matchesFocus(path) || dirname(path) === ".")) {
        if (environmentTemplate.test(name)) persistence.push({ path, kind: "env-template" });
        if (composeFile.test(name)) persistence.push({ path, kind: "compose" });
      }
    }
  }
  return {
    convention_files: bounded(convention, "Convention", warnings),
    entry_signals: bounded(entry, "Entry signal", warnings),
    persistence_signals: bounded(persistence, "Persistence signal", warnings),
    git_flow: gitFlow(repo, warnings),
    workflows: githubWorkflows(repo, warnings),
  };
}

export function compactForbiddenPaths(paths: Iterable<string>): string[] {
  const patterns = new Set(paths);
  return [...patterns].sort(byPath).filter(pattern => {
    const anchored = pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern;
    for (let parent = dirname(anchored); parent !== "."; parent = dirname(parent)) {
      if (patterns.has(parent + "/**")) return false;
    }
    return true;
  });
}
