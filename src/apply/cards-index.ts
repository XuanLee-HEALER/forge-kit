import { lstatSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { localPath } from "../instance";

const heading = /^ {0,3}(#{1,6})[\t ]+(.+?)[\t ]*#*[\t ]*$/;
const linkTarget = /^(?:<([^<>]*)>|((?:\\[() ]|[^\s()]|\([^()\n]*\))+))/;
const inlineEnd = /^(?:\s+(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\((?:\\.|[^()])*\)))?\s*\)/;

function indexLines(lines: string[]) {
  const section: string[] = [];
  const references = new Map<string, string>();
  let fence: string | undefined;
  let active: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1].startsWith(fence) && !marker[2].trim()) fence = undefined;
      continue;
    }
    if (fence) continue;
    const atx = heading.exec(line);
    const setext = /^ {0,3}(=+|-+)[\t ]*$/.exec(lines[i + 1] ?? "");
    const isSetext = !!setext && /^ {0,3}\S/.test(line);
    if (atx || isSetext) {
      const level = atx ? atx[1].length : setext![1][0] === "=" ? 1 : 2;
      const title = atx ? atx[2].trim() : line.trim();
      if (title.toLowerCase() === "domain index") active = level;
      else if (active !== undefined && level <= active) active = undefined;
      if (isSetext && !atx) i++;
      continue;
    }
    const ref = /^ {0,3}\[([^\]]+)\]:[\t ]*(.+)$/.exec(line);
    if (ref) {
      const key = refKey(ref[1]);
      if (!references.has(key)) references.set(key, ref[2]);
    } else if (active !== undefined) {
      section.push(line);
    }
  }
  return { section, references };
}

function refKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function linkedPaths(lines: string[]): string[] {
  const { section, references } = indexLines(lines);
  const paths = new Set<string>();
  const text = section.join("\n").replace(/(`+)[^`]*\1/g, "");
  const links = /(?<![\\!])\[([^\]\n]+)\](?:(\()|\[([^\]\n]*)\])?/g;
  for (const match of text.matchAll(links)) {
    const inline = match[2] === "(";
    const target = inline ? text.slice(match.index + match[0].length) : references.get(refKey(match[3] || match[1]));
    if (target === undefined) continue;
    const raw = target.trimStart();
    const parsed = linkTarget.exec(raw);
    if (!parsed || (inline && !inlineEnd.test(raw.slice(parsed[0].length)))) continue;
    const dest = parsed[1] ?? parsed[2];
    if (dest) paths.add(dest);
  }
  return [...paths];
}

function indexTarget(root: string, card: string, link: string): string | null {
  if (/^(?:https?:|mailto:)/i.test(link)) return null;
  // Parent components are needed by child repo cards. Validate each step so a
  // symlink or a climb out of the workspace cannot be hidden by normalization.
  const raw = link.split(/(?<!\\)[?#]/, 1)[0];
  if (!raw) return null;
  const decoded = decodeURIComponent(raw.replace(/\\([() ])/g, "$1"));
  if (isAbsolute(decoded) || /^[\w+.-]+:/.test(decoded) || /[\\\p{Cc}]/u.test(decoded))
    throw Error("Unsafe Domain Index link");
  const components = dirname(card).split("/");
  for (const segment of decoded.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!components.length) throw Error("Domain Index link escapes the workbench");
      components.pop();
    } else {
      components.push(segment);
    }
    localPath(root, components.length ? join(...components) : ".");
  }
  return components.length ? join(...components) : ".";
}

export function inspectIndexLinks(root: string, card: string, lines: string[]) {
  const issues: { level: "warn" | "error"; message: string }[] = [];
  for (const link of linkedPaths(lines)) {
    try {
      const target = indexTarget(root, card, link);
      if (target === null) continue;
      const stat = lstatSync(localPath(root, target), { throwIfNoEntry: false });
      if (!stat) issues.push({ level: "warn", message: card + ": broken Domain Index link to " + target });
      else if (!stat.isFile()) throw Error("Domain Index link target is not a regular file");
    } catch (error) {
      issues.push({ level: "error", message: card + ": invalid Domain Index link " + JSON.stringify(link) +
        " (" + (error instanceof Error ? error.message : String(error)) + ")" });
    }
  }
  return issues;
}
