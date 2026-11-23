import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { runProcess } from "./git";

export type CheckLanguage = "go" | "ts" | "python";
export type CheckMode = "static" | "dynamic" | "all";

export interface LangCheckItem {
  language: CheckLanguage;
  phase: "static" | "dynamic";
  name: string;
  command: string;
  status: "pass" | "fail" | "skipped";
  exit_code: number | null;
  duration_ms: number;
  output_excerpt?: string;
}

export interface LangCheckReport {
  target_dir: string;
  mode: CheckMode;
  detected_languages: CheckLanguage[];
  ok: boolean;
  executed: number;
  failed: number;
  checks: LangCheckItem[];
}

function whichBin(name: string, targetDir: string): string | null {
  const localCandidates = [
    join(targetDir, ".venv", "bin", name),
    join(targetDir, "venv", "bin", name),
    join(targetDir, "node_modules", ".bin", name),
  ];
  for (const c of localCandidates) {
    if (existsSync(c)) return c;
  }
  const res = runProcess(["which", name], { timeoutMs: 3000 });
  if (res.code === 0 && res.stdout.trim()) {
    return res.stdout.trim().split("\n")[0];
  }
  return null;
}

function hasFileMatching(dir: string, predicate: (name: string) => boolean, maxDepth = 2): boolean {
  if (!existsSync(dir)) return false;
  const skip = new Set([".git", "node_modules", ".venv", "venv", "dist", "build", "__pycache__"]);
  const walk = (cur: string, depth: number): boolean => {
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      if (e.isFile() && predicate(e.name)) return true;
      if (e.isDirectory() && depth < maxDepth) {
        if (walk(join(cur, e.name), depth + 1)) return true;
      }
    }
    return false;
  };
  return walk(dir, 0);
}

export function detectRepoLanguages(targetDir: string): CheckLanguage[] {
  const langs: CheckLanguage[] = [];
  if (existsSync(join(targetDir, "go.mod"))) {
    langs.push("go");
  }
  if (
    existsSync(join(targetDir, "tsconfig.json")) ||
    (existsSync(join(targetDir, "package.json")) &&
      hasFileMatching(targetDir, (n) =>
        /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|svelte)$/.test(n),
      ))
  ) {
    langs.push("ts");
  }
  if (
    existsSync(join(targetDir, "pyproject.toml")) ||
    existsSync(join(targetDir, "requirements.txt")) ||
    existsSync(join(targetDir, "setup.py")) ||
    hasFileMatching(targetDir, (n) => n.endsWith(".py"))
  ) {
    langs.push("python");
  }
  return langs;
}

function execCheck(
  language: CheckLanguage,
  phase: "static" | "dynamic",
  name: string,
  argv: string[],
  cwd: string,
  extraEnv?: Record<string, string>,
  timeoutMs = 120_000,
): LangCheckItem {
  const started = Date.now();
  const res = runProcess(argv, {
    cwd,
    env: extraEnv ? { ...process.env, ...extraEnv } : undefined,
    timeoutMs,
  });
  const duration_ms = Date.now() - started;
  const combined = `${res.stdout}${res.stderr}`.trim();
  return {
    language,
    phase,
    name,
    command: argv.join(" "),
    status: res.code === 0 ? "pass" : "fail",
    exit_code: res.code,
    duration_ms,
    output_excerpt: combined ? combined.slice(-600) : undefined,
  };
}

function runGoChecks(targetDir: string, mode: CheckMode): LangCheckItem[] {
  const items: LangCheckItem[] = [];
  const goBin = whichBin("go", targetDir);
  if (!goBin) {
    items.push({
      language: "go",
      phase: mode === "dynamic" ? "dynamic" : "static",
      name: "go-toolchain",
      command: "go",
      status: "skipped",
      exit_code: null,
      duration_ms: 0,
      output_excerpt: "go binary not found on PATH",
    });
    return items;
  }

  if (mode === "static" || mode === "all") {
    items.push(execCheck("go", "static", "go-vet", [goBin, "vet", "./..."], targetDir));
    const hasGolangciCfg = [
      ".golangci.yml",
      ".golangci.yaml",
      ".golangci.toml",
      ".golangci.json",
    ].some((f) => existsSync(join(targetDir, f)));
    const golangciBin = hasGolangciCfg ? whichBin("golangci-lint", targetDir) : null;
    if (golangciBin) {
      items.push(
        execCheck("go", "static", "golangci-lint", [golangciBin, "run", "./..."], targetDir),
      );
    }
  }

  if (mode === "dynamic" || mode === "all") {
    items.push(execCheck("go", "dynamic", "go-test-race", [goBin, "test", "-race", "./..."], targetDir));
  }
  return items;
}

