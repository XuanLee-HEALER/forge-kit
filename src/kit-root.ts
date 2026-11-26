import { existsSync, realpathSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function findKitRoot(): string {
  const fromEnv = process.env.FORGE_KIT_ROOT;
  if (fromEnv && existsSync(join(fromEnv, "kit.toml"))) {
    return realpathSync(fromEnv);
  }
  const candidate = resolve(import.meta.dir, "..");
  if (existsSync(join(candidate, "kit.toml"))) {
    return realpathSync(candidate);
  }
  const lockPath = join(candidate, "kit-lock.json");
  if (existsSync(lockPath)) {
    const { kit_root } = JSON.parse(readFileSync(lockPath, "utf8")) as { kit_root?: string };
    if (kit_root && existsSync(join(kit_root, "kit.toml"))) return realpathSync(kit_root);
  }
  throw new Error("Cannot locate forge-kit root (missing kit.toml)");
}
