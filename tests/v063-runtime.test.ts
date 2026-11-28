import { expect, test } from "bun:test";
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { caps, guarantees, limits, primitives, withRuntime } from "./helpers/rt-cli";

test("D01 runtime discovery is complete, bounded and does not dispatch", withRuntime(f => {
  const check = (bindings: Record<string, unknown>, expected: unknown[]) => {
    f.configure(bindings);
    const rows = f.success("list").data;
    expect(rows.map((row: {primitive: string}) => row.primitive)).toEqual([...primitives]);
    expect(rows).toMatchObject(expected);
    expect(f.s.run([f.s.forge, "doctor", f.s.work, "--json"]).code).toBe(0);
    expect(f.calls()).toHaveLength(0);
  };
  const unconfigured = { status: "unconfigured", action: null, read_only_guarantee: null, ...limits };
  const local = { read_only_guarantee: "fixed-ro-subcommand", action: null, ...limits };
  check({}, [unconfigured, local, unconfigured, unconfigured, unconfigured]);
  check({ status: f.bound }, [{ ...f.bound, ...limits }, local, unconfigured, unconfigured, unconfigured]);
  const configured = primitives.map((key, i) => [key, {
    ...f.bound, read_only_guarantee: guarantees[i % guarantees.length], ...(key === "status" ? caps : {}),
  }] as const);
  check(Object.fromEntries(configured), configured.map(([, binding]) => ({ ...limits, ...binding })));
  const human = f.raw("list");
  expect(human.code).toBe(0);
  for (const name of [...primitives, ...guarantees]) expect(human.out).toContain(name);
}));

test("D02 absent and explicit unverified guarantees warn and permit a run, verified removes the warning", withRuntime(f => {
  for (const guarantee of [undefined, "unverified", "ro-rbac"]) {
    f.configure({ status: { action: f.bound.action, read_only_guarantee: guarantee } });
    const list = f.success("list");
    const doctor = f.s.run([f.s.forge, "doctor", f.s.work, "--json"]);
    expect(doctor.code, doctor.out + doctor.err).toBe(0);
    expect(list.data[0].read_only_guarantee).toBe(guarantee ?? "unverified");
    const writeRisk = /(?:unverified|write[- ]risk|未验证|写入风险)/i;
    if (guarantee === "ro-rbac") {
      expect(JSON.stringify(list.warnings)).not.toMatch(writeRisk);
      expect(doctor.out + doctor.err).not.toMatch(writeRisk);
    } else {
      for (const warnings of [JSON.stringify(list.warnings), doctor.out + doctor.err]) {
        expect(warnings).toMatch(writeRisk);
        expect(warnings).toContain("status");
      }
    }
    f.scenario({ default: { json: { healthy: true } } });
    expect(f.success("status", "--env", "fixture").data).toEqual({healthy: true});
  }
  expect(f.calls()).toHaveLength(3);
}));

test("D03 invalid runtime policy and recursive dispatch are rejected with actionable diagnostics", withRuntime(f => {
  const rules: [Record<string, unknown>, object, RegExp][] = [
    [{ typo: f.bound }, f.defaultAction, /extensions\.runtime/],
    [{ status: { ...f.bound, typo: true } }, f.defaultAction, /extensions\.runtime\.status/],
    [{ status: { ...f.bound, read_only_guarantee: "maybe" } }, f.defaultAction, /guarantee/],
    [{ status: { ...f.bound, action: "missing-action" } }, f.defaultAction, /extensions\.runtime\.status.*action/],
    ...[undefined, "verify", "deliver"].map(purpose => [
      { status: f.bound }, { ...f.defaultAction, purpose }, /observe|purpose/i,
    ] as [Record<string, unknown>, object, RegExp]),
    ...Object.entries(caps).flatMap(([key, maximum]) => ["1", 0, -1, 1.5, maximum + 1].map(invalid => [
      { status: { ...f.bound, [key]: invalid } }, f.defaultAction, new RegExp(key),
    ] as [Record<string, unknown>, object, RegExp])),
    [{ status: f.bound }, { ...f.defaultAction, argv: [f.s.forge, "rt", "list"] }, /recurs|嵌套|递归/i],
  ];
  for (const [bindings, action, diagnostic] of rules) {
    f.configure(bindings, action);
    const doctor = f.s.run([f.s.forge, "doctor", f.s.work, "--json"]);
    expect(doctor.code, doctor.out + doctor.err).not.toBe(0);
    expect(doctor.out + doctor.err).toMatch(diagnostic);
    const {out, err} = f.rejected("status", "--env", "fixture");
    expect(out + err).toMatch(diagnostic);
  }
  f.configure({});
  for (const [primitive, ...args] of [
    ["status"], ["logs"], ["query", "--target", "db", "--expr", "select value"], ["metrics", "--metric", "latency"],
  ]) {
    const { json, out, err } = f.rejected(primitive, "--env", "fixture", ...args);
    expect(json.primitive).toBe(primitive);
    expect(out + err).toContain("extensions.runtime." + primitive);
  }
  expect(f.calls()).toHaveLength(0);

  f.configure({ status: f.bound });
  f.scenario({ default: { nested: true } });
  const nested = f.rejected("status", "--env", "fixture");
  expect(nested.out + nested.err).toMatch(/recurs|嵌套|递归/i);
  expect(f.calls()).toHaveLength(1);
  f.scenario({ default: { json: { healthy: true } } });
  expect(f.success("status", "--env", "fixture").data).toEqual({ healthy: true });
  expect(f.calls()).toHaveLength(2);
}), 15_000);

