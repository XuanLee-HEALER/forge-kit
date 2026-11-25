import { type WorkbenchConfig } from "../config";
import { runGit } from "../git";
import {
  extractShellCommand,
  extractToolWorkdir,
  extractTouchedFilePaths,
  type CodexHookInput,
} from "../hook-io";
import { listActiveSpecLocks } from "../ledger/spec";
import { Ledger } from "../ledger/store";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { extractGitSubcommand, resolveGitDirFlags } from "../shared/git-cmd";
import { canonicalizeMaybePath, matchesGlob } from "../shared/path";
import {
  pushUtf8Bytes,
  resolveSegmentCwd,
  splitShellSegments,
  splitShellTokensWithMeta,
  type ShellToken,
} from "../shared/shell";

const INLINE_WRITE_INDICATOR_RE =
  /\b(open|write|writelines|writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|truncate|truncateSync|unlink|unlinkSync|rm|rmSync|rmdir|rename|renameSync|replace|copyFile|copyFileSync|cpSync|chmod|chmodSync|shutil|pathlib|Path|os\.remove|os\.unlink|os\.rename|os\.replace|os\.system|subprocess|child_process|exec|execSync|spawn|spawnSync|Bun\.write|File\.write|File\.open|File\.delete|File\.unlink|File\.rename|IO\.write|FileUtils|syswrite|system|qx)\b|['"]\s*,\s*['"][wax+]/;

function unwrapCommandPrefix(
  metaToks: ShellToken[],
  startCwd: string,
): { bin: string; cmdToks: string[]; effectiveCwd: string; readOnly: boolean } {
  let idx = 0;
  let cwd = startCwd;
  let readOnly = false;
  while (idx < metaToks.length) {
    if (metaToks[idx].isEnvAssign) {
      idx++;
      continue;
    }
    const val = metaToks[idx].value;
    const base = val.split("/").pop() ?? "";
    if (base === "env") {
      idx++;
      while (idx < metaToks.length) {
        const t = metaToks[idx].value;
        if (t === "--") {
          idx++;
          break;
        }
        if (t === "-C" || t === "--chdir") {
          const dir = metaToks[idx + 1]?.value;
          if (dir) cwd = resolve(cwd, dir);
          idx += 2;
          continue;
        }
        if (t.startsWith("--chdir=")) {
          const dir = t.slice("--chdir=".length);
          if (dir) cwd = resolve(cwd, dir);
          idx++;
          continue;
        }
        if (t === "-u" || t === "--unset") {
          idx += 2;
          continue;
        }
        if (t.startsWith("-")) {
          idx++;
          continue;
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
          idx++;
          continue;
        }
        break;
      }
      continue;
    }
    if (base === "command") {
      idx++;
      while (idx < metaToks.length && metaToks[idx].value.startsWith("-")) {
        const flag = metaToks[idx].value;
        if (flag === "--") {
          idx++;
          break;
        }
        if (flag.includes("v") || flag.includes("V")) readOnly = true;
        idx++;
      }
      continue;
    }
    if (base === "nohup" || base === "time") {
      idx++;
      while (idx < metaToks.length && metaToks[idx].value.startsWith("-")) idx++;
      continue;
    }
    if (base === "nice") {
      idx++;
      while (idx < metaToks.length && metaToks[idx].value.startsWith("-")) {
        if (metaToks[idx].value === "-n") idx += 2;
        else idx++;
      }
      continue;
    }
    break;
  }
  const cmdToks = metaToks.slice(idx).map((t) => t.value);
  const bin = cmdToks[0]?.split("/").pop() ?? "";
  return { bin, cmdToks, effectiveCwd: cwd, readOnly };
}

function parseShellRedirections(
  seg: string,
  segCwd: string,
): { writeTargets: string[]; readInputs: string[]; strippedSeg: string } {
  const writeTargets: string[] = [];
  const readInputs: string[] = [];
  const strippedParts: string[] = [];
  let quote: "'" | '"' | "$'" | null = null;
  let escape = false;
  let i = 0;

  const readWord = (start: number): { word: string; nextIdx: number } => {
    let j = start;
    while (j < seg.length && (seg[j] === " " || seg[j] === "\t")) j++;
    let w = "";
    let q: "'" | '"' | null = null;
    let esc = false;
    while (j < seg.length) {
      const c = seg[j];
      if (esc) {
        w += c;
        esc = false;
        j++;
        continue;
      }
      if (q === "'") {
        if (c === "'") q = null;
        else w += c;
        j++;
        continue;
      }
      if (q === '"') {
        if (c === "\\") {
          if (j + 1 < seg.length) w += seg[++j];
        } else if (c === '"') {
          q = null;
        } else {
          w += c;
        }
        j++;
        continue;
      }
      if (c === "\\") {
        esc = true;
        j++;
        continue;
      }
      if (c === "'" || c === '"') {
        q = c;
        j++;
        continue;
      }
      if (c === " " || c === "\t" || c === "\n" || c === ";" || c === "&" || c === "|" || c === ">" || c === "<") {
        break;
      }
      w += c;
      j++;
    }
    return { word: w, nextIdx: j };
  };

  while (i < seg.length) {
    const ch = seg[i];
    const next = seg[i + 1];
    if (escape) {
      strippedParts.push(ch);
      escape = false;
      i++;
      continue;
    }
    if (quote === "'") {
      strippedParts.push(ch);
      if (ch === "'") quote = null;
      i++;
      continue;
    }
    if (quote === "$'") {
      strippedParts.push(ch);
      if (ch === "\\") escape = true;
      else if (ch === "'") quote = null;
      i++;
      continue;
    }
    if (quote === '"') {
      strippedParts.push(ch);
      if (ch === "\\") escape = true;
      else if (ch === '"') quote = null;
      i++;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      strippedParts.push(ch);
      i++;
      continue;
    }
    if (ch === "$" && next === "'") {
      quote = "$'";
      strippedParts.push("$'");
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      strippedParts.push(ch);
      i++;
      continue;
    }

    // Output redirections: `>`, `>>`, `>|`, `<>`, `&>`, `&>>`, `[fd]>`, `[fd]>>`, `[fd]>|`
    const isAmpRedir = ch === "&" && next === ">";
    const isOutRedir = ch === ">";
    const isReadWriteRedir = ch === "<" && next === ">";
    const isInRedir = ch === "<" && next !== "<" && next !== "&" && next !== ">";

    if (isAmpRedir || isOutRedir || isReadWriteRedir) {
      // Strip optional preceding single-digit fd from strippedParts when at word boundary
      if (
        isOutRedir &&
        strippedParts.length > 0 &&
        /^[0-9]$/.test(strippedParts[strippedParts.length - 1]) &&
        (strippedParts.length === 1 ||
          strippedParts[strippedParts.length - 2] === " " ||
          strippedParts[strippedParts.length - 2] === "\t")
      ) {
        strippedParts.pop();
      }
      let opLen = 1;
      if (isAmpRedir) {
        opLen = seg[i + 2] === ">" ? 3 : 2;
      } else if (isReadWriteRedir) {
        opLen = 2;
      } else if (next === ">" || next === "|") {
        opLen = 2;
      } else if (next === "&") {
        // fd dup like `2>&1` or `>&2` or `>&-` -> skip operator and target fd
        const { nextIdx } = readWord(i + 2);
        strippedParts.push(" ");
        i = nextIdx;
        continue;
      }
      const { word, nextIdx } = readWord(i + opLen);
      if (word && !word.includes("://") && word !== "/dev/null") {
        writeTargets.push(canonicalizeMaybePath(resolve(segCwd, word)));
      }
      strippedParts.push(" ");
      i = nextIdx;
      continue;
    }

    if (isInRedir) {
      const { word, nextIdx } = readWord(i + 1);
      if (word && word !== "/dev/null") {
        readInputs.push(canonicalizeMaybePath(resolve(segCwd, word)));
      }
      strippedParts.push(" ");
      i = nextIdx;
      continue;
    }

    strippedParts.push(ch);
    i++;
  }

  return { writeTargets, readInputs, strippedSeg: strippedParts.join("") };
}

const STRICT_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const PATCH_HEADER_PREFIXES = [
  Buffer.from("diff --git "),
  Buffer.from("--- "),
  Buffer.from("+++ "),
  Buffer.from("*** "),
  Buffer.from("rename from "),
  Buffer.from("rename to "),
  Buffer.from("copy from "),
  Buffer.from("copy to "),
  Buffer.from("Index: "),
];

function decodeGitCQuotedPath(quoted: string): string | null {
  if (!quoted.startsWith('"') || !quoted.endsWith('"') || quoted.length < 2) return null;
  const inner = quoted.slice(1, -1);
  if (inner.includes("\0")) return null;
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch !== "\\") {
      const cp = inner.codePointAt(i)!;
      if (cp === 0) return null;
      const full = String.fromCodePoint(cp);
      pushUtf8Bytes(bytes, full);
      if (full.length > 1) i += full.length - 1;
      continue;
    }
    if (i + 1 >= inner.length) return null;
    const esc = inner[++i];
    if (esc === "a") bytes.push(0x07);
    else if (esc === "b") bytes.push(0x08);
    else if (esc === "t") bytes.push(0x09);
    else if (esc === "n") bytes.push(0x0a);
    else if (esc === "v") bytes.push(0x0b);
    else if (esc === "f") bytes.push(0x0c);
    else if (esc === "r") bytes.push(0x0d);
    else if (esc === '"') bytes.push(0x22);
    else if (esc === "\\") bytes.push(0x5c);
    else if (esc >= "0" && esc <= "3") {
      const oct = inner.slice(i, i + 3);
      if (!/^[0-3][0-7][0-7]$/.test(oct)) return null;
      const val = Number.parseInt(oct, 8);
      if (val === 0) return null;
      bytes.push(val);
      i += 2;
    } else {
      return null;
    }
  }
  try {
    return STRICT_UTF8_DECODER.decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

function readGitDiffHeaderToken(
  s: string,
  start: number,
): { value: string; nextIdx: number } | null {
  if (start >= s.length) return null;
  if (s[start] === '"') {
    let i = start + 1;
    while (i < s.length) {
      if (s[i] === "\\") {
        i += 2;
        continue;
      }
      if (s[i] === '"') {
        const decoded = decodeGitCQuotedPath(s.slice(start, i + 1));
        if (decoded === null) return null;
        return { value: decoded, nextIdx: i + 1 };
      }
      i++;
    }
    return null;
  }
  let end = s.indexOf(" ", start);
  if (end < 0) end = s.length;
  return { value: s.slice(start, end), nextIdx: end };
}

function bufferStartsWith(buf: Uint8Array, start: number, end: number, prefix: Uint8Array): boolean {
  if (end - start < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (buf[start + i] !== prefix[i]) return false;
  }
  return true;
}

function extractPatchFileTargets(
  patchAbsPath: string,
  baseDir: string,
  stripLevel: number | null,
): { targets: string[]; uninspectable: boolean } {
  if (!existsSync(patchAbsPath)) return { targets: [], uninspectable: true };
  try {
    const st = statSync(patchAbsPath);
    if (!st.isFile() || st.size > 4 * 1024 * 1024) {
      return { targets: [], uninspectable: true };
    }
    const rawBuf = readFileSync(patchAbsPath);
    const out: string[] = [];
    let anyUninspectableHeader = false;

    const pushPath = (
      rawPath: string,
      defaultStripIfPrefixed: boolean,
      alreadyDecoded = false,
    ): "pushed" | "devnull" | "invalid" => {
      let raw = rawPath;
      if (!alreadyDecoded) {
        if (raw.startsWith('"')) {
          const decoded = decodeGitCQuotedPath(raw);
          if (decoded === null) return "invalid";
          raw = decoded;
        }
      }
      if (raw.includes("\0")) return "invalid";
      if (!raw || raw === "/dev/null") return "devnull";
      const parts = raw.split("/").filter((seg) => seg.length > 0);
      const effectiveStrip =
        stripLevel !== null
          ? defaultStripIfPrefixed
            ? stripLevel
            : 0
          : defaultStripIfPrefixed && (parts[0] === "a" || parts[0] === "b")
            ? 1
            : 0;
      const rel = parts.slice(effectiveStrip).join("/");
      if (!rel) return "devnull";
      out.push(canonicalizeMaybePath(resolve(baseDir, rel)));
      return "pushed";
    };

    const parseDiffGitLine = (line: string): [string, string] | null => {
      const rest = line.slice("diff --git ".length);
      if (!rest || rest.includes("\0")) return null;
      // 1. C-quoted path(s) (handles spaces, escaped quotes, and octal UTF-8 bytes like `\303\251`)
      if (rest.includes('"')) {
        const first = readGitDiffHeaderToken(rest, 0);
        if (!first || rest[first.nextIdx] !== " ") return null;
        const secondStart = first.nextIdx + 1;
        if (rest[secondStart] === '"') {
          const second = readGitDiffHeaderToken(rest, secondStart);
          if (!second || second.nextIdx !== rest.length) return null;
          return [first.value, second.value];
        }
        const tail = rest.slice(secondStart);
        if (!tail || tail.includes('"')) return null;
        return [first.value, tail];
      }
      // 2. Unquoted identical path with optional spaces (e.g. `a/plan notes.md b/plan notes.md`)
      if (rest.length % 2 === 1) {
        const mid = (rest.length - 1) / 2;
        if (rest[mid] === " ") {
          const left = rest.slice(0, mid);
          const right = rest.slice(mid + 1);
          const lSlash = left.indexOf("/");
          const rSlash = right.indexOf("/");
          if (lSlash > 0 && rSlash > 0 && left.slice(lSlash + 1) === right.slice(rSlash + 1)) {
            return [left, right];
          }
        }
      }
      // 3. Unquoted rename/different paths with spaces separated by unique ` b/` boundary
      const bMatches = [...rest.matchAll(/ (b\/)/g)];
      if (bMatches.length === 1 && bMatches[0].index !== undefined) {
        const idx = bMatches[0].index;
        const left = rest.slice(0, idx);
        const right = rest.slice(idx + 1);
        if (left && right) return [left, right];
      }
      // 4. Plain two whitespace-separated paths without internal spaces
      const plain = rest.split(" ");
      if (plain.length === 2 && plain[0] && plain[1]) {
        return [plain[0], plain[1]];
      }
      return null;
    };

    const AT_AT_PREFIX = Buffer.from("@@ ");
    let hunkOldRem = 0;
    let hunkNewRem = 0;

    // Scan lines at the byte level and strictly UTF-8 decode header lines (fatal + ignoreBOM)
    // while tracking unified-diff hunk line counts so hunk body lines starting with `+++ `/`--- `
    // are never misclassified as file headers!
    let lineStart = 0;
    while (lineStart <= rawBuf.length) {
      let lineEnd = rawBuf.indexOf(0x0a, lineStart);
      if (lineEnd < 0) lineEnd = rawBuf.length;
      const trimmedEnd =
        lineEnd > lineStart && rawBuf[lineEnd - 1] === 0x0d ? lineEnd - 1 : lineEnd;

      // Consume unified-diff hunk body lines before header matching
      if (hunkOldRem > 0 || hunkNewRem > 0) {
        if (lineStart === trimmedEnd) {
          if (hunkOldRem > 0 && hunkNewRem > 0) {
            hunkOldRem--;
            hunkNewRem--;
          }
          if (lineEnd === rawBuf.length) break;
          lineStart = lineEnd + 1;
          continue;
        }
        const firstByte = rawBuf[lineStart];
        if (firstByte === 0x20 && hunkOldRem > 0 && hunkNewRem > 0) {
          hunkOldRem--;
          hunkNewRem--;
          if (lineEnd === rawBuf.length) break;
          lineStart = lineEnd + 1;
          continue;
        }
        if (firstByte === 0x2d && hunkOldRem > 0) {
          hunkOldRem--;
          if (lineEnd === rawBuf.length) break;
          lineStart = lineEnd + 1;
          continue;
        }
        if (firstByte === 0x2b && hunkNewRem > 0) {
          hunkNewRem--;
          if (lineEnd === rawBuf.length) break;
          lineStart = lineEnd + 1;
          continue;
        }
        if (firstByte === 0x5c) {
          // `\ No newline at end of file` inside hunk
          if (lineEnd === rawBuf.length) break;
          lineStart = lineEnd + 1;
          continue;
        }
        // Unexpected non-hunk line ends hunk tracking so following headers are never skipped
        hunkOldRem = 0;
        hunkNewRem = 0;
      }

      if (bufferStartsWith(rawBuf, lineStart, trimmedEnd, AT_AT_PREFIX)) {
        const hunkHdr = rawBuf.subarray(lineStart, trimmedEnd).toString("latin1");
        const hm = hunkHdr.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/);
        if (hm) {
          hunkOldRem = hm[1] !== undefined ? Number(hm[1]) : 1;
          hunkNewRem = hm[2] !== undefined ? Number(hm[2]) : 1;
        }
        if (lineEnd === rawBuf.length) break;
        lineStart = lineEnd + 1;
        continue;
      }

      const isHeader = PATCH_HEADER_PREFIXES.some((pfx) =>
        bufferStartsWith(rawBuf, lineStart, trimmedEnd, pfx),
      );
      if (isHeader) {
        let line: string;
        try {
          line = STRICT_UTF8_DECODER.decode(rawBuf.subarray(lineStart, trimmedEnd));
        } catch {
          anyUninspectableHeader = true;
          lineStart = lineEnd + 1;
          continue;
        }
        if (line.startsWith("diff --git ")) {
          const pair = parseDiffGitLine(line);
          if (!pair) {
            // Fail closed unconditionally on any ambiguous or malformed `diff --git` header
            anyUninspectableHeader = true;
          } else {
            const r1 = pushPath(pair[0], true, true);
            const r2 = pushPath(pair[1], true, true);
            if (r1 === "invalid" || r2 === "invalid") anyUninspectableHeader = true;
          }
        } else {
          const std = line.match(/^(?:---|\+\+\+|\*\*\*) ([^\t\r\n]+)/);
          if (std) {
            const res = pushPath(std[1], true);
            if (res === "invalid") anyUninspectableHeader = true;
          } else {
            const metaPath = line.match(
              /^(?:rename from|rename to|copy from|copy to|Index:) ([^\r\n]+)/,
            );
            if (metaPath) {
              const res = pushPath(metaPath[1], false);
              if (res === "invalid") anyUninspectableHeader = true;
            }
          }
        }
      }
      if (lineEnd === rawBuf.length) break;
      lineStart = lineEnd + 1;
    }
    // Fail closed if a readable patch yielded zero recognized target paths or any header was uninspectable
    if (out.length === 0 || anyUninspectableHeader) {
      return { targets: [], uninspectable: true };
    }
    return { targets: [...new Set(out)], uninspectable: false };
  } catch {
    return { targets: [], uninspectable: true };
  }
}