function runTsChecks(targetDir: string, mode: CheckMode): LangCheckItem[] {
  const items: LangCheckItem[] = [];
  let pkg: { scripts?: Record<string, string> } | null = null;
  const pkgPath = join(targetDir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
    } catch {
      pkg = null;
    }
  }

  if (mode === "static" || mode === "all") {
    if (existsSync(join(targetDir, "tsconfig.json"))) {
      const localTsc = join(targetDir, "node_modules", ".bin", "tsc");
      const tscBin = existsSync(localTsc) ? localTsc : whichBin("tsc", targetDir);
      if (tscBin) {
        items.push(execCheck("ts", "static", "tsc-noEmit", [tscBin, "--noEmit"], targetDir));
      } else {
        items.push({
          language: "ts",
          phase: "static",
          name: "tsc-noEmit",
          command: "tsc --noEmit",
          status: "skipped",
          exit_code: null,
          duration_ms: 0,
          output_excerpt: "tsc binary not found",
        });
      }
    }

    const hasBiomeCfg = existsSync(join(targetDir, "biome.json")) || existsSync(join(targetDir, "biome.jsonc"));
    const biomeBin = hasBiomeCfg ? whichBin("biome", targetDir) : null;
    if (biomeBin) {
      items.push(execCheck("ts", "static", "biome-check", [biomeBin, "check", "."], targetDir));
    } else {
      const hasEslintCfg = [
        "eslint.config.js",
        "eslint.config.mjs",
        "eslint.config.ts",
        ".eslintrc",
        ".eslintrc.js",
        ".eslintrc.json",
      ].some((f) => existsSync(join(targetDir, f)));
      const localEslint = join(targetDir, "node_modules", ".bin", "eslint");
      if (hasEslintCfg && existsSync(localEslint)) {
        items.push(execCheck("ts", "static", "eslint", [localEslint, "."], targetDir));
      }
    }
  }

  if (mode === "dynamic" || mode === "all") {
    const strictNodeEnv = { NODE_OPTIONS: "--unhandled-rejections=throw" };
    const isBunProject =
      existsSync(join(targetDir, "bun.lock")) ||
      existsSync(join(targetDir, "bun.lockb")) ||
      existsSync(join(targetDir, "bunfig.toml"));
    const hasTestFiles = hasFileMatching(
      targetDir,
      (n) => /\.(test|spec)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(n),
      3,
    );
    const bunBin = whichBin("bun", targetDir);
    const npmBin = whichBin("npm", targetDir);
    const testScript = pkg?.scripts?.["test:unit"] ?? pkg?.scripts?.test ?? "";
    const hasRealTestScript =
      Boolean(testScript.trim()) && !testScript.includes("no test specified");

    if (isBunProject && bunBin && hasTestFiles) {
      items.push(
        execCheck("ts", "dynamic", "bun-test-strict", [bunBin, "test"], targetDir, strictNodeEnv),
      );
    } else if (hasRealTestScript && npmBin) {
      const scriptName = pkg?.scripts?.["test:unit"] ? "test:unit" : "test";
      items.push(
        execCheck(
          "ts",
          "dynamic",
          `npm-${scriptName}-strict`,
          [npmBin, "run", scriptName],
          targetDir,
          strictNodeEnv,
        ),
      );
    }
  }

  return items;
}