test("P01 remote adapters receive the CLI fields and return structured evidence", withRuntime(f => {
  f.configure({ ...f.runtime, metrics: { ...f.bound, ...caps } });
  const status = { healthy: true, git_sha: "a".repeat(40), image: "fixture:current" };
  const metrics = { points: [[1, 32], [2, 64]] };
  const logs = { records: [{ level: "warn", message: "fixture record" }] };
  const query = { rows: ["first row"] };
  f.scenario({ status: { json: status }, logs: { json: logs }, metrics: { json: metrics }, query: { json: query } });
  const base = ["--env", "fixture"];
  const observed = [
    ["status", [], status, {}],
    ["status", ["--service", "worker"], status, {SERVICE: "worker"}],
    ["logs", [], logs, {LIMIT: "100"}],
    ["logs", ["--service", "worker", "--level", "warn", "--trace", "a1-b2", "--grep", "narrow match", "--limit", "500"],
      logs, {SERVICE: "worker", LEVEL: "warn", TRACE: "a1-b2", GREP: "narrow match", LIMIT: "500"}],
    ["query", ["--target", "queue", "--expr", "HGETALL fixture"], query, { TARGET: "queue", EXPR: "HGETALL fixture", LIMIT: "100" }],
    ["query", ["--target", "queue", "--expr", "SCAN 0", "--param", "key=matching", "--limit", "500"],
      query, { TARGET: "queue", EXPR: "SCAN 0", LIMIT: "500" }],
    ["metrics", ["--metric", "p95"], metrics, { METRIC: "p95" }],
    ["metrics", ["--service", "worker", "--metric", "queue_depth"], metrics, { SERVICE: "worker", METRIC: "queue_depth" }],
  ] as const;
  for (const [primitive, args, data, fields] of observed) {
    const reply = f.success(primitive, ...base, ...args);
    expect(reply).toMatchObject({ primitive, env: "fixture", exit_code: 0, data });
    const { env, argv } = f.calls().at(-1)!;
    expect(argv).toEqual(["fixed", "arg with space"]);
    const bounds = primitive === "metrics" ? caps : limits;
    const all = { ENV: "fixture", PRIMITIVE: primitive, MAX_BYTES: String(bounds.max_bytes), TIMEOUT_MS: String(bounds.timeout_ms), ...fields };
    for (const [key, value] of Object.entries(all)) expect(env["FORGE_RT_" + key], key).toBe(value);
  }
  expect(JSON.parse(f.calls()[5].env.FORGE_RT_PARAMS_JSON)).toEqual({ key: "matching" });
  for (const [primitive, args] of [["logs", []], ["query", ["--target", "queue", "--expr", "SCAN 0"]]] as const) {
    const count = f.calls().length;
    for (const limit of ["0", "501", "1.5"]) expect(f.rejected(primitive, ...base, ...args, "--limit", limit).out).toMatch(/limit/i);
    expect(f.calls()).toHaveLength(count);
    expect(f.success(primitive, ...base, ...args, "--limit", "1").exit_code).toBe(0);
  }
}));

