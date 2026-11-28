type Delimiter = '"' | "'" | '"""' | "'''" | "/" | "$/";
type Token = { kind: "word" | "symbol" | "literal" | "string"; text: string; startsLine: boolean };

const newLine = (character: string) => character === "\n" || character === "\r";
const wordCharacter = (character: string) => /[\w$\u0080-\uffff]/.test(character);
const taskName = /^[\w-]+$/;

function afterComment(source: string, start: number, groovy: boolean): number {
  if (source.startsWith("//", start)) {
    let at = start + 2;
    while (at < source.length && !newLine(source[at])) at++;
    return at;
  }
  if (!source.startsWith("/*", start)) return start;
  let depth = 1;
  let at = start + 2;
  while (at < source.length && depth) {
    if (source.startsWith("*/", at)) {
      depth--;
      at += 2;
    } else if (!groovy && source.startsWith("/*", at)) {
      depth++;
      at += 2;
    } else at++;
  }
  return at;
}

function delimiterAt(source: string, at: number, groovy: boolean, startsOperand: boolean): Delimiter | undefined {
  if (source.startsWith('"""', at)) return '"""';
  if (source.startsWith("'''", at) && groovy) return "'''";
  const character = source[at];
  if (character === '"' || character === "'") return character;
  if (groovy && source.startsWith("$/", at)) return "$/";
  if (groovy && character === "/" && startsOperand) return "/";
}

function afterString(source: string, start: number, opening: Delimiter, groovy: boolean): number {
  // Interpolations stay inside the string token, including their nested strings.
  const frames: (Delimiter | "}")[] = [opening];
  let at = start + opening.length;
  let startsOperand = true;
  while (frames.length && at < source.length) {
    const delimiter = frames.at(-1)!;
    const character = source[at];
    if (delimiter === "}") {
      const commentEnd = character === "/" ? afterComment(source, at, groovy) : at;
      if (commentEnd !== at) {
        at = commentEnd;
        continue;
      }
      const nested = delimiterAt(source, at, groovy, startsOperand);
      if (nested) {
        frames.push(nested);
        at += nested.length;
        continue;
      }
      if (character === "{") frames.push("}");
      else if (character === "}") frames.pop();
      if (!/\s/.test(character)) startsOperand = "=([{,:;!?&|+*-%~<>".includes(character);
      at++;
      continue;
    }

    const next = source[at + 1];
    const escapes = delimiter === "$/" ? character === "$" && (next === "$" || next === "/") :
      delimiter === "/" ? character === "\\" && next === "/" :
        character === "\\" && (delimiter.length === 1 || groovy);
    if (escapes) {
      at += 2;
      continue;
    }
    const close = delimiter === "$/" ? "/$" : delimiter;
    if (source.startsWith(close, at)) {
      frames.pop();
      at += close.length;
      startsOperand = false;
      continue;
    }
    if (!delimiter.startsWith("'") && character === "$" && next === "{") {
      frames.push("}");
      startsOperand = true;
      at += 2;
      continue;
    }
    at++;
  }
  return at;
}

function* tokens(source: string, groovy: boolean): Generator<Token> {
  let at = 0;
  let startsLine = true;
  let previous: Token | undefined;
  while (at < source.length) {
    const character = source[at];
    if (/\s/.test(character)) {
      startsLine ||= newLine(character);
      at++;
      continue;
    }
    if (character === "/") {
      const end = afterComment(source, at, groovy);
      if (end !== at) {
        startsLine ||= /[\r\n]/.test(source.slice(at, end));
        at = end;
        continue;
      }
    }

    // A division operator follows an operand. A slashy literal starts an
    // operand, including a Groovy command argument with an attached slash.
    const startsOperand = startsLine || !previous ||
      (previous.kind === "symbol" && "=([{,:;!?&|+*-%~<>".includes(previous.text)) ||
      (previous.kind === "word" && /^(?:return|throw|case|assert|yield)$/.test(previous.text)) ||
      (character === "/" && previous.startsLine && previous.kind === "word" && !/^\d/.test(previous.text) &&
        /\s/.test(source[at - 1]) && at + 1 < source.length && !/\s/.test(source[at + 1]));
    const delimiter = delimiterAt(source, at, groovy, startsOperand);
    let token: Token;
    if (delimiter) {
      const start = at + delimiter.length;
      at = afterString(source, at, delimiter, groovy);
      const value = delimiter.length === 1 && delimiter !== "/" && source[at - 1] === delimiter
        ? source.slice(start, at - 1) : "";
      token = taskName.test(value)
        ? { kind: "literal", text: value, startsLine }
        : { kind: "string", text: "", startsLine };
    } else if (wordCharacter(character)) {
      const start = at++;
      while (at < source.length && (wordCharacter(source[at]) || source[at] === "-")) at++;
      token = { kind: "word", text: source.slice(start, at), startsLine };
    } else {
      token = { kind: "symbol", text: character, startsLine };
      at++;
    }
    startsLine = false;
    previous = token;
    yield token;
  }
}

export function gradleTasks(source: string, groovy: boolean): Set<string> {
  const tasks = new Set<string>();
  const recent: (Token | undefined)[] = Array(7).fill(undefined);
  for (const token of tokens(source, groovy)) {
    const previous = recent.at(-1);
    if (groovy && previous?.kind === "word" && previous.text === "task" && previous.startsLine &&
        !token.startsLine && token.kind === "word" && taskName.test(token.text)) {
      tasks.add(token.text);
    }
    if (token.kind === "symbol" && (token.text === ")" || token.text === ",")) {
      const [receiver, operator, container, dot, method, opening, name] = recent;
      const knownContainer = operator?.text !== "." || receiver?.text === "project" || receiver?.text === "rootProject";
      if (knownContainer && container?.kind === "word" && container.text === "tasks" && dot?.text === "." &&
          method?.kind === "word" && (method.text === "register" || method.text === "create") &&
          opening?.text === "(" && name?.kind === "literal") {
        tasks.add(name.text);
      }
    }
    recent.shift();
    recent.push(token);
  }
  return tasks;
}
