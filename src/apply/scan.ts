import { realpathSync } from "node:fs";
import { addScanGitlinks, applyHead, byPath, inspectScanPath, loadApplyCatalog, relativeApplyPath, scanExcluded, selectApplyRepo } from "./catalog";
import { scanFacts } from "./facts";
import { scanHistory } from "./history";

export function scanApply(input: string, options: { repos: string[]; focus: string[]; days: number }) {
  const root = realpathSync(input);
  const catalog = loadApplyCatalog(root);
  const requested = [...new Set(options.focus.map(relativeApplyPath))].sort(byPath);
  const selection = options.repos.length ? options.repos : catalog.registered;
  const selected = selection.length
    ? [...new Set(selection.map(repo => selectApplyRepo(catalog, repo)))].sort((a, b) => byPath(a.repo, b.repo))
    : catalog.repos;
  const since = Math.max(0, Math.floor(Date.now() / 1000) - options.days * 86400);
  const repos = selected.map(selectedRepo => {
    const { head, available } = applyHead(selectedRepo.dir);
    const warnings: string[] = [];
    const repo = addScanGitlinks(selectedRepo, head, warnings);
    const focus = requested.filter(path => !scanExcluded(path) &&
      !inspectScanPath(repo, path, { followSymlinks: true }).excluded);
    if (focus.length < requested.length) warnings.push("Excluded focus paths were skipped.");
    const focusRequested = requested.length > 0;
    const { packageDirs, discoveredBoundaries, ...facts } = scanFacts(repo, focus, { focusRequested });
    const historical = scanHistory({ ...repo, boundaries: discoveredBoundaries }, head, available, focus, since, packageDirs, focusRequested);
    return { repo: repo.repo, focus, head, ...facts, ...historical, warnings: [...warnings, ...facts.warnings, ...historical.warnings] };
  });
  return { root, days: options.days, repos, warnings: catalog.warnings };
}

export function formatApplyScan(output: ReturnType<typeof scanApply>) {
  const lines = [`Apply scan of ${output.root}, last ${output.days} days`];
  if (!output.repos.length) lines.push("No local repositories selected.");
  for (const warning of output.warnings) lines.push("Warning: " + warning);
  for (const repo of output.repos) {
    lines.push("", `${repo.repo}  HEAD ${repo.head ?? "unavailable"}`);
    if (repo.focus.length) lines.push("Focus: " + repo.focus.join(", "));
    lines.push("Local history window: " + output.days + " days");
    for (const warning of repo.warnings) lines.push("Warning: " + warning);
    for (const { name, manager, sources } of repo.stack)
      lines.push(`Stack ${name}${manager ? " (" + manager + ")" : ""}  ${sources.join(", ")}`);
    for (const { name, argv, source, cwd, declared } of repo.entrypoints)
      lines.push(`${declared ? "Declared entry" : "Tool default"} ${name}  ${argv?.map(Bun.$.escape).join(" ") ?? "runner unknown"}  ${source}  cwd ${cwd}`);
    for (const { path, kind } of repo.workflows) lines.push(`Workflow ${path}  ${kind}`);
    for (const { path, kind } of repo.deployment_signals) lines.push(`Deployment ${path}  ${kind}`);
    for (const workspace of repo.workspaces) {
      lines.push(`Workspace ${workspace.source}  ${workspace.kind}`);
      for (const member of workspace.members)
        lines.push(`  ${member.role} ${member.path}${member.directory_present === false ? " (missing)" : ""}`);
    }
    for (const group of [repo.convention_files, repo.entry_signals, repo.persistence_signals])
      for (const { path, kind } of group) lines.push(`Signal ${kind}  ${path}`);
    for (const entry of repo.tree) {
      const counts = entry.direct_files === undefined ? "" :
        `  ${entry.direct_files} direct, ${entry.recursive_files} recursive${entry.counts_complete ? "" : " (partial)"}`;
      lines.push(`Tree ${entry.path}  ${entry.type}${counts}`);
    }
    lines.push(`Commits in window: ${repo.history.commits_in_window ?? "unknown"}, older commits: ${repo.history.has_older_commits ?? "unknown"}`);
    for (const { path, count } of repo.style_samples) lines.push(`Style sample ${count}  ${path}`);
    for (const { path, count } of repo.dir_hotspots) lines.push(`Directory hotspot ${count}  ${path}`);
    const flow = repo.git_flow;
    lines.push(`Current branch: ${flow.current_branch ?? (flow.detached ? "detached HEAD" : "unknown")}`);
    for (const branch of flow.long_lived_branches) lines.push(`Branch ${branch.source}  ${branch.name}`);
    for (const prefix of flow.tag_prefixes) lines.push("Tag prefix " + prefix);
    for (const path of flow.hook_paths) lines.push("Hook " + path);
    for (const path of flow.codeowners_paths) lines.push("Code owners " + path);
    for (const { path, count } of repo.hotspots) lines.push(`Hotspot ${count}  ${path}`);
    for (const { path, count } of repo.cochange_neighbors) lines.push(`Neighbor directory ${count}  ${path}`);
    for (const { paths, count } of repo.cochanges) lines.push(`Cochanges ${count}  ${paths.join(" + ")}`);
    for (const { argv, cwd, inputs } of repo.verification_actions)
      lines.push(`Proposed verification ${argv.map(Bun.$.escape).join(" ")}  cwd ${cwd}  inputs ${inputs.join(", ")}`);
    for (const path of repo.forbidden_paths) lines.push("Proposed forbidden path " + path);
  }
  return lines.join("\n");
}
