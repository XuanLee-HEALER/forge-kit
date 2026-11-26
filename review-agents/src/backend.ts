import OpenAI from "openai";
import { z } from "zod";
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Report } from "./report";
import { loadApiKey } from "./config";

const schema = z.toJSONSchema(Report, { target: "draft-7" });
delete schema.$schema;
export type Backend = "api" | "codex";
export type Model = { model: string; effort: string };

export class BackendFailure extends Error {
  constructor(message: string, readonly upstream = false) { super(message); }
}

// Only a transport-level failure event can authorize another provider invocation.
// Assistant messages, subprocess stderr and model-controlled reports are never signals.
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

async function codex(prompt: string, model: Model) {
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
    const proc = Bun.spawn(args, { cwd: tmp, env: { ...process.env, PWD: tmp, FORGE_WORKBENCH_ROOT: undefined }, stdin: new Blob([prompt]), stdout: "pipe", stderr: "ignore", timeout: 300_000 });
    const [events, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) {
      const upstream = !proc.signalCode && upstreamCode(events);
      throw new BackendFailure(upstream || "Codex execution failed (exit " + code + ")", Boolean(upstream));
    }
    try { return JSON.parse(readFileSync(result, "utf8")); }
    catch { throw new BackendFailure("Codex returned an unreadable JSON report"); }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

export async function invoke(backend: Backend, prompt: string, model: Model) {
  if (backend === "codex") return codex(prompt, model);
  const config = process.env.REVIEW_CONFIG || join(homedir(), ".config/review-agents/config.toml");
  const apiKey = process.env.OPENAI_API_KEY || (existsSync(config) && await loadApiKey(config));
  if (!apiKey) throw new BackendFailure("API credentials missing (OPENAI_API_KEY or REVIEW_CONFIG)");
  const client = new OpenAI({ apiKey, maxRetries: 0, timeout: 300_000 });
  try {
    const response = await client.responses.create({
      model: model.model, input: prompt, store: false,
      reasoning: { effort: model.effort as "medium" | "high" },
      text: { format: { type: "json_schema", name: "review", strict: true, schema } },
    });
    if (response.status && response.status !== "completed") throw new BackendFailure("API response was " + response.status);
    return JSON.parse(response.output_text);
  } catch (err) {
    if (err instanceof BackendFailure) throw err;
    if (err instanceof OpenAI.APIError) throw new BackendFailure("API request failed (HTTP " + (err.status ?? "unknown") + ")");
    throw new BackendFailure("API returned an unreadable response");
  }
}
