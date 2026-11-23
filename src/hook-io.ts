export interface CodexHookInput {
  hook_event_name?: string;
  session_id?: string;
  turn_id?: string;
  cwd?: string;
  model?: string;
  permission_mode?: string;
  source?: string;
  trigger?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  tool_use_id?: string;
  agent_id?: string;
  agent_type?: string;
  prompt?: string;
}

export type HookReadResult =
  | { ok: true; input: CodexHookInput | null }
  | { ok: false; error: string };

const SHELL_TOOL_NAMES = new Set([
  "bash",
  "exec_command",
  "shell",
  "run_command",
  "terminal",
]);

const PATCH_TOOL_NAMES = new Set(["apply_patch"]);

const FILE_EDIT_TOOL_NAMES = new Set([
  "write",
  "edit",
  "multiedit",
  "write_file",
  "edit_file",
  "create_file",
]);

export async function readHookStdinStrict(): Promise<HookReadResult> {
  const raw = await Bun.stdin.text();
  if (!raw.trim()) return { ok: true, input: null };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "Hook stdin JSON must be an object" };
    }
    return { ok: true, input: parsed as CodexHookInput };
  } catch (err) {
    return {
      ok: false,
      error: `Invalid hook stdin JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function isPatchToolInput(input: CodexHookInput): boolean {
  const name = (input.tool_name ?? "").toLowerCase();
  // Known shell tools are NEVER reclassified as patch tools (prevents bypassing shell guard via `*** Begin Patch` in args!).
  if (SHELL_TOOL_NAMES.has(name)) return false;
  if (PATCH_TOOL_NAMES.has(name)) return true;
  if (name) return false;
  const ti = input.tool_input;
  if (ti && typeof ti === "object") {
    const obj = ti as Record<string, unknown>;
    for (const key of ["patch", "input", "command", "cmd"]) {
      if (
        typeof obj[key] === "string" &&
        (obj[key] as string).trimStart().startsWith("*** Begin Patch")
      ) {
        return true;
      }
    }
  }
  return false;
}

export function isShellToolInput(input: CodexHookInput): boolean {
  const name = (input.tool_name ?? "").toLowerCase();
  if (SHELL_TOOL_NAMES.has(name)) return extractRawCommand(input) !== null;
  if (isPatchToolInput(input)) return false;
  if (FILE_EDIT_TOOL_NAMES.has(name)) return false;
  if (name) return false;
  return extractRawCommand(input) !== null;
}

function extractRawCommand(input: CodexHookInput): string | null {
  const ti = input.tool_input;
  if (!ti || typeof ti !== "object") return null;
  const obj = ti as Record<string, unknown>;
  if (typeof obj.command === "string") return obj.command;
  if (typeof obj.cmd === "string") return obj.cmd;
  return null;
}

export function extractShellCommand(input: CodexHookInput): string | null {
  if (!isShellToolInput(input)) return null;
  return extractRawCommand(input);
}

export function extractToolWorkdir(input: CodexHookInput): string {
  const ti = input.tool_input;
  if (ti && typeof ti === "object") {
    const obj = ti as Record<string, unknown>;
    if (typeof obj.workdir === "string" && obj.workdir.trim()) {
      return obj.workdir.trim();
    }
  }
  return input.cwd ?? process.cwd();
}

export function extractTouchedFilePaths(input: CodexHookInput): string[] {
  const ti = input.tool_input;
  if (!ti || typeof ti !== "object") return [];
  const obj = ti as Record<string, unknown>;
  const paths: string[] = [];

  for (const key of ["file_path", "path", "target_file", "notebook_path"]) {
    if (typeof obj[key] === "string" && obj[key]) {
      paths.push(obj[key] as string);
    }
  }

  // Parse Codex native apply_patch format (can arrive in patch, input, or command)
  const patchCandidates: string[] = [];
  if (typeof obj.patch === "string") patchCandidates.push(obj.patch);
  if (typeof obj.input === "string") patchCandidates.push(obj.input);
  if (isPatchToolInput(input)) {
    const rawCmd = extractRawCommand(input);
    if (rawCmd) patchCandidates.push(rawCmd);
  }

  const fileHeaderRe = /^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s+(.+)$/gm;
  const moveToRe = /^\*\*\*\s+Move\s+to:\s+(.+)$/gm;
  for (const text of patchCandidates) {
    let m: RegExpExecArray | null;
    while ((m = fileHeaderRe.exec(text)) !== null) {
      if (m[1]?.trim()) paths.push(m[1].trim());
    }
    while ((m = moveToRe.exec(text)) !== null) {
      if (m[1]?.trim()) paths.push(m[1].trim());
    }
  }

  return [...new Set(paths)];
}

export function extractResponseExitCode(resp: unknown): number | null {
  if (resp == null) return null;
  if (typeof resp === "object") {
    const obj = resp as Record<string, unknown>;
    if (typeof obj.exit_code === "number") return obj.exit_code;
    if (typeof obj.exitCode === "number") return obj.exitCode;
    if (typeof obj.code === "number") return obj.code;
  }
  if (typeof resp === "string") {
    const m = resp.match(/(?:exit(?:_|\s+)code|Process exited with code)[:=\s]+(\d+)/i);
    if (m) return Number(m[1]);
  }
  return null;
}

export function extractResponseText(resp: unknown): string {
  if (resp == null) return "";
  if (typeof resp === "string") return resp;
  if (typeof resp === "object") {
    const obj = resp as Record<string, unknown>;
    if (typeof obj.output === "string") return obj.output;
    if (typeof obj.stdout === "string") {
      return [obj.stdout, typeof obj.stderr === "string" ? obj.stderr : ""]
        .filter(Boolean)
        .join("\n");
    }
    return JSON.stringify(resp);
  }
  return String(resp);
}

/**
 * Codex 0.169.1 PreToolUse schema:
 * - Allow: exit 0 with empty stdout (do NOT emit permissionDecision: allow/ask).
 * - Deny: emit hookSpecificOutput.permissionDecision = "deny" with non-empty reason.
 */
export function emitPreToolUseDeny(reason: string): void {
  const safeReason = reason.trim() || "Blocked by workbench guard";
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: safeReason,
      },
    }),
  );
}

export function emitSessionStartContext(additionalContext: string): void {
  if (!additionalContext.trim()) return;
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext,
      },
    }),
  );
}

export function emitPostCompactMessage(systemMessage: string): void {
  if (!systemMessage.trim()) return;
  console.log(JSON.stringify({ systemMessage }));
}

export function emitPostToolUseContext(additionalContext: string): void {
  if (!additionalContext.trim()) return;
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext,
      },
    }),
  );
}

export function emitUserPromptSubmitContext(additionalContext: string): void {
  if (!additionalContext.trim()) return;
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext,
      },
    }),
  );
}
