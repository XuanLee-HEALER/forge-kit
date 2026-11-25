import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, sep } from "node:path";

const NODE_TEST_ALLOWED_VALUE_FLAGS = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "-C",
  "--conditions",
  "--env-file",
  "--env-file-if-exists",
  "--test-name-pattern",
  "--test-skip-pattern",
  "--test-reporter",
  "--test-reporter-destination",
  "--test-shard",
  "--test-timeout",
  "--test-concurrency",
  "--max-old-space-size",
  "--redirect-warnings",
  "--title",
]);

const NODE_TEST_ALLOWED_BOOL_FLAGS = new Set([
  "--test",
  "--test-force-exit",
  "--experimental-test-coverage",
  "--experimental-strip-types",
  "--experimental-transform-types",
  "--experimental-vm-modules",
  "--no-warnings",
  "--enable-source-maps",
  "--trace-uncaught",
  "--trace-warnings",
]);

export function parseNodeTestInvocation(cmdToks: string[]): { files: string[] } | null {
  const bin0 = (cmdToks[0] ?? "").split("/").pop() ?? "";
  if (bin0 !== "node") return null;
  let sawTestFlag = false;
  let idx = 1;
  // Parse strictly allowlisted Node CLI options BEFORE the first positional entry point
  // (automatically rejects `--v8-options`, `-v`, `-h`, `-e`, `-p`, `-c`, `--watch`, `--test-only`, etc.)
  while (idx < cmdToks.length) {
    const t = cmdToks[idx];
    if (t === "--") {
      idx++;
      break;
    }
    if (!t.startsWith("-") || t === "-") {
      break;
    }
    const eq = t.indexOf("=");
    const name = eq >= 0 ? t.slice(0, eq) : t;
    if (name === "--test") {
      if (eq >= 0) return null;
      sawTestFlag = true;
      idx++;
      continue;
    }
    if (NODE_TEST_ALLOWED_BOOL_FLAGS.has(name) && eq < 0) {
      idx++;
      continue;
    }
    if (NODE_TEST_ALLOWED_VALUE_FLAGS.has(name)) {
      if (eq < 0) {
        if (idx + 1 >= cmdToks.length) return null;
        idx += 2;
      } else {
        idx++;
      }
      continue;
    }
    return null;
  }
  if (!sawTestFlag) return null;
  const files = cmdToks.slice(idx).filter((a) => a && a !== "--" && !a.startsWith("-"));
  return { files };
}

const valueFlags: Record<string, Set<string>> = {
  pytest: new Set("-k -m -c -o -W -p -n --maxfail --tb --capture --junitxml --basetemp --confcutdir --ignore --ignore-glob --deselect --durations --rootdir".split(" ")),
  bun: new Set("-t --test-name-pattern --timeout --preload -r --retry --rerun-each --reporter --reporter-outfile".split(" ")),
  vitest: new Set("-t --testNamePattern --config -c --root -r --dir --reporter --environment --pool --project --testTimeout".split(" ")),
  jest: new Set("-t --testNamePattern --config -c --rootDir --testEnvironment --env --maxWorkers -w --reporters --testTimeout --testPathPattern".split(" ")),
};

export function testInputsInCheckout(bin: string, args: string[], dir: string): boolean {
  function inside(input: string): boolean {
    const target = isAbsolute(input) ? input : dir + sep + input;
    const actual = realpathSync.native(target);
    return actual === dir || actual.startsWith(dir + sep);
  }
  if (bin === "node") {
    const invocation = parseNodeTestInvocation(["node", ...args]);
    return !!invocation && invocation.files.every(inside);
  }
  let positionalOnly = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!positionalOnly && arg === "--") { positionalOnly = true; continue; }
    if (!positionalOnly && arg.startsWith("-")) {
      const [name, ...attached] = arg.split("=");
      if (valueFlags[bin].has(name)) {
        const value = attached.length ? attached.join("=") : args[++i];
        if (!value) return false;
        if (["--rootdir","--rootDir","--root","--dir"].includes(name) && !inside(value)) return false;
      }
      continue;
    }
    if (bin === "vitest" && i === 0 && arg === "run") continue;
    const input = bin === "pytest" ? arg.split("::")[0] : arg;
    // Bun, Jest and Vitest also accept plain name filters.
    if (bin !== "pytest" && !input.includes("/") && !input.startsWith(".") &&
        !/\.[cm]?[jt]sx?$/.test(input) && !existsSync(dir + sep + input)) continue;
    if (!input || !inside(input)) return false;
  }
  return true;
}
