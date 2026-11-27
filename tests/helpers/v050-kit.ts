import { expect } from "bun:test";
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { kit, type Sandbox } from "../v05-sandbox";

const baseline = "e2d7453ab08bee29cf174425e84012819a74bcc3";
const archiveDigest = "dd59b1771a3e19e9b588dd3b46d21a714c79b6226e848f55539664c81ece80eb";
const digest = (path: string) => new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");

export function historicalV050Kit(s: Sandbox) {
  const old = join(s.root, "v05");
  const tar = join(s.root, "baseline.tar");
  mkdirSync(old);
  const supplied = process.env.FORGE_V05_TEST_ARCHIVE;
  if (supplied !== undefined) copyFileSync(supplied, tar);
  else s.ok(["git", "-C", kit, "--no-replace-objects", "-c", "core.attributesFile=/dev/null", "-c", "tar.umask=0002",
    "archive", "--format=tar", "--output", tar, baseline]);
  expect(digest(tar)).toBe(archiveDigest);
  s.ok(["tar", "-xf", tar, "-C", old]);
  // The historical release requires its own dependencies, including its retired review SDK.
  const bundles = [
    [process.env.FORGE_V050_CLI_FIXTURE_FILE, "dist/cli.js", "b564cc71307e7181ee63c8828ca72c9be74edbacf7af871c3cc4f471b158cd3a"],
    [process.env.FORGE_V050_REVIEW_FIXTURE_FILE, "review-agents/dist/review.js", "a4be4e07f2eef4b2814b0792d554d7513bff2638489084b7751d8feeb977aceb"],
  ] as const;
  if (bundles.some(([path]) => path !== undefined)) {
    for (const [path, name, sha] of bundles) {
      if (!path) throw Error("Supply both fixed v0.5.0 bundle fixtures");
      mkdirSync(join(old, name, ".."), {recursive: true});
      copyFileSync(path, join(old, name));
      expect(digest(join(old, name))).toBe(sha);
    }
  } else {
    s.env.BUN_INSTALL_CACHE_DIR = process.env.BUN_INSTALL_CACHE_DIR || join(process.env.HOME!, ".bun/install/cache");
    s.ok(["bun", "install", "--offline", "--frozen-lockfile"], old);
    s.ok(["bun", "run", "build"], old);
  }
  rmSync(join(old, "src"), {recursive: true});
  return old;
}
