import { isPytestInfoSwitch } from "./lang-check";
import { hasNonExecutingGoFlags } from "./shared/go";
import { hasNonExecutingTscFlags, tscTargets } from "./shared/tsc";
import { lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parsePkgManagerInvocation } from "./shared/pkg-manager";
import { testInputsInCheckout } from "./shared/test-inputs";
import { extractMakeDirs, hasBuildTarget, hasMakeNonExecArgs } from "./shared/make";
import { runGit } from "./git";
import { cargoProjectInCheckout } from "./verification-process";

export type VerificationKind = "lint" | "test" | "build" | "hurl";
const hurlSwitches = new Set(
  "--digest -0 --http2-prior-knowledge --negotiate --no-cookie-store --ntlm --fail-with-body -i --include --json --no-pretty --pretty --progress-bar --no-jsonpath-coercion --parallel --test --verbose -v --very-verbose --color --no-color -k --insecure -L --location --location-trusted --continue-on-error --compressed --no-output --path-as-is --ipv4 -4 --ipv6 -6 --http1.0 --http1.1 --http2 --http3 --netrc -n --netrc-optional --ssl-no-revoke --interactive".split(
    " ",
  ),
);
const hurlValues = new Set(
  "--aws-sigv4 -E --limit-rate --max-filesize -m --no-header --no-proxy --pinnedpubkey -x --proxy-header --tls-max --tls-min --unix-socket --error-format --verbosity --secret --secrets-file -b -c --variable --variables-file --output -o --report-json --repeat --from-entry --to-entry --report-html --report-junit --report-tap --file-root --header -H --user -u --connect-timeout --max-time --retry --retry-interval --delay --jobs --max-redirs --proxy --cacert --cert --key --cookie --cookie-jar --resolve --netrc-file --user-agent -A --connect-to --timeout".split(
    " ",
  ),
);

const infoFlags = new Set(
  (
    "--version --help --dry-run --dry --showconfig --show-config --print-config --listtests --list-tests --collect-only --collectonly --co --listfilesonly " +
    "--init --fixtures --fixtures-per-test --markers --funcargs --setuponly --setupplan --setup-only --setup-plan --show-files --show-settings --inspect-config --env-info " +
    "--list --pass-with-no-tests --passwithnotests --usage --versions --clearcache --mergereports --nocheck --clean --completion --completions " +
    "--cwd --prefix --directory --if-present"
  ).split(" "),
);

function trackedLinkPath(dir: string, head: string, input: string, canonical: string): boolean {
  const seen = new Set<string>();
  while (input !== canonical) {
    const rel = relative(dir, input);
    if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel) || seen.has(input)) return false;
    seen.add(input);
    let prefix = dir;
    const parts = rel.split(sep);
    let next: string | undefined;
    for (const [index, part] of parts.entries()) {
      prefix = join(prefix, part);
      if (!lstatSync(prefix).isSymbolicLink()) continue;
      const entry = runGit(dir, ["ls-tree", "-z", head, "--", ":(literal)" + relative(dir, prefix)]);
      if (entry.code || !entry.stdout.startsWith("120000 blob ")) return false;
      next = resolve(dirname(prefix), readlinkSync(prefix), ...parts.slice(index + 1));
      break;
    }
    if (!next) return false;
    input = next;
  }
  return true;
}

function hurlInputs(args: string[], dir: string, head: string) {
  let options = true,
    files = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (options && a === "--") {
      options = false;
      continue;
    }
    if (options && a.startsWith("-")) {
      if (hurlSwitches.has(a)) continue;
      if (!a.startsWith("--") && a.length > 2 && hurlValues.has(a.slice(0,2))) continue;
      const eq = a.indexOf("=");
      const flag = eq < 0 ? a : a.slice(0,eq);
      if (!hurlValues.has(flag)) return false;
      const value = eq < 0 ? args[++i] : a.slice(eq+1);
      if (!value || (["--repeat","--from-entry","--to-entry"].includes(flag) && !/^[1-9]\d*$/.test(value))) return false;
      continue;
    }
    if (!a.endsWith(".hurl")) return false;
    const input = resolve(dir, a),
      path = realpathSync.native(isAbsolute(a) ? a : dir + "/" + a),
      rel = relative(dir, path);
    const inputRel = relative(dir, input);
    if (inputRel.startsWith("../") || isAbsolute(inputRel)) return false;
    if (!trackedLinkPath(dir, head, input, path)) return false;
    if (isAbsolute(rel) || rel.startsWith("../") || !statSync(path).isFile()) return false;
    const entry = runGit(dir, ["ls-tree", "-z", head, "--", ":(literal)" + rel]);
    if (entry.code || !/^100(?:644|755) blob /.test(entry.stdout)) return false;
    files++;
  }
  return files > 0;
}

