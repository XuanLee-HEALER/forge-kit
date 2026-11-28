import { dirname, relative } from "node:path";
import { applyGit, byPath, relativeApplyPath, scanExcluded, type ApplyRepo } from "./catalog";
import { isBusinessSource, pickStyleSamples } from "./history-samples";
import { pathIsIn } from "./inventory";
import { isOid } from "../git";

const top = 20;
const commitLimit = 800;
const pathLimit = 300;
const aggregationLimit = 50_000;
const batchSize = 32;

function pathChanges(output: string, batch: string[]) {
  if (!output.endsWith("\0")) throw Error("Incomplete Git path-change output.");
  const tokens = output.split("\0");
  const commits: Set<string>[] = [];
  let paths: Set<string> | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token && isOid(tokens[i + 1] ?? "")) {
      if (tokens[i + 1] !== batch[commits.length]) throw Error("Unexpected commit in Git path-change output.");
      paths = new Set();
      commits.push(paths);
      i++;
      continue;
    }
    if (!token) continue;
    if (!paths) throw Error("Missing commit in Git path-change output.");
    const status = token.replace(/^\n/, "");
    if (!/^[A-Z]\d*$/.test(status)) throw Error("Invalid Git path-change record.");
    const path = tokens[++i];
    if (!path) throw Error("Incomplete Git path-change record.");
    paths.add(path);
    if (/^[RC]/.test(status)) {
      const other = tokens[++i];
      if (!other) throw Error("Incomplete Git rename or copy record.");
      paths.add(other);
    }
  }
  if (commits.length !== batch.length) throw Error("Missing commit in Git path-change output.");
  return commits;
}

function historyPathAllowed(path: string, boundaries: Set<string>) {
  if (path === "." || scanExcluded(path)) return false;
  try { if (relativeApplyPath(path) !== path) return false; }
  catch { return false; }
  for (let parent = path; parent !== "."; parent = dirname(parent)) {
    if (boundaries.has(parent)) return false;
  }
  return true;
}

const dateArg = (seconds: number) => new Date(seconds * 1000).toISOString();
const rank = (values: Map<string, number>) =>
  [...values.entries()].sort((a, b) => b[1] - a[1] || byPath(a[0], b[0]));
const topPaths = (ranked: [string, number][]) => ranked.slice(0, top).map(([path, count]) => ({ path, count }));

