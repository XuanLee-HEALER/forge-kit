import { splitShellTokens } from "./shell-tokens";

function trimAsciiWhitespace(s: string): string {
  return s.replace(/^[ \t\n]+|[ \t\n]+$/g, "");
}

export function splitShellSegments(cmd: string, pipedInputs?: Set<number>): string[] {
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
      pipedInputs?.add(segs.length);
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
export function stripUnquotedShellRedirections(seg: string, outputPaths?: string[]): string {
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
      const targetStart = i;
      skipTargetWord();
      if (outputPaths && (ch !== "<" || next === ">")) {
        const target = splitShellTokens(seg.slice(targetStart, i).trim())?.[0];
        if (target) outputPaths.push(target);
      }
      out += " ";
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

export function hasOnlyAndSeparators(cmd: string, allowNewlines = false): boolean {
  let quote: "'" | '"' | "$'" | null = null;
  let escape = false;
  let sawAnd = false;
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
    if (ch === ";" || ch === "|") return false;
    // Under errexit an unsuccessful AND-list may still be followed by a successful line.
    if ((ch === "\n" || ch === "\r") && (!allowNewlines || sawAnd)) return false;
    if (ch === "&") {
      if (next === "&") {
        sawAnd = true;
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
