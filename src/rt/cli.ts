import { findWorkbenchRoot } from "../config";
import { resolveRuntimeInstance } from "../instance";
import { checkMigration } from "../managed-assets";
import { executeAdapter, RUNTIME_ANCESTOR } from "./adapter-process";
import { boundLocalChanges, ChangesError, readLocalChanges, resolveChangesRefs, selectChangesRepo, type LocalChanges } from "./changes";
import { RUNTIME_DEFAULTS, RuntimeConfigError, runtimeList, runtimeWarnings, type RuntimeBinding, type RuntimePrimitive } from "./config";
import { isRuntimeCommand, parseRuntimeOptions, RuntimeParameterError, type RuntimeCommand, type RuntimeInputs } from "./options";
import { runtimeSecrets, safeAdapterOutput, safeRuntimeText, safeRuntimeValue } from "./redact";

const usage = `Usage: forge rt <primitive> [options] [--json]
  list
  status [--env <env>] [--service <service>]
  changes [--repo <repo>] [--from-sha <sha>] [--to-ref <ref>] [--limit N]
          [--live --env <env> [--service <service>]] [--with-adapter]
  logs [--env <env>] [--service <service>] [--from <iso|unix>] [--to <iso|unix>]
       [--minutes N] [--level <level>] [--trace <id>] [--grep <text>] [--limit N]
  query [--env <env>] [--target <target>] [--expr <expression>] [--param <key=value>]... [--limit N]
  metrics [--env <env>] [--service <service>] [--metric <metric>] [--from <iso|unix>]
          [--to <iso|unix>] [--minutes N]

Configure an adapter in .workbench/workbench.yaml, for example:
  extensions:
    actions:
      read-logs:
        purpose: observe
        cwd: .
        argv: ["bun", ".workbench/actions/read-logs.ts"]
    runtime:
      logs:
        action: read-logs
        read_only_guarantee: ro-rbac
        timeout_ms: 15000
        max_bytes: 32768
        max_lines: 200

Supply your adapter at the given path. The configured argv runs directly in cwd.
The adapter, its endpoint and its credentials determine physical read-only access.
Guarantees: ro-credential, ro-rbac, ro-endpoint, fixed-ro-subcommand, unverified
(default). Inspect effective bindings and write-risk warnings with rt list and doctor.
Timeout, byte and line limits default to the values shown; hard caps are 60000 ms,
131072 bytes and 1000 lines. Stdout and stderr share the capture budget.

Adapter inputs are environment variables with the FORGE_RT_ prefix:
  PRIMITIVE, ENV, SERVICE, TARGET, LEVEL, TRACE, GREP, METRIC, EXPR, LIMIT,
  FROM_UNIX, TO_UNIX, FROM_ISO, TO_ISO, PARAMS_JSON, TIMEOUT_MS, MAX_BYTES, MAX_LINES.
Repeated --param key=value entries form one JSON object. A later duplicate wins.
Return JSON on stdout for structured data or text for output. Stderr supplies
diagnostics. Exit 0 for success; a nonzero adapter exit makes the CLI fail.
The envelope reports redacted results, timeout and truncation.

Logs and metrics default to the last 15 minutes. --minutes accepts 1..1440.
An end alone looks back; a start alone ends now, or advances by explicit minutes.
Supply ISO timestamps with timezones or integer Unix seconds. --limit accepts 1..500
(default 100). changes reads local Git and ledger evidence; --live queries status
for data.git_sha and --with-adapter requests a supplemental changes observation.`;

type Failure = "parameter" | "configuration" | "unconfigured" | "recursion" | "startup" | "timeout" |
  "adapter_exit" | "partial_failure" | "git";

interface Envelope {
  primitive: RuntimeCommand | null;
  ok: boolean;
  env: string | null;
  service: string | null;
  target: string | null;
  read_only_guarantee: RuntimeBinding["read_only_guarantee"] | null;
  duration_ms: number;
  exit_code: number | null;
  timed_out: boolean;
  truncated: boolean;
  output: string | null;
  data: unknown;
  warnings: string[];
  error?: Failure;
}

