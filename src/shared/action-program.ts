import { basename } from "node:path";

// Other tools and option-dependent loaders declare their code and configuration
// in action.inputs. Only the interpreter's entry point is implicit.
export function interpreterScript(argv: string[]): string | undefined {
  const program = basename(argv[0]);
  let args = argv.slice(1);
  if (program === "bun") {
    if (args[0] === "--bun") args = args.slice(1);
    if (args[0] === "run") args = args.slice(1);
    const entry = args[0];
    return entry && !entry.startsWith("-") && (/\.[cm]?[jt]sx?$/.test(entry) || entry.includes("/")) ? entry : undefined;
  }
  if (["sh", "bash", "dash", "zsh"].includes(program)) {
    while (args[0] && /^-[euxv]+$/.test(args[0])) args = args.slice(1);
  } else if (/^python(?:\d+(?:\.\d+)?)?$/.test(program)) {
    while (args[0] && /^-[BIuEOsS]+$/.test(args[0])) args = args.slice(1);
  } else if (!["node", "ruby", "perl"].includes(program)) return undefined;
  if (args[0] === "--") args = args.slice(1);
  return args[0] && !args[0].startsWith("-") ? args[0] : undefined;
}
