import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { localPath } from "../instance";

/**
 * Kernel-enforced exclusive lock using SQLite `BEGIN IMMEDIATE` (OS POSIX fcntl byte-range lock).
 * Eliminates userspace mkdir/PID stale-lock races completely: the OS automatically releases
 * the lock on process crash/SIGKILL and never steals a lock from a paused live holder.
 */
export function withConfigWriteLock<T>(yamlPath: string, fn: () => T): T {
  const lockDbPath = localPath(dirname(yamlPath), "ledger/config-lock.sqlite");
  mkdirSync(dirname(lockDbPath), { recursive: true });
  const db = new Database(lockDbPath, { create: true });
  try {
    db.exec("PRAGMA busy_timeout = 60000;");
    db.exec("BEGIN IMMEDIATE;");
    try {
      const result = fn();
      db.exec("COMMIT;");
      return result;
    } catch (e) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        // Ignore rollback failure
      }
      throw e;
    }
  } finally {
    db.close();
  }
}
