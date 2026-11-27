import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const dist = join(import.meta.dir, "..", "dist");
mkdirSync(dist, { recursive: true });
const entries = readdirSync(dist, { withFileTypes: true });
for (const entry of entries) {
  if (!entry.isFile() || !entry.name.endsWith(".js"))
    throw Error("Unexpected build output. Inspect before rebuilding: " + join(dist, entry.name));
}
for (const entry of entries) unlinkSync(join(dist, entry.name));

const run = Bun.spawnSync([process.execPath, "build", "--target=bun", "--outfile=dist/cli.js", "src/bin/cli.ts"], {
  cwd: join(import.meta.dir, ".."), stdout: "inherit", stderr: "inherit",
});
if (run.exitCode !== 0) process.exit(run.exitCode || 1);
const outputs = readdirSync(dist, { withFileTypes: true });
if (outputs.length !== 1 || outputs[0].name !== "cli.js" || !outputs[0].isFile())
  throw Error("Expected only dist/cli.js after building forge");
