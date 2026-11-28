import { dirname } from "node:path";
import { applyGit, byPath, type ApplyRepo } from "./catalog";
import { pathIsIn, scanExcluded } from "./facts";
import { isOid } from "../git";

const top = 20;
const commitLimit = 800;
const pathLimit = 300;
const aggregationLimit = 50_000;
const batchSize = 32;

function pathChanges(output: string) {
  const tokens = output.split("\0");
  const commits: Set<string>[] = [];
  let paths: Set<string> | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token && isOid(tokens[i + 1] ?? "")) {
      paths = new Set();
      commits.push(paths);
      i++;
      continue;
    }
    if (!paths || !token) continue;
    const status = token.replace(/^\n/, "");
    if (!/^[A-Z]\d*$/.test(status)) throw Error("Invalid Git path-change record.");
    const path = tokens[++i];
    if (!path) throw Error("Incomplete Git path-change record.");
    paths.add(path);
    if (/^[RC]/.test(status)) {
      const other = tokens[++i];
      if (!other) throw Error("Incomplete Git rename record.");
      paths.add(other);
    }
  }
  return commits;
}

export function scanHistory(repo: ApplyRepo, head: string | null, headAvailable: boolean, focus: string[], since: number) {
  const shallow = applyGit(repo.dir, ["rev-parse", "--is-shallow-repository"]);
  const history = {
    shallow: shallow.code ? null : shallow.stdout.trim() === "true",
    no_commits: headAvailable && !head, available: headAvailable, truncated: false,
  };
  const warnings: string[] = [];
  if (history.shallow) warnings.push("Shallow repository; history covers only locally visible commits.");
  if (history.shallow === null) warnings.push("Could not determine whether this repository is shallow.");
  if (history.no_commits) warnings.push("Repository has no commits.");
  if (!headAvailable) warnings.push("HEAD could not be resolved with local Git objects.");
  const hotspots = new Map<string, number>();
  const pairs = new Map<string, number>();
  const neighborDirs = new Map<string, number>();
  const increment = (counts: Map<string, number>, name: string) => {
    const previous = counts.get(name);
    if (previous === undefined && counts.size >= aggregationLimit) {
      history.truncated = true;
      return;
    }
    counts.set(name, (previous ?? 0) + 1);
  };
  const includes = (path: string) => !focus.length || focus.some(f => pathIsIn(f, path));
  const count = (paths: Set<string>) => {
    const safe = [...paths].filter(path => !scanExcluded(path)).sort(byPath);
    const focal = safe.filter(includes);
    const neighbors = safe.filter(path => !includes(path));
    const focalSet = new Set(focal);
    for (const path of focal) increment(hotspots, path);
    if (focal.length && focus.length) {
      for (const dir of new Set(neighbors.map(path => dirname(path)))) increment(neighborDirs, dir);
    }
    if (safe.length > pathLimit) history.truncated = true;
    // Include focused paths before sampling neighbors when a commit changed very many paths.
    const picked = focal.concat(neighbors).slice(0, pathLimit).sort(byPath);
    for (const [i, a] of picked.entries()) {
      for (let j = i + 1; j < picked.length; j++) {
        const b = picked[j];
        if (!focalSet.has(a) && !focalSet.has(b)) continue;
        increment(pairs, a + "\0" + b);
      }
    }
  };

  if (head) {
    const ids = focus.some(f => !scanExcluded(f)) || !focus.length
      ? applyGit(repo.dir, ["rev-list", "--timestamp", "--since-as-filter=@" + since, "--max-count=" + (commitLimit + 1),
        "--no-merges", "--full-history", head, "--", ...focus.filter(f => !scanExcluded(f))])
      : { code: 0, stdout: "" };
    if (ids.code) {
      history.available = false;
      warnings.push("Could not read the local commit window.");
    } else {
      const commits = ids.stdout.trim().split("\n").flatMap(line => {
        const [timestamp, oid] = line.split(" ");
        return Number(timestamp) >= since && isOid(oid ?? "") ? [oid] : [];
      });
      if (commits.length > commitLimit) history.truncated = true;
      const selected = commits.slice(0, commitLimit);
      for (let offset = 0; offset < selected.length; offset += batchSize) {
        const batch = selected.slice(offset, offset + batchSize);
        const changes = applyGit(repo.dir, ["log", "--no-walk=unsorted", "--format=%x00%H", "--name-status", "-z",
          "--no-ext-diff", "--no-textconv", "--find-renames", "--root", ...batch, "--"]);
        try {
          if (changes.code) throw Error();
          const parsed = pathChanges(changes.stdout);
          if (parsed.length !== batch.length) throw Error();
          for (const paths of parsed) count(paths);
        } catch {
          history.available = false;
          history.truncated = true;
          warnings.push("Could not read all commit changes from local Git objects.");
          break;
        }
      }
    }
  }
  if (history.truncated) warnings.push("History counts are limited by the commit, path, pair, or local read limits.");
  const ranked = (values: Map<string, number>) =>
    [...values.entries()].sort((a, b) => b[1] - a[1] || byPath(a[0], b[0])).slice(0, top);
  return {
    history,
    hotspots: ranked(hotspots).map(([path, count]) => ({ path, count })),
    cochange_neighbors: ranked(neighborDirs).map(([path, count]) => ({ path, count })),
    cochanges: ranked(pairs).map(([paths, count]) => ({ paths: paths.split("\0"), count })),
    warnings,
  };
}
