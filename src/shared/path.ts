import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export function matchesGlob(filePath: string, glob: string, rootRelative = false): boolean {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const base = normalized.split("/").pop() ?? normalized;
  const normGlob = glob.replace(/\\/g, "/").replace(/^\.\//, "");
  const target = rootRelative || normGlob.includes("/") ? normalized : base;
  let re = "^";
  let i = 0;
  while (i < normGlob.length) {
    const ch = normGlob[i];
    if (ch === "*") {
      if (normGlob[i + 1] === "*") {
        if (normGlob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
          continue;
        }
        re += ".*";
        i += 2;
        continue;
      }
      re += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      re += "[^/]";
      i += 1;
      continue;
    }
    re += /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
    i += 1;
  }
  re += "$";
  return new RegExp(re).test(target);
}

export function canonicalizeMaybePath(p: string): string {
  const abs = resolve(p);
  let cur = abs;
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return abs;
    tail.unshift(basename(cur));
    cur = parent;
  }
  try {
    const real = realpathSync(cur);
    return tail.length > 0 ? join(real, ...tail) : real;
  } catch {
    return abs;
  }
}

/**
 * Resolve `rawPath` relative to `cwd` preserving `..` segments across symlinks
 * (using POSIX `realpath(3)` via `realpathSync.native` without lexical `path.resolve` collapse).
 */
export function canonicalizeOsPath(cwd: string, rawPath: string): string | null {
  const joined = isAbsolute(rawPath) ? rawPath : `${cwd.replace(/\/+$/, "")}/${rawPath}`;
  try {
    return realpathSync.native(joined);
  } catch {
    return null;
  }
}

export function sha256File(absPath: string): string | null {
  if (!existsSync(absPath)) return null;
  try {
    const st = statSync(absPath);
    if (!st.isFile()) return null;
    const buf = readFileSync(absPath);
    return createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}
