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
