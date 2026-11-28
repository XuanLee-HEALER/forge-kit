import { applyGit, applyHead, inspectApplyPath, loadApplyCatalog, selectApplyRepo, validateApplyPath, type ApplyRepo } from "./catalog";
import { isDomainSlug, loadApplyMap, type DomainCard, type MapIssue } from "./cards";
import { diffDetails, pathsIntersect, probeDiff, readProbeGit, safeDisplay } from "./probe-diff";

type State = "UNCHANGED" | "CHANGED" | "BROKEN";
type Row = Omit<DomainCard, "archived"> & {
  head: string | null;
  status: State | null;
  commit_count: number | null;
  reason?: string;
  history_note?: string;
} & Partial<ReturnType<typeof diffDetails>>;

export type ProbeOutput = {
  root: string;
  cards: Row[];
  warnings: string[];
  errors: MapIssue[];
} & (
  { unmapped: { repo: string; path: string; status: "UNMAPPED"; hint: string }[] } |
  { totals: Record<State, number> }
);

const committed = "Changes compare committed Git snapshots. The worktree supplies anchor existence only.";
const shellQuote = (value: string) => /^[A-Za-z0-9._/-]+$/.test(value)
  ? value : "'" + value.replaceAll("'", "'\\''") + "'";
const shellOption = (option: string, value: string) =>
  option + (value.startsWith("-") ? "=" : " ") + shellQuote(value);

function inspectCard(row: Row, repo: ApplyRepo, shallow: boolean, mode: "check" | "status") {
  const { dir } = repo;
  const { anchored_paths: anchors, last_verified_sha: base, head } = row;
  if (!head) {
    row.status = "BROKEN";
    row.reason = "HEAD has no commits; involving commits cannot be counted";
    return;
  }
  if (base.length !== head.length) {
    row.status = "BROKEN";
    row.reason = "Baseline SHA uses a different Git object format; involving commits cannot be counted";
    return;
  }
  const object = applyGit(dir, ["cat-file", "-t", base]);
  if (object.termination) throw Error(object.termination);
  if (object.code && object.stderr.trim() !== "fatal: git cat-file: could not get object info") {
    throw Error("Could not read baseline object: " + safeDisplay(object.stderr.trim() || "Git exit " + object.code));
  }
  if (object.code || object.stdout.trim() !== "commit") {
    row.status = "BROKEN";
    row.reason = "Baseline SHA is unavailable as a local commit; involving commits cannot be counted";
    if (shallow) row.history_note = "This is a shallow repository with limited local history";
    return;
  }
  const ancestry = applyGit(dir, ["merge-base", "--is-ancestor", base, head]);
  if (ancestry.code === 1 && !ancestry.termination) {
    row.status = "BROKEN";
    row.reason = shallow
      ? "Baseline is not a provable ancestor of HEAD in the shallow local history; involving commits cannot be counted"
      : "Baseline is not an ancestor of HEAD; involving commits cannot be counted";
    return;
  }
  if (ancestry.code) throw Error("Could not verify baseline ancestry: " +
    safeDisplay(ancestry.stderr.trim() || "Git exit " + ancestry.code));
  const anyAnchor = anchors.some(path => !!inspectApplyPath(dir, path, repo.boundaries).stat);
  const count = readProbeGit(dir, ["rev-list", "--count", "--full-history", base + ".." + head, "--", ...anchors]).trim();
  if (!/^\d+$/.test(count) || !Number.isSafeInteger(Number(count))) throw Error("Invalid Git commit count");
  row.commit_count = Number(count);
  if (shallow && head !== base) row.history_note = "Commit count reflects the available shallow local history";
  if (!anyAnchor) {
    row.status = "BROKEN";
    row.reason = "All anchored paths are absent from the worktree";
    return;
  }
  const diff = probeDiff(dir, base, head, anchors);
  row.status = diff.fileCount ? "CHANGED" : "UNCHANGED";
  if (row.status === "CHANGED" && mode === "check") {
    Object.assign(row, diffDetails(dir, base, head, anchors, diff, row.commit_count));
  }
}

function matchesPath(card: DomainCard, path: string): boolean {
  return card.anchored_paths.some(anchor => pathsIntersect(anchor, path));
}

