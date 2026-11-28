import { redactAuditText } from "../shared/redact";
import { applyGit } from "./catalog";

const changeLimit = 30;
const subjectLimit = 10;

export const pathsIntersect = (first: string, second: string): boolean =>
  first === "." || second === "." || first === second ||
  first.startsWith(second + "/") || second.startsWith(first + "/");

export function safeDisplay(text: string): string {
  return redactAuditText(text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)|\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\p{Cc}\p{Cf}]+/gu, " "));
}

export function readProbeGit(dir: string, args: string[]): string {
  const result = applyGit(dir, args);
  if (result.code) {
    const detail = safeDisplay(result.stderr.trim()).slice(0, 280);
    throw Error("Git " + args[0] + " failed (exit " + result.code + ")" + (detail ? ": " + detail : ""));
  }
  return result.stdout;
}

interface NameStatus {
  status: string;
  path: string;
  old_path?: string;
}

function nulRecords(raw: string): string[] {
  if (!raw) return [];
  if (!raw.endsWith("\0")) throw Error("Incomplete Git output");
  return raw.slice(0, -1).split("\0");
}

export function probeDiff(
  dir: string, base: string, head: string, anchors: string[],
) {
  const args = ["diff", "--no-ext-diff", "--no-textconv", "--no-relative", "--no-color", "-O/dev/null",
    "--submodule=short", "--ignore-submodules=none", "--find-renames", "-z"];
  const names = nulRecords(readProbeGit(dir, [...args, "--name-status", base, head, "--", ...anchors]));
  let fileCount = 0;
  const changes: NameStatus[] = [];
  for (let i = 0; i < names.length;) {
    const status = names[i++];
    const from = names[i++];
    const path = /^[RC]/.test(status) ? names[i++] : from;
    if (!from || !path || !/^(?:[RC]\d+|[ADMTUXB]\d*)$/.test(status))
      throw Error("Invalid Git name-status record");
    fileCount++;
    if (changes.length < changeLimit) changes.push({
      status, path, ...(from !== path ? { old_path: from } : {}),
    });
  }
  return { args, fileCount, changes };
}

export function diffDetails(
  dir: string, base: string, head: string, anchors: string[],
  diff: ReturnType<typeof probeDiff>, commitCount: number | null,
) {
  const stats = nulRecords(readProbeGit(dir, [...diff.args, "--numstat", base, head, "--", ...anchors]));
  let insertions = 0;
  let deletions = 0;
  let binaryFiles = 0;
  for (let i = 0; i < stats.length;) {
    const record = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(stats[i++]);
    if (!record) throw Error("Invalid Git numstat record");
    const from = record[3] || stats[i++];
    const to = record[3] || stats[i++];
    if (!from || !to) throw Error("Incomplete Git numstat record");
    if (record[1] === "-" || record[2] === "-") binaryFiles++;
    else {
      insertions += Number(record[1]);
      deletions += Number(record[2]);
    }
  }
  const raw = readProbeGit(dir, ["log", "--full-history", "--no-show-signature", "--no-notes",
    "-z", "--format=%h%x00%s", "--max-count=" + (subjectLimit + 1), base + ".." + head, "--", ...anchors]);
  const subjects = nulRecords(raw);
  if (subjects.length % 2) throw Error("Incomplete Git commit subjects");
  const commits: { sha: string; subject: string }[] = [];
  let shortenedSubject = false;
  for (let i = 0; i < Math.min(subjects.length, subjectLimit * 2); i += 2) {
    if (!/^[a-f0-9]+$/.test(subjects[i])) throw Error("Invalid Git short OID");
    const subject = safeDisplay(subjects[i + 1]);
    const chars = [...subject];
    if (chars.length > 160) shortenedSubject = true;
    commits.push({ sha: subjects[i], subject: chars.length > 160 ? chars.slice(0, 159).join("") + "…" : subject });
  }
  return {
    commits, name_status: diff.changes,
    numstat: { files_changed: diff.fileCount, insertions, deletions, binary_files: binaryFiles },
    truncated: diff.fileCount > diff.changes.length || subjects.length > subjectLimit * 2 ||
      (commitCount !== null && commitCount > subjects.length / 2) ||
      shortenedSubject,
  };
}
