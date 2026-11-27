import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });
const entries = readdirSync(dist, { withFileTypes: true });
for (const entry of entries) {
  if (!entry.isFile() || !entry.name.endsWith(".js"))
    throw Error("Unexpected build output. Inspect before rebuilding: " + join(dist, entry.name));
}
for (const entry of entries) if (entry.name !== "cli.js") unlinkSync(join(dist, entry.name));
const build = Bun.spawnSync([process.execPath, "build", "--target=bun", "--outfile=dist/cli.js", "src/bin/cli.ts"], {
  cwd: root, stdout: "inherit", stderr: "inherit",
});
process.exit(build.exitCode ?? 1);
