import { beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function isolateHome() {
  let dir: string;
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "forge-home-"));
    saved = {};
    for (const key of ["HOME", "GH_CONFIG_DIR", "XDG_CONFIG_HOME", "GH_HOST", "GH_REPO", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "FORGE_WORKBENCH_ROOT", "FORGE_MODELS_TOML", "FORGE_KIT_ROOT"]) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.HOME = dir;
    process.env.GH_CONFIG_DIR = join(dir, "gh");
    process.env.XDG_CONFIG_HOME = join(dir, ".config");
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    mkdirSync(process.env.GH_CONFIG_DIR);
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
}
