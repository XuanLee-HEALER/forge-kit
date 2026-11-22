import { findWorkbenchRoot, loadDbEnvironments } from "./config";

export function formatDbCred(root: string, envName: string): string {
  const envs = loadDbEnvironments(root);
  const entry = envs[envName];
  if (!entry || !entry.user) {
    throw new Error(`Environment not found in environments.json: ${envName}`);
  }
  const user = encodeURIComponent(String(entry.user));
  const pass = encodeURIComponent(String(entry.password ?? ""));
  return `${user}:${pass}`;
}

export function runDbCredCli(): void {
  const envName = process.argv[2];
  if (!envName || process.argv.length !== 3) {
    console.error("Usage: dbcred <env>");
    process.exit(1);
  }
  try {
    const root = findWorkbenchRoot();
    process.stdout.write(formatDbCred(root, envName));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
