import { basename, resolve } from "node:path";
import { statSync } from "node:fs";
import { extractGitSubcommand, resolveGitDirFlags } from "../shared/git-cmd";
import { copyDestination, hasUnquotedRedirect, resolveSegmentCwd, splitShellSegments, splitShellTokens, stripUnquotedShellRedirections, tarCreateDestination, unwrapShellPrefix } from "../shared/shell";
import { extractShellCommand, extractToolWorkdir, extractTouchedFilePaths, type CodexHookInput } from "../hook-io";
import { canonicalizeMaybePath } from "../shared/path";
import { SQL_WRITE_RE } from "./sql-http";

/** Paths written by editor tools, output redirects, and recognizable filesystem operations. */
export function writeTargets(input: CodexHookInput): string[] {
  if (input.tool_name === "Read") return [];
  const workdir = extractToolWorkdir(input);
  const targets = extractTouchedFilePaths(input).map(p => resolve(workdir, p));
  const pipedInputs = new Set<number>();
  const segments = splitShellSegments(extractShellCommand(input) ?? "", pipedInputs);
  for (const [index, segment] of segments.entries()) {
    const cwd = resolveSegmentCwd(segments, index, workdir);
    const outputs: string[] = [];
    const command = stripUnquotedShellRedirections(segment, outputs);
    targets.push(...outputs.map(p => resolve(cwd, p)));
    const prefix = unwrapShellPrefix(splitShellTokens(command) ?? []);
    const git = prefix.bin === "git" ? extractGitSubcommand(["git", ...prefix.args]) : null;
    const bin = git?.subcmd ?? prefix.bin;
    const dir = resolveGitDirFlags(cwd, [...prefix.dirs, ...(git?.gitDirFlags ?? [])]) ?? cwd;
    const args = git?.subArgs ?? prefix.args;
    const operands = args.filter(a => !a.startsWith("-"));
    const add = (p: string) => targets.push(resolve(dir, p));
    if (git && !["mv", "rm"].includes(git.subcmd)) continue;
    if (["chmod","chown","tee","rm","rmdir","mv","touch","truncate"].includes(bin ?? "") ||
        (["sed","perl"].includes(bin ?? "") && args.some(a => /^-[A-Za-z]*i/.test(a))) ||
        (bin === "find" && args.includes("-delete"))) {
      operands.forEach(add);
    }
    if (["cp","mv","rsync","ditto","install"].includes(bin ?? "")) {
      const dest = copyDestination(args);
      if (dest) {
        add(dest);
        if (statSync(resolve(dir, dest), { throwIfNoEntry: false })?.isDirectory())
          operands.filter(p => p !== dest).forEach(p => add(resolve(dir, dest, basename(p))));
      }
    }
    if (bin === "tar") {
      const dest = tarCreateDestination(args);
      if (dest) add(dest);
      if (args.some(a => a === "--extract" || /^-[a-zA-Z]*x/.test(a))) {
        const directory = args.findIndex(a => a === "-C" || a === "--directory");
        add(directory >= 0 ? args[directory + 1] ?? "." : ".");
      }
    }
    if (bin === "dd") args.filter(a => a.startsWith("of=")).forEach(a => add(a.slice(3)));
    if (bin === "sqlite3") {
      const sql = operands.slice(1).join(" ");
      if (SQL_WRITE_RE.test(sql) || /(?:\bpragma\b|^\s*\.(?:read|restore|import))/im.test(sql) ||
          hasUnquotedRedirect(segment, "<") || pipedInputs.has(index)) operands.slice(0, 1).forEach(add);
    }
    if (["python", "python3", "node", "bun"].includes(bin ?? "")) {
      const inline = args.findIndex(a => a === "-c" || a === "-e" || a === "--eval");
      if (inline >= 0) {
        const program = args[inline + 1] ?? "";
        for (const match of program.matchAll(/(?:writeFile(?:Sync)?|appendFile(?:Sync)?|unlink(?:Sync)?|Bun\.write|Path)\(\s*(["'])([^"'\n]+)\1/g)) {
          if (!match[0].startsWith("Path(") || /^\s*\)\s*\.\s*(?:write_text|write_bytes|unlink)\(/.test(program.slice(match.index! + match[0].length)))
            add(match[2]);
        }
        for (const match of program.matchAll(/\bopen\(\s*(["'])([^"'\n]+)\1\s*,\s*(["'])[awx+][^"']*\3/g)) add(match[2]);
      }
    }
  }
  return [...new Set(targets.map(canonicalizeMaybePath))];
}
