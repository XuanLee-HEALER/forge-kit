// @ts-expect-error Bun embeds the source as a string for the temporary launcher.
import cargoGuardSource from "./cargo-project.ts" with { type: "text" };
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { checkoutEnvironment, runProcess } from "./git";
import { delegatedGoEnvironment } from "./shared/go";
import { tscProjectPreload } from "./shared/tsc";

// Pytest's call-phase report distinguishes test execution from collection and setup-only modes,
// even when project addopts suppress the terminal summary.
const pytestObserver = `import os
from pathlib import Path

directory = Path(__file__).parent
(directory / "loaded").touch()
observed = False

def pytest_runtest_call(item):
    root = os.path.realpath(os.environ["FORGE_VERIFY_CHECKOUT"])
    test_file = os.path.realpath(str(item.fspath))
    if os.path.commonpath([root, test_file]) != root:
        (directory / "outside").touch()

def pytest_runtest_logreport(report):
    global observed
    if report.when == "call" and not observed:
        (directory / "called").touch()
        observed = True
`;

export function cargoProjectInCheckout(bin: string, args: string[], dir: string): boolean {
  const check = cargoGuardSource + "\nconst v = JSON.parse(process.env.FORGE_VERIFY_CARGO_CHECK);\n" +
    "process.exit(cargoProjectInCheckout(v.bin, v.args, v.dir) ? 0 : 1);";
  return Bun.spawnSync([process.execPath, "-e", check], {
    cwd: dir, env: {...checkoutEnvironment(), FORGE_VERIFY_CARGO_CHECK: JSON.stringify({bin, args, dir})},
    stdout: "ignore", stderr: "ignore", timeout: 15_000,
  }).exitCode === 0;
}

type Options = NonNullable<Parameters<typeof runProcess>[1]> & { cwd: string; baseEnv?: NodeJS.ProcessEnv };

export function runVerificationProcess(argv: string[], dynamic: boolean, options: Options) {
  const bin = basename(argv[0]);
  const env: Record<string, string | undefined> = { ...checkoutEnvironment(options.baseEnv), ...delegatedGoEnvironment(bin, options.cwd), ...options.env };
  if (bin === "tsc") {
    const executable = Bun.which(argv[0], { PATH: env.PATH, cwd: options.cwd });
    if (!executable) throw Error("TypeScript compiler not found in verification environment");
    argv = [process.execPath, executable, ...argv.slice(1)];
  } else if (bin === "bun" && !argv.includes("--bun")) {
    // Package binaries can declare a Node shebang even in a Bun-only checkout.
    argv = [argv[0], "--bun", ...argv.slice(1)];
  }
  const observe = dynamic && ["pytest", "bun"].includes(bin);
  const delegated = ["bun", "make"].includes(bin);
  const cargo = delegated ? Bun.which("cargo", {PATH: env.PATH, cwd: options.cwd}) : null;
  if (!observe && !delegated) return { ...runProcess(argv, {...options, env}), noPytestCalls: false };

  const dir = mkdtempSync(join(tmpdir(), "forge-verify-"));
  try {
    env.FORGE_VERIFY_CHECKOUT = options.cwd;
    if (observe) {
      const plugin = "_forge_verify_pytest";
      writeFileSync(join(dir, plugin + ".py"), pytestObserver);
      env.PYTHONPATH = [dir, env.PYTHONPATH].filter(Boolean).join(delimiter);
      env.PYTEST_PLUGINS = [env.PYTEST_PLUGINS, plugin].filter(Boolean).join(",");
    }
    if (delegated) {
      // BUN_OPTIONS is inherited by package-script children. A data URL also
      // works when the system temporary path contains spaces.
      const preload = "data:text/javascript;base64," + Buffer.from(tscProjectPreload).toString("base64");
      env.BUN_OPTIONS = [env.BUN_OPTIONS, "--preload=" + preload].filter(Boolean).join(" ");
    }
    if (cargo) {
      const shim = join(dir, "cargo");
      env.FORGE_VERIFY_CARGO_BINARY = env.FORGE_VERIFY_CARGO_BINARY || cargo;
      env.FORGE_VERIFY_BUN = process.execPath;
      env.FORGE_VERIFY_CARGO_MODULE = join(dir, "cargo-project.ts");
      writeFileSync(env.FORGE_VERIFY_CARGO_MODULE, cargoGuardSource + "\nrunCargoLauncher();\n");
      writeFileSync(shim, '#!/bin/sh\nexec "$FORGE_VERIFY_BUN" "$FORGE_VERIFY_CARGO_MODULE" "$@"\n', {mode: 0o755});
      env.PATH = [dir, env.PATH].filter(Boolean).join(delimiter);
      env.CARGO = shim;
    }
    const result = runProcess(argv, { ...options, env });
    if (existsSync(join(dir, "outside"))) return {...result, code: 1, stderr: result.stderr + "\nPytest executed a test outside the verified checkout", noPytestCalls: false};
    const observedPytest = bin === "pytest" || existsSync(join(dir, "loaded"));
    return { ...result, noPytestCalls: result.code === 0 && observedPytest && !existsSync(join(dir, "called")) };
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}
