import { findWorkbenchRoot, loadDbEnvironments, loadWorkbenchConfig } from "./config";

import { redactSecrets } from "./shared/redact";
export { redactSecrets } from "./shared/redact";

const DB_CLIENT_RE = /(^|[\s;&|(])(usql|psql|mysql)\s/;
const SQL_TARGET_RE =
  /\b(?:UPDATE|INTO|FROM|TABLE|JOIN)\s+(?:ONLY\s+|IF\s+(?:NOT\s+)?EXISTS\s+)?([A-Za-z_][\w."]*)/i;
const SQL_WRITE_WORD_RE =
  /\b(insert|update|delete|merge|replace|alter|drop|create|truncate|grant|revoke)\b/i;

export function summarizeCommand(
  cmd: string,
  workbenchRoot?: string,
): { env: string; action: string; target: string; redacted: string } {
  const redacted = redactSecrets(cmd).trim();
  const root = workbenchRoot ?? findWorkbenchRoot();
  const cfg = loadWorkbenchConfig(root);
  const envs = loadDbEnvironments(root);

  let envLabel = "";
  for (const [name, entry] of Object.entries(envs)) {
    if (entry.host && entry.host !== "localhost" && cmd.includes(entry.host)) {
      envLabel = `${name} DB`;
      break;
    }
  }
  if (!envLabel) {
    for (const h of cfg.guard.prod_db_hosts) {
      if (h && cmd.includes(h)) {
        envLabel = "prod DB";
        break;
      }
    }
  }

  let action = "";
  let target = "";

  if (DB_CLIENT_RE.test(cmd)) {
    const sqlMatch = cmd.match(/(?:-c|-e|--command)\s+(?:"([^"]+)"|'([^']+)')/);
    const fileMatch = cmd.match(/(?:-f|--file)\s+(\S+)/);
    const sql = sqlMatch?.[1] ?? sqlMatch?.[2] ?? "";
    if (sql) {
      const verb = sql.trim().match(/^([A-Za-z\\]+\w*)/)?.[1]?.toUpperCase() ?? "SQL";
      const tbl = sql.match(SQL_TARGET_RE)?.[1]?.replace(/"/g, "") ?? "";
      const rw = SQL_WRITE_WORD_RE.test(sql) ? "write" : "read";
      action = `${verb}${tbl ? " " + tbl : ""} (${rw})`;
      target = tbl;
    } else if (fileMatch) {
      action = `exec file ${fileMatch[1]}`;
      target = fileMatch[1];
    }
  } else if (/\bkubectl\b/.test(cmd)) {
    const ns = cmd.match(/(?:-n|--namespace)(?:\s+|=)([^\s]+)/);
    envLabel = ns ? `k8s:${ns[1]}` : "k8s";
    const km = cmd.match(/\bkubectl\s+(?:(?:-\S+(?:\s+\S+)?)\s+)*([a-z-]+)(?:\s+([^\s-][^\s]*))?/);
    if (km) {
      action = `kubectl ${km[1]}${km[2] ? " " + km[2] : ""}`;
      target = km[2] ?? "";
    }
  }

  if (!action) {
    const firstLine = redacted.split("\n")[0] ?? redacted;
    action = firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
  }

  return { env: envLabel, action, target, redacted };
}

export async function runCmdFmtCli(): Promise<void> {
  const raw = await Bun.stdin.text();
  const oneline = process.argv.includes("--oneline");
  try {
    const data = JSON.parse(raw) as {
      tool_name?: string;
      tool_input?: { command?: string; cmd?: string };
    };
    const cmd = data.tool_input?.command ?? data.tool_input?.cmd ?? "";
    const summary = summarizeCommand(cmd);
    if (oneline) {
      console.log([summary.env, summary.action].filter(Boolean).join(" · "));
    } else {
      console.log(JSON.stringify(summary));
    }
  } catch {
    console.log(redactSecrets(raw));
  }
}
