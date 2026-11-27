// This process starts a new group before launching the command. It owns its
// PGID through pipe draining, even after the command's former PID is reused.
import { spawn, spawnSync } from "node:child_process";
let drained = false;
process.on("disconnect", () => {
  if (drained) return;
  try {
    // Nested verifiers and build tools can start another process group.
    const table = spawnSync("/bin/ps", ["-Ao", "pid=,ppid=,pgid="], {encoding:"utf8", timeout:1000});
    const children = new Map<number, number[]>(), groups = new Map<number, number>();
    for (const row of (table.stdout ?? "").trim().split("\n")) {
      const [id, parent, group] = row.trim().split(/\s+/).map(Number);
      if (!id || !parent) continue;
      groups.set(id, group);
      const list = children.get(parent) ?? [];
      list.push(id);
      children.set(parent, list);
    }
    const tree = [process.pid];
    for (const id of tree) tree.push(...children.get(id) ?? []);
    for (const id of tree.reverse()) {
      if (id !== process.pid && groups.get(id) !== process.pid) {
        try { process.kill(id, "SIGKILL"); }
        catch (err) { if ((err as NodeJS.ErrnoException).code !== "ESRCH") process.stderr.write("Cannot stop verification descendant\n"); }
      }
    }
  } finally {
    process.kill(-process.pid, "SIGKILL");
  }
});

process.once("message", (job: {argv: string[]; cwd: string; env: NodeJS.ProcessEnv}) => {
  const command = spawn(job.argv[0], job.argv.slice(1), {cwd: job.cwd, env: job.env, stdio:["ignore","pipe","pipe"]});
  command.stdout.pipe(process.stdout);
  command.stderr.pipe(process.stderr);
  command.on("error", error => { if (process.connected) process.send?.({reason: error.message}); });
  command.on("exit", (_code, signal) => {
    if (process.connected) process.send?.({reason: signal ? "Process terminated by " + signal : ""});
  });
  command.on("close", code => {
    drained = true;
    process.exitCode = code === null || code < 0 ? 1 : code;
    if (process.connected) process.disconnect?.();
  });
});
