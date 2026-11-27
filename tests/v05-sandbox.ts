import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { developerGit } from "./helpers/git-tool";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const kit = resolve(import.meta.dir, "..");
export const legacyRevision = "eb139c117be733173648abce723b6eaaf975f7bc";
export const bootstrap = join(kit, "bin", "forge");

export function sandbox(bundle?: string) {
  const root = mkdtempSync(join(tmpdir(), "forge-v05-"));
  const home = join(root, "home");
  const work = join(root, "instance");
  const bin = join(root, "bin");
  for (const dir of [home, bin, work]) mkdirSync(dir);
  symlinkSync(process.execPath, join(bin, "bun"));
  const probeLog = join(root, "unexpected-js-runtime");
  for (const command of ["node", "npm", "npx"]) {
    const path = join(bin, command);
    writeFileSync(path, '#!/bin/sh\nprintf "%s\\n" "$0" >> "$PROBE_LOG"\nexit 127\n');
    chmodSync(path, 0o755);
  }
  const env: Record<string, string> = {
    HOME: home, PATH: [bin, "/usr/bin", "/bin"].join(":"), TMPDIR: root,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "file", PROBE_LOG: probeLog,
    HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1",
    NO_PROXY: "127.0.0.1,localhost", BUN_CONFIG_NO_AUTO_INSTALL: "1",
  };
  if (developerGit) {
    const tools = join(root, "git-tools");
    mkdirSync(tools);
    symlinkSync(developerGit, join(tools, "git"));
    env.PATH = [bin, tools, "/usr/bin", "/bin"].join(":");
  }
  function fresh() {
    if (!bundle) return ok([bootstrap, "init", work], root);
    const release = join(root, "release");
    mkdirSync(join(release, "dist"), {recursive: true});
    for (const entry of ["kit.toml", "core", "templates"])
      cpSync(join(kit, entry), join(release, entry), {recursive: true});
    const cli = join(release, "dist/cli.js");
    copyFileSync(bundle, cli);
    return ok(["bun", cli, "init", work], root);
  }
  function run(args: string[], cwd = work) {
    const result = Bun.spawnSync(args, { cwd, env, timeout: 60_000 });
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
  }
  function ok(args: string[], cwd = work) {
    const result = run(args, cwd);
    if (result.code !== 0) throw new Error(`${args.join(" ")} exited ${result.code}\n${result.out}\n${result.err}`);
    return result.out;
  }
  function privateFile(name: string, contents: string) {
    const path = join(work, name);
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, contents, { mode: 0o600 });
    return path;
  }
  function hook(name: string, payload: Record<string, unknown>): {code: number; text: string}[] {
    const config = JSON.parse(readFileSync(join(work, ".codex/hooks.json"), "utf8"));
    const commands = config.hooks[name].flatMap((group: {hooks: {command: string}[]}) => group.hooks);
    if (!commands.length) throw new Error("Missing installed hook for " + name);
    return commands.map(({command}: {command: string}) => {
      const result = Bun.spawnSync(["/bin/sh", "-c", command], {
        cwd: work, env, stdin: Buffer.from(JSON.stringify({hook_event_name: name, cwd: work, ...payload})),
      });
      return { code: result.exitCode, text: result.stdout.toString() + result.stderr.toString() };
    });
  }
  const forge = join(work, ".workbench/bin/forge");
  return {
    root, home, work, bin, forge, env, run, ok, hook, privateFile, probeLog,
    cleanup: () => rmSync(root, { force: true, recursive: true }),
    fresh,
    git: (cwd: string, ...args: string[]) => ok(["git", "-C", cwd, ...args]),
    read: (name: string) => readFileSync(join(work, name), "utf8"),
  };
}
export type Sandbox = ReturnType<typeof sandbox>;
