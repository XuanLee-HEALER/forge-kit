import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";

export function cargoProjectInCheckout(bin: string, args: string[], dir: string, cwd = dir): boolean {
  const manifests = [];
  for (let i = 1; i < args.length && args[i] !== "--"; i++) {
    if (args[i] === "--manifest-path") manifests.push(args[++i]);
    else if (args[i].startsWith("--manifest-path=")) manifests.push(args[i].slice("--manifest-path=".length));
  }
  if (manifests.length > 1 || manifests.some(path => !path)) return false;
  let input = manifests[0];
  if (!input) {
    let project = cwd;
    while (!existsSync(join(project, "Cargo.toml"))) {
      if (project === dir || !project.startsWith(dir + sep)) return false;
      project = dirname(project);
    }
    input = join(project, "Cargo.toml");
  }
  const manifest = realpathSync.native(isAbsolute(input) ? input : cwd + sep + input);
  if (!manifest.startsWith(dir + sep) || !statSync(manifest).isFile()) return false;

  // Package and workspace selectors can widen a run beyond the selected manifest.
  const result = Bun.spawnSync([bin, "metadata", "--offline", "--no-deps", "--format-version=1", "--manifest-path", manifest],
    { cwd, stdout: "pipe", stderr: "pipe", timeout: 10_000 });
  if (result.exitCode !== 0) return false;
  const metadata = JSON.parse(result.stdout.toString()) as {packages: {manifest_path: string}[]};
  return metadata.packages.length > 0 && metadata.packages.every(pkg =>
    realpathSync.native(pkg.manifest_path).startsWith(dir + sep));
}

// The verification process installs this same module as a temporary Cargo launcher for package scripts.
export function runCargoLauncher() {
  const bin = process.env.FORGE_VERIFY_CARGO_BINARY;
  const root = process.env.FORGE_VERIFY_CHECKOUT;
  const args = process.argv.slice(2);
  if (!bin || !root) throw Error("Missing verification context");
  if (args.some(arg => ["test", "check", "build", "clippy"].includes(arg)) &&
      !cargoProjectInCheckout(bin, args, root, process.cwd())) {
    console.error("Cargo project is outside the verified checkout");
    process.exit(1);
  }
  const result = Bun.spawnSync([bin, ...args], {stdin: "inherit", stdout: "inherit", stderr: "inherit"});
  process.exit(result.exitCode ?? 1);
}
