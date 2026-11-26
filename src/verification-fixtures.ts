import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

function digestFile(path: string, destination?: number) {
  const source = openSync(path, fileFlags);
  try {
    if (!fstatSync(source).isFile()) throw Error("Expected a regular file");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes;
    while ((bytes = readSync(source, buffer, 0, buffer.length, null)) > 0) {
      const chunk = buffer.subarray(0, bytes);
      hash.update(chunk);
      if (destination !== undefined) writeFileSync(destination, chunk);
    }
    return hash.digest("hex");
  } finally {
    closeSync(source);
  }
}

export function copyVerificationFixtures(temporary: string, entries: string[]) {
  const env: Record<string, string> = {};
  const digests: Record<string, string> = {};
  const dir = join(temporary, "fixtures");
  mkdirSync(dir, { mode: 0o700 });
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    const name = entry.slice(0, separator),
      source = entry.slice(separator + 1);
    // A fixture may name its file, but must never override Git, Bun or other runtime settings.
    if (
      separator < 1 ||
      !/^(?:FORGE_FIXTURE_[A-Z0-9_]+|[A-Z][A-Z0-9_]*_(?:TEST|FIXTURE)_(?:FILE|ARCHIVE))$/.test(name) ||
      !isAbsolute(source)
    )
      throw Error(
        "Expected --fixture-env NAME=/absolute/file with a FORGE_FIXTURE_ prefix or _TEST_FILE, _TEST_ARCHIVE, _FIXTURE_FILE or _FIXTURE_ARCHIVE suffix",
      );
    if (Object.hasOwn(env, name)) throw Error("Duplicate fixture name: " + name);
    const path = join(dir, name);
    const destination = openSync(path, "wx", 0o400);
    try {
      digests[name] = digestFile(source, destination);
    } catch {
      throw Error(
        "Cannot copy fixture " + name + "; supply a readable regular file with no symlink at its final path",
      );
    } finally {
      closeSync(destination);
    }
    env[name] = path;
  }
  return {
    env,
    digests,
    verify() {
      for (const [key, path] of Object.entries(env))
        if (digestFile(path) !== digests[key]) throw Error("Verification changed fixture " + key);
    },
  };
}
