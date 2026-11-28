import { expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { releaseCLI } from "./historical-kit";
import { sandbox, type Sandbox } from "../v05-sandbox";

export const primitives = ["status", "changes", "logs", "query", "metrics"] as const;
export const guarantees = ["ro-credential", "ro-rbac", "ro-endpoint", "fixed-ro-subcommand"] as const;
export const limits = { timeout_ms: 15_000, max_bytes: 32_768, max_lines: 200 };
export const caps = { timeout_ms: 60_000, max_bytes: 131_072, max_lines: 1_000 };

export function runtimeFixture(s: Sandbox) {
  const configPath = ".workbench/workbench.yaml";
  const stub = s.privateFile("stub.ts", [
    'import { appendFileSync } from "node:fs";',
    'const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("FORGE_RT_")));',
    'appendFileSync(process.env.FORGE_TEST_RT_CALLS!, JSON.stringify({ env, argv: process.argv.slice(2), pid: process.pid }) + "\\n");',
    'const scenario = JSON.parse(await Bun.file(process.env.FORGE_TEST_RT_SCENARIO!).text());',
    'const action = scenario[env.FORGE_RT_PRIMITIVE!] ?? scenario.default ?? {};',
    'if (action.nested) {',
    '  const child = Bun.spawn([process.env.FORGE_TEST_RT_CLI!, "rt", "status", "--env", "fixture", "--json"], { stdout: "pipe", stderr: "pipe" });',
    '  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);',
    '  console.log(out.trim()); console.error(err.trim()); process.exit(code);',
    '}',
    'if (action.json !== undefined) console.log(JSON.stringify(action.json));',
    'if (action.out) process.stdout.write(action.out);',
    'if (action.err) process.stderr.write(action.err);',
    'if (action.flood) for (let i = 0; i < 512; i++) process.stdout.write("safe flood ".repeat(512));',
    'if (action.delay) await Bun.sleep(action.delay);',
    'if (action.late) appendFileSync(process.env.FORGE_TEST_RT_CALLS!, "late completion\\n");',
    'process.exit(action.exit ?? 0);',
  ].join("\n"));
  const protocolLog = join(s.root, "calls.jsonl");
  s.env.FORGE_TEST_RT_CALLS = protocolLog;
  s.env.FORGE_TEST_RT_CLI = s.forge;
  const scenarioPath = "stub-scenario.json";
  s.env.FORGE_TEST_RT_SCENARIO = s.privateFile(scenarioPath, "{}");
  const defaultAction = { purpose: "observe", argv: ["bun", stub, "fixed", "arg with space"], cwd: "." };
  const bound = { action: "observe-fixture", read_only_guarantee: "ro-credential" };
  const runtime = Object.fromEntries(primitives.map(key => [key, { ...bound }]));
  function configure(bindings: Record<string, unknown>, action: object = defaultAction) {
    const original = parse(s.read(configPath));
    s.privateFile(configPath, stringify({
      ...original,
      extensions: {
        ...original.extensions,
        actions: { ...original.extensions?.actions, "observe-fixture": action },
        runtime: bindings,
      },
    }));
  }
  function scenario(actions: object) {
    s.privateFile(scenarioPath, JSON.stringify(actions));
  }
  function calls(): {env: Record<string, string>; argv: string[]; pid: number}[] {
    if (!existsSync(protocolLog)) return [];
    return readFileSync(protocolLog, "utf8")
      .split("\n").filter(Boolean).map(line => JSON.parse(line));
  }
  function raw(...args: string[]) {
    const res = Bun.spawnSync([s.forge, "rt", ...args], { cwd: s.work, env: s.env, timeout: 5_000 });
    return { code: res.exitCode, out: res.stdout.toString(), err: res.stderr.toString() };
  }
  function call(...args: string[]) {
    const result = raw(...args, "--json");
    let json;
    try {
      json = JSON.parse(result.out);
    } catch {
      throw Error(`rt ${args[0]} exited ${result.code} without a JSON response: ${result.out}\n${result.err}`);
    }
    return { ...result, json };
  }
  function success(...args: string[]) {
    const result = call(...args);
    expect(result.code, result.out + result.err).toBe(0);
    expect(result.json.ok).toBe(true);
    return result.json;
  }
  function rejected(...args: string[]) {
    const result = call(...args);
    expect(result.code, result.out + result.err).not.toBe(0);
    expect(result.json.ok).toBe(false);
    return result;
  }
  return { s, defaultAction, bound, runtime, configure, scenario, calls, protocolLog, raw, call, success, rejected };
}

export type RtFixture = ReturnType<typeof runtimeFixture>;
export function withRuntime(run: (f: RtFixture) => void | Promise<void>) {
  return async () => {
    const s = sandbox();
    try {
      s.ok([releaseCLI(s), "init", s.work]);
      await run(runtimeFixture(s));
    } finally {
      s.cleanup();
      expect(existsSync(s.root)).toBe(false);
    }
  };
}
