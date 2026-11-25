import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  normalizeDbHosts,
  productionHosts,
  findWorkbenchRoot,
  isProductionDb,
  loadDbEnvironments,
  loadWorkbenchConfig,
} from "./config";

function approved(root: string, host?: string, runbook?: string, session?: string) {
  if (!host?.trim() || !runbook || !session?.trim()) return false;
  const db = new Database(join(root, ".workbench/ledger/ledger.sqlite"), { readonly: true });
  try {
    const row = db
      .query(
        "SELECT expires_at, approved_session_id, actions_json, actions_hash FROM runbooks WHERE runbook_id=? AND status='APPROVED'",
      )
      .get(runbook) as {
      expires_at: string;
      approved_session_id: string | null;
      actions_json: string;
      actions_hash: string;
    } | null;
    if (
      !row ||
      !(Date.parse(row.expires_at) > Date.now()) ||
      !row.approved_session_id?.trim() ||
      row.approved_session_id !== session
    )
      return false;
    if (createHash("sha256").update(row.actions_json).digest("hex") !== row.actions_hash) return false;
    const files: { host: string }[] = JSON.parse(row.actions_json).sql_files ?? [];
    const allowed = new Set(files.flatMap(file => normalizeDbHosts(file.host)).filter(Boolean));
    return normalizeDbHosts(host).every(member => allowed.has(member));
  } finally {
    db.close();
  }
}

export function formatDbCred(
  root: string,
  envName: string,
  mode: "ro" | "rw" = "ro",
  runbook?: string,
  session?: string,
): string {
  try {
    const environments = loadDbEnvironments(root, { strict: true });
    const entry = environments[envName];
    if (!entry || (mode === "ro" && !Object.hasOwn(entry, "ro") && Object.hasOwn(entry, "rw"))) throw Error();
    const forgeSession = process.env.FORGE_SESSION_ID;
    const trusted = forgeSession?.trim() ? forgeSession : process.env.CODEX_SESSION_ID;
    if (trusted !== undefined && session !== undefined && trusted !== session) throw Error();
    if (
      mode === "rw" &&
      isProductionDb(envName, entry, productionHosts(loadWorkbenchConfig(root), environments)) &&
      !approved(root, entry.host, runbook, trusted)
    )
      throw Error();
    const pair = Object.hasOwn(entry, mode) ? entry[mode] : entry;
    if (
      typeof pair?.user !== "string" ||
      !pair.user ||
      (pair.password !== undefined && typeof pair.password !== "string")
    )
      throw Error();
    return encodeURIComponent(pair.user) + ":" + encodeURIComponent(pair.password ?? "");
  } catch {
    throw Error(
      "Credentials unavailable or access denied. Production writes require an approved matching runbook and session.",
    );
  }
}

export function runDbCredCli(): void {
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        ro: { type: "boolean" },
        rw: { type: "boolean" },
        runbook: { type: "string" },
        session: { type: "string" },
      },
    });
    if (positionals.length !== 1 || (values.ro && values.rw)) throw Error();
    process.stdout.write(
      formatDbCred(
        findWorkbenchRoot(),
        positionals[0],
        values.rw ? "rw" : "ro",
        values.runbook,
        values.session,
      ),
    );
  } catch {
    console.error("Credentials unavailable. Usage: dbcred <env> [--ro | --rw [--runbook ID] [--session ID]]");
    process.exitCode = 1;
  }
}
