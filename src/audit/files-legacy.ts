import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { ledgerDbPath, type EventRecord, type LedgerReader, type TaskRecord, type TaskRepoRecord } from "../ledger/types";
import { auditSecretKey, redactAuditArguments, redactAuditText } from "../shared/redact";
import { auditChild, auditDirectory, auditFile, auditStat, requireAuditTask, tempPrefix, writePrivateFile } from "./files-path";

export type ArchiveLedger = LedgerReader & { readonly dbPath?: string };

function safePayload(raw: string): string {
  try {
    // Decode JSON escaping before applying CLI, PEM and contact rules to string fields.
    let changed = false;
    function clean(value: unknown): unknown {
      if (typeof value === "string") {
        const safe = redactAuditText(value);
        changed ||= safe !== value;
        return safe;
      }
      if (Array.isArray(value)) {
        if (!value.every(arg => typeof arg === "string")) return value.map(clean);
        const safe = redactAuditArguments(value);
        changed ||= safe.some((arg, i) => arg !== value[i]);
        return safe;
      }
      if (value === null || typeof value !== "object") return value;
      const result: Record<string, unknown> = Object.create(null);
      for (const [name, entry] of Object.entries(value)) {
        const safe = redactAuditText(name);
        let key = safe;
        for (let n = 2; Object.hasOwn(result, key); n++) key = safe + " #" + n;
        const count = typeof entry === "number" && /(?:^|_)tokens?(?:_count)?$/i.test(name);
        const secret = auditSecretKey.test(name) && !count && typeof entry !== "boolean";
        changed ||= key !== name || secret;
        result[key] = secret ? "***" : clean(entry);
      }
      return result;
    }
    const result = JSON.stringify(clean(JSON.parse(raw)));
    return changed ? result : raw;
  } catch {
    return "[unreadable ledger payload]";
  }
}

export function legacyArchiveText(task: TaskRecord, repos: TaskRepoRecord[], events: EventRecord[]): string {
  const safe = redactAuditText;
  const lines = [
    `# Task Ledger Archive: ${safe(task.task_id)}`,
    "",
    `- **Title**: ${safe(task.title)}`,
    `- **Status**: ${task.status}`,
    `- **Endpoint / Depth**: ${safe(task.endpoint)} / ${task.verification_depth}`,
    `- **Created / Closed**: ${safe(task.created_at)} → ${safe(task.closed_at ?? "-")}`,
    `- **Chain Tip Hash**: \`${safe(task.tip_hash)}\``,
    "",
    "## Repositories",
    "",
  ];
  if (repos.length === 0) lines.push("- (none)");
  for (const repo of repos) {
    lines.push(
      `- \`${safe(repo.repo)}\` (${safe(repo.branch)}): base=\`${safe(repo.base_sha ?? "-")}\`, head=\`${safe(repo.head_sha ?? "-")}\``,
    );
  }
  lines.push("", "## Event Chain", "");
  for (const event of events) {
    lines.push(
      `- \`#${event.seq}\` [${safe(event.ts)}] **${safe(event.event_type)}** (${safe(event.actor)}${event.repo ? `, ${safe(event.repo)}` : ""}${event.sha ? `@${safe(event.sha.slice(0, 8))}` : ""}) \`${safe(event.entry_hash)}\`: ${safePayload(event.payload_json)}`,
    );
  }
  return lines.join("\n") + "\n";
}

export function prepareLegacyArchive(
  ledger: ArchiveLedger, task: string, ts: string, content: string,
) {
  requireAuditTask(task);
  const month = ts.slice(0, 7);
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) throw Error("Invalid legacy archive month");
  const dbDir = dirname(ledger.dbPath ?? ledgerDbPath(ledger.workbenchRoot));
  const segments = relative(resolve(ledger.workbenchRoot), resolve(dbDir)).split(/[\\/]/).filter(Boolean);
  if (segments[0] === "..") throw Error("Legacy archive is outside the workbench");
  const directory = (create: boolean) => {
    let path = auditDirectory(resolve(ledger.workbenchRoot), false);
    for (const segment of [...segments, "archive", month]) {
      path = path && auditDirectory(auditChild(path, segment), false, create);
    }
    if (!path) throw Error("Legacy archive directory is unavailable");
    return path;
  };
  const dir = directory(true);
  if (!(auditStat(dir)!.mode & 0o200)) throw Error("Legacy archive directory is not writable");
  const file = task + ".md";
  const archivePath = auditChild(dir, file);
  auditFile(archivePath, false);
  const temporary = mkdtempSync(join(dir, tempPrefix));
  const draft = join(temporary, file);
  const cleanup = () => {
    if (directory(false) === dir && auditDirectory(temporary, true)) rmSync(temporary, { recursive: true });
  };
  try {
    auditDirectory(temporary, true);
    writePrivateFile(draft, content);
  } catch (error) {
    cleanup();
    throw error;
  }
  return {
    archivePath,
    cleanup,
    publish() {
      auditFile(auditChild(directory(false), file), false);
      renameSync(draft, archivePath);
    },
  };
}

export function exportArchive(ledger: ArchiveLedger, taskId: string, closedTs?: string): string {
  requireAuditTask(taskId);
  const task = ledger.getTask(taskId);
  if (!task) throw Error("Task not found");
  const draft = prepareLegacyArchive(
    ledger, taskId, closedTs ?? task.closed_at ?? task.updated_at,
    legacyArchiveText(task, ledger.getTaskRepos(taskId), ledger.getTaskEvents(taskId)),
  );
  try {
    draft.publish();
    return draft.archivePath;
  } finally {
    draft.cleanup();
  }
}