test("P02 middleware expressions and repeated parameters remain data in the adapter protocol", withRuntime(f => {
  f.configure({ query: f.bound });
  f.scenario({ query: {json: {rows: [1]}} });
  const marker = join(f.s.root, "expression-side-effect");
  const expr = ['LRANGE "queue with spaces" 0 -1;', "DROP ordinary data;", "$(touch " + marker + ")"].join("\n");
  const args = ["query", "--env", "fixture", "--target", "redis", "--expr", expr];
  expect(f.rejected(...args, "--param", "missing-separator").out).toMatch(/param/i);
  expect(f.calls()).toHaveLength(0);
  expect(f.success(...args, "--param", "key=a=b", "--param", "filter=hello world").data).toEqual({ rows: [1] });
  const [call] = f.calls();
  expect(call.argv).toEqual(["fixed", "arg with space"]);
  expect(call.env.FORGE_RT_EXPR).toBe(expr);
  expect(JSON.parse(call.env.FORGE_RT_PARAMS_JSON)).toEqual({ key: "a=b", filter: "hello world" });
  expect(existsSync(marker)).toBe(false);
}));

test("P03 logs and metrics normalize explicit and relative windows with strict validation", withRuntime(f => {
  f.configure({ logs: f.bound, metrics: f.bound });
  f.scenario({ default: {json: {observed: true}} });
  const from = 1780315200;
  const to = from + 3600;
  const now = () => Math.floor(Date.now() / 1000);
  for (const primitive of ["logs", "metrics"]) {
    const base = [primitive, "--env", "fixture", ...(primitive === "metrics" ? ["--metric", "cpu"] : [])];
    const range = (args: string[], expectedFrom: number | null, expectedTo: number | null, seconds?: number) => {
      const before = now();
      f.success(...base, ...args);
      const after = now();
      const {env} = f.calls().at(-1)!;
      const a = Number(env.FORGE_RT_FROM_UNIX);
      const b = Number(env.FORGE_RT_TO_UNIX);
      expect(env.FORGE_RT_FROM_ISO).toBe(new Date(a * 1000).toISOString());
      expect(env.FORGE_RT_TO_ISO).toBe(new Date(b * 1000).toISOString());
      if (expectedFrom !== null) expect(a).toBe(expectedFrom);
      if (expectedTo === null) {
        expect(b).toBeGreaterThanOrEqual(before);
        expect(b).toBeLessThanOrEqual(after);
      } else expect(b).toBe(expectedTo);
      if (seconds !== undefined) expect(b - a).toBe(seconds);
    };
    range(["--from", "2026-06-01T20:00:00+08:00", "--to", String(to)], from, to, 3600);
    range(["--to", String(to), "--minutes", "20"], to - 1200, to, 1200);
    range(["--to", String(to)], to - 900, to, 900);
    range(["--from", String(from)], from, null);
    range(["--from", String(from), "--minutes", "45"], from, from + 2700, 2700);
    range([], null, null, 900);
    range(["--minutes", "1440"], null, null, 86400);
    const called = f.calls().length;
    for (const args of [
      ["--from", "2026-06-01T12:00:00"], ["--from", "2026-02-30T12:00:00Z"],
      ["--from", "999999999999999"], ["--from", "1.5"], ["--from", "1e9"],
      ["--from", String(to), "--to", String(from)], ["--minutes", "1441"], ["--minutes", "0"], ["--minutes", "2.5"],
      ["--from", String(from), "--to", String(to), "--minutes", "60"],
    ]) expect(f.rejected(...base, ...args).json.error).toBeDefined();
    expect(f.calls()).toHaveLength(called);
    range(["--from", "2026-06-01T12:00:00Z", "--to", String(to)], from, to, 3600);
  }
}), 15_000);

const mail = "operator-marker@example.invalid";
const mobile = "+1 (415) 555-0146";
const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJydC1maXh0dXJlIn0.c2lnbmF0dXJlLXN5bnRoZXRpYw";
const credential = "rt_fixture_opaque_not_a_real_password";
const token = "ghp_f1xture000000000000000000000000000000";
const secrets = [mail, mobile, jwt, credential, token];
function privateOutput(text: string) {
  for (const secret of secrets) expect(text).not.toContain(secret);
}

