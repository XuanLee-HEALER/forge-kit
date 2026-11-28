import { dirname, posix, win32 } from "node:path";
import { byPath, inspectScanPath, scanExcluded, type ApplyRepo } from "./catalog";
import { childPath } from "./inventory";

type Member = { path: string; role: "include" | "exclude"; directory_present: boolean | null };
type Kind = "package-json" | "pnpm-workspace" | "go-work" | "cargo-workspace";
type Workspace = { source: string; kind: Kind; members: Member[] };
const maxProbes = 3000;

function goQuotedPath(text: string) {
  // Go's octal and hexadecimal escapes append individual bytes. Unicode
  // escapes and unescaped characters append UTF-8 sequences.
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  const simpleEscapes: Record<string, string> = {
    a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\x0b", '"': '"', "\\": "\\",
  };
  for (const [part, escape] of text.matchAll(/[^\\]+|\\([0-7]{3}|x[\dA-Fa-f]{2}|u[\dA-Fa-f]{4}|U[\dA-Fa-f]{8}|.)/g)) {
    if (escape?.length === 3) {
      const byte = escape.startsWith("x") ? parseInt(escape.slice(1), 16) : parseInt(escape, 8);
      if (byte > 255) throw Error();
      bytes.push(byte);
      continue;
    }
    const characters = escape === undefined ? part : escape.length > 1
      ? String.fromCodePoint(parseInt(escape.slice(1), 16))
      : simpleEscapes[escape];
    if (characters === undefined || /\p{Cs}/u.test(characters)) throw Error();
    for (const byte of encoder.encode(characters)) bytes.push(byte);
  }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(bytes));
}

function goUseTargets(source: string) {
  const targets: unknown[] = [];
  let block: "use" | "skip" | undefined;
  const operand = /^(?:"((?:[^"\\]|\\.)*)"|`([^`]*)`|((?:[^/"'`\s]|\/(?!\/))+))(?:\s*\/\/.*|\s*)$/;
  for (const line of source.split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith("//")) continue;
    if (block && /^\)(?:\s*\/\/.*)?$/.test(text)) {
      block = undefined;
      continue;
    }
    if (block === "skip") continue;
    const declaration = !block && /^(\w+)\s+\((?:\s*\/\/.*)?$/.exec(text);
    if (declaration) {
      block = declaration[1] === "use" ? "use" : "skip";
      continue;
    }
    const target = block === "use" ? text : /^use\s+(.+)$/.exec(text)?.[1];
    if (text === "use" && !block) targets.push(null);
    if (!target) continue;
    const match = operand.exec(target);
    if (!match) {
      targets.push(null);
    } else if (match[1] !== undefined) {
      try {
        targets.push(goQuotedPath(match[1]));
      } catch {
        targets.push(null);
      }
    } else targets.push(match[2] ?? match[3]);
  }
  if (block === "use") targets.push(null);
  return targets;
}

export function collectWorkspaces(repo: ApplyRepo, dirs: ReadonlySet<string>, warnings: string[]) {
  const workspaces: Workspace[] = [];
  const checked = new Map<string, boolean | null | undefined>();
  let probes = 0;
  let limited = false;
  let unreadable = false;

  function directoryPresent(path: string): boolean | null | undefined {
    if (dirs.has(path)) return true;
    if (checked.has(path)) return checked.get(path);
    if (probes >= maxProbes) {
      if (!limited) warnings.push("Workspace directory probes reached the scan limit.");
      limited = true;
      return null;
    }
    probes++;
    let present: boolean | null | undefined;
    try {
      const item = inspectScanPath(repo, path);
      if (!item.excluded && !item.symbolicLink) present = item.inaccessible ? null : Boolean(item.stat?.isDirectory());
    } catch { /* Boundary crossings and failed inspections supply no safe evidence. */ }
    if (present === null && !unreadable) {
      warnings.push("Could not check all workspace directories.");
      unreadable = true;
    }
    checked.set(path, present);
    return present;
  }

  function add(source: string, kind: Kind, includes: unknown, excludes?: unknown, negation = false) {
    const members = new Map<string, Member>();
    let unsafe = false;
    const patternSegment = /[*?\[\]{}]|[+@!]\(/;
    for (const [defaultRole, targets] of [["include", includes], ["exclude", excludes]] as const) {
      if (targets === undefined) continue;
      if (!Array.isArray(targets)) {
        warnings.push("Invalid workspace declaration: " + JSON.stringify(source));
        continue;
      }
      for (const target of targets) {
        const negative = typeof target === "string" && negation && target.startsWith("!");
        const value = negative ? target.slice(1) : target;
        if (typeof value !== "string" || !value || scanExcluded(value) || win32.isAbsolute(value) ||
            posix.isAbsolute(value) || /^[a-z]:/i.test(value) || /[\\\p{Cc}\p{Cs}]/u.test(value)) {
          unsafe = true;
          continue;
        }
        const parts = value.split("/").filter(part => part && part !== ".");
        const firstName = parts.findIndex(part => part !== "..");
        const path = posix.normalize(value).replace(/\/$/, "") || ".";
        const resolved = posix.normalize(childPath(dirname(source), path));
        if ((firstName >= 0 && parts.includes("..", firstName)) || resolved === ".." ||
            resolved.startsWith("../") || scanExcluded(resolved)) {
          unsafe = true;
          continue;
        }
        const segments = resolved.split("/");
        const pattern = kind === "go-work" ? -1 : segments.findIndex(segment => patternSegment.test(segment));
        const checkedPath = pattern === -1 ? resolved : segments.slice(0, pattern).join("/") || ".";
        const present = directoryPresent(checkedPath);
        if (present === undefined) {
          unsafe = true;
          continue;
        }
        const role = negative ? "exclude" : defaultRole;
        members.set(role + "\0" + path, { path, role, directory_present: pattern === -1 ? present : null });
      }
    }
    if (unsafe) warnings.push("Ignored an unsafe workspace member in " + JSON.stringify(source));
    workspaces.push({ source, kind, members: [...members.values()]
      .sort((a, b) => byPath(a.path, b.path) || byPath(a.role, b.role)) });
  }

  return {
    workspaces,
    packageJson(source: string, declaration: unknown) {
      if (declaration === undefined) return;
      const packages = declaration && typeof declaration === "object" && !Array.isArray(declaration)
        ? (declaration as { packages?: unknown }).packages : declaration;
      if (packages === undefined) warnings.push("Invalid workspace declaration: " + JSON.stringify(source));
      add(source, "package-json", packages, undefined, true);
    },
    pnpm(source: string, text: string) {
      const config = Bun.YAML.parse(text) as { packages?: unknown } | null;
      add(source, "pnpm-workspace", config?.packages, undefined, true);
    },
    go(source: string, text: string) {
      add(source, "go-work", goUseTargets(text));
    },
    cargo(source: string, text: string) {
      const config = Bun.TOML.parse(text) as { workspace?: { members?: unknown; exclude?: unknown } };
      if (config.workspace === undefined) return;
      const workspace = config.workspace;
      if (workspace && typeof workspace === "object" && !Array.isArray(workspace))
        add(source, "cargo-workspace", workspace.members, workspace.exclude);
      else warnings.push("Invalid workspace declaration: " + JSON.stringify(source));
    },
  };
}
