import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import { checkoutEnvironment, isOid, runProcess } from "../git";

export type ApplyRepo = { repo: string; dir: string; slug: string; boundaries: string[] };
export type ApplyCatalog = { repos: ApplyRepo[]; registered: string[]; warnings: string[] };

const scanExclusions = new Set([".git", "node_modules", "vendor", "dist", "build", "target", ".venv", ".workbench",
  ".DS_Store", ".claude", ".codex", ".agents"]);
export const scanExcluded = (path: string) => path.split(/[\\/]/).some(segment =>
  scanExclusions.has(segment) || (/^\.env(?:\.|$)/.test(segment) && !/^\.env(?:\..+)?\.example$/.test(segment)));
export const byPath = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export function containsPath(parent: string, child: string): boolean {
  const offset = relative(parent, child);
  return offset !== ".." && !offset.startsWith("../") && !isAbsolute(offset);
}

export function relativeApplyPath(input: string): string {
  if (!input || isAbsolute(input) || win32.isAbsolute(input) || /^[a-z]:/i.test(input) ||
      /[\\\p{Cc}]/u.test(input) || input.split("/").includes(".."))
    throw Error("Expected a safe relative path: " + JSON.stringify(input));
  return input.split("/").filter(segment => segment && segment !== ".").join("/") || ".";
}

export function hasRepositoryMarker(dir: string, includeLinks = false): boolean {
  const marker = lstatSync(join(dir, ".git"), { throwIfNoEntry: false });
  return Boolean(marker?.isFile() || marker?.isDirectory() || (includeLinks && marker?.isSymbolicLink()));
}

type ApplyPath = { path: string; stat?: Stats; excluded?: true; inaccessible?: true; symbolicLink?: true };
export function inspectApplyPath(root: string, path: string, boundaries?: string[],
  scan?: { followSymlinks?: boolean }): ApplyPath {
  let at = root;
  let pending = path.split("/").filter(Boolean);
  let links = 0;
  let stat = lstatSync(root, { throwIfNoEntry: false });
  while (pending.length) {
    const segment = pending.shift()!;
    if (segment === ".") continue;
    if (segment === "..") {
      if (at === root) throw Error("Path escapes repository via symlink: " + JSON.stringify(path));
      at = dirname(at);
      if (stat?.isDirectory()) stat = lstatSync(at);
      else stat = undefined;
      continue;
    }
    let next = join(at, segment);
    if (boundaries?.some(boundary => containsPath(boundary, next)))
      throw Error("Path crosses a repository boundary: " + JSON.stringify(path));
    if (scan && stat?.isDirectory() && !(stat.mode & 0o111))
      return { path: next, inaccessible: true };
    stat = stat?.isDirectory() ? lstatSync(next, { throwIfNoEntry: false }) : undefined;
    if (!stat?.isSymbolicLink()) {
      if (scan && stat) {
        next = realpathSync(next);
        if (!containsPath(root, next)) throw Error("Path escapes repository: " + JSON.stringify(path));
        if (scanExcluded(relative(root, next))) return { path: root, excluded: true };
        if (boundaries?.some(boundary => containsPath(boundary, next)))
          throw Error("Path crosses a repository boundary: " + JSON.stringify(path));
      }
      if (boundaries && stat?.isDirectory() && (!scan || (stat.mode & 0o111)) && hasRepositoryMarker(next, Boolean(scan)))
        throw Error("Path crosses a repository boundary: " + JSON.stringify(path));
      at = next;
      continue;
    }
    if (scan && !scan.followSymlinks) return { path: next, symbolicLink: true };
    if (++links > 40) throw Error("Too many symbolic links: " + JSON.stringify(path));
    let target = readlinkSync(next);
    if (isAbsolute(target)) {
      const prefix = root === "/" ? root : root + "/";
      if (target !== root && !target.startsWith(prefix))
        throw Error("Path escapes repository via symlink: " + JSON.stringify(path));
      target = target.slice(prefix.length);
      at = root;
    }
    if (scan) {
      if (scanExcluded(target)) return { path: next, excluded: true };
      if (/[\\\p{Cc}]/u.test(target) || /^[a-z]:/i.test(target))
        throw Error("Unsafe symbolic link target for path: " + JSON.stringify(path));
    }
    pending = [...target.split("/").filter(Boolean), ...pending];
    stat = lstatSync(at);
  }
  return { path: at, stat };
}

export function inspectScanPath(repo: Pick<ApplyRepo, "dir" | "boundaries">, path: string,
  options: { followSymlinks?: boolean } = {}): ApplyPath {
  if (scanExcluded(path)) return { path: repo.dir, excluded: true };
  if (relativeApplyPath(path) !== path) throw Error("Expected a canonical scan path.");
  try {
    return inspectApplyPath(repo.dir, path, repo.boundaries, options);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") return { path: join(repo.dir, path), inaccessible: true };
    throw error;
  }
}

