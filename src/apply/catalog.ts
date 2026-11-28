import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import { checkoutEnvironment, isOid, runProcess } from "../git";

export type ApplyRepo = { repo: string; dir: string; slug: string; boundaries: string[] };
export type ApplyCatalog = { repos: ApplyRepo[]; registered: string[]; warnings: string[] };

export const scanExclusions = new Set([".git", "node_modules", "vendor", "dist", "build", "target", ".venv", ".workbench"]);
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

export function hasRepositoryMarker(dir: string): boolean {
  const marker = lstatSync(join(dir, ".git"), { throwIfNoEntry: false });
  return Boolean(marker?.isFile() || marker?.isDirectory());
}

export function inspectApplyPath(root: string, path: string, boundaries?: string[]) {
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
    const next = join(at, segment);
    if (boundaries?.some(boundary => containsPath(boundary, next)))
      throw Error("Path crosses a repository boundary: " + JSON.stringify(path));
    stat = stat?.isDirectory() ? lstatSync(next, { throwIfNoEntry: false }) : undefined;
    if (!stat?.isSymbolicLink()) {
      if (boundaries && stat?.isDirectory() && hasRepositoryMarker(next))
        throw Error("Path crosses a repository boundary: " + JSON.stringify(path));
      at = next;
      continue;
    }
    if (++links > 40) throw Error("Too many symbolic links: " + JSON.stringify(path));
    let target = readlinkSync(next);
    if (isAbsolute(target)) {
      const prefix = root === "/" ? root : root + "/";
      if (target !== root && !target.startsWith(prefix))
        throw Error("Path escapes repository via symlink: " + JSON.stringify(path));
      target = target.slice(prefix.length);
      at = root;
    }
    pending = [...target.split("/").filter(Boolean), ...pending];
    stat = lstatSync(at);
  }
  return { path: at, stat };
}

export function validateApplyPath(repo: ApplyRepo, input: string): string {
  const path = relativeApplyPath(input);
  inspectApplyPath(repo.dir, path, repo.boundaries);
  return path;
}

export function applyGit(dir: string, args: string[]) {
  const env = checkoutEnvironment();
  for (const key of Object.keys(env))
    if (key === "GIT_CONFIG" || key.startsWith("GIT_CONFIG_") || ["GIT_EXTERNAL_DIFF", "GIT_ALLOW_PROTOCOL"].includes(key)) delete env[key];
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
  return Boolean(gitDir && commonDir && top && resolve(dir, gitDir) === gitDirectory &&
    resolve(dir, commonDir) === gitDirectory && resolve(dir, top) === dir);
}

function gitSetup(dir: string, name: string, repository: string) {
  const marker = join(dir, ".git");
  const stat = lstatSync(marker, { throwIfNoEntry: false });
  if (stat?.isDirectory()) return marker;
  if (!stat?.isFile() || stat.size > 4096 || !(stat.mode & 0o444)) return null;
  const target = readFileSync(marker, "utf8").match(/^gitdir: ([^\r\n]+)\r?\n?$/)?.[1];
  if (!target) return null;
  const resolved = resolve(dir, target);
  if (!containsPath(join(repository, ".git", "modules"), resolved)) return null;
  const selected = inspectApplyPath(repository, relative(repository, resolved));
  return selected.path === resolved && selected.stat?.isDirectory() && name !== "." ? resolved : null;
}

function gitlinks(root: string, warnings: string[]) {
  const paths = new Set<string>();
  const results = [
    applyGit(root, ["ls-files", "--stage", "-z"]),
    applyGit(root, ["ls-tree", "-z", "HEAD"]),
  ];
  if (results[0].code) warnings.push("Could not read root Git index for submodule discovery.");
  for (const result of results) {
    if (result.code) continue;
    for (const entry of result.stdout.split("\0")) {
      const match = /^160000 [^\t]+\t([^/]+)$/s.exec(entry);
      if (!match || scanExclusions.has(match[1])) continue;
      try {
        if (relativeApplyPath(match[1]) === match[1]) paths.add(match[1]);
      } catch { warnings.push("Ignored an unsafe submodule path."); }
    }
  }
  return paths;
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
  const rootGit = gitSetup(root, ".", root);
  const rootRepo = rootGit && identifyCheckout(root, rootGit);
  const children = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !scanExclusions.has(entry.name))
    .map(entry => entry.name).sort(byPath);
  const links = rootRepo ? gitlinks(root, warnings) : new Set<string>();
  const repos: ApplyRepo[] = [];
  const boundaries = new Set([...links].map(name => join(root, name)));
  const add = (repo: string, dir: string, boundaries: string[] = []) =>
    repos.push({ repo, dir, slug: repo === "." ? "root" : repo, boundaries });
  for (const name of children) {
    const dir = join(root, name);
    try {
      if (relativeApplyPath(name) !== name) continue;
      const marker = lstatSync(join(dir, ".git"), { throwIfNoEntry: false });
      if (marker?.isFile() || marker?.isDirectory()) boundaries.add(dir);
      if (!marker?.isDirectory() && !links.has(name)) continue;
      const gitDir = gitSetup(dir, name, root);
      if (gitDir && identifyCheckout(dir, gitDir)) add(name, dir);
    } catch { warnings.push("Could not inspect repository candidate: " + JSON.stringify(name)); }
  }
  for (const name of [...links].sort(byPath))
    if (!repos.some(repo => repo.repo === name)) warnings.push("Submodule is unavailable locally: " + JSON.stringify(name));
  if (!links.size && !repos.length && rootRepo) add(".", root, [...boundaries].sort(byPath));
  return { repos, registered: registeredRepos(root, repos, warnings), warnings };
}

export function selectApplyRepo(catalog: ApplyCatalog, input: string): ApplyRepo {
  const repo = relativeApplyPath(input);
  const result = catalog.repos.find(candidate => candidate.repo === repo);
  if (!result) throw Error("Repository is unavailable for mapping: " + JSON.stringify(input));
  return result;
}
