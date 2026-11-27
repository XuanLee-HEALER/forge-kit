// Embedded alongside the shared redactor in a separate Bun process. fd 3 is
// the parent's already-open private log. The project never inherits that fd.
import { readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
declare function redactSecrets(text: string): string;

const { argv, cwd, env, timeout } = JSON.parse(readFileSync(0, "utf8"));
const child = spawn(argv[0], argv.slice(1), {
  cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true,
});
function capture(stream: NodeJS.ReadableStream) {
  let partial = "";
  // Latin-1 maps each byte reversibly, including non-UTF-8 compiler output.
  stream.setEncoding("latin1");
  stream.on("data", (chunk: string) => {
    const end = chunk.lastIndexOf("\n");
    if (end < 0) {
      partial += chunk;
      return;
    }
    writeFileSync(3, redactSecrets(partial + chunk.slice(0, end + 1)), "latin1");
    partial = chunk.slice(end + 1);
  });
  return () => { if (partial) writeFileSync(3, redactSecrets(partial), "latin1"); };
}
const flushStdout = capture(child.stdout!);
const flushStderr = capture(child.stderr!);
function killTree(pid: number) {
  // A nested verifier or build tool can start its own process group.
  const table = spawnSync("/bin/ps", ["-Ao", "pid=,ppid="], {encoding: "utf8", timeout: 1000});
  const children = new Map<number, number[]>();
  for (const row of (table.stdout ?? "").trim().split("\n")) {
    const [id, parent] = row.trim().split(/\s+/).map(Number);
    if (!id || !parent) continue;
    const list = children.get(parent) ?? [];
    list.push(id);
    children.set(parent, list);
  }
  const tree = [pid];
  for (const parent of tree) tree.push(...children.get(parent) ?? []);
  for (const target of [-pid, ...tree.reverse()]) {
    try { process.kill(target, "SIGKILL"); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err; }
  }
}
let reason = "";
const timer = setTimeout(() => {
  reason = "Verification timed out after " + timeout + " ms";
  if (child.pid) killTree(child.pid);
}, timeout);
child.on("error", error => { reason = error.message; });
child.on("close", (code, signal) => {
  clearTimeout(timer);
  flushStdout();
  flushStderr();
  if (!reason && signal) reason = "Process terminated by " + signal;
  if (reason) process.stderr.write(redactSecrets(reason));
  process.exitCode = reason || code === null || code < 0 ? 1 : code;
});