function runPythonChecks(targetDir: string, mode: CheckMode): LangCheckItem[] {
  const items: LangCheckItem[] = [];
  const pyBin = whichBin("python3", targetDir) ?? whichBin("python", targetDir);

  if (mode === "static" || mode === "all") {
    const ruffBin = whichBin("ruff", targetDir);
    if (ruffBin) {
      items.push(execCheck("python", "static", "ruff-check", [ruffBin, "check", "."], targetDir));
    }

    const pyproject = existsSync(join(targetDir, "pyproject.toml"))
      ? readFileSync(join(targetDir, "pyproject.toml"), "utf8")
      : "";
    const hasPyrightCfg =
      existsSync(join(targetDir, "pyrightconfig.json")) || pyproject.includes("[tool.pyright]");
    const pyrightBin = hasPyrightCfg ? whichBin("pyright", targetDir) : null;
    if (pyrightBin) {
      items.push(execCheck("python", "static", "pyright", [pyrightBin], targetDir));
    } else {
      const hasMypyCfg =
        existsSync(join(targetDir, "mypy.ini")) || pyproject.includes("[tool.mypy]");
      const mypyBin = hasMypyCfg ? whichBin("mypy", targetDir) : null;
      if (mypyBin) {
        items.push(execCheck("python", "static", "mypy", [mypyBin, "."], targetDir));
      }
    }

    if (pyBin) {
      items.push(
        execCheck(
          "python",
          "static",
          "python-compileall",
          [pyBin, "-m", "compileall", "-q", "-x", "(/\\.git/|/\\.venv/|/venv/|/node_modules/)", "."],
          targetDir,
        ),
      );
    }
  }

  if (mode === "dynamic" || mode === "all") {
    const pytestBin = whichBin("pytest", targetDir);
    const hasTests =
      existsSync(join(targetDir, "tests")) ||
      hasFileMatching(targetDir, (n) => n.startsWith("test_") && n.endsWith(".py"), 3);
    if (pytestBin && hasTests) {
      items.push(
        execCheck(
          "python",
          "dynamic",
          "pytest-devmode",
          [pytestBin, "-W", "error::RuntimeWarning", "-q"],
          targetDir,
          { PYTHONDEVMODE: "1" },
        ),
      );
    }
  }

  return items;
}

export function runLangChecks(opts: {
  targetDir: string;
  mode?: CheckMode;
  lang?: "auto" | CheckLanguage;
}): LangCheckReport {
  const mode: CheckMode = opts.mode ?? "all";
  const resolvedDir = existsSync(opts.targetDir)
    ? realpathSync(opts.targetDir)
    : resolve(opts.targetDir);
  if (!existsSync(resolvedDir)) {
    throw new Error(`Target directory does not exist: ${opts.targetDir}`);
  }

  const detected =
    opts.lang && opts.lang !== "auto"
      ? [opts.lang]
      : detectRepoLanguages(resolvedDir);

  const checks: LangCheckItem[] = [];
  for (const lang of detected) {
    if (lang === "go") checks.push(...runGoChecks(resolvedDir, mode));
    else if (lang === "ts") checks.push(...runTsChecks(resolvedDir, mode));
    else if (lang === "python") checks.push(...runPythonChecks(resolvedDir, mode));
  }

  const executed = checks.filter((c) => c.status !== "skipped").length;
  const failed = checks.filter((c) => c.status === "fail").length;
  return {
    target_dir: resolvedDir,
    mode,
    detected_languages: detected,
    ok: executed > 0 && failed === 0,
    executed,
    failed,
    checks,
  };
}

export function runLangCheckCli(): void {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    console.log(
      `Usage: lang-check [target-dir] [--mode static|dynamic|all] [--lang auto|go|ts|python] [--json]
Runs language-specific static & dynamic checks (Go, TypeScript, Python).
Exit 0: >=1 check executed and all passed; 1: check failed; 2: no applicable checks executed (fail-closed).`,
    );
    return;
  }

  const { values, positionals } = parseArgs({
    args: rawArgs,
    allowPositionals: true,
    options: {
      mode: { type: "string", default: "all" },
      lang: { type: "string", default: "auto" },
      json: { type: "boolean", default: false },
    },
  });

  const mode = values.mode as CheckMode;
  if (mode !== "static" && mode !== "dynamic" && mode !== "all") {
    console.error(`Invalid --mode: ${values.mode} (expected static|dynamic|all)`);
    process.exit(2);
  }
  const lang = values.lang as "auto" | CheckLanguage;
  if (lang !== "auto" && lang !== "go" && lang !== "ts" && lang !== "python") {
    console.error(`Invalid --lang: ${values.lang} (expected auto|go|ts|python)`);
    process.exit(2);
  }

  const targetDir = positionals[0] ? resolve(process.cwd(), positionals[0]) : process.cwd();
  const report = runLangChecks({ targetDir, mode, lang });
  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `lang-check (${report.mode}) [${report.detected_languages.join(",") || "none"}] -> executed=${report.executed}, failed=${report.failed}, ok=${report.ok}`,
    );
    for (const c of report.checks) {
      console.log(
        `  [${c.status.toUpperCase()}] (${c.language}/${c.phase}) ${c.name}: ${c.command} (${c.duration_ms}ms)`,
      );
      if (c.status === "fail" && c.output_excerpt) {
        console.log(`    ${c.output_excerpt.replace(/\n/g, "\n    ")}`);
      }
    }
  }

  if (report.failed > 0) process.exit(1);
  if (report.executed === 0) process.exit(2);
}
