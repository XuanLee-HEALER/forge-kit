import { expect } from "bun:test";
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { kit, type Sandbox } from "../v05-sandbox";
import { historicalV050Kit } from "./v050-kit";

const releases = {
  "0.5.1": ["4b4fa0b3fe009f0559cb359ec6098f02f29fc873", "65c903e7f6e2ff6e7ed19d7f370740974b858eb5fbf2939284b5666ba86585be"],
  "0.5.2": ["1a52bf488da8731b6687bc6a6ff7651c8ae48fd2", "e0f920ace13f5633134828b4246c93492a619eb6530d1aac1f553c621df9a8de"],
  "0.5.3": ["dc43ddc9897481e50da4379dc8d73becd3637f27", "268f616d5a15d45874c6b1a7a96ac248f9f546f9ff4c4362851a51bf67e290fb"],
} as const;
export type HistoricalVersion = "0.5.0" | keyof typeof releases;
export const digest = (path: string) => new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");

export function historicalKit(s: Sandbox, version: HistoricalVersion) {
  if (version === "0.5.0") return historicalV050Kit(s);
  const [revision, sha] = releases[version];
  const old = join(s.root, version);
  const tar = old + ".tar";
  mkdirSync(old);
  const supplied = process.env["FORGE_V" + version.replaceAll(".", "") + "_TEST_ARCHIVE"];
  if (supplied !== undefined) copyFileSync(supplied, tar);
  else s.ok(["git", "-C", kit, "--no-replace-objects", "-c", "core.attributesFile=/dev/null", "-c", "tar.umask=0002",
    "archive", "--format=tar", "--output", tar, revision]);
  expect(digest(tar)).toBe(sha);
  s.ok(["tar", "-xf", tar, "-C", old]);

  const cli = process.env.FORGE_V051_CLI_FIXTURE_FILE;
  const review = process.env.FORGE_V051_REVIEW_FIXTURE_FILE;
  if (version === "0.5.1" && (cli !== undefined || review !== undefined)) {
    if (!cli || !review) throw Error("Supply both fixed v0.5.1 bundle fixtures");
    for (const [source, target, sha] of [
      [cli, "dist/cli.js", "72f9e8b002005385d267f1b485426821e9c331f629961feae7f519c92cb3e966"],
      [review, "review-agents/dist/review.js", "84f233ec27460b7bb3a439fd95dc2b5896a8a6bc6ab701ec3934ec191bb85867"],
    ]) {
      const path = join(old, target);
      mkdirSync(join(path, ".."), {recursive:true});
      copyFileSync(source, path);
      expect(digest(path)).toBe(sha);
    }
  } else {
    if (version === "0.5.1") {
      s.env.BUN_INSTALL_CACHE_DIR = process.env.BUN_INSTALL_CACHE_DIR || join(process.env.HOME!, ".bun/install/cache");
      s.ok(["bun", "install", "--offline", "--frozen-lockfile"], old);
    } else {
      expect(readFileSync(join(old, "bun.lock"))).toEqual(readFileSync(join(kit, "bun.lock")));
      for (const dir of ["node_modules", "review-agents/node_modules"]) symlinkSync(join(kit, dir), join(old, dir));
    }
    s.ok(["bun", "run", "build"], old);
  }
  rmSync(join(old, "src"), {recursive: true});
  return old;
}

export function releaseCLI(s: Sandbox) {
  const release = join(s.root, "candidate");
  for (const path of ["kit.toml", "package.json", "bin", "core", "templates", "review-agents/prompts"]) {
    cpSync(join(kit, path), join(release, path), {recursive:true});
  }
  const bundle = join(release, "dist/cli.js");
  s.ok(["bun", "build", "--target=bun", "--outfile=" + bundle, "src/bin/cli.ts"], kit);
  return join(release, "bin/forge");
}