export function scanHistory(repo: ApplyRepo, head: string | null, headAvailable: boolean, focus: string[], since: number,
  packageDirs: string[] = [], focusRequested = focus.length > 0) {
  const shallow = applyGit(repo.dir, ["rev-parse", "--is-shallow-repository"]);
  const shallowValue = shallow.code ? null : shallow.stdout.trim();
  const noCommits = headAvailable && !head;
  const noScope = focusRequested && !focus.length;
  const history = {
    shallow: shallowValue === "true" ? true : shallowValue === "false" ? false : null,
    no_commits: noCommits, available: headAvailable, truncated: false,
    commits_in_window: noCommits || noScope ? 0 : null as number | null,
    has_older_commits: noCommits || noScope ? false : null as boolean | null,
  };
  const warnings: string[] = [];
  if (history.shallow) warnings.push("Shallow repository; history covers only locally visible commits.");
  if (history.shallow === null) warnings.push("Could not determine whether this repository is shallow.");
  if (history.no_commits) warnings.push("Repository has no commits.");
  if (!headAvailable) warnings.push("HEAD could not be resolved with local Git objects.");
  const hotspots = new Map<string, number>();
  const dirHotspots = new Map<string, number>();
  const pairs = new Map<string, number>();
  const neighborDirs = new Map<string, number>();
  const boundaries = new Set(repo.boundaries.map(path => relative(repo.dir, path)));
  const increment = (counts: Map<string, number>, name: string) => {
    const previous = counts.get(name);
    if (previous === undefined && counts.size >= aggregationLimit) {
      history.truncated = true;
      return;
    }
    counts.set(name, (previous ?? 0) + 1);
  };
  const includes = (path: string) => !focusRequested || focus.some(f => pathIsIn(f, path));
  const count = (paths: Set<string>) => {
    const safe = [...paths].filter(path => historyPathAllowed(path, boundaries)).sort(byPath);
    const focal = safe.filter(includes);
    const neighbors = safe.filter(path => !includes(path));
    const focalSet = new Set(focal);
    for (const path of focal) increment(hotspots, path);
    if (!focusRequested) {
      for (const dir of new Set(focal.filter(isBusinessSource).map(path => dirname(path)))) increment(dirHotspots, dir);
    } else if (focal.length) {
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

  const incomplete = (warning: string) => {
    history.available = false;
    history.truncated = true;
    warnings.push(warning);
  };
  if (head && !noScope) {
    const scope = ["--no-merges", "--full-history", head, "--", ...focus];
    const window = "--since-as-filter=" + dateArg(since);
    const total = applyGit(repo.dir, ["rev-list", "--count", window, ...scope]);
    const totalText = total.stdout.trim();
    const totalCount = Number(totalText);
    const localTotalKnown = !total.code && /^\d+$/.test(totalText) && Number.isSafeInteger(totalCount);
    if (!localTotalKnown) {
      incomplete("Could not count commits in the local history window.");
    } else if (history.shallow === false) {
      history.commits_in_window = totalCount;
    }

    // Git treats both date selectors as inclusive, so split the window at adjacent seconds.
    const older = applyGit(repo.dir, ["rev-list", "--max-count=1", "--until=" + dateArg(since - 1), ...scope]);
    const olderId = older.stdout.trim();
    if (older.code || (olderId && !isOid(olderId))) {
      incomplete("Could not determine whether older commits exist in local history.");
    } else if (olderId || history.shallow === false) {
      history.has_older_commits = Boolean(olderId);
    }
    if (localTotalKnown && totalCount === 0 && history.has_older_commits)
      warnings.push("No locally visible commits fall in the history window. Increase --days to include older commits.");

    const ids = applyGit(repo.dir, ["rev-list", window, "--max-count=" + (commitLimit + 1), ...scope]);
    const idsText = ids.stdout.trim();
    const commits = idsText ? idsText.split("\n") : [];
    if (ids.code || commits.some(oid => !isOid(oid))) {
      incomplete("Could not read the local commit window.");
    } else {
      if (commits.length > commitLimit) history.truncated = true;
      const selected = commits.slice(0, commitLimit);
      let failedBatch = false;
      for (let offset = 0; offset < selected.length; offset += batchSize) {
        const batch = selected.slice(offset, offset + batchSize);
        const changes = applyGit(repo.dir, ["log", "--no-show-signature", "--no-notes", "--no-walk=unsorted", "--format=%x00%H", "--name-status", "-z",
          "--no-ext-diff", "--no-textconv", "--no-color", "--find-renames", "--find-copies", "--root", ...batch, "--"]);
        try {
          if (changes.code) throw Error();
          for (const paths of pathChanges(changes.stdout, batch)) count(paths);
        } catch {
          failedBatch = true;
        }
      }
      if (failedBatch) incomplete("Could not read all commit changes from local Git objects.");
    }
  }
  if (history.truncated) warnings.push("History details are limited by the commit, path, pair, or local read limits.");
  const ranked = rank(hotspots);
  return {
    history,
    hotspots: topPaths(ranked),
    dir_hotspots: topPaths(rank(dirHotspots)),
    style_samples: pickStyleSamples(repo, ranked, packageDirs),
    cochange_neighbors: topPaths(rank(neighborDirs)),
    cochanges: rank(pairs).slice(0, top).map(([paths, count]) => ({ paths: paths.split("\0"), count })),
    warnings,
  };
}