function extractQuotedStrings(script: string): string[] {
  const out: string[] = [];
  const re = /'([^'\n]{1,300})'|"([^"\n]{1,300})"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(script)) !== null) {
    const s = m[1] ?? m[2] ?? "";
    if (s) out.push(s);
  }
  return out;
}

function collectDestOperands(
  args: string[],
  valueFlags: Set<string>,
): { operands: string[]; targetDir: string | null } {
  const operands: string[] = [];
  let targetDir: string | null = null;
  let endFlags = false;
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (!endFlags && t === "--") {
      endFlags = true;
      continue;
    }
    if (!endFlags && t.startsWith("-") && t.length > 1) {
      if (t === "-t" || t === "--target-directory") {
        targetDir = args[++i] ?? null;
        continue;
      }
      if (t.startsWith("--target-directory=")) {
        targetDir = t.slice("--target-directory=".length);
        continue;
      }
      if (t.startsWith("-t") && t.length > 2) {
        targetDir = t.slice(2);
        continue;
      }
      if (valueFlags.has(t)) {
        i++;
        continue;
      }
      continue;
    }
    operands.push(t);
  }
  return { operands, targetDir };
}

function expandCopyDestPaths(
  srcs: string[],
  dest: string,
  cwd: string,
): string[] {
  const destAbs = canonicalizeMaybePath(resolve(cwd, dest));
  const out = [destAbs];
  const destIsDir =
    dest.endsWith("/") ||
    (existsSync(destAbs) &&
      (() => {
        try {
          return statSync(destAbs).isDirectory();
        } catch {
          return false;
        }
      })());
  if (destIsDir) {
    for (const s of srcs) {
      const b = basename(s);
      if (b) out.push(canonicalizeMaybePath(join(destAbs, b)));
    }
  }
  return out;
}

