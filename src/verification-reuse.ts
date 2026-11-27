import { createHash } from "node:crypto";
import { statSync } from "node:fs";

// Project-local runners are fixed by the candidate tree and lockfile. Include
// the external runners used by the built-in language checks in the receipt.
export function verificationReuseKey(policy: string, offline: boolean, fixtures: Record<string, string>) {
  const commands = [process.execPath, "git", "go", "cargo", "rustc", "python3", "pytest", "make", "hurl"];
  const tools = commands.map(command => {
    const path = Bun.which(command);
    const stat = path && statSync(path, {throwIfNoEntry: false});
    return stat ? [path, stat.size, stat.mtimeMs] : [command, null];
  });
  return createHash("sha256").update(JSON.stringify([
    1, Bun.version, process.platform, process.arch, policy, offline, tools,
    process.env.PATH, process.env.BUN_INSTALL_CACHE_DIR, Object.entries(fixtures).sort(),
  ])).digest("hex");
}