test("O01 response envelope distinguishes launch, adapter, parameter and config failures", withRuntime(f => {
  f.configure({ status: f.bound });
  const args = ["status", "--env", "fixture", "--service", "worker"];
  f.scenario({ status: {out: "safe fixture text\n"} });
  const response = f.success(...args);
  expect(response).toMatchObject({
    primitive: "status", ok: true, env: "fixture", service: "worker", target: null,
    read_only_guarantee: "ro-credential", exit_code: 0, timed_out: false, truncated: false, data: null,
  });
  expect(response.warnings).toEqual([]);
  expect(response.output).toContain("safe fixture text");
  expect(response.duration_ms).toBeGreaterThanOrEqual(0);

  const script = f.s.privateFile("bad-interpreter", "#!/nonexistent/fixture-interpreter\n");
  chmodSync(script, 0o700);
  f.configure({ status: f.bound }, { ...f.defaultAction, argv: [script] });
  const launch = f.rejected(...args);
  f.configure({ status: f.bound });
  f.scenario({ status: {exit: 23, err: "fixture adapter diagnostic\n"} });
  const adapter = f.rejected(...args);
  expect(adapter.json.exit_code).toBe(23);
  expect(adapter.out + adapter.err).toContain("fixture adapter diagnostic");
  const parameter = f.rejected(...args, "--unknown");
  f.configure({ status: { ...f.bound, timeout_ms: 0 } });
  const config = f.rejected(...args);
  const classifiers = [launch, adapter, parameter, config].map(({json}) => json.error?.code ?? json.error?.kind ?? json.error);
  expect(classifiers).not.toContain(undefined);
  expect(classifiers.every(value => typeof value === "string")).toBe(true);
  expect(new Set(classifiers).size).toBe(4);
  expect(f.calls()).toHaveLength(2);

  f.configure({ status: f.bound });
  const data = { healthy: true, checks: [{ counts: [1, 2], note: null }] };
  f.scenario({ status: {json: data} });
  expect(f.success(...args)).toMatchObject({data, exit_code: 0, timed_out: false});
}));

test("O02 structured, textual, error and human runtime output redact synthetic secrets", withRuntime(f => {
  const binding = { action: f.bound.action };
  f.configure({ status: binding, query: binding });
  const args = ["query", "--env", mail, "--target", jwt, "--expr", "SCAN 0"];
  const data = { ordinary: "safe object field", records: [{ email: mail, secret: credential, value: 42 }, [true, token, mobile, jwt]] };
  f.scenario({ query: {json: data, err: "safe stderr password=" + credential + " token=" + token + "\n"} });
  const json = f.call(...args);
  expect(json.code, json.err).toBe(0);
  expect(json.json).toMatchObject({ ok: true, read_only_guarantee: "unverified", data: {
    ordinary: "safe object field", records: [{ value: 42 }, [true, expect.any(String), expect.any(String), expect.any(String)]],
  } });
  expect(json.out).toMatch(/(?:unverified|未验证)/i);
  expect(json.out + json.err).toContain("safe stderr");
  privateOutput(json.out + json.err);
  const human = f.raw(...args);
  expect(human.code, human.err).toBe(0);
  expect(human.out).toContain("safe object field");
  privateOutput(human.out + human.err);

  f.scenario({ status: {
    out: "safe text\npassword=" + credential + " jwt=" + jwt + " email=" + mail + " phone=" + mobile + "\n",
    err: "safe failure token=" + token + "\n", exit: 19,
  } });
  const failed = f.rejected("status", "--env", mail, "--service", token);
  expect(failed.json.exit_code).toBe(19);
  for (const mark of ["safe text", "safe failure"]) expect(failed.out + failed.err).toContain(mark);
  expect(failed.out).toMatch(/(?:unverified|未验证)/i);
  privateOutput(failed.out + failed.err);
  const humanFailure = f.raw("status", "--env", mail, "--service", token);
  expect(humanFailure.code).not.toBe(0);
  privateOutput(humanFailure.out + humanFailure.err);

  const script = f.s.privateFile(token, "#!/nonexistent/fixture-interpreter\n");
  chmodSync(script, 0o700);
  f.configure({ status: f.bound }, { ...f.defaultAction, argv: [script] });
  const launch = f.rejected("status", "--env", mail);
  privateOutput(launch.out + launch.err);

  f.configure({ status: f.bound });
  f.scenario({ default: { out: "safe recovered text" } });
  expect(f.success("status", "--env", "fixture").output).toContain("safe recovered text");
}));

