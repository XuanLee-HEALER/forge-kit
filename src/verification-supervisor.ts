// Embedded alongside the shared redactor in a separate Bun process. fd 3 is
// the parent's already-open private log. The project never inherits that fd.
import { linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
declare const groupProgram: string;
declare function verificationRedactor(write: (data: string) => void): {write(data: string): void; finish(): void};
declare function redactSecrets(text: string): string;

const { argv, cwd, env, timeout, active } = JSON.parse(readFileSync(0, "utf8"));
// Each writer owns a link. Expiring a dead CLI's link leaves the open
// supervisor's link in place, including while it is draining child output.
const writer = active.replace(/\.\d+\.active$/, "." + process.pid + ".active");
linkSync(active, writer);
process.on("exit", () => unlinkSync(writer));
const owner = spawn(process.execPath, ["-e", groupProgram], {
  stdio: ["ignore", "pipe", "pipe", "ipc"], detached: true,
});
let outcome: {reason: string} | undefined;
let reason = "";
owner.on("message", message => { outcome = message as {reason: string}; });
owner.send({argv, cwd, env}, error => { if (error) stop(error.message); });

function stop(message: string) {
  if (reason) return;
  reason = message;
  // Only the live group leader receives this cancellation. It signals its
  // own group; the supervisor never targets a stored PID or PGID.
  if (owner.connected) owner.disconnect();
}

function capture(stream: NodeJS.ReadableStream) {
  const redactor = verificationRedactor(data => writeFileSync(3, data, "latin1"));
  stream.setEncoding("latin1");
  function write(chunk?: string) {
    try {
      if (chunk === undefined) redactor.finish();
      else redactor.write(chunk);
    } catch (error) {
      stop("Cannot write verification log: " + (error instanceof Error ? error.message : String(error)));
    }
  }
  stream.on("data", write);
  return () => write();
}
const flushStdout = capture(owner.stdout!);
const flushStderr = capture(owner.stderr!);
const timer = setTimeout(() => {
  stop((outcome ? "Verification output drain" : "Verification") + " timed out after " + timeout + " ms");
}, timeout);
owner.on("error", error => { reason = error.message; });
owner.on("close", (code, signal) => {
  clearTimeout(timer);
  flushStdout();
  flushStderr();
  if (!reason) {
    if (signal) reason = "Verification group leader terminated by " + signal;
    else reason = outcome?.reason ?? "Verification command returned no status";
  }
  if (reason) process.stderr.write(redactSecrets(reason));
  process.exitCode = reason || code === null || code < 0 ? 1 : code;
});
