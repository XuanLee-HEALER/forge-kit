import { parseArgs } from "node:util";
import {
  productionHosts,
  findWorkbenchRoot,
  isProductionDb,
  loadDbEnvironments,
  loadWorkbenchConfig,
} from "./config";

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
      isProductionDb(envName, entry, productionHosts(loadWorkbenchConfig(root), environments))
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
      "Credentials unavailable or access denied. The authorized ship executor supports exact production SQL for PostgreSQL.",
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
    console.error("Credentials unavailable. Use forge dbcred <env> --ro for production reads. Run authorized production writes through forge ship. For a non-production account, use forge dbcred <env> [--ro | --rw].");
    process.exitCode = 1;
  }
}