test("O03 shared byte and line budgets preserve UTF-8 and omit unsafe partial output", withRuntime(f => {
  const args = ["status", "--env", "fixture"];
  const capture = (bounds: object, out: string, err = "", flood = false) => {
    f.configure({ status: { ...f.bound, ...bounds } });
    f.scenario({ status: { out, err, flood } });
    return f.success(...args);
  };
  const visible = (value: {output: unknown; warnings: unknown}) => JSON.stringify([value.output, value.warnings]);
  const atBytes = capture({max_bytes: 32}, "C".repeat(32));
  expect(atBytes.truncated).toBe(false);
  expect(atBytes.output).toContain("C".repeat(32));
  const atLines = capture({max_lines: 3}, "safe one\nsafe two\nsafe three\n");
  expect(atLines.truncated).toBe(false);
  expect(atLines.output).toContain("safe three");
  const overLines = capture({max_lines: 3}, "safe one\nsafe two\nsafe three\nexcess fourth\n");
  expect(overLines.truncated).toBe(true);
  expect(visible(overLines)).not.toContain("excess fourth");
  const sharedBytes = capture({max_bytes: 64}, "safe stdout\n" + "A".repeat(39), "safe stderr\n" + "B".repeat(39));
  expect(sharedBytes.truncated).toBe(true);
  expect(visible(sharedBytes)).toMatch(/safe stdout|safe stderr/);
  expect(visible(sharedBytes).match(/A/g)?.length ?? 0).toBeLessThanOrEqual(39);
  expect((visible(sharedBytes).match(/[AB]/g) ?? []).length).toBeLessThan(78);
  const sharedLines = capture({max_lines: 3}, "stdout one\nstdout two\n", "stderr one\nstderr two\n");
  expect(sharedLines.truncated).toBe(true);
  expect((visible(sharedLines).match(/(?:std(?:out|err) (?:one|two))/g) ?? []).length).toBeLessThan(4);
  const utf8 = capture({max_bytes: 12}, "safe\n🙂🙂🙂");
  expect(utf8.truncated).toBe(true);
  expect(visible(utf8)).toContain("safe");
  expect(visible(utf8)).not.toContain("\uFFFD");

  for (const [bytes, prefix] of [
    [55, '{"safe":"fixture","secret":"' + credential + '","more":"' + "A".repeat(60) + '"}'],
    [500, '{"safe":"fixture","password":"' + credential + '" BROKEN}'],
  ] as const) {
    const body = capture({max_bytes: bytes}, prefix);
    expect(body.data).toBeNull();
    expect(body.truncated).toBe(true);
    const human = f.raw(...args);
    for (const text of [JSON.stringify(body), human.out + human.err]) {
      privateOutput(text);
      expect(text).not.toContain(credential.slice(0, 16));
    }
  }
  const flood = capture({max_bytes: 256}, "safe initial boundary\n", "", true);
  expect(flood.truncated).toBe(true);
  expect(flood.output).toContain("safe initial boundary");
  expect(Buffer.byteLength(flood.output)).toBeLessThanOrEqual(256);
}), 15_000);

test("O04 timeout stops the spawned adapter and permits recovery", withRuntime(async f => {
  f.configure({ status: { ...f.bound, timeout_ms: 250 } });
  const args = ["status", "--env", "fixture"];
  f.scenario({ status: {out: "safe before timeout\npassword=" + credential + "\n", delay: 900, late: true} });
  const timedOut = f.rejected(...args);
  expect(timedOut.json.timed_out).toBe(true);
  expect(timedOut.json.output).toContain("safe before timeout");
  expect(timedOut.json.error).toBeDefined();
  privateOutput(timedOut.out + timedOut.err);
  const [pending] = f.calls();
  expect(pending.pid).toBeGreaterThan(0);
  await Bun.sleep(950);
  expect(f.s.run(["/bin/kill", "-0", String(pending.pid)]).code).not.toBe(0);
  expect(f.calls()).toHaveLength(1);
  f.scenario({ status: {json: {healthy: true}} });
  expect(f.success(...args)).toMatchObject({ timed_out: false, data: {healthy: true} });
  expect(f.calls()).toHaveLength(2);
}), 10_000);
