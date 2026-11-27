// Embedded alongside the shared redactor in a separate Bun process. fd 3 is
// the parent's already-open private log. The project never inherits that fd.
import { linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
declare function verificationRedactor(write: (data: string) => void): {write(data: string): void; finish(): void};
declare function redactSecrets(text: string): string;

const { argv, cwd, env, timeout, active } = JSON.parse(readFileSync(0, "utf8"));
// Each writer owns a link. Expiring a dead CLI's link leaves the open
// supervisor's link in place, including while it is draining child output.
const writer = active.replace(/\.\d+\.active$/, "." + process.pid + ".active");
linkSync(active, writer);
process.on("exit", () => unlinkSync(writer));
const child = spawn(argv[0], argv.slice(1), {
  cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true,
});
function capture(stream: NodeJS.ReadableStream) {
  const redactor = verificationRedactor(data => writeFileSync(3, data, "latin1"));
  stream.setEncoding("latin1");
  stream.on("data", redactor.write);
  return redactor.finish;
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
  // A reparented process can still own the write end of either pipe.
  child.stdout!.destroy();
  child.stderr!.destroy();
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