export function runApplyProbe(
  root: string, mode: "check" | "status", options: { repo?: string; domain?: string; paths: string[] },
): ProbeOutput {
  if (options.domain !== undefined && !isDomainSlug(options.domain)) throw Error("Expected --domain to be a lowercase slug");
  const catalog = loadApplyCatalog(root);
  const selected = options.repo !== undefined ? selectApplyRepo(catalog, options.repo) : undefined;
  const repos = selected ? [selected] : catalog.repos;
  if (options.paths.length && !repos.length) throw Error("No project repository is available for --path");
  const map = loadApplyMap(root, catalog.repos, selected);
  const cards: Row[] = [];
  const warnings = [...catalog.warnings, ...map.issues.filter(issue => issue.level === "warn").map(issue => issue.message)];
  const errors = map.issues.filter(issue => issue.level === "error");
  const unmapped: Extract<ProbeOutput, { unmapped: unknown }>["unmapped"] = [];
  const totals = { UNCHANGED: 0, CHANGED: 0, BROKEN: 0 };
  const pathsByRepo = new Map(repos.map(repo => [repo.repo,
    [...new Set(options.paths.map(path => validateApplyPath(repo, path)))].sort(),
  ]));

  for (const repo of repos) {
    const paths = pathsByRepo.get(repo.repo)!;
    const active = map.cards.filter(card => !card.archived && card.repo === repo.repo);
    for (const path of paths) {
      if (!active.some(card => matchesPath(card, path))) unmapped.push({
        repo: repo.repo, path, status: "UNMAPPED",
        hint: "forge apply " + shellOption("--repo", repo.repo) + " " + shellOption("--focus", path),
      });
    }
    const matched = active.filter(card => options.domain !== undefined ? card.domain === options.domain :
      !paths.length || paths.some(path => matchesPath(card, path)));
    if (!matched.length) continue;

    let head: string | null = null;
    let shallow = false;
    let unavailable: string | undefined;
    try {
      const resolved = applyHead(repo.dir);
      if (!resolved.available) throw Error("Could not resolve local HEAD; involving commits cannot be counted");
      head = resolved.head;
      shallow = readProbeGit(repo.dir, ["rev-parse", "--is-shallow-repository"]).trim() === "true";
    } catch (error) {
      unavailable = error instanceof Error ? error.message : String(error);
      errors.push({ level: "error", check: "apply-map", message: repo.repo + ": " + unavailable });
    }
    for (const { archived: _archived, ...card } of matched) {
      const row: Row = { ...card, head, status: null, commit_count: null };
      cards.push(row);
      if (unavailable) {
        row.reason = unavailable;
        continue;
      }
      try {
        inspectCard(row, repo, shallow, mode);
        if (row.status) totals[row.status]++;
      } catch (error) {
        row.status = null;
        row.commit_count = null;
        row.reason = error instanceof Error ? error.message : String(error);
        errors.push({ level: "error", check: "apply-map", message: repo.repo + "/" + row.domain + ": " + row.reason });
      }
    }
  }
  if (options.domain !== undefined && !cards.length)
    warnings.push("No active domain named " + options.domain + " in the selected repositories");
  if (cards.length) warnings.push(committed);
  const output = { root, cards, warnings, errors };
  return mode === "check" ? { ...output, unmapped } : { ...output, totals };
}

export function formatApplyProbe(output: ProbeOutput): string {
  const lines = [output.root];
  for (const card of output.cards) {
    lines.push(safeDisplay(card.repo + " / " + card.domain) + "  " + (card.status ?? "Unavailable") +
      "  " + (card.commit_count === null ? "commit count unavailable" : card.commit_count + " involving commit(s)"));
    lines.push("  Anchors: " + card.anchored_paths.map(safeDisplay).join(", "));
    lines.push("  Baseline " + card.last_verified_sha + ", HEAD " + (card.head ?? "unavailable"));
    if (card.reason) lines.push("  " + safeDisplay(card.reason));
    if (card.history_note) lines.push("  " + card.history_note);
    for (const commit of card.commits ?? []) lines.push("  " + commit.sha + " " + commit.subject);
    for (const item of card.name_status ?? []) {
      lines.push("  " + item.status + " " + (item.old_path ? safeDisplay(item.old_path) + " → " : "") + safeDisplay(item.path));
    }
    if (card.numstat) {
      const { files_changed, insertions, deletions, binary_files } = card.numstat;
      lines.push("  " + files_changed + " changed file(s), +" + insertions + " / -" + deletions +
        (binary_files ? ", line counts unavailable for " + binary_files + " binary file(s)" : ""));
    }
    if (card.truncated) lines.push("  Change details truncated");
  }
  if ("totals" in output) {
    lines.push(Object.entries(output.totals).map(([state, count]) => state + " " + count).join("  "));
  } else {
    for (const item of output.unmapped) {
      lines.push(safeDisplay(item.repo + " / " + item.path) + "  UNMAPPED", "  " + item.hint);
    }
  }
  if (!output.cards.length) lines.push("No active domain cards matched");
  for (const warning of output.warnings) lines.push("Warning: " + safeDisplay(warning));
  for (const error of output.errors) lines.push("Error: " + safeDisplay(error.message));
  return lines.join("\n");
}