export function isVerificationCommand(kind: VerificationKind, argv: string[], dir: string, head: string, env = process.env) {
  const bin = basename(argv[0]),
    args = argv.slice(1),
    [cmd] = args;
  if (bin === "tsc") {
    if ((kind !== "lint" && kind !== "build") || hasNonExecutingTscFlags(args)) return false;
    const targets = tscTargets(args);
    if (!targets) return false;
    const inputs = targets.projectPath ? [targets.projectPath] : [...targets.buildProjects, ...targets.sourceFiles];
    if (!inputs.length) inputs.push("tsconfig.json");
    return inputs.every(input => {
      const path = realpathSync.native(isAbsolute(input) ? input : dir + sep + input);
      const config = statSync(path).isDirectory() ? realpathSync.native(join(path, "tsconfig.json")) : path;
      return config.startsWith(dir + sep) && statSync(config).isFile();
    });
  }
  if (bin === "make") {
    if (kind !== "build" || hasMakeNonExecArgs(args)) return false;
    const target = extractMakeDirs(args, dir, (cwd, next) =>
      realpathSync.native(isAbsolute(next) ? next : cwd + sep + next),
    );
    if (!target || (target !== dir && !target.startsWith(dir + sep))) return false;
    if (!hasBuildTarget(args, target)) return false;
    const flags = [process.env.MAKEFLAGS, process.env.GNUMAKEFLAGS];
    for (const arg of args) {
      const m = /^(?:GNU)?MAKEFLAGS\s*(?:::=|:=|\+=|\?=|=)(.*)$/.exec(arg);
      if (m) flags.push(m[1]);
    }
    return !flags.some((f) => f && hasMakeNonExecArgs(f.split(/\s+/), true));
  }
  const pm = parsePkgManagerInvocation(argv);
  if (args.some((a) => infoFlags.has(a.split("=")[0].toLowerCase()) || ["-h", "-V", "-C"].includes(a)))
    return false;
  if (kind === "test" && ["pytest","vitest","jest"].includes(bin) && !testInputsInCheckout(bin,args,dir)) return false;
  if (bin === "pytest" && args.some(isPytestInfoSwitch)) return false;
  if (kind === "hurl") return bin === "hurl" && hurlInputs(args, dir, head);
  if (bin === "lang-check") {
    const required = kind === "lint" ? "static" : kind === "test" ? "dynamic" : null;
    return required && (args.join(" ") === "--mode " + required || args.join(" ") === "--mode=" + required);
  }
  if (bin === "go")
    return (
      cmd === { lint: "vet", test: "test", build: "build" }[kind] &&
      !hasNonExecutingGoFlags(argv[0], dir, args, env)
    );
  if (bin === "cargo")
    return (kind === "lint" ? ["clippy", "check"].includes(cmd) : cmd === kind && !args.includes("--no-run")) &&
      cargoProjectInCheckout(argv[0], args, dir);
  if (bin === "bun") {
    if (!pm || pm.invalidDirFlag || pm.hasAmbiguousFilter) return false;
    let projectDir = dir;
    for (const offset of pm.dirOffsets) {
      projectDir = realpathSync.native(isAbsolute(offset) ? offset : dir + sep + offset);
      if (projectDir !== dir && !projectDir.startsWith(dir + sep)) return false;
    }
    if (pm.managerFlags.some(flag => /^-[^-]*[hvV?H]/.test(flag))) return false;
    if (bin === "bun" && !pm.bunScript && pm.subcmd === kind && (kind === "test" || kind === "build"))
      return kind === "build" || testInputsInCheckout("bun", pm.rest, projectDir);
    const name = pm.scriptName;
    if (!name) return false;
    const pattern =
      kind === "lint" ? /^(lint|check|typecheck)$/ : kind === "test" ? /^test/ : /^build/;
    if (!pattern.test(name)) return false;
    const script = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8")).scripts?.[name];
    return typeof script === "string" && !!script.trim();
  }
  if (
    ["jest", "eslint", "vite", "vitest"].includes(bin) && args.includes("-v")
  )
    return false;
  if (kind === "build") {
    if (bin === "vite") return cmd === "build";
    return false;
  }
  if (kind === "test")
    return (
      ["jest", "pytest", "vitest"].includes(bin) &&
      !args.includes("--list") &&
      cmd !== "list" &&
      !args.includes("--co")
    );
  if (bin === "ruff") return cmd === "check";
  if (bin === "biome") return ["check", "lint", "ci"].includes(cmd);
  if (bin === "golangci-lint") return cmd === "run";
  return ["eslint", "pyright", "mypy"].includes(bin);
}
