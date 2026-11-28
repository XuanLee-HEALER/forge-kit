import { spawn } from "node:child_process";
import type { RuntimeBinding, RuntimePrimitive } from "./config";
import type { RuntimeInputs } from "./options";

export const RUNTIME_ANCESTOR = "FORGE_RT_ANCESTOR";

// Known fields only. No inherited protocol value can supply an omitted option.
const inputNames = ["env", "service", "target", "from_unix", "to_unix", "from_iso", "to_iso", "limit",
  "level", "trace", "grep", "metric", "expr", "params_json"] as const satisfies readonly (keyof RuntimeInputs)[];

function adapterEnv(binding: RuntimeBinding, primitive: RuntimePrimitive, inputs: RuntimeInputs) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("FORGE_RT_")) delete env[key];
  for (const key of inputNames) {
    if (inputs[key] !== undefined) env[`FORGE_RT_${key.toUpperCase()}`] = String(inputs[key]);
  }
  env.FORGE_RT_PRIMITIVE = primitive;
  env.FORGE_RT_MAX_BYTES = String(binding.max_bytes);
  env.FORGE_RT_MAX_LINES = String(binding.max_lines);
  env.FORGE_RT_TIMEOUT_MS = String(binding.timeout_ms);
  env[RUNTIME_ANCESTOR] = "1";
  return env;
}

interface StreamCapture {
  chunks: Buffer[];
  open: boolean;
  ended: boolean;
  clipped: boolean;
}

export interface CapturedStream {
  bytes: Buffer;
  clipped: boolean;
  incomplete: boolean;
}

export interface AdapterExecution {
  stdout: CapturedStream;
  stderr: CapturedStream;
  exit_code: number | null;
  timed_out: boolean;
  startup_failure: boolean;
  duration_ms: number;
}

export function executeAdapter(binding: RuntimeBinding, primitive: RuntimePrimitive, inputs: RuntimeInputs): Promise<AdapterExecution> {
  const makeStream = (): StreamCapture => ({ chunks: [], open: false, ended: false, clipped: false });
  const stdout = makeStream();
  const stderr = makeStream();
  const started = performance.now();
  let exitCode: number | null = null;
  let bytesLeft = binding.max_bytes;
  let linesLeft = binding.max_lines;

  function capture(stream: StreamCapture, chunk: Buffer) {
    if (stream.clipped || !chunk.length) return;
    const max = Math.min(bytesLeft, chunk.length);
    let size = 0;
    for (; size < max; size++) {
      if (!stream.open) {
        if (linesLeft === 0) break;
        linesLeft--;
      }
      stream.open = chunk[size] !== 10;
    }
    if (size) stream.chunks.push(Buffer.from(chunk.subarray(0, size)));
    bytesLeft -= size;
    stream.clipped = size < chunk.length;
  }

  function result(timed_out: boolean, startup_failure: boolean): AdapterExecution {
    const output = (stream: StreamCapture) => ({ bytes: Buffer.concat(stream.chunks), clipped: stream.clipped,
      incomplete: stream.clipped || timed_out && !stream.ended });
    return { stdout: output(stdout), stderr: output(stderr), exit_code: exitCode, timed_out, startup_failure,
      duration_ms: Math.round(performance.now() - started) };
  }

  return new Promise(resolve => {
    let child;
    try {
      child = spawn(binding.argv[0], binding.argv.slice(1), {
        cwd: binding.cwd, env: adapterEnv(binding, primitive, inputs), detached: true, shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve(result(false, true));
      return;
    }
    let startupFailure = false;
    child.once("error", () => { startupFailure = true; });
    child.once("exit", code => { if (code !== null && code >= 0) exitCode = code; });
    child.stdout.on("data", chunk => capture(stdout, chunk));
    child.stderr.on("data", chunk => capture(stderr, chunk));
    child.stdout.once("end", () => { stdout.ended = true; });
    child.stderr.once("end", () => { stderr.ended = true; });

    // A descendant can retain a pipe after the group leader exits. Wait for close
    // and kill the group at the deadline even when the leader has already exited.
    let settled = false;
    const expire = () => {
      settled = true;
      if (child.pid !== undefined) {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch { /* The group can disappear while the deadline callback runs. */ }
      }
      const outcome = result(true, false);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve(outcome);
    };
    const timer = setTimeout(expire, Math.max(0, binding.timeout_ms - (performance.now() - started)));
    child.once("close", () => {
      clearTimeout(timer);
      if (!settled) resolve(result(!startupFailure && performance.now() - started >= binding.timeout_ms, startupFailure));
    });
  });
}