export function checkSpecAndTestLocks(
  workbenchRoot: string,
  input: CodexHookInput,
  cfg: WorkbenchConfig,
): string | null {
  if (!cfg.ledger.enabled) return null;
  const dbPath = join(workbenchRoot, ".workbench", "ledger", "ledger.sqlite");
  if (!existsSync(dbPath)) return null;

  const wbReal = canonicalizeMaybePath(workbenchRoot);
  const baseWorkdir = extractToolWorkdir(input);
  const touchedFilePaths = extractTouchedFilePaths(input).map((p) =>
    canonicalizeMaybePath(resolve(baseWorkdir, p)),
  );
  const cmd = extractShellCommand(input);
  if (touchedFilePaths.length === 0 && !cmd) return null;

  let ledger: Ledger | null = null;
  try {
    ledger = new Ledger(workbenchRoot);
    const activeLocks = listActiveSpecLocks(ledger, true);
    if (activeLocks.length === 0) return null;

    const allOpenBoundWorktrees = new Set<string>();
    for (const openTask of ledger.listOpenTasks()) {
      for (const r of ledger.getTaskRepos(openTask.task_id)) {
        if (r.worktree) {
          allOpenBoundWorktrees.add(canonicalizeMaybePath(r.worktree));
        }
      }
    }

    type UnboundWorktreeMatcher = { worktreesDir: string; branch: string };
    type ResolvedLock = {
      task_id: string;
      lockedSpecFiles: Array<{ kind: "ssot" | "tech_spec" | "test_spec"; abs: string; rel: string }>;
      lockedTestGlobs: string[];
      explicitRoots: string[];
      unboundWorktrees: UnboundWorktreeMatcher[];
    };

    const resolvedLocks: ResolvedLock[] = activeLocks.map((st) => {
      const scopes = new Set(st.state === "AMENDED" ? st.amend_scopes : []);
      const unlockedSsot = scopes.has("requirement") || scopes.has("invariant");
      const unlockedTech = unlockedSsot || scopes.has("tech_spec");
      const unlockedTest = unlockedSsot || scopes.has("test_spec");

      const lockedSpecFiles: ResolvedLock["lockedSpecFiles"] = [];
      if (st.files) {
        if (!unlockedSsot) {
          lockedSpecFiles.push({
            kind: "ssot",
            rel: st.files.ssot,
            abs: canonicalizeMaybePath(resolve(wbReal, st.files.ssot)),
          });
        }
        if (!unlockedTech) {
          lockedSpecFiles.push({
            kind: "tech_spec",
            rel: st.files.tech_spec,
            abs: canonicalizeMaybePath(resolve(wbReal, st.files.tech_spec)),
          });
        }
        if (!unlockedTest) {
          lockedSpecFiles.push({
            kind: "test_spec",
            rel: st.files.test_spec,
            abs: canonicalizeMaybePath(resolve(wbReal, st.files.test_spec)),
          });
        }
      }

      const taskRepos = ledger!.getTaskRepos(st.task_id);
      const explicitRoots: string[] = [];
      const unboundWorktrees: UnboundWorktreeMatcher[] = [];
      for (const r of taskRepos) {
        if (r.worktree) {
          explicitRoots.push(canonicalizeMaybePath(r.worktree));
        } else {
          explicitRoots.push(canonicalizeMaybePath(resolve(wbReal, r.repo)));
          unboundWorktrees.push({
            worktreesDir: canonicalizeMaybePath(resolve(wbReal, `${r.repo}.worktrees`)),
            branch: r.branch,
          });
        }
      }
      explicitRoots.sort((a, b) => b.length - a.length);

      return {
        task_id: st.task_id,
        lockedSpecFiles,
        lockedTestGlobs: scopes.has("test_spec") || scopes.has("invariant") ? [] : st.locked_test_globs,
        explicitRoots,
        unboundWorktrees,
      };
    });

    const wtBranchCache = new Map<string, string | null>();
    const getWorktreeBranch = (wtRoot: string): string | null => {
      if (wtBranchCache.has(wtRoot)) return wtBranchCache.get(wtRoot)!;
      const res = runGit(wtRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
      const b = res.code === 0 ? res.stdout.trim() : null;
      wtBranchCache.set(wtRoot, b);
      return b;
    };

    const resolveRelWithinLock = (lock: ResolvedLock, absTarget: string): string | null => {
      const relFromWb = relative(wbReal, absTarget).replace(/\\/g, "/");
      if (lock.explicitRoots.length === 0 && lock.unboundWorktrees.length === 0) {
        return relFromWb && !relFromWb.startsWith("..") ? relFromWb : null;
      }
      for (const rr of lock.explicitRoots) {
        if (absTarget === rr || absTarget.startsWith(rr + "/")) {
          return relative(rr, absTarget).replace(/\\/g, "/");
        }
      }
      for (const uw of lock.unboundWorktrees) {
        if (absTarget.startsWith(uw.worktreesDir + "/")) {
          const sub = relative(uw.worktreesDir, absTarget).replace(/\\/g, "/");
          const wtName = sub.split("/")[0];
          if (!wtName) continue;
          const wtRoot = canonicalizeMaybePath(join(uw.worktreesDir, wtName));
          if (allOpenBoundWorktrees.has(wtRoot)) continue;
          const b = getWorktreeBranch(wtRoot);
          if (b && b === uw.branch) {
            return relative(wtRoot, absTarget).replace(/\\/g, "/");
          }
        }
      }
      return null;
    };

    const matchLockedPath = (absTarget: string): string | null => {
      for (const lock of resolvedLocks) {
        for (const sf of lock.lockedSpecFiles) {
          if (absTarget === sf.abs) {
            const suggestedScope =
              sf.kind === "ssot" ? "requirement|invariant" : sf.kind;
            return (
              `物理锁（冻结 Spec 保护）：任务 ${lock.task_id} 的 ${sf.rel} 处于周期冻结态，禁止直接修改。\n` +
              `如确需变更，请先经用户确认并执行：ledger amend ${lock.task_id} --scope ${suggestedScope} --reason "<变更原因>"`
            );
          }
        }
        if (lock.lockedTestGlobs.length > 0) {
          const relFromWb = relative(wbReal, absTarget).replace(/\\/g, "/");
          const relWithinTask = resolveRelWithinLock(lock, absTarget);
          if (
            relWithinTask &&
            lock.lockedTestGlobs.some((g) => matchesGlob(relWithinTask, g))
          ) {
            return (
              `物理锁（冻结测试防篡改）：任务 ${lock.task_id} 已锁定测试文件 (${relFromWb})，实现/修 bug 阶段禁止私自修改测试断言迎合代码。\n` +
              `如确认是测试用例本身有误，请经用户确认后执行：ledger amend ${lock.task_id} --scope test_spec --reason "<原因>"`
            );
          }
        }
      }
      return null;
    };

    // 1. Check direct file-edit & apply_patch targets
    for (const abs of touchedFilePaths) {
      const hit = matchLockedPath(abs);
      if (hit) return hit;
    }

    // 2. Check mutating shell commands (with bounded recursion for `sh -c` / `bash -c` / `zsh -c`)
    const checkShellString = (shellCmd: string, cwdStart: string, depth: number): string | null => {
      if (depth > 3) return null;
      const segments = splitShellSegments(shellCmd);
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const segCwd = resolveSegmentCwd(segments, i, cwdStart);

        // Always inspect unquoted shell output redirections (`>`, `>>`, `>|`, `&>`, `<>`, etc.)
        const { writeTargets: redirWrites, readInputs: redirReads, strippedSeg } =
          parseShellRedirections(seg, segCwd);
        for (const targetAbs of redirWrites) {
          const hit = matchLockedPath(targetAbs);
          if (hit) return hit;
        }

        const metaToks = splitShellTokensWithMeta(strippedSeg);
        if (!metaToks || metaToks.length === 0) continue;
        const { bin, cmdToks, effectiveCwd, readOnly } = unwrapCommandPrefix(metaToks, segCwd);
        if (readOnly || !bin) continue;

        const isLedgerCli =
          bin === "ledger" ||
          ((bin === "bun" || bin === "node") &&
            Boolean(cmdToks[1]?.endsWith("/ledger.js") || cmdToks[1]?.endsWith("/ledger.ts")));
        if (isLedgerCli) continue;

        const args = cmdToks.slice(1);

        // Nested shell invocation (`sh -c`, `bash -lc`, `zsh -c`, `dash -c`, `ksh -c`)
        if (/^(sh|bash|zsh|dash|ksh)$/.test(bin)) {
          for (let j = 0; j < args.length; j++) {
            const a = args[j];
            if (a === "--") break;
            if (a === "-o" || a === "+o") {
              j++;
              continue;
            }
            if (a.startsWith("-") && !a.startsWith("--") && a.includes("c")) {
              const nested = args[j + 1];
              if (nested) {
                const nestedHit = checkShellString(nested, effectiveCwd, depth + 1);
                if (nestedHit) return nestedHit;
              }
              break;
            }
          }
          continue;
        }

        const candidateTargets: string[] = [];

        const failClosedForUninspectablePatchDir = (dirPath: string): string | null => {
          const canonDir = canonicalizeMaybePath(dirPath);
          for (const lock of resolvedLocks) {
            for (const sf of lock.lockedSpecFiles) {
              if (
                dirname(sf.abs) === canonDir ||
                sf.abs.startsWith(canonDir + "/") ||
                canonDir.startsWith(dirname(sf.abs) + "/")
              ) {
                return matchLockedPath(sf.abs);
              }
            }
            if (lock.lockedTestGlobs.length > 0) {
              const dirInsideLock = resolveRelWithinLock(lock, canonDir) !== null;
              const lockInsideDir = lock.explicitRoots.some(
                (rr) => rr === canonDir || rr.startsWith(canonDir + "/"),
              );
              if (dirInsideLock || lockInsideDir) {
                return (
                  `物理锁（冻结测试防篡改）：无法在预检查阶段安全解析补丁目标，禁止在包含锁定测试文件的目录 (${relative(wbReal, canonDir) || "."}) 中应用未检视补丁（任务 ${lock.task_id}）。`
                );
              }
            }
          }
          return null;
        };

        if (bin === "cp" || bin === "install") {
          const valFlags =
            bin === "install"
              ? new Set(["-m", "-o", "-g", "-S", "-B", "--mode", "--owner", "--group", "--suffix"])
              : new Set(["-S", "--suffix", "--backup"]);
          const { operands, targetDir } = collectDestOperands(args, valFlags);
          if (targetDir) {
            candidateTargets.push(...expandCopyDestPaths(operands, targetDir, effectiveCwd));
          } else if (operands.length >= 2) {
            const dest = operands[operands.length - 1];
            const srcs = operands.slice(0, -1);
            candidateTargets.push(...expandCopyDestPaths(srcs, dest, effectiveCwd));
          }
        } else if (bin === "mv") {
          const { operands, targetDir } = collectDestOperands(
            args,
            new Set(["-S", "--suffix", "--backup"]),
          );
          if (targetDir) {
            for (const s of operands) {
              candidateTargets.push(canonicalizeMaybePath(resolve(effectiveCwd, s)));
            }
            candidateTargets.push(...expandCopyDestPaths(operands, targetDir, effectiveCwd));
          } else if (operands.length >= 2) {
            const dest = operands[operands.length - 1];
            const srcs = operands.slice(0, -1);
            for (const s of srcs) {
              candidateTargets.push(canonicalizeMaybePath(resolve(effectiveCwd, s)));
            }
            candidateTargets.push(...expandCopyDestPaths(srcs, dest, effectiveCwd));
          }
        } else if (bin === "rm" || bin === "touch" || bin === "tee") {
          const { operands } = collectDestOperands(args, new Set());
          for (const op of operands) {
            candidateTargets.push(canonicalizeMaybePath(resolve(effectiveCwd, op)));
          }
        } else if (bin === "truncate") {
          const { operands } = collectDestOperands(
            args,
            new Set(["-s", "--size", "-r", "--reference"]),
          );
          for (const op of operands) {
            candidateTargets.push(canonicalizeMaybePath(resolve(effectiveCwd, op)));
          }
        } else if (bin === "chmod" || bin === "chown") {
          const hasRef = args.some((a) => a === "--reference" || a.startsWith("--reference="));
          const { operands } = collectDestOperands(args, new Set(["--reference"]));
          const files = hasRef ? operands : operands.slice(1);
          for (const f of files) {
            candidateTargets.push(canonicalizeMaybePath(resolve(effectiveCwd, f)));
          }
        } else if (bin === "dd") {
          for (const a of args) {
            if (a.startsWith("of=") && a.length > 3) {
              candidateTargets.push(canonicalizeMaybePath(resolve(effectiveCwd, a.slice(3))));
            }
          }
        } else if (bin === "sed") {
          let inPlace = false;
          let hasExplicitScript = false;
          const scripts: string[] = [];
          const positionals: string[] = [];
          let endFlags = false;
          for (let j = 0; j < args.length; j++) {
            const a = args[j];
            if (!endFlags && a === "--") {
              endFlags = true;
              continue;
            }
            if (!endFlags && a.startsWith("-") && a.length > 1) {
              if (a === "--in-place" || a.startsWith("--in-place=")) {
                inPlace = true;
                continue;
              }
              if (a === "-i") {
                inPlace = true;
                // GNU vs BSD sed `-i ''` or `-i .bak`: if next arg is empty string, consume it
                if (args[j + 1] === "") j++;
                continue;
              }
              if (!a.startsWith("--") && /^-[a-zA-Z]*i/.test(a)) {
                inPlace = true;
                continue;
              }
              if (a === "-e" || a === "--expression") {
                hasExplicitScript = true;
                if (args[j + 1]) scripts.push(args[++j]);
                continue;
              }
              if (a === "-f" || a === "--file") {
                hasExplicitScript = true;
                j++;
                continue;
              }
              continue;
            }
            positionals.push(a);
          }
          let fileArgs = positionals;
          if (!hasExplicitScript && positionals.length > 0) {
            scripts.push(positionals[0]);
            fileArgs = positionals.slice(1);
          }
          if (inPlace) {
            for (const f of fileArgs) {
              candidateTargets.push(canonicalizeMaybePath(resolve(effectiveCwd, f)));
            }
          }
          for (const sc of scripts) {
            const wm = sc.match(/(?:^|[;\n\s])w\s+([^\s;]+)/);
            if (wm?.[1]) {
              candidateTargets.push(canonicalizeMaybePath(resolve(effectiveCwd, wm[1])));
            }
          }
        } else if (bin === "awk" || bin === "gawk" || bin === "mawk") {
          let inPlace = false;
          let hasProgFile = false;
          const progs: string[] = [];
          const positionals: string[] = [];
          for (let j = 0; j < args.length; j++) {
            const a = args[j];
            if (a === "--") {
              positionals.push(...args.slice(j + 1));
              break;
            }
            if (a === "-i" && args[j + 1] === "inplace") {
              inPlace = true;
              j++;
              continue;
            }
            if (a === "-f" || a === "--file") {
              hasProgFile = true;
              j++;
              continue;
            }
            if (a === "-F" || a === "-v") {
              j++;
              continue;
            }
            if (a.startsWith("-")) continue;
            positionals.push(a);
          }
          let fileArgs = positionals;
          if (!hasProgFile && positionals.length > 0) {
            progs.push(positionals[0]);
            fileArgs = positionals.slice(1);
          }
          if (inPlace) {
            for (const f of fileArgs) {
              candidateTargets.push(canonicalizeMaybePath(resolve(effectiveCwd, f)));
            }
          }
          for (const pr of progs) {
            for (const m of pr.matchAll(/>>?\s*["']([^"'\n]+)["']/g)) {
              if (m[1]) candidateTargets.push(canonicalizeMaybePath(resolve(effectiveCwd, m[1])));
            }
          }
        } else if (bin === "patch") {
          let stripLevel: number | null = null;
          let patchDir = effectiveCwd;
          let dryRun = false;
          let hasOutputFlag = false;
          const patchInputs: string[] = [...redirReads];
          const positionals: string[] = [];
          for (let j = 0; j < args.length; j++) {
            const a = args[j];
            if (a === "--") {
              positionals.push(...args.slice(j + 1));
              break;
            }
            if (a === "--dry-run" || a === "--check" || a === "-C") {
              dryRun = true;
              continue;
            }
            if (a === "-p" && args[j + 1] !== undefined) {
              const n = Number(args[++j]);
              if (Number.isInteger(n) && n >= 0) stripLevel = n;
              continue;
            }
            if (/^-p\d+$/.test(a)) {
              stripLevel = Number(a.slice(2));
              continue;
            }
            if (a === "-d" || a === "--directory") {
              if (args[j + 1]) patchDir = resolve(effectiveCwd, args[++j]);
              continue;
            }
            if (a.startsWith("--directory=")) {
              patchDir = resolve(effectiveCwd, a.slice("--directory=".length));
              continue;
            }
            if (a === "-i" || a === "--input") {
              if (args[j + 1]) patchInputs.push(canonicalizeMaybePath(resolve(effectiveCwd, args[++j])));
              continue;
            }
            if (a.startsWith("--input=")) {
              patchInputs.push(canonicalizeMaybePath(resolve(effectiveCwd, a.slice("--input=".length))));
              continue;
            }
            if (a === "-o" || a === "--output") {
              hasOutputFlag = true;
              if (args[j + 1]) candidateTargets.push(canonicalizeMaybePath(resolve(effectiveCwd, args[++j])));
              continue;
            }
            if (a === "-r" || a === "-b" || a === "-B" || a === "-z" || a === "-V") {
              if (a !== "-b") j++;
              continue;
            }
            if (a.startsWith("-")) continue;
            positionals.push(a);
          }
          if (dryRun && !hasOutputFlag) continue;
          if (positionals[0]) {
            candidateTargets.push(canonicalizeMaybePath(resolve(patchDir, positionals[0])));
          }
          if (positionals[1]) {
            patchInputs.push(canonicalizeMaybePath(resolve(effectiveCwd, positionals[1])));
          }
          let anyUninspectable = false;
          for (const pf of patchInputs) {
            const parsed = extractPatchFileTargets(pf, patchDir, stripLevel);
            candidateTargets.push(...parsed.targets);
            if (parsed.uninspectable) anyUninspectable = true;
          }
          if (
            anyUninspectable ||
            (candidateTargets.length === 0 && patchInputs.length === 0)
          ) {
            const failHit = failClosedForUninspectablePatchDir(patchDir);
            if (failHit) return failHit;
          }
        } else if (bin === "git") {
          const git = extractGitSubcommand(cmdToks);
          if (git) {
            const gitDir = resolveGitDirFlags(effectiveCwd, git.gitDirFlags, false) ?? effectiveCwd;
            const subArgs = git.subArgs;
            if (git.subcmd === "checkout" || git.subcmd === "restore") {
              const ddIdx = subArgs.indexOf("--");
              let pathArgs: string[] = [];
              if (ddIdx >= 0) {
                pathArgs = subArgs.slice(ddIdx + 1);
              } else if (git.subcmd === "restore") {
                const { operands } = collectDestOperands(subArgs, new Set(["-s", "--source"]));
                pathArgs = operands;
              } else {
                const { operands } = collectDestOperands(subArgs, new Set(["-b", "-B", "--orphan"]));
                pathArgs = operands.slice(1);
              }
              for (const p of pathArgs) {
                candidateTargets.push(canonicalizeMaybePath(resolve(gitDir, p)));
              }
            } else if (git.subcmd === "rm" || git.subcmd === "mv") {
              const { operands } = collectDestOperands(subArgs, new Set());
              for (const p of operands) {
                candidateTargets.push(canonicalizeMaybePath(resolve(gitDir, p)));
              }
            } else if (git.subcmd === "apply") {
              let stripLevel: number | null = 1;
              let applyDir = gitDir;
              let hasReportOrCheckFlag = false;
              let hasExplicitApplyFlag = false;
              let hasFakeAncestorFlag = false;
              const patchFiles: string[] = [...redirReads];
              for (let j = 0; j < subArgs.length; j++) {
                const a = subArgs[j];
                if (a === "--") {
                  for (const pf of subArgs.slice(j + 1)) {
                    patchFiles.push(canonicalizeMaybePath(resolve(gitDir, pf)));
                  }
                  break;
                }
                if (a === "--check" || a === "--stat" || a === "--numstat" || a === "--summary") {
                  hasReportOrCheckFlag = true;
                  continue;
                }
                if (a === "--apply") {
                  hasExplicitApplyFlag = true;
                  continue;
                }
                if (a === "--build-fake-ancestor") {
                  hasFakeAncestorFlag = true;
                  const target = subArgs[++j];
                  if (target) {
                    candidateTargets.push(canonicalizeMaybePath(resolve(gitDir, target)));
                  }
                  continue;
                }
                if (a.startsWith("--build-fake-ancestor=")) {
                  hasFakeAncestorFlag = true;
                  const target = a.slice("--build-fake-ancestor=".length);
                  if (target) {
                    candidateTargets.push(canonicalizeMaybePath(resolve(gitDir, target)));
                  }
                  continue;
                }
                if (a === "-p" && subArgs[j + 1] !== undefined) {
                  const n = Number(subArgs[++j]);
                  if (Number.isInteger(n) && n >= 0) stripLevel = n;
                  continue;
                }
                if (/^-p\d+$/.test(a)) {
                  stripLevel = Number(a.slice(2));
                  continue;
                }
                if (a === "--directory" && subArgs[j + 1] !== undefined) {
                  applyDir = resolve(gitDir, subArgs[++j]);
                  continue;
                }
                if (a.startsWith("--directory=")) {
                  applyDir = resolve(gitDir, a.slice("--directory=".length));
                  continue;
                }
                if (
                  a === "--include" ||
                  a === "--exclude" ||
                  a === "--whitespace" ||
                  a === "-C"
                ) {
                  j++;
                  continue;
                }
                if (a.startsWith("-")) continue;
                patchFiles.push(canonicalizeMaybePath(resolve(gitDir, a)));
              }
              // In git apply, `--apply` overrides `--stat`/`--numstat`/`--summary`/`--check` regardless of flag order!
              if (hasReportOrCheckFlag && !hasExplicitApplyFlag && !hasFakeAncestorFlag) continue;
              let anyUninspectable = false;
              for (const pf of patchFiles) {
                const parsed = extractPatchFileTargets(pf, applyDir, stripLevel);
                candidateTargets.push(...parsed.targets);
                if (parsed.uninspectable) anyUninspectable = true;
              }
              if (anyUninspectable || patchFiles.length === 0) {
                const failHit = failClosedForUninspectablePatchDir(applyDir);
                if (failHit) return failHit;
              }
            }
          }
        } else if (/^(python3?(?:\.\d+)?|node|bun|perl|ruby)$/.test(bin)) {
          let inPlace = false;
          const inlineScripts: string[] = [];
          const fileArgs: string[] = [];
          let endFlags = false;
          for (let j = 0; j < args.length; j++) {
            const a = args[j];
            if (!endFlags && a === "--") {
              endFlags = true;
              continue;
            }
            if (!endFlags && a.startsWith("-") && a.length > 1) {
              if ((bin === "perl" || bin === "ruby") && /^-[a-zA-Z]*i/.test(a)) {
                inPlace = true;
              }
              if (
                a === "-c" ||
                a === "-e" ||
                a === "-E" ||
                a === "--eval" ||
                ((bin === "perl" || bin === "ruby") && /^-[a-zA-Z]*[eE]$/.test(a))
              ) {
                if (args[j + 1] !== undefined) inlineScripts.push(args[++j]);
                continue;
              }
              continue;
            }
            fileArgs.push(a);
          }

          if (inPlace) {
            for (const f of fileArgs) {
              candidateTargets.push(canonicalizeMaybePath(resolve(effectiveCwd, f)));
            }
          }

          if (inlineScripts.length > 0) {
            const combinedScript = inlineScripts.join("\n");
            const looksMutating = inPlace || INLINE_WRITE_INDICATOR_RE.test(combinedScript);
            if (looksMutating) {
              // 1. Resolve all quoted string literals as candidate paths
              for (const lit of extractQuotedStrings(combinedScript)) {
                candidateTargets.push(canonicalizeMaybePath(resolve(effectiveCwd, lit)));
              }
              // 2. Check explicit spec file / task-owned locked glob references
              const canonEffCwd = canonicalizeMaybePath(effectiveCwd);
              for (const lock of resolvedLocks) {
                for (const sf of lock.lockedSpecFiles) {
                  const baseName = sf.rel.split("/").pop() ?? sf.rel;
                  const inSpecDir = canonEffCwd === dirname(sf.abs);
                  if (
                    combinedScript.includes(sf.rel) ||
                    combinedScript.includes(sf.abs) ||
                    (inSpecDir && combinedScript.includes(baseName))
                  ) {
                    const suggestedScope =
                      sf.kind === "ssot" ? "requirement|invariant" : sf.kind;
                    return (
                      `物理锁（冻结 Spec 保护）：禁止通过内联脚本修改任务 ${lock.task_id} 的冻结文档 (${sf.rel})。\n` +
                      `如确需变更，请先经用户确认并执行：ledger amend ${lock.task_id} --scope ${suggestedScope} --reason "<变更原因>"`
                    );
                  }
                }
                if (lock.lockedTestGlobs.length > 0) {
                  const cwdInLock = resolveRelWithinLock(lock, canonEffCwd) !== null;
                  const hasDynamicPathBuild =
                    /\+|\$\{|\#\{|\b(?:join|resolve|format)\s*\(|f["']/.test(combinedScript);
                  if (
                    cwdInLock &&
                    hasDynamicPathBuild &&
                    lock.lockedTestGlobs.some((g) => g.includes(".hurl")) &&
                    combinedScript.includes(".hurl")
                  ) {
                    return (
                      `物理锁（冻结测试防篡改）：禁止通过内联脚本修改任务 ${lock.task_id} 锁定的 .hurl 测试文件。\n` +
                      `如确认是测试用例本身有误，请经用户确认后执行：ledger amend ${lock.task_id} --scope test_spec --reason "<原因>"`
                    );
                  }
                }
              }
            }
          }
        }

        for (const candidateAbs of candidateTargets) {
          const hit = matchLockedPath(candidateAbs);
          if (hit) return hit;
        }
      }
      return null;
    };

    if (cmd) {
      const shellHit = checkShellString(cmd, baseWorkdir, 0);
      if (shellHit) return shellHit;
    }
  } finally {
    ledger?.closeDb();
  }

  return null;
}
