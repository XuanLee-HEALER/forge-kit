import { realpathSync } from "node:fs";
import { applyHead, byPath, loadApplyCatalog, relativeApplyPath, selectApplyRepo, validateApplyPath } from "./catalog";
import { scanFacts } from "./facts";
import { scanHistory } from "./history";

export function scanApply(input: string, options: { repos: string[]; focus: string[]; days: number }) {
  const root = realpathSync(input);
  const catalog = loadApplyCatalog(root);
  const focus = [...new Set(options.focus.map(relativeApplyPath))].sort(byPath);
  const selection = options.repos.length ? options.repos : catalog.registered;
  const selected = selection.length
    ? [...new Set(selection.map(repo => selectApplyRepo(catalog, repo)))].sort((a, b) => byPath(a.repo, b.repo))
    : catalog.repos;
  for (const repo of selected) for (const path of focus) validateApplyPath(repo, path);
  const since = Math.max(0, Math.floor(Date.now() / 1000) - options.days * 86400);
  const repos = selected.map(repo => {
    const { head, available } = applyHead(repo.dir);
    const facts = scanFacts(repo, focus);
    const historical = scanHistory(repo, head, available, focus, since);
    return { repo: repo.repo, focus, head, ...facts, ...historical, warnings: [...facts.warnings, ...historical.warnings] };
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
    for (const { path, type } of repo.tree) lines.push(`Tree ${path}  ${type}`);
    for (const { path, count } of repo.hotspots) lines.push(`Hotspot ${count}  ${path}`);
    for (const { path, count } of repo.cochange_neighbors) lines.push(`Neighbor directory ${count}  ${path}`);
    for (const { paths, count } of repo.cochanges) lines.push(`Cochanges ${count}  ${paths.join(" + ")}`);
    for (const { argv, cwd, inputs } of repo.verification_actions)
      lines.push(`Proposed verification ${argv.map(Bun.$.escape).join(" ")}  cwd ${cwd}  inputs ${inputs.join(", ")}`);
    for (const path of repo.forbidden_paths) lines.push("Proposed forbidden path " + path);
  }
  return lines.join("\n");
}
