import { expect } from "bun:test";
import { copyFileSync, cpSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { kit, type Sandbox } from "../v05-sandbox";


const releases = {
  "0.6.1": ["0da45b0bc72c8f9067d13466d1a5e0a87a702ae5", "bb41eb760d5cc53339eb4aeb05420ed35f720b88b4ae6023575c165bd996cdcf"],
  "0.5.0": ["e2d7453ab08bee29cf174425e84012819a74bcc3", "dd59b1771a3e19e9b588dd3b46d21a714c79b6226e848f55539664c81ece80eb"],
  "0.5.1": ["4b4fa0b3fe009f0559cb359ec6098f02f29fc873", "65c903e7f6e2ff6e7ed19d7f370740974b858eb5fbf2939284b5666ba86585be"],
  "0.5.2": ["1a52bf488da8731b6687bc6a6ff7651c8ae48fd2", "e0f920ace13f5633134828b4246c93492a619eb6530d1aac1f553c621df9a8de"],
  "0.5.3": ["dc43ddc9897481e50da4379dc8d73becd3637f27", "268f616d5a15d45874c6b1a7a96ac248f9f546f9ff4c4362851a51bf67e290fb"],
  "0.5.4": ["0e252c19bce5184c7aff66bbde753683b8fd5a36", "d18fb1432215566374d3a7747d931603e451df0cc2e4568cdd3841e34f417329"],
  "0.5.5": ["47537e9c7eb047f848e0cf1f98ab4c5f29a34d04", "3fa44013ccc67b97846267ecb7a27e474334d787679c9f33edcbaa12ddb9ce18"],
  "0.5.6": ["fec8d0beb5e8383ea167574f97105675bfc6fe37", "539ce7e5c291ba1bc4bae19d201b7426af16655d6eec3de68ecfa1dd9c0c517a"],
  "0.5.7": ["e5558bb3d0195b87d2f9d5fe7ab3b41207293b04", "693b556267260f47185bbad34a9450d5eb822310f410b72d0b851f0108fb7859"],
  "0.6.0": ["65c74667f1f106b9e9dbb7985b072bb0a5767954", "1addfcb22156a5bac33918d4cfb5cb1170d988067704a292259b8c232c4b3802"],
} as const;

const bundles = {
  "0.6.1": ["2681c48fc6a1433c6e10e0c5e5110b3e83c68c78e389482a6c9f0633fb096658", null],
  "0.5.0": ["b564cc71307e7181ee63c8828ca72c9be74edbacf7af871c3cc4f471b158cd3a", "a4be4e07f2eef4b2814b0792d554d7513bff2638489084b7751d8feeb977aceb"],
  "0.5.1": ["72f9e8b002005385d267f1b485426821e9c331f629961feae7f519c92cb3e966", "84f233ec27460b7bb3a439fd95dc2b5896a8a6bc6ab701ec3934ec191bb85867"],
  "0.5.2": ["89a757dd7dcb349a75572cdd8b7444cf0f4bef77aa56c3d1a01f41058c5ba04f", "9cfde987d53974b490d508fa70ede0dedb2cea5c3a9eb515ac30ccd466c955ac"],
  "0.5.3": ["fb1b7ed422edab73aaf4309e837c4b5ef17c72ca4330e19029d19d3016bd54cd", "d6f36d7ba00b18c1a3391f1e5812cf0639ad97b774035bf3f995ab326ab99e4b"],
  "0.5.4": ["47eaf3e96d6f73192bf4481008aca5553d7f76bed5465b7b0c3f535a81f3a89a", "5cb9a803afccb32315512223d6f2f20d6bb0ef54e18cfec1ed62097b19e203df"],
  "0.5.5": ["653648aa4a9cdc9482fa4afef2a135921806d0f12cd269ace172da12f9da7ed1", null],
  "0.5.6": ["dddc18f863fee293abd29110a98ff462dfd8b4322a809082ec6e7794f2e9c9ca", null],
  "0.5.7": ["a1e31210c45572c2ae38d285b51535f53f5907fd53d1de345c6058cdb3e3dac2", null],
  "0.6.0": ["e373a7fb4b567569119be4ad20f33bd921beac23ecf7dac7052d93f846c539c6", null],
} as const;
export type HistoricalVersion = keyof typeof releases;
export const digest = (path: string) => new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");

export function historicalKit(s: Sandbox, version: HistoricalVersion) {
  const [revision, sha] = releases[version];
  const old = join(s.root, version);
  const tar = old + ".tar";
  mkdirSync(old);
  const prefix = "FORGE_V" + version.replaceAll(".", "");
  const supplied = process.env[version === "0.5.0" ? "FORGE_V05_TEST_ARCHIVE" : prefix + "_TEST_ARCHIVE"];
  if (supplied !== undefined) copyFileSync(supplied, tar);
  else s.ok(["git", "-C", kit, "--no-replace-objects", "-c", "core.attributesFile=/dev/null", "-c", "tar.umask=0002",
    "archive", "--format=tar", "--output", tar, revision]);
  expect(digest(tar)).toBe(sha);
  s.ok(["tar", "-xf", tar, "-C", old]);

  // Use the historical lockfile and offline cache, or the prebuilt artifacts the release shipped.
  const cli = process.env[prefix + "_CLI_FIXTURE_FILE"];
  const review = process.env[prefix + "_REVIEW_FIXTURE_FILE"];
  const [cliSha, reviewSha] = bundles[version];
  if (cli !== undefined || review !== undefined) {
    if (!cli || Boolean(review) !== Boolean(reviewSha)) throw Error("Supply the fixed v" + version + " bundle fixtures");
    const artifacts: [string, string, string][] = [[cli, "dist/cli.js", cliSha]];
    if (review && reviewSha) artifacts.push([review, "review-agents/dist/review.js", reviewSha]);
    for (const [source, target, sha] of artifacts) {
      const path = join(old, target);
      mkdirSync(join(path, ".."), {recursive:true});
      copyFileSync(source, path);
      expect(digest(path)).toBe(sha);
    }
  } else {
    s.env.BUN_INSTALL_CACHE_DIR = process.env.BUN_INSTALL_CACHE_DIR || join(process.env.HOME!, ".bun/install/cache");
    s.ok(["bun", "install", "--offline", "--frozen-lockfile"], old);
    s.ok(["bun", "run", "build"], old);
  }
  // Keep the matching historical ledger writer for fixture data. bin/forge runs the bundle.
  renameSync(join(old, "src"), join(old, "historical-src"));
  return old;
}

export function releaseCLI(s: Sandbox) {
  const release = join(s.root, "candidate");
  for (const path of ["kit.toml", "package.json", "bin", "core", "templates"]) {
    cpSync(join(kit, path), join(release, path), {recursive:true});
  }
  const bundle = join(release, "dist/cli.js");
  s.ok(["bun", "build", "--target=bun", "--outfile=" + bundle, "src/bin/cli.ts"], kit);
  return join(release, "bin/forge");
}
