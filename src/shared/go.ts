import { checkoutEnvironment, runProcess } from "../git";

function effectiveFlags(bin: string, cwd: string): string | null {
  if (process.env.GOFLAGS) return process.env.GOFLAGS;
  const result = runProcess([bin, "env", "GOFLAGS"], { cwd, env: checkoutEnvironment() });
  return result.code === 0 ? result.stdout.trim() : null;
}

// Go permits quotes at the beginning of a field and takes their contents literally.
function parseGoFlags(value: string): string[] | null {
  const fields: string[] = [];
  const field = /[ \t\r\n]+|"([^"]*)"|'([^']*)'|([^ \t\r\n'"][^ \t\r\n]*)/gy;
  while (field.lastIndex < value.length) {
    const match = field.exec(value);
    if (!match) return null;
    const word = match[1] ?? match[2] ?? match[3];
    if (word !== undefined) fields.push(word);
  }
  return fields;
}

function preventsExecution(flags: string[], subcommand: string): boolean {
  const active = new Set<string>();
  let testBinaryArgs = false;
  for (const flag of flags) {
    if (flag === "-args" || flag === "--args" || flag === "--") {
      testBinaryArgs = true;
      continue;
    }
    if (/^--?(?:h|help)(?:=|$)/.test(flag)) return true;
    if (testBinaryArgs && !/^--?test\./.test(flag)) continue;
    const [raw, ...rest] = flag.split("=");
    const name = raw.replace(/^--?test\./, "-").replace(/^--/, "-");
    const value = rest.join("=");
    if (name === "-n" || (subcommand === "test" && name === "-c")) {
      if (["false", "False", "FALSE", "f", "F", "0"].includes(value)) active.delete(name);
      else active.add(name);
    } else if (["-list", "-exec", "-toolexec", "-help"].includes(name)) {
      if (rest.length && !value && name !== "-help") active.delete(name);
      else active.add(name);
    }
  }
  return active.size > 0;
}

export function hasNonExecutingGoFlags(bin: string, cwd: string, args: string[]): boolean {
  const effective = effectiveFlags(bin, cwd);
  const flags = effective === null ? null : parseGoFlags(effective);
  return !flags || preventsExecution([...flags, ...args.slice(1)], args[0]);
}

export function delegatedGoEnvironment(bin: string, cwd: string): Record<string, string> {
  if (!["bun", "make"].includes(bin)) return {};
  const effective = effectiveFlags("go", cwd);
  // A nonempty whitespace value means zero flags and overrides saved Go settings.
  const flags = effective === null ? null : parseGoFlags(effective);
  return { GOFLAGS: effective && flags && !preventsExecution(flags, "test") ? effective : " " };
}
