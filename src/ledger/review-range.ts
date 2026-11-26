import { normalizeReviewRole } from "./types";
import { runGit } from "../git";
import { resolveTaskCheckout } from "./checkout";
import type { TaskRepoRecord } from "./types";

export function coversReviewBase(
  root: string,
  attachment: Pick<TaskRepoRecord, "repo" | "branch" | "worktree" | "base_sha">,
  base: unknown,
): boolean {
  if (!attachment.base_sha) return false;
  if (typeof base !== "string" || !/^[a-f0-9]{7,64}$/i.test(base)) return false;
  if (base === attachment.base_sha) return true;
  if (!/^[a-f0-9]{7,64}$/i.test(attachment.base_sha)) return false;
  const { dir } = resolveTaskCheckout(root, attachment);
  const resolve = (sha: string) => runGit(dir, ["rev-parse", "--verify", sha + "^{commit}"]);
  const reviewed = resolve(base), recorded = resolve(attachment.base_sha);
  return reviewed.code === 0 && recorded.code === 0 && reviewed.stdout === recorded.stdout;
}

export function reviewMeetsFloor(status: string, meta: { role?: string; started_at?: string; review_floor_seq?: number; review_task_id?: string } | undefined,
  task: string, floor: number, floorTime?: string, source?: string): boolean {
  if (source === "hook" && status === "pass" && normalizeReviewRole(meta?.role) !== "codex-review")
    return meta?.review_task_id === task && meta.review_floor_seq === floor;
  if (meta?.review_task_id !== undefined && meta.review_task_id !== task) return false;
  if (meta?.review_floor_seq !== undefined) return meta.review_floor_seq === floor && (!floor || meta.review_task_id === task);
  if (!floor) return true;
  if (status !== "fail") return false;
  if (meta?.started_at !== undefined) return !!floorTime && Date.parse(meta.started_at) > Date.parse(floorTime);
  return true; // Undated legacy failures still require resolution.
}