function envelope(primitive: RuntimeCommand | null, inputs: RuntimeInputs = {}, secrets: readonly string[] = []): Envelope {
  const visible = (value: string | undefined) => value === undefined ? null : safeRuntimeText(value, secrets);
  return { primitive, ok: true, env: visible(inputs.env), service: visible(inputs.service), target: visible(inputs.target),
    read_only_guarantee: null, duration_ms: 0, exit_code: null, timed_out: false, truncated: false,
    output: null, data: null, warnings: [] };
}

function failed(result: Envelope, error: Failure, warning: string): Envelope {
  return { ...result, ok: false, error, warnings: [...result.warnings, warning] };
}

function show(result: Envelope, json: boolean) {
  if (json) console.log(JSON.stringify(result));
  else if (result.primitive === "list" && Array.isArray(result.data)) {
    for (const row of result.data) console.log(`${row.primitive}: ${row.status} (${row.action ?? "–"}, ${row.read_only_guarantee ?? "–"}; ` +
      `${row.timeout_ms} ms, ${row.max_bytes} bytes, ${row.max_lines} lines)`);
  } else {
    console.log(`rt ${result.primitive ?? ""} ${result.ok ? "OK" : `FAILED (${result.error})`}`.trim());
    if (result.output) console.log(result.output);
    if (result.data !== null) console.log(JSON.stringify(result.data));
  }
  if (!json && result.truncated) console.log("  WARN Output was truncated.");
  if (!json) for (const warning of result.warnings) console.log(`  WARN ${warning}`);
  process.exitCode = result.ok ? 0 : 1;
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key] : undefined;
}

async function runAdapter(primitive: RuntimePrimitive, binding: RuntimeBinding | undefined,
  inputs: RuntimeInputs, secrets: readonly string[] = []): Promise<{ result: Envelope; gitSha?: string }> {
  const result = envelope(primitive, inputs, secrets);
  const fail = (error: Failure, warning: string) => ({ result: failed(result, error, warning) });
  if (!binding) return fail("unconfigured", `Configure extensions.runtime.${primitive} in workbench.yaml to bind an observe action. See forge rt --help for the binding and adapter protocol.`);
  result.read_only_guarantee = binding.read_only_guarantee;
  result.warnings = runtimeWarnings(new Map([[primitive, binding]]));
  const execution = await executeAdapter(binding, primitive, inputs);
  const safe = safeAdapterOutput(execution, binding, secrets);
  Object.assign(result, { duration_ms: execution.duration_ms, exit_code: execution.exit_code, timed_out: execution.timed_out,
    truncated: safe.truncated, output: safe.output, data: safe.data });
  if (safe.warning) result.warnings.push(safe.warning);
  if (execution.startup_failure) return fail("startup", "Could not start the observe action. Check its executable and working directory.");
  if (execution.timed_out) return fail("timeout", "The observe action exceeded its time limit.");
  if (execution.exit_code !== 0) {
    if (field(safe.data, "error") === "recursion")
      return fail("recursion", "An observe action attempted a nested forge rt invocation.");
    return fail("adapter_exit", "The observe action exited unsuccessfully.");
  }
  return { result, gitSha: safe.gitSha };
}

function limitsFor(binding: RuntimeBinding | undefined) {
  const { timeout_ms, max_bytes, max_lines } = binding ?? RUNTIME_DEFAULTS;
  return { timeout_ms, max_bytes, max_lines };
}

type RuntimeInstance = ReturnType<typeof resolveRuntimeInstance>;
type Options = ReturnType<typeof parseRuntimeOptions>;

