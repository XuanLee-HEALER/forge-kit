import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, statSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { taskRunDirectory } from "./ledger/task-runs";
import { StringDecoder } from "node:string_decoder";
import { redactSecrets, redactWithPatterns, SECRET_PATTERNS } from "./shared/redact";
// @ts-expect-error Bun embeds this module for the child interpreter.
import supervisor from "./verification-supervisor.ts" with {type: "text"};

// @ts-expect-error Bun embeds the streaming redactor alongside the supervisor.
import streamRedactor from "./verification-redactor.ts" with {type: "text"};

// @ts-expect-error Bun embeds the separate process-group leader.
import groupProgram from "./verification-group.ts" with {type: "text"};

export const defaultVerificationTimeout = 120_000;
const patterns = SECRET_PATTERNS.map(([pattern, replacement]) => `[${pattern}, ${JSON.stringify(replacement)}]`);
export const verificationSupervisorSource = `const patterns = [${patterns}];
const redactSecrets = text => (${redactWithPatterns.toString()})(text, patterns);
${streamRedactor}
const groupProgram = ${JSON.stringify(groupProgram)};
${supervisor}`;

function writerGone(path: string, pid?: string) {
  if (pid) {
    try { process.kill(Number(pid), 0); }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
    if (process.platform === "linux") {
      // Match the inode because the supervisor opens it via the CLI's link.
      const directory = "/proc/" + pid + "/fd";
      try {
        const file = lstatSync(path);
        return !readdirSync(directory).some(fd => {
          const open = statSync(join(directory, fd), {throwIfNoEntry: false});
          return open?.dev === file.dev && open.ino === file.ino;
        });
      } catch { return false; }
    }
  }
  // Older names have no owner. Remove only when the OS confirms no open fd.
  const lsof = Bun.which("lsof", { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" });
  if (!lsof) return false;
  const check = spawnSync(lsof, ["-nP", ...(pid ? ["-a", "-p", pid] : []), "-t", "--", path], {timeout: 1000, encoding: "utf8"});
  return check.status === 1 && !check.stdout && !check.stderr && !check.error;
}

export function verificationLogDirectory(root: string, retentionDays: number, task?: string) {
  let dir = task ? taskRunDirectory(root, task) : join(root, ".workbench");
  for (const name of task ? ["verify"] : ["logs", "verify"]) {
    dir = join(dir, name);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!lstatSync(dir).isDirectory()) throw Error("Expected verification log directory: " + dir);
  }
  chmodSync(dir, 0o700);
  try { writeFileSync(join(dir, ".gitignore"), "*\n", {flag: "wx", mode: 0o600}); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const cutoff = Date.now() - retentionDays * 86_400_000;
  for (const name of readdirSync(dir)) {
    const owned = /^verify-[0-9a-f-]{36}(?:\.([1-9][0-9]{0,9}))?\.(active|log)$/.exec(name);
    if (!owned) continue;
    const path = join(dir, name);
    const stat = lstatSync(path, {throwIfNoEntry: false});
    if (stat?.isFile() && stat.mtimeMs < cutoff && (owned[2] === "log" || writerGone(path, owned[1]))) rmSync(path, {force: true});
  }
  return dir;
}

export class VerificationLog {
  private readonly path: string;
  private readonly active: string;
  private readonly fd: number;
  private closed = false;
  private unsavedNote = "";
  constructor(dir: string) {
    this.path = join(dir, "verify-" + randomUUID());
    this.active = this.path + "." + process.pid + ".active";
    this.fd = openSync(this.active, "wx+", 0o600);
  }

  run(argv: string[], cwd: string, env: NodeJS.ProcessEnv, timeout = defaultVerificationTimeout, inspect?: (lines: string) => void) {
    const start = fstatSync(this.fd).size;
    const proc = spawnSync(process.execPath, ["-e", verificationSupervisorSource], {
      timeout: Math.min(2_147_483_647, timeout + 2500), killSignal: "SIGKILL",
      cwd: dirname(process.execPath), env: {PATH: process.env.PATH}, stdio: ["pipe", "ignore", "pipe", this.fd],
      input: JSON.stringify({argv, cwd, env, timeout, active: this.active}), encoding: "utf8",
    });
    const termination = (proc.error as NodeJS.ErrnoException)?.code === "ETIMEDOUT"
      ? "Verification supervisor timed out after " + timeout + " ms" : redactSecrets(proc.error?.message || proc.stderr || "");
    if (termination) this.note(termination);
    let partial = "";
    const decoder = new StringDecoder("utf8");
    if (inspect) {
      this.read(start, chunk => {
        const text = decoder.write(chunk);
        for (const line of text.split(/(?<=\n)/)) {
          if (partial.length < 65536) partial += line.slice(0, 65536 - partial.length);
          if (line.endsWith("\n")) { inspect(partial); partial = ""; }
        }
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
    const clean = redactSecrets(message);
    try { writeFileSync(this.fd, "\n" + clean + "\n"); }
    catch (error) {
      this.unsavedNote = clean.slice(-2048) + "\nCannot append to verification log: " +
        redactSecrets(error instanceof Error ? error.message : String(error));
    }
  }

  finish(failed: boolean, keepOutput = false) {
    const hash = createHash("sha256");
    let tail = Buffer.alloc(0);
    this.read(0, chunk => {
      hash.update(chunk);
      if (failed) tail = Buffer.concat([tail, chunk]).subarray(-2048);
    });
    const result = { output_sha256: hash.digest("hex"), ...(failed && {
      output_excerpt: [tail.toString().trim(), this.unsavedNote].filter(Boolean).join("\n") || "Verification failed without output", log_path: this.path + ".log",
    }) };
    const path = this.path + (failed ? ".log" : ".passed.log");
    if (failed || keepOutput) renameSync(this.active, path);
    this.dispose();
    return keepOutput ? {...result, log_path: path} : result;
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.fd);
    rmSync(this.active, {force: true});
  }
}
