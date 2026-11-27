import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { redactSecrets, redactWithPatterns, SECRET_PATTERNS } from "./shared/redact";
// @ts-expect-error Bun embeds this module for the child interpreter.
import supervisor from "./verification-supervisor.ts" with {type: "text"};

export const defaultVerificationTimeout = 120_000;
const patterns = SECRET_PATTERNS.map(([pattern, replacement]) => `[${pattern}, ${JSON.stringify(replacement)}]`);
const supervisorSource = `const patterns = [${patterns}];
const redactSecrets = text => (${redactWithPatterns.toString()})(text, patterns);
${supervisor}`;

export function verificationLogDirectory(root: string, retentionDays: number) {
  let dir = join(root, ".workbench");
  for (const name of ["logs", "verify"]) {
    dir = join(dir, name);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!lstatSync(dir).isDirectory()) throw Error("Expected verification log directory: " + dir);
  }
  chmodSync(dir, 0o700);
  try { writeFileSync(join(dir, ".gitignore"), "*\n", {flag: "wx", mode: 0o600}); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const cutoff = Date.now() - retentionDays * 86_400_000;
  for (const name of readdirSync(dir)) {
    if (!/^verify-[0-9a-f-]{36}\.log$/.test(name)) continue;
    const path = join(dir, name);
    const stat = lstatSync(path, {throwIfNoEntry: false});
    if (stat?.isFile() && stat.mtimeMs < cutoff) rmSync(path, {force: true});
  }
  return dir;
}

export class VerificationLog {
  private readonly path: string;
  private readonly fd: number;
  private closed = false;
  constructor(dir: string) {
    this.path = join(dir, "verify-" + randomUUID());
    this.fd = openSync(this.path + ".active", "wx+", 0o600);
  }

  run(argv: string[], cwd: string, env: NodeJS.ProcessEnv, timeout = defaultVerificationTimeout, inspect?: (lines: string) => void) {
    const start = fstatSync(this.fd).size;
    const proc = spawnSync(process.execPath, ["-e", supervisorSource], {
      cwd: dirname(process.execPath), env: {PATH: process.env.PATH}, stdio: ["pipe", "ignore", "pipe", this.fd],
      input: JSON.stringify({argv, cwd, env, timeout}), encoding: "utf8",
    });
    const termination = redactSecrets(proc.error?.message || proc.stderr || "");
    if (termination) this.note(termination);
    let partial = "";
    const decoder = new StringDecoder("utf8");
    if (inspect) {
      this.read(start, chunk => {
        const text = decoder.write(chunk);
        const end = text.lastIndexOf("\n");
        if (end >= 0) {
          inspect(partial + text.slice(0, end + 1));
          partial = text.slice(end + 1);
        } else partial += text;
      });
      inspect(partial + decoder.end());
    }
    const end = fstatSync(this.fd).size;
    const tail = Buffer.alloc(Math.min(end - start, 2048));
    if (tail.length) readSync(this.fd, tail, 0, tail.length, end - tail.length);
    return { code: proc.status ?? 1, stdout: tail.toString(), stderr: "", termination };
  }

  read(offset: number, consume: (chunk: Buffer) => void) {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes;
    while ((bytes = readSync(this.fd, buffer, 0, buffer.length, offset)) > 0) {
      offset += bytes;
      consume(buffer.subarray(0, bytes));
    }
  }

  note(message: string) {
    writeFileSync(this.fd, "\n" + redactSecrets(message) + "\n");
  }

  finish(failed: boolean) {
    const hash = createHash("sha256");
    let tail = Buffer.alloc(0);
    this.read(0, chunk => {
      hash.update(chunk);
      if (failed) tail = Buffer.concat([tail, chunk]).subarray(-2048);
    });
    const result = { output_sha256: hash.digest("hex"), ...(failed && {
      output_excerpt: tail.toString().trim() || "Verification failed without output", log_path: this.path + ".log",
    }) };
    if (failed) renameSync(this.path + ".active", this.path + ".log");
    this.dispose();
    return result;
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.fd);
    rmSync(this.path + ".active", {force: true});
  }
}
