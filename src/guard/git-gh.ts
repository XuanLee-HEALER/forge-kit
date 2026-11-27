import type { WorkbenchConfig } from "../config";
import { extractGitSubcommand, requestsForcedPush } from "../shared/git-cmd";
import { expandEnvSplitStrings, splitShellSegments, splitShellTokens, stripUnquotedShellRedirections, unwrapShellPrefix } from "../shared/shell";

export function checkGitPhysicalFuse(cmd: string, cfg: WorkbenchConfig): string | null {
  for (const segment of splitShellSegments(cmd)) {
    const words = splitShellTokens(stripUnquotedShellRedirections(segment)) ?? [];
    const prefix = unwrapShellPrefix(words);
    const git = prefix.bin === "git" ? extractGitSubcommand(["git", ...prefix.args]) :
      prefix.ambiguous ? extractGitSubcommand(expandEnvSplitStrings(words)) : null;
    if (!git) continue;
    // Shared worktree destructive operations
    if (cfg.guard.block_shared_worktree_ops) {
      if (git.subcmd === "stash") {
        // Allow strictly read-only `git stash list` and `git stash show`
        const firstArg = git.subArgs.find((a) => !a.startsWith("-")) ?? "";
        if (firstArg !== "list" && firstArg !== "show") {
          return "物理保险丝（共享工作树）：禁止写入型 `git stash`，工作树可能存在用户未提交改动。";
        }
      }
      if (git.subcmd === "restore") {
        return "物理保险丝（共享工作树）：禁止 `git restore`，工作树可能存在用户未提交改动。";
      }
      if (git.subcmd === "reset") {
        return "物理保险丝（共享工作树）：禁止 `git reset`，工作树可能存在用户未提交改动。";
      }
      if (git.subcmd === "clean" && git.subArgs.some((a) => /^-[a-z]*f/.test(a) || a === "--force")) {
        return "物理保险丝（共享工作树）：禁止 `git clean -f`。";
      }
      if (git.subcmd === "checkout" && git.subArgs.includes("--")) {
        return "物理保险丝（共享工作树）：禁止 `git checkout -- <path>` 丢弃工作区改动。";
      }
      if (git.subcmd === "commit" && git.subArgs.includes("--amend")) {
        return "物理保险丝（共享工作树）：禁止 `git commit --amend`。";
      }
      if (
        git.subcmd === "add" &&
        git.subArgs.some(
          (a) => a === "-A" || a === "--all" || a === "." || a === "./" || a === "-u" || a === "--update",
        )
      ) {
        return "物理保险丝（共享工作树）：禁止 `git add -A / . / -u`，请逐文件 `git add <file>` 并带 pathspec 提交。";
      }
    }

    if (git.subcmd === "push" && requestsForcedPush(git.subArgs))
      return "物理保险丝：禁止强制推送或使用强制 refspec 覆盖远端历史。";
  }
  return null;
}
