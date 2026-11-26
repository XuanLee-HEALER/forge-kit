/** Parse Bun dispatch and scope options before accepting verification evidence. */
export function parsePkgManagerInvocation(cmdToks: string[]) {
  if (cmdToks[0]?.split("/").pop() !== "bun") return null;
  const dirOffsets: string[] = [];
  const managerFlags: string[] = [];
  let invalidDirFlag = false;
  let hasAmbiguousFilter = false;
  let separateBunCwd = false;
  function consumeManagerFlag(tokens: string[], pos: number): number {
    const flag = tokens[pos];
    if (flag === "--cwd" || flag.startsWith("--cwd=")) {
      const separate = flag === "--cwd";
      separateBunCwd ||= separate;
      const path = separate ? tokens[pos + 1] : flag.slice(6);
      if (path) dirOffsets.push(path);
      else invalidDirFlag = true;
      return pos + (separate ? 2 : 1);
    }
    if (/^(?:--filter(?:=|$)|-F|--workspaces(?:=|$))/.test(flag)) hasAmbiguousFilter = true;
    managerFlags.push(flag);
    return pos + (flag === "--filter" || flag === "-F" ? 2 : 1);
  }
  let i = 1;
  while (i < cmdToks.length && cmdToks[i].startsWith("-")) {
    if (cmdToks[i] === "--") { i++; break; }
    i = consumeManagerFlag(cmdToks, i);
  }
  const subcmd = cmdToks[i] ?? "";
  let rest = cmdToks.slice(i + 1);
  let scriptName = subcmd;

  // Only switches before the script name configure Bun itself.
  if (subcmd === "run") {
    let r = 0;
    while (r < rest.length) {
      const tok = rest[r];
      if (tok === "--") {
        r++;
        break;
      }
      if (!tok.startsWith("-") || tok === "-") break;
      const nextPos = consumeManagerFlag(rest, r);
      if (nextPos === null || invalidDirFlag) break;
      r = nextPos;
    }
    scriptName = rest[r] ?? "";
    rest = rest.slice(r + 1);
  }

  const bunScript = (subcmd === "test" || subcmd === "build") && separateBunCwd;
  // Bun 1.4.4 dispatches --cwd DIR to a script, but --cwd=DIR to the built-in.
  if (!bunScript && (subcmd === "test" || subcmd === "build")) {
    const bunValFlags = subcmd === "build"
      ? BUN_BUILD_VALUE_FLAGS
      : new Set(["-t", "--test-name-pattern", "--timeout", "--preload", "-r"]);
    for (let j = 0; j < rest.length; j++) {
      const tok = rest[j];
      if (tok === "--") break;
      if (tok === "--cwd") {
        const val = rest[++j];
        if (!val) {
          invalidDirFlag = true;
          break;
        }
        dirOffsets.push(val);
        continue;
      }
      if (tok.startsWith("--cwd=")) {
        const val = tok.slice("--cwd=".length);
        if (!val) {
          invalidDirFlag = true;
          break;
        }
        dirOffsets.push(val);
        continue;
      }
      if (!tok.includes("=") && bunValFlags.has(tok)) {
        j++;
      }
    }
  }

  return { dirOffsets, managerFlags, invalidDirFlag, hasAmbiguousFilter, subcmd, rest, bunScript, scriptName };
}

export const BUN_BUILD_VALUE_FLAGS = new Set([
  "--cwd", "--outdir", "--outfile", "--target", "--format", "--root", "--public-path",
  "-e", "--external", "-d", "--define", "-l", "--loader", "--entry-naming", "--chunk-naming",
  "--asset-naming", "--banner", "--footer", "--conditions", "--env", "--tsconfig-override",
  "--jsx-factory", "--jsx-fragment", "--jsx-import-source", "--jsx-runtime", "--packages",
  "--compile-exec-argv", "--compile-executable-path", "--compile-jit-policy", "--asset",
  "--bytecode-depth", "--bytecode-order", "--min-chunk-size", "--allow-unresolved",
  "--windows-icon", "--windows-title", "--windows-publisher", "--windows-version",
  "--windows-description", "--windows-copyright", "--main-fields", "--extension-order",
  "--drop", "--feature", "--env-file", "-c", "--config", "-r", "--preload", "--require", "--import",
]);
