import { accessSync, constants as fsConstants, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";

export function pushUtf8Bytes(out: number[], s: string): void {
  for (const b of Buffer.from(s, "utf8")) {
    out.push(b);
  }
}

function decodeAnsiCChunkBytes(
  segment: string,
  startIdx: number,
): { bytes: number[]; nextIdx: number } | null {
  const bytes: number[] = [];
  let nulTruncated = false;
  const pushByte = (b: number): void => {
    if (nulTruncated) return;
    if ((b & 0xff) === 0) {
      nulTruncated = true;
      return;
    }
    bytes.push(b & 0xff);
  };
  const pushUtf8 = (s: string): void => {
    if (nulTruncated) return;
    for (const b of Buffer.from(s, "utf8")) {
      if (b === 0) {
        nulTruncated = true;
        return;
      }
      bytes.push(b);
    }
  };

  for (let i = startIdx; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === "'") {
      return { bytes, nextIdx: i };
    }
    if (ch === "\\" && i + 1 < segment.length) {
      const esc = segment[++i];
      if (esc === "a") pushByte(0x07);
      else if (esc === "b") pushByte(0x08);
      else if (esc === "e" || esc === "E") pushByte(0x1b);
      else if (esc === "f") pushByte(0x0c);
      else if (esc === "n") pushByte(0x0a);
      else if (esc === "r") pushByte(0x0d);
      else if (esc === "t") pushByte(0x09);
      else if (esc === "v") pushByte(0x0b);
      else if (esc === "\\" || esc === "'" || esc === '"' || esc === "?") pushUtf8(esc);
      else if (esc === "c" && i + 1 < segment.length) {
        const ctrlChar = segment[++i];
        pushByte(ctrlChar === "?" ? 0x7f : ctrlChar.toUpperCase().charCodeAt(0) & 0x1f);
      } else if (esc === "x") {
        const hex = segment.slice(i + 1, i + 3).match(/^[0-9a-fA-F]{1,2}/)?.[0];
        if (hex) {
          pushByte(Number.parseInt(hex, 16));
          i += hex.length;
        } else {
          pushUtf8("\\x");
        }
      } else if (esc === "u" || esc === "U") {
        const maxLen = esc === "u" ? 4 : 8;
        const hex = segment.slice(i + 1, i + 1 + maxLen).match(/^[0-9a-fA-F]{1,8}/)?.[0];
        if (hex) {
          const cp = Number.parseInt(hex, 16);
          if (cp === 0) pushByte(0);
          else if (cp <= 0x10ffff) pushUtf8(String.fromCodePoint(cp));
          else pushUtf8(`\\${esc}${hex}`);
          i += hex.length;
        } else {
          pushUtf8(`\\${esc}`);
        }
      } else if (esc >= "0" && esc <= "7") {
        const oct = segment.slice(i, i + 3).match(/^[0-7]{1,3}/)![0];
        pushByte(Number.parseInt(oct, 8));
        i += oct.length - 1;
      } else {
        pushUtf8(`\\${esc}`);
      }
      continue;
    }
    // Preserve full Unicode code points (including surrogate pairs such as emoji 🚀)
    const cp = segment.codePointAt(i)!;
    const fullChar = String.fromCodePoint(cp);
    pushUtf8(fullChar);
    if (fullChar.length > 1) i += fullChar.length - 1;
  }
  return null; // Unclosed $'...'
}

export interface ShellToken {
  value: string;
  /** True ONLY when the `NAME=` prefix (up to and including `=`) was completely unquoted and unescaped (POSIX ASSIGNMENT_WORD). */
  isEnvAssign: boolean;
  hasExpansion?: boolean;
}

