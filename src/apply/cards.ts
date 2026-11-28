import { lstatSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { isMap, parseDocument } from "yaml";
import { repoCardPath } from "../config";
import { isOid } from "../git";
import { localPath, readRequired } from "../instance";
import { loadApplyCatalog, validateApplyPath, type ApplyRepo } from "./catalog";
import { inspectIndexLinks } from "./cards-index";

const domainsPath = ".workbench/domains";

export const isDomainSlug = (value: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);

export interface MapIssue {
  level: "warn" | "error";
  check: "apply-map";
  message: string;
}

export interface DomainCard {
  repo: string;
  domain: string;
  anchored_paths: string[];
  last_verified_sha: string;
  archived: boolean;
}

function checked(issues: MapIssue[], path: string, inspect: () => void) {
  try {
    inspect();
  } catch (error) {
    issues.push({ level: "error", check: "apply-map", message: path + ": " +
      (error instanceof Error ? error.message : String(error)) });
  }
}

function linesOf(root: string, path: string, issues: MapIssue[]): string[] {
  const content = new TextDecoder("utf-8", { fatal: true }).decode(readRequired(localPath(root, path)));
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length > 150) {
    issues.push({ level: "warn", check: "apply-map", message: path + " exceeds 150 lines (" + lines.length + ")" });
  }
  return lines;
}

function namesIn(root: string, path: string): string[] {
  const dir = localPath(root, path);
  const stat = lstatSync(dir, { throwIfNoEntry: false });
  if (!stat) return [];
  if (!stat.isDirectory() || !(stat.mode & 0o444) || !(stat.mode & 0o111))
    throw Error("Map directory is inaccessible or is not a directory");
  return readdirSync(dir).sort();
}

function parseCard(lines: string[], repo: ApplyRepo, domain: string): DomainCard {
  const end = lines.indexOf("---", 1);
  if (lines[0] !== "---" || end < 0) throw Error("Expected YAML frontmatter at the start of the card");
  const yaml = parseDocument(lines.slice(1, end).join("\n"), { uniqueKeys: true, prettyErrors: false });
  if (yaml.errors.length || !isMap(yaml.contents))
    throw Error("Invalid YAML frontmatter; expected a single mapping with unique keys");
  let fields: Record<string, unknown>;
  try {
    fields = yaml.toJS();
  } catch {
    throw Error("Invalid YAML frontmatter values");
  }
  if (fields.repo !== repo.repo) throw Error("Frontmatter repo must be canonical " + JSON.stringify(repo.repo));
  if (!isDomainSlug(domain) || fields.domain !== domain)
    throw Error("Frontmatter domain must be a lowercase slug matching the card filename");
  if (typeof fields.last_verified_sha !== "string" || !isOid(fields.last_verified_sha.toLowerCase()))
    throw Error("Frontmatter last_verified_sha must be a full Git OID");
  if (Object.hasOwn(fields, "status") && fields.status !== "active" && fields.status !== "archived")
    throw Error("Frontmatter status must be active or archived");
  if (!Array.isArray(fields.anchored_paths) || !fields.anchored_paths.length)
    throw Error("Frontmatter anchored_paths must be a nonempty list of paths");
  const anchoredPaths = fields.anchored_paths.map((path, index) => {
    if (typeof path !== "string" || !path.trim()) throw Error("Invalid anchored_paths[" + index + "]");
    try {
      return validateApplyPath(repo, path);
    } catch (error) {
      throw Error("Invalid anchored_paths[" + index + "]: " + (error instanceof Error ? error.message : String(error)));
    }
  });
  return { repo: repo.repo, domain, anchored_paths: [...new Set(anchoredPaths)].sort(),
    last_verified_sha: fields.last_verified_sha.toLowerCase(), archived: fields.status === "archived" };
}

export function loadApplyMap(root: string, repos?: ApplyRepo[], selected?: ApplyRepo): {
  cards: DomainCard[];
  issues: MapIssue[];
} {
  const cards: DomainCard[] = [];
  const issues: MapIssue[] = [];
  checked(issues, domainsPath, () => {
    const namespaces = selected ? [selected.slug] : namesIn(root, domainsPath);
    if (!namespaces.length) return;
    const bySlug = new Map((repos ?? loadApplyCatalog(root).repos).map(repo => [repo.slug, repo]));
    for (const slug of namespaces) {
      if (slug.startsWith(".") && !bySlug.has(slug)) continue;
      const repo = bySlug.get(slug);
      const directory = join(domainsPath, slug);
      checked(issues, directory, () => {
        for (const file of namesIn(root, directory)) {
          if (!file.endsWith(".md")) continue;
          const path = join(directory, file);
          checked(issues, path, () => {
            if (!repo) throw Error("Domain directory has no matching project in this workbench layout");
            cards.push(parseCard(linesOf(root, path, issues), repo, file.slice(0, -3)));
          });
        }
      });
    }
  });

  if (selected) {
    inspectRepoCard(root, relative(root, repoCardPath(root, selected.repo)), issues);
  } else {
    inspectRepoCard(root, relative(root, repoCardPath(root, ".")), issues);
    const directory = ".workbench/repos";
    checked(issues, directory, () => {
      for (const name of namesIn(root, directory).filter(name => name.endsWith(".md"))) {
        inspectRepoCard(root, join(directory, name), issues);
      }
    });
  }
  return { cards, issues };
}

function inspectRepoCard(root: string, path: string, issues: MapIssue[]) {
  checked(issues, path, () => {
    if (!lstatSync(localPath(root, path), { throwIfNoEntry: false })) return;
    for (const issue of inspectIndexLinks(root, path, linesOf(root, path, issues))) {
      issues.push({ ...issue, check: "apply-map" });
    }
  });
}