export function validateApplyPath(repo: ApplyRepo, input: string): string {
  const path = relativeApplyPath(input);
  inspectApplyPath(repo.dir, path, repo.boundaries);
  return path;
}

export function applyGit(dir: string, args: string[]) {
  const env = checkoutEnvironment();
  for (const key of Object.keys(env))
    if (/^GIT_(?:CONFIG(?:_|$)|TRACE|REDIRECT_|TEST_)/.test(key) ||
        ["GIT_EXTERNAL_DIFF", "GIT_ALLOW_PROTOCOL"].includes(key)) delete env[key];
  Object.assign(env, {
    GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "", GIT_ATTR_NOSYSTEM: "1", LC_ALL: "C",
  });
  return runProcess(["git", "-C", dir, "--no-pager", "--literal-pathspecs",
    "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never", ...args], { env });
}

export function applyHead(dir: string) {
  const result = applyGit(dir, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (!result.code && isOid(result.stdout.trim())) return { head: result.stdout.trim(), available: true };
  const unborn = applyGit(dir, ["symbolic-ref", "--quiet", "HEAD"]);
  if (!unborn.code && !result.termination) {
    const branch = applyGit(dir, ["show-ref", "--verify", "--quiet", unborn.stdout.trim()]);
    if (branch.code === 1 && !branch.termination) return { head: null, available: true };
  }
  return { head: null, available: false };
}

function identifyCheckout(dir: string, gitDirectory: string): boolean {
  if (lstatSync(join(gitDirectory, "commondir"), { throwIfNoEntry: false })) return false;
  for (const file of ["HEAD", "shallow", "config", "index", "refs", "packed-refs", "objects", "info"]) {
    const stat = lstatSync(join(gitDirectory, file), { throwIfNoEntry: false });
    if (stat && !stat.isDirectory() && !stat.isFile()) return false;
  }
  const result = applyGit(dir, ["rev-parse", "--absolute-git-dir", "--git-common-dir", "--show-toplevel"]);
  if (result.code) return false;
  const [gitDir, commonDir, top] = result.stdout.replace(/\n$/, "").split("\n");
  try {
    return Boolean(gitDir && commonDir && top && realpathSync(resolve(dir, gitDir)) === gitDirectory &&
      realpathSync(resolve(dir, commonDir)) === gitDirectory && realpathSync(resolve(dir, top)) === dir);
  } catch { return false; }
}

function gitSetup(dir: string, workspace: string) {
  const marker = join(dir, ".git");
  const stat = lstatSync(marker, { throwIfNoEntry: false });
  if (stat?.isDirectory()) return marker;
  if (!stat?.isFile() || stat.size > 4096 || !(stat.mode & 0o444)) return null;
  const target = readFileSync(marker, "utf8").match(/^gitdir: ([^\r\n]+)\r?\n?$/)?.[1];
  if (!target) return null;
  // A gitfile may be a primary checkout (separate Git dir or submodule) or a
  // linked worktree. Validate the local target before Git reads it. Keep raw
  // components so an escaping symlink cannot disappear through lexical `..`.
  const prefix = workspace === "/" ? workspace : workspace + "/";
  if (isAbsolute(target) && !target.startsWith(prefix)) return null;
  const path = isAbsolute(target) ? target.slice(prefix.length) : (relative(workspace, dir) || ".") + "/" + target;
  try {
    const selected = inspectApplyPath(workspace, path);
    return selected.stat?.isDirectory() && selected.path !== workspace ? selected.path : null;
  } catch { return null; }
}

function gitlinks(root: string, warnings: string[]) {
  const paths = new Set<string>();
  const results = [
    // Only direct gitlinks can change the workspace layout. The glob is internal and fixed.
    applyGit(root, ["--no-literal-pathspecs", "ls-files", "--stage", "-z", "--", ":(top,glob)*"]),
    applyGit(root, ["ls-tree", "-z", "HEAD"]),
  ];
  if (results[0].code) warnings.push("Could not read root Git index for submodule discovery.");
  for (const result of results) {
    if (result.code) continue;
    for (const entry of result.stdout.split("\0")) {
      const match = /^160000 [^\t]+\t([^/]+)$/s.exec(entry);
      if (!match || scanExcluded(match[1])) continue;
      try {
        if (relativeApplyPath(match[1]) === match[1]) paths.add(match[1]);
      } catch { warnings.push("Ignored an unsafe submodule path."); }
    }
  }
  return paths;
}

export function addScanGitlinks(repo: ApplyRepo, head: string | null, warnings: string[]): ApplyRepo {
  const boundaries = new Set(repo.boundaries);
  const results = [applyGit(repo.dir, ["ls-files", "--stage", "-z"])];
  if (head) results.push(applyGit(repo.dir, ["ls-tree", "-r", "-z", head]));
  for (const result of results) {
    if (result.code) {
      warnings.push("Could not read local Git paths for submodule boundaries.");
      continue;
    }
    for (const entry of result.stdout.split("\0")) {
      const match = /^160000 [^\t]+\t(.+)$/s.exec(entry);
      if (!match || scanExcluded(match[1])) continue;
      try {
        if (relativeApplyPath(match[1]) === match[1]) boundaries.add(join(repo.dir, match[1]));
      } catch { warnings.push("Ignored an unsafe submodule path."); }
    }
  }
  return { ...repo, boundaries: [...boundaries].sort(byPath) };
}

function registeredRepos(root: string, repos: ApplyRepo[], warnings: string[]): string[] {
  const configPath = ".workbench/workbench.yaml";
  const config = inspectApplyPath(root, configPath);
  if (config.path !== join(root, configPath)) throw Error("Symlink in .workbench/workbench.yaml");
  if (!config.stat) return [];
  if (!config.stat.isFile() || !(config.stat.mode & 0o444) || config.stat.size > 1024 * 1024)
    throw Error("Cannot safely read .workbench/workbench.yaml");
  let parsed: unknown;
  try { parsed = Bun.YAML.parse(readFileSync(config.path, "utf8")); }
  catch { throw Error("Invalid .workbench/workbench.yaml"); }
  const registered = (parsed as { repos?: unknown } | null)?.repos ?? [];
  if (!Array.isArray(registered) || registered.some(entry => typeof entry !== "string"))
    throw Error("Expected a repository list in .workbench/workbench.yaml");
  const selected = new Set<string>();
  for (const entry of registered) {
    if (scanExcluded(entry)) {
      warnings.push("Ignored an excluded registered repository.");
      continue;
    }
    let canonical: string;
    try { canonical = relativeApplyPath(entry); }
    catch { warnings.push("Ignored unsafe registered repository: " + JSON.stringify(entry)); continue; }
    if (repos.some(repo => repo.repo === canonical)) selected.add(canonical);
    else warnings.push("Registered repository is unavailable for mapping: " + JSON.stringify(entry));
  }
  return [...selected].sort(byPath);
}

export function loadApplyCatalog(input: string): ApplyCatalog {
  const root = realpathSync(input);
  const warnings: string[] = [];
  const rootGit = gitSetup(root, root);
  const rootRepo = rootGit && identifyCheckout(root, rootGit) ? rootGit : null;
  const children = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !scanExcluded(entry.name))
    .map(entry => entry.name).sort(byPath);
  const links = rootRepo ? gitlinks(root, warnings) : new Set<string>();
  const candidates: { repo: string; dir: string }[] = [];
  const metadata = new Set(rootRepo ? [rootRepo] : []);
  const boundaries = new Set([...links].map(name => join(root, name)));
  for (const name of children) {
    const dir = join(root, name);
    try {
      if (relativeApplyPath(name) !== name || (rootRepo && containsPath(rootRepo, dir))) continue;
      if (!hasRepositoryMarker(dir)) continue;
      boundaries.add(dir);
      const gitDir = gitSetup(dir, root);
      if (gitDir && identifyCheckout(dir, gitDir)) {
        candidates.push({ repo: name, dir });
        metadata.add(gitDir);
      }
    } catch { warnings.push("Could not inspect repository candidate: " + JSON.stringify(name)); }
  }
  const projects = candidates.filter(({ dir }) => ![...metadata].some(gitDir => containsPath(gitDir, dir)));
  for (const name of [...links].sort(byPath))
    if (!projects.some(repo => repo.repo === name)) warnings.push("Submodule is unavailable locally: " + JSON.stringify(name));
  if (!links.size && !projects.length && rootRepo) projects.push({ repo: ".", dir: root });
  const nested = [...new Set([...boundaries, ...metadata])].sort(byPath);
  const repos: ApplyRepo[] = projects.map(({ repo, dir }) => ({
    repo, dir, slug: repo === "." ? "root" : repo,
    boundaries: nested.filter(path => path !== dir && containsPath(dir, path)),
  }));
  return { repos, registered: registeredRepos(root, repos, warnings), warnings };
}

export function selectApplyRepo(catalog: ApplyCatalog, input: string): ApplyRepo {
  if (scanExcluded(input)) throw Error("Repository path is excluded from mapping.");
  const repo = relativeApplyPath(input);
  const result = catalog.repos.find(candidate => candidate.repo === repo);
  if (!result) throw Error("Repository is unavailable for mapping: " + JSON.stringify(input));
  return result;
}
