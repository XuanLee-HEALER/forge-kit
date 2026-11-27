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
let live = true;
let reason = "";
child.on("exit", () => { live = false; });

function stop(message: string) {
  if (reason) return;
  reason = message;
  if (live && child.pid && child.exitCode === null && child.signalCode === null) killTree(child.pid);
  child.stdout!.destroy();
  child.stderr!.destroy();
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
const flushStdout = capture(child.stdout!);
const flushStderr = capture(child.stderr!);
function killTree(pid: number) {
  // A nested verifier or build tool can start its own process group.
  const table = spawnSync("/bin/ps", ["-Ao", "pid=,ppid=,pgid="], {encoding: "utf8", timeout: 1000});
  const children = new Map<number, number[]>();
  const groups = new Map<number, number>();
  for (const row of (table.stdout ?? "").trim().split("\n")) {
    const [id, parent, group] = row.trim().split(/\s+/).map(Number);
    if (!id || !parent) continue;
    groups.set(id, group);
    const list = children.get(parent) ?? [];
    list.push(id);
    children.set(parent, list);
  }
  // A finished child can leave inherited pipes open. Its former PID cannot
  // identify any process after reaping, even if the close event is pending.
  if (table.status !== 0) { child.kill("SIGKILL"); return; }
  if (!children.get(process.pid)?.includes(pid)) return;
  const tree = [pid];
  for (const parent of tree) tree.push(...children.get(parent) ?? []);
  // Signal detached descendants separately, then the original group once.
  // Do not reuse its leader's numerical PID after killing that group.
  for (const target of [...tree.reverse().filter(id => id !== pid && groups.get(id) !== pid), -pid]) {
    try { process.kill(target, "SIGKILL"); }
    catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") reason += "; cannot stop verification process (" + code + ")";
    }
  }
}
const timer = setTimeout(() => {
  stop((live ? "Verification" : "Verification output drain") + " timed out after " + timeout + " ms");
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