export function splitShellTokensWithMeta(segment: string): ShellToken[] | null {
  const tokens: ShellToken[] = [];
  let curBytes: number[] = [];
  let hasToken = false;
  let quote: "'" | '"' | null = null;
  let escape = false;
  let hasExpansion = false;
  let sawEq = false;
  let sawQuoteOrEscapeBeforeEq = false;
  let validEnvAssign = false;

  const flushToken = (): void => {
    if (!hasToken) return;
    tokens.push({
      value: Buffer.from(curBytes).toString("utf8"),
      isEnvAssign: validEnvAssign,
      ...(hasExpansion && { hasExpansion }),
    });
    hasExpansion = false;
    curBytes = [];
    hasToken = false;
    sawEq = false;
    sawQuoteOrEscapeBeforeEq = false;
    validEnvAssign = false;
  };

  for (let i = 0; i < segment.length; i++) {
    const cp = segment.codePointAt(i)!;
    const fullChar = String.fromCodePoint(cp);
    const ch = segment[i];
    if (escape) {
      if (!sawEq) sawQuoteOrEscapeBeforeEq = true;
      pushUtf8Bytes(curBytes, fullChar);
      hasToken = true;
      escape = false;
      if (fullChar.length > 1) i += fullChar.length - 1;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") {
        quote = null;
      } else {
        pushUtf8Bytes(curBytes, fullChar);
        if (fullChar.length > 1) i += fullChar.length - 1;
      }
      continue;
    }
    if ((ch === "$" && (quote || segment[i + 1] !== "'")) || ch === "`") hasExpansion = true;
    if (quote === '"') {
      if (ch === "\\") {
        const next = segment[i + 1];
        if (next === '"' || next === "\\" || next === "$" || next === "`") {
          pushUtf8Bytes(curBytes, next);
          i++;
        } else if (next === "\n") {
          // Line continuation inside double quotes removes both `\` and `\n`
          i++;
        } else {
          // Per POSIX/Bash: backslash inside `"..."` stays literal before all other characters
          pushUtf8Bytes(curBytes, "\\");
        }
      } else if (ch === '"') {
        quote = null;
      } else {
        pushUtf8Bytes(curBytes, fullChar);
        if (fullChar.length > 1) i += fullChar.length - 1;
      }
      continue;
    }
    if (ch === "\\") {
      if (segment[i + 1] === "\n") {
        // Line continuation outside quotes removes both `\` and `\n`
        i++;
      } else {
        if (!sawEq) sawQuoteOrEscapeBeforeEq = true;
        escape = true;
        hasToken = true;
      }
    } else if (ch === "$" && segment[i + 1] === "'") {
      if (!sawEq) sawQuoteOrEscapeBeforeEq = true;
      const decoded = decodeAnsiCChunkBytes(segment, i + 2);
      if (!decoded) return null;
      for (const b of decoded.bytes) curBytes.push(b);
      hasToken = true;
      i = decoded.nextIdx;
    } else if (ch === "'" || ch === '"') {
      if (!sawEq) sawQuoteOrEscapeBeforeEq = true;
      quote = ch;
      hasToken = true;
    } else if (ch === "#" && !hasToken) {
      // Unquoted `#` at start of a word begins a POSIX shell comment to end of line.
      while (i < segment.length && segment[i] !== "\n") i++;
    } else if (ch === " " || ch === "\t" || ch === "\n") {
      // Strictly POSIX shell IFS whitespace (ASCII space/tab/LF) — NEVER JS `/\s/` which splits U+00A0 NBSP!
      flushToken();
    } else {
      if (ch === "=" && !sawEq) {
        sawEq = true;
        if (!sawQuoteOrEscapeBeforeEq) {
          const namePart = Buffer.from(curBytes).toString("utf8");
          if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(namePart)) {
            validEnvAssign = true;
          }
        }
      }
      pushUtf8Bytes(curBytes, fullChar);
      hasToken = true;
      if (fullChar.length > 1) i += fullChar.length - 1;
    }
  }
  if (quote !== null) return null;
  flushToken();
  return tokens;
}

export function splitShellTokens(segment: string): string[] | null {
  const toks = splitShellTokensWithMeta(segment);
  return toks ? toks.map((t) => t.value) : null;
}

function trimAsciiWhitespace(s: string): string {
  return s.replace(/^[ \t\n]+|[ \t\n]+$/g, "");
}