async function changes(root: string, instance: RuntimeInstance, options: Options) {
  const { inputs, live, withAdapter, fromSha, toRef, limit } = options;
  const result = envelope("changes", inputs);
  result.read_only_guarantee = "fixed-ro-subcommand";
  const repo = selectChangesRepo(root, instance.repos, options.repo);
  const refs = resolveChangesRefs(repo, { fromSha, toRef });
  const statusBinding = instance.runtime.get("status");
  const statusObservation = live ? await runAdapter("status", statusBinding, { env: inputs.env, service: inputs.service }) : null;
  const status = statusObservation?.result;
  const raw = await readLocalChanges(root, repo, { refs, limit, live,
    liveSha: statusObservation?.gitSha });
  const local = boundLocalChanges(safeRuntimeValue(raw) as LocalChanges, RUNTIME_DEFAULTS);
  const changesBinding = instance.runtime.get("changes");
  const adapter = withAdapter ? (await runAdapter("changes", changesBinding, { ...inputs,
    params_json: JSON.stringify({ repo: raw.repo, from_sha: raw.git.from_sha, to_sha: raw.git.to_sha }) })).result : null;

  const { warnings, truncated, ...evidence } = local;
  result.warnings = warnings;
  result.truncated = truncated || !!status?.truncated || !!adapter?.truncated;
  result.timed_out = !!status?.timed_out || !!adapter?.timed_out;
  result.read_only_guarantee = status?.read_only_guarantee === "unverified" || adapter?.read_only_guarantee === "unverified"
    ? "unverified" : adapter?.read_only_guarantee ?? status?.read_only_guarantee ?? result.read_only_guarantee;
  result.data = { ...evidence,
    live: status ? { ...status, ...limitsFor(statusBinding) } : null,
    adapter: adapter ? { ...adapter, ...limitsFor(changesBinding) } : null };
  if (live && !raw.live_anchored || adapter && !adapter.ok)
    return failed(result, "partial_failure", "One or more requested runtime observations failed. Local evidence is available.");
  return result;
}

export async function runRuntimeCli(argv: string[]) {
  const started = performance.now();
  const now = Date.now();
  const [command = "", ...args] = argv;
  const primitive = isRuntimeCommand(command) ? command : null;
  const json = argv.includes("--json");
  let result = envelope(primitive);
  if (process.env[RUNTIME_ANCESTOR] === "1") {
    show(failed(result, "recursion", "An observe action attempted a nested forge rt invocation."), json);
    return;
  }
  if (argv.length === 0 || command === "--help" || command === "-h" ||
      primitive && args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(usage);
    return;
  }

  try {
    if (primitive === null) throw new RuntimeParameterError("Unknown runtime primitive. See forge rt --help.");
    const options = parseRuntimeOptions(primitive, args, now);
    const secrets = runtimeSecrets(options.params);
    result = envelope(primitive, options.inputs, secrets);
    let root: string;
    try { root = findWorkbenchRoot(); }
    catch { throw new RuntimeConfigError("Could not find the workbench. Run forge rt from a configured workbench."); }
    try { checkMigration(root); }
    catch { throw new RuntimeConfigError("An interrupted workbench migration requires forge sync."); }
    const instance = resolveRuntimeInstance(root);
    if (primitive === "list") {
      result.data = safeRuntimeValue(runtimeList(instance.runtime));
      result.warnings = runtimeWarnings(instance.runtime);
    } else if (primitive === "changes") result = await changes(root, instance, options);
    else result = (await runAdapter(primitive, instance.runtime.get(primitive), options.inputs, secrets)).result;
  } catch (error) {
    if (error instanceof RuntimeConfigError) result = failed(result, "configuration", safeRuntimeText(error.message));
    else if (error instanceof RuntimeParameterError) result = failed(result, "parameter", error.message);
    else if (error instanceof ChangesError) result = failed(result, error.kind, safeRuntimeText(error.message));
    else result = failed(result, "startup", "Runtime observation could not be completed.");
  }
  result.duration_ms = Math.round(performance.now() - started);
  show(result, json);
}
