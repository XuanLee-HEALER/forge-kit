import { z } from "zod";
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Report } from "./report";
import type { Model } from "./models";

const schema = z.toJSONSchema(Report, { target: "draft-7" });
delete schema.$schema;
export class BackendFailure extends Error {}

function upstreamCode(events: string): string | undefined {
  for (const line of events.trim().split("\n").reverse()) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type !== "turn.failed") continue;
    const info = event.error?.codex_error_info ?? event.error?.codexErrorInfo;
    if (["usage_limit_exceeded", "usageLimitExceeded", "server_overloaded", "serverOverloaded"].includes(info)) return info;
    const status = info?.http_connection_failed?.http_status_code ?? info?.httpConnectionFailed?.httpStatusCode;
    if (status === 429 || (Number.isInteger(status) && status >= 500 && status <= 599)) return "upstream_http_" + status;
    // Some Codex releases expose only a formatted transport error in turn.failed.
    const match = /^unexpected status (429|5\d\d)\b/i.exec(event.error?.message ?? "");
    if (match) return "upstream_http_" + match[1];
    return undefined;
  }
}

// Drain transport output without retaining prompts or unbounded event histories.
async function tail(stream: ReadableStream<Uint8Array>) {
  let bytes = Buffer.alloc(0);
  for await (const part of stream) {
    const end = part.subarray(Math.max(0, part.length - 8192));
    bytes = Buffer.concat([bytes, end]).subarray(-8192);
  }
  return bytes.toString("utf8");
}

// Provider authentication and transport are independent of workbench, cloud
// and deployment credentials present in the invoking agent's process.
function codexEnvironment(cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PWD: cwd };
  for (const name of [
    "PATH", "HOME", "CODEX_HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL",
    "SYSTEMROOT", "USERPROFILE", "LOCALAPPDATA", "APPDATA",
    "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "ALL_PROXY",
    "https_proxy", "http_proxy", "no_proxy", "all_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR",
  ]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

export async function invoke(prompt: string, model: Model) {
  const tmp = mkdtempSync(join(tmpdir(), "forge-model-"));
  try {
    const schemaPath = join(tmp, "schema.json");
    const result = join(tmp, "result.json");
    writeFileSync(schemaPath, JSON.stringify(schema));
    const executable = process.env.FORGE_CODEX_BIN || "codex";
    const args = [
      executable.includes("/") ? resolve(executable) : executable, "exec", "--json", "--ephemeral",
      "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "-s", "read-only", "-C", tmp,
      "-c", "project_doc_max_bytes=0", "-c", 'approval_policy="never"', "-c", 'web_search="disabled"',
      "--disable", "shell_tool", "--disable", "unified_exec", "--disable", "multi_agent",
      "--disable", "multi_agent_v2", "--disable", "plugins", "--disable", "hooks", "--disable", "code_mode_host", "--enable", "skip_host_skill_discovery",
      "-m", model.model, "-c", "model_reasoning_effort=" + JSON.stringify(model.effort),
      "--output-schema", schemaPath, "-o", result, "-",
    ];
    const proc = Bun.spawn(args, { cwd: tmp, env: codexEnvironment(tmp), stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe", timeout: 300_000 });
    const [events, stderr, code] = await Promise.all([tail(proc.stdout), tail(proc.stderr), proc.exited]);
    if (code !== 0) {
      const upstream = proc.signalCode ? "Codex terminated by signal " + proc.signalCode : upstreamCode(events);
      // Return diagnostic classes without replaying untrusted command output.
      const reason = /unexpected argument|unrecognized (?:option|argument|feature)/i.test(stderr) ? "unsupported CLI option" :
        /unauthori[sz]ed|authentication|not logged in/i.test(stderr) ? "authentication failed" : "execution failed";
      throw new BackendFailure(upstream || "Codex " + reason + " (exit " + code + ")");
    }
    if ((statSync(result, {throwIfNoEntry:false})?.size ?? 0) > 20_000) throw new BackendFailure("Codex report exceeds the response budget");
    try { return JSON.parse(readFileSync(result, "utf8")); }
    catch { throw new BackendFailure("Codex returned an unreadable JSON report"); }
  } catch (error) {
    if (error instanceof BackendFailure) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    throw new BackendFailure("Unable to start or read Codex" + (code && /^[A-Z_]+$/.test(code) ? " (" + code + ")" : ""));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