export function splitShellSegments(cmd: string): string[] {
  const segs: string[] = [];
  let cur = "";
  let quote: "'" | '"' | "$'" | null = null;
  let escape = false;
  let atWordStart = true;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    const next = cmd[i + 1];
    if (escape) {
      cur += ch;
      escape = false;
      continue;
    }
    if (quote === "'") {
      cur += ch;
      if (ch === "'") quote = null;
      atWordStart = false;
      continue;
    }
    if (quote === "$'") {
      cur += ch;
      if (ch === "\\") escape = true;
      else if (ch === "'") quote = null;
      atWordStart = false;
      continue;
    }
    if (quote === '"') {
      cur += ch;
      if (ch === "\\") escape = true;
      else if (ch === '"') quote = null;
      atWordStart = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      cur += ch;
      if (next !== "\n") atWordStart = false;
      continue;
    }
    if (ch === "$" && next === "'") {
      quote = "$'";
      cur += "$'";
      atWordStart = false;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      atWordStart = false;
      continue;
    }
    if (ch === "#" && atWordStart) {
      // Unquoted `#` at a true POSIX word boundary starts a comment until `\n` or EOF.
      while (i + 1 < cmd.length && cmd[i + 1] !== "\n") i++;
      continue;
    }
    if (ch === ";" || ch === "\n") {
      const trimmed = trimAsciiWhitespace(cur);
      if (trimmed) segs.push(trimmed);
      cur = "";
      atWordStart = true;
      continue;
    }
    if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
      const trimmed = trimAsciiWhitespace(cur);
      if (trimmed) segs.push(trimmed);
      cur = "";
      atWordStart = true;
      i++;
      continue;
    }
    if (ch === "&") {
      const prev = cmd[i - 1];
      if (prev === ">" || prev === "<" || next === ">") {
        cur += ch;
        atWordStart = false;
        continue;
      }
      const trimmed = trimAsciiWhitespace(cur);
      if (trimmed) segs.push(trimmed);
      cur = "";
      atWordStart = true;
      continue;
    }
    if (ch === "|") {
      if (cmd[i - 1] === ">") {
        // Clobber redirection `>|` is part of the current command, NOT a pipe!
        cur += ch;
        atWordStart = false;
        continue;
      }
      const trimmed = trimAsciiWhitespace(cur);
      if (trimmed) segs.push(trimmed);
      cur = "";
      atWordStart = true;
      continue;
    }
    cur += ch;
    atWordStart = ch === " " || ch === "\t" || ch === "(" || ch === ")";
  }
  const tail = trimAsciiWhitespace(cur);
  if (tail) segs.push(tail);
  return segs;
}

/** Detect unquoted shell redirection (`<` or `>`) so SQL comparisons inside quotes don't false-positive. */
export function hasUnquotedRedirect(cmd: string, char: "<" | ">"): boolean {
  let quote: "'" | '"' | null = null;
  let escape = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") escape = true;
      else if (ch === '"') quote = null;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === char) {
      if (char === ">" && cmd[i + 1] === "&") continue; // fd dup like 2>&1
      return true;
    }
  }
  return false;
}

export function hasUnquotedPipe(cmd: string): boolean {
  let quote: "'" | '"' | "$'" | null = null;
  let escape = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    const next = cmd[i + 1];
    if (escape) {
      escape = false;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === "$'") {
      if (ch === "\\") escape = true;
      else if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") escape = true;
      else if (ch === '"') quote = null;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === "$" && next === "'") {
      quote = "$'";
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "|") {
      if (next === "|") {
        i++;
        continue;
      }
      if (cmd[i - 1] === ">") continue; // clobber >|
      return true;
    }
  }
  return false;
}

/**
 * Strip unquoted shell redirections (`> /dev/null`, `2>&1`, `>> log`, `< input`) from a command segment
 * while preserving quoted literal filenames (e.g. `"foo>bar.test.js"`).
 */
