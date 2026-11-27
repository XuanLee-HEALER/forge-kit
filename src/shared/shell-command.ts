import { accessSync, constants as fsConstants, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { type ShellToken, splitShellTokens } from "./shell-tokens";

export function unwrapShellPrefix(toks: string[]) {
  let i = 0;
  let clearedEnv = false;
  let ambiguous = false;
  const env = new Map<string, string>();
  const unsetKeys = new Set<string>();
  const dirs: string[] = [];
  while (i < toks.length) {
    const tok = toks[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
      const eq = tok.indexOf("=");
      env.set(tok.slice(0, eq), tok.slice(eq + 1));
      unsetKeys.delete(tok.slice(0, eq));
      i++;
      continue;
    }
    const name = tok.split("/").pop();
    if (name === "command") {
      i++;
      while (toks[i] === "-p" || toks[i] === "--") i++;
      continue;
    }
    if (name !== "env") break;
    i++;
    while (toks[i]?.startsWith("-")) {
      const opt = toks[i++];
      if (opt === "--") break;
      if (["-i", "--ignore-environment", "-"].includes(opt)) {
        clearedEnv = true;
        env.clear();
        unsetKeys.clear();
      } else if (opt.startsWith("-u") || opt === "--unset" || opt.startsWith("--unset=")) {
        const key = opt === "-u" || opt === "--unset" ? toks[i++] :
          opt.startsWith("--unset=") ? opt.slice(8) : opt.slice(2);
        if (!key) { ambiguous = true; break; }
        unsetKeys.add(key);
        env.delete(key);
      } else if (opt.startsWith("-P")) {
        if (opt === "-P") i++;
      } else if (opt.startsWith("-C") || opt === "--chdir" || opt.startsWith("--chdir=")) {
        const dir = opt.startsWith("--chdir=") ? opt.slice(8) : opt.startsWith("-C") && opt.length > 2 ? opt.slice(2) : toks[i++];
        if (!dir) { ambiguous = true; break; }
        dirs.push(dir);
      } else {
        ambiguous = true;
        break;
      }
    }
    if (ambiguous) break;
  }
  const effective = (key: string) => env.get(key) ??
    (clearedEnv || unsetKeys.has(key) ? "" : process.env[key] ?? "");
  return { bin: toks[i]?.split("/").pop(), args: toks.slice(i + 1), effective, ambiguous, dirs };
}

// Inspect split-string arguments only to identify commands that must be gated.
export function expandEnvSplitStrings(toks: string[]): string[] {
  return toks.flatMap((tok, i) => {
    if (toks[i - 1] === "-S" || toks[i - 1] === "--split-string") return splitShellTokens(tok) ?? [tok];
    if (tok.startsWith("--split-string=")) return splitShellTokens(tok.slice("--split-string=".length)) ?? [tok];
    if (tok.startsWith("-S") && tok.length > 2) return splitShellTokens(tok.slice(2)) ?? [tok];
    return [tok];
  });
}

export function resolveSegmentCwd(
  segments: string[],
  targetIndex: number,
  initialCwd: string,
): string {
  let cwd = initialCwd;
  for (let i = 0; i < targetIndex; i++) {
    const toks = splitShellTokens(segments[i]);
    if (toks && toks[0] === "cd" && toks[1]) {
      cwd = resolve(cwd, toks[1]);
    }
  }
  return cwd;
}

export function splitLeadingEnv(toks: ShellToken[]): { envToks: string[]; cmdToks: string[] } {
  let start = 0;
  while (start < toks.length && toks[start].isEnvAssign) {
    start++;
  }
  return {
    envToks: toks.slice(0, start).map((t) => t.value),
    cmdToks: toks.slice(start).map((t) => t.value),
  };
}

/**
 * POSIX/Bash `cd` target resolver (supports no-arg `$HOME`, `-L` logical default, `-P` physical,
 * `--`, and in-chain `cd -`). Returns `null` if `cd` would fail or target is indeterminate.
 */
export function resolveCdTarget(
  curDir: string,
  prevDir: string | null,
  toks: ShellToken[],
): string | null {
  const { envToks, cmdToks } = splitLeadingEnv(toks);
  if (cmdToks[0] !== "cd") return null;
  let effectiveHome = process.env.HOME;
  let effectiveCdpath = process.env.CDPATH;
  let explicitOldPwd: string | undefined;
  for (const raw of envToks) {
    if (raw.startsWith("HOME=")) effectiveHome = raw.slice("HOME=".length);
    else if (raw.startsWith("CDPATH=")) effectiveCdpath = raw.slice("CDPATH=".length);
    else if (raw.startsWith("OLDPWD=")) explicitOldPwd = raw.slice("OLDPWD=".length);
  }
  let physical = false;
  let idx = 1;
  while (idx < cmdToks.length) {
    const arg = cmdToks[idx];
    if (arg === "--") {
      idx++;
      break;
    }
    if (arg === "-" || !arg.startsWith("-")) break;
    // POSIX / macOS `/bin/bash` `cd` accepts ONLY `-L` and `-P` (can be bundled e.g. `-LP`).
    for (let j = 1; j < arg.length; j++) {
      const ch = arg[j];
      if (ch === "P") physical = true;
      else if (ch === "L") physical = false;
      else return null;
    }
    idx++;
  }
  const rest = cmdToks.slice(idx);
  if (rest.length > 1) return null;

  let target: string;
  if (rest.length === 0) {
    // Per Bash: unset HOME fails, whereas empty `HOME=""` acts as `cd ""` (no-op in curDir).
    if (effectiveHome === undefined) return null;
    target = effectiveHome;
  } else if (rest[0] === "-") {
    if (explicitOldPwd !== undefined) {
      // Per Bash: empty `OLDPWD=""` is still set, acting as `cd ""` (stays in curDir).
      target = explicitOldPwd;
    } else {
      if (!prevDir) return null;
      target = prevDir;
    }
  } else {
    target = rest[0];
    if (
      effectiveCdpath &&
      !target.startsWith("/") &&
      target !== "." &&
      target !== ".." &&
      !target.startsWith("./") &&
      !target.startsWith("../")
    ) {
      return null;
    }
  }

  if (physical) {
    // Per Bash 3.2: `cd -P ""` (including empty HOME= / OLDPWD=) calls chdir("") -> ENOENT!
    if (target === "") return null;
    const rawTarget = target.startsWith("/") ? target : `${curDir}/${target}`;
    try {
      if (!statSync(rawTarget).isDirectory()) return null;
      accessSync(rawTarget, fsConstants.X_OK);
      // Use OS native realpath(3) so symlinks are resolved BEFORE `..` (e.g. `/tmp/..` -> `/private`).
      return realpathSync.native(rawTarget);
    } catch {
      return null;
    }
  }

  // POSIX logical `cd -L` (Bash default): walk components, verifying current path is a directory BEFORE popping `..`.
  const parts = target.startsWith("/")
    ? []
    : curDir.split("/").filter((p) => p.length > 0);
  const currentLogicalPath = () => `/${parts.join("/")}`;

  for (const comp of target.split("/")) {
    if (comp === "" || comp === ".") continue;
    if (comp === "..") {
      const beforePop = currentLogicalPath();
      try {
        if (!statSync(beforePop).isDirectory()) return null;
      } catch {
        return null;
      }
      parts.pop();
    } else {
      parts.push(comp);
    }
  }

  const finalPath = currentLogicalPath();
  try {
    if (!statSync(finalPath).isDirectory()) return null;
    accessSync(finalPath, fsConstants.X_OK);
    return finalPath;
  } catch {
    return null;
  }
}

/** Resolve the destination operand of a cp command, including GNU target-directory options. */
export function copyDestination(args: string[]): string | undefined {
  for (const [index, option] of args.entries()) {
    if (option === "--") break;
    const target = /^(?:--target-directory(?:=|$)|-[^-]*?t)(.*)$/.exec(option);
    if (target) return target[1] || args[index + 1];
  }
  return args.at(-1);
}

/** Return the archive written by a plain tar create command with read-only inputs. */
export function tarCreateDestination(args: string[]): string | undefined {
  let create = false, output: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") break;
    if (arg === "-C" || arg === "--directory") { i++; continue; }
    if (arg === "--create") create = true;
    else if (arg === "--file") output = args[++i];
    else if (arg.startsWith("--file=")) output = arg.slice(7);
    else if (/^-[czjJvf]+$/.test(arg)) {
      create ||= arg.includes("c");
      if (arg.includes("f")) {
        if (!arg.endsWith("f")) return;
        output = args[++i];
      }
    } else if (arg.startsWith("-")) return;
  }
  return create ? output : undefined;
}