export function stripUnquotedShellRedirections(seg: string): string {
  let out = "";
  let quote: "'" | '"' | "$'" | null = null;
  let escape = false;
  let i = 0;
  const skipTargetWord = () => {
    while (i < seg.length && (seg[i] === " " || seg[i] === "\t")) i++;
    let wQuote: "'" | '"' | "$'" | null = null;
    let wEscape = false;
    while (i < seg.length) {
      const c = seg[i];
      const nx = seg[i + 1];
      if (wEscape) {
        wEscape = false;
        i++;
        continue;
      }
      if (wQuote === "'") {
        if (c === "'") wQuote = null;
        i++;
        continue;
      }
      if (wQuote === "$'") {
        if (c === "\\") wEscape = true;
        else if (c === "'") wQuote = null;
        i++;
        continue;
      }
      if (wQuote === '"') {
        if (c === "\\") wEscape = true;
        else if (c === '"') wQuote = null;
        i++;
        continue;
      }
      if (c === "\\") {
        wEscape = true;
        i++;
        continue;
      }
      if (c === "$" && nx === "'") {
        wQuote = "$'";
        i += 2;
        continue;
      }
      if (c === "'" || c === '"') {
        wQuote = c;
        i++;
        continue;
      }
      if (c === " " || c === "\t" || c === "\n" || c === ">" || c === "<") break;
      i++;
    }
  };

  while (i < seg.length) {
    const ch = seg[i];
    const next = seg[i + 1];
    if (escape) {
      out += ch;
      escape = false;
      i++;
      continue;
    }
    if (quote === "'") {
      out += ch;
      if (ch === "'") quote = null;
      i++;
      continue;
    }
    if (quote === "$'") {
      out += ch;
      if (ch === "\\") escape = true;
      else if (ch === "'") quote = null;
      i++;
      continue;
    }
    if (quote === '"') {
      out += ch;
      if (ch === "\\") escape = true;
      else if (ch === '"') quote = null;
      i++;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      escape = true;
      i++;
      continue;
    }
    if (ch === "$" && next === "'") {
      quote = "$'";
      out += "$'";
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if ((ch === "&" && next === ">") || ch === ">" || ch === "<") {
      // Drop any immediately preceding unquoted fd digits at word start (e.g. `2>` or `1>`)
      if (ch === ">" || ch === "<") {
        let dEnd = out.length;
        while (dEnd > 0 && out[dEnd - 1] >= "0" && out[dEnd - 1] <= "9") dEnd--;
        if (dEnd < out.length && (dEnd === 0 || out[dEnd - 1] === " " || out[dEnd - 1] === "\t")) {
          out = out.slice(0, dEnd);
        }
      }
      if (ch === "&" && next === ">") {
        i += seg[i + 2] === ">" ? 3 : 2;
      } else if (ch === ">" && (next === ">" || next === "|" || next === "&")) {
        i += 2;
      } else if (ch === "<" && (next === "&" || next === ">")) {
        i += 2;
      } else {
        i += 1;
      }
      skipTargetWord();
      out += " ";
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

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

export function hasShellExpansion(s: string): boolean {
  return /[$`]/.test(s);
}

export function hasPrecedingDynamicCd(segments: string[], targetIndex: number): boolean {
  for (let i = 0; i < targetIndex; i++) {
    const toks = splitShellTokens(segments[i]);
    if (toks && toks[0] === "cd" && toks[1] && hasShellExpansion(toks[1])) {
      return true;
    }
  }
  return false;
}

export function hasOnlyAndSeparators(cmd: string): boolean {
  let quote: "'" | '"' | "$'" | null = null;
  let escape = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    const next = cmd[i + 1];
    if (escape) {
      escape = false;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === "$'") {
      if (ch === "\\") escape = true;
      else if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") escape = true;
      else if (ch === '"') quote = null;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === "$" && next === "'") {
      quote = "$'";
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "\r" || ch === "|") return false;
    if (ch === "&") {
      if (next === "&") {
        i++;
        continue;
      }
      const prev = cmd[i - 1];
      if (prev === ">" || prev === "<" || next === ">") continue;
      return false;
    }
  }
  return !escape && quote === null;
}

export function isSimpleLiteralCdSegment(seg: string): boolean {
  if (hasUnquotedRedirect(seg, ">") || hasUnquotedRedirect(seg, "<")) return false;
  if (seg.includes("$(") || seg.includes("`")) return false;
  const toks = splitShellTokens(seg);
  if (!toks || toks.length !== 2) return false;
  return toks[0] === "cd" && !toks[1].startsWith("-") && !hasShellExpansion(toks[1]);
}

export function tokenizeSimpleShellCommand(raw: string): string[] | null {
  if (/[\n\r\0]/.test(raw)) return null;
  const tokens: string[] = [];
  let cur = "";
  let has = false;
  let quote: "'" | '"' | null = null;
  let escape = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escape) {
      cur += ch;
      has = true;
      escape = false;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
        const next = raw[i + 1];
        if (next === '"' || next === "\\" || next === "$" || next === "`") {
          cur += next;
          i++;
        } else {
          cur += "\\";
        }
      } else if (ch === '"') {
        quote = null;
      } else if (ch === "`" || (ch === "$" && raw[i + 1] === "(")) {
        return null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === "\\") {
      escape = true;
      has = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
      continue;
    }
    if (ch === ";" || ch === "&" || ch === "|" || ch === "`" || ch === "<" || ch === ">" || ch === "(" || ch === ")") {
      return null;
    }
    if (ch === "$" && raw[i + 1] === "(") return null;
    if (ch === " " || ch === "\t") {
      if (has) {
        tokens.push(cur);
        cur = "";
        has = false;
      }
      continue;
    }
    cur += ch;
    has = true;
  }
  if (escape || quote !== null) return null;
  if (has) tokens.push(cur);
  return tokens;
}

/**
 * POSIX/Bash `cd` target resolver (supports no-arg `$HOME`, `-L` logical default, `-P` physical,
 * `--`, and in-chain `cd -`). Returns `null` if `cd` would fail or target is indeterminate.
 */
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
