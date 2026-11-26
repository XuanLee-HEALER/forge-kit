import { type WorkbenchConfig } from "../config";
import { extractGitSubcommand, resolveGitDirFlags } from "../shared/git-cmd";
import { runGit } from "../git";
import {
  extractShellCommand,
  extractToolWorkdir,
  extractTouchedFilePaths,
  type CodexHookInput,
} from "../hook-io";
import { activeSpecTaskIds, listActiveSpecLocks } from "../ledger/spec";
import { Ledger } from "../ledger/store";
import { existsSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { canonicalizeMaybePath, matchesGlob } from "../shared/path";
import {
  unwrapShellPrefix,
  resolveSegmentCwd,
  splitShellSegments,
  splitShellTokens,
  stripUnquotedShellRedirections,
} from "../shared/shell";

export function checkSpecAndTestLocks(
  workbenchRoot: string,
  input: CodexHookInput,
  cfg: WorkbenchConfig,
): string | null {
  if (!cfg.ledger.enabled) return null;
  const dbPath = join(workbenchRoot, ".workbench", "ledger", "ledger.sqlite");
  if (!existsSync(dbPath)) return null;

  const wbReal = canonicalizeMaybePath(workbenchRoot);
  const baseWorkdir = extractToolWorkdir(input);
  const touchedFilePaths = extractTouchedFilePaths(input).map((p) =>
    canonicalizeMaybePath(resolve(baseWorkdir, p)),
  );
  const cmd = extractShellCommand(input);
  if (touchedFilePaths.length === 0 && !cmd) return null;

  let ledger: Ledger | null = null;
  try {
    ledger = new Ledger(workbenchRoot);
    const activeLocks = listActiveSpecLocks(ledger, true);
    if (activeLocks.length === 0) return null;

    const allOpenBoundWorktrees = new Set<string>();
    for (const openTask of activeSpecTaskIds(ledger)) {
      for (const r of ledger.getTaskRepos(openTask.task_id)) {
        if (r.worktree) allOpenBoundWorktrees.add(canonicalizeMaybePath(r.worktree));
      }
    }

    type UnboundWorktreeMatcher = { worktreesDir: string; branch: string };
    type ResolvedLock = {
      task_id: string;
      lockedSpecFiles: Array<{ kind: "ssot" | "tech_spec" | "test_spec" | "scope"; abs: string; rel: string }>;
      lockedTestGlobs: string[];
      explicitRoots: string[];
      unboundWorktrees: UnboundWorktreeMatcher[];
    };

    const resolvedLocks: ResolvedLock[] = activeLocks.map((st) => {
      const scopes = new Set(st.state === "AMENDED" ? st.amend_scopes : []);
      const unlockedSsot = scopes.has("requirement") || scopes.has("invariant");
      const unlockedTech = unlockedSsot || scopes.has("tech_spec");
      const unlockedTest = unlockedSsot || scopes.has("test_spec");

      const lockedSpecFiles: ResolvedLock["lockedSpecFiles"] = [];
      for (const kind of ["ssot", "tech_spec", "test_spec", "scope"] as const) {
        if (!st.files?.[kind] || { ssot: unlockedSsot, tech_spec: unlockedTech, test_spec: unlockedTest, scope: scopes.size > 0 }[kind]) continue;
        const rel = st.files[kind];
        lockedSpecFiles.push({ kind, rel, abs: canonicalizeMaybePath(resolve(wbReal, rel)) });
      }
      const taskRepos = ledger!.getTaskRepos(st.task_id);
      const explicitRoots: string[] = [];
      const unboundWorktrees: UnboundWorktreeMatcher[] = [];
      for (const r of taskRepos) {
        if (r.worktree) {
          explicitRoots.push(canonicalizeMaybePath(r.worktree));
        } else {
          explicitRoots.push(canonicalizeMaybePath(resolve(wbReal, r.repo)));
          unboundWorktrees.push({
            worktreesDir: canonicalizeMaybePath(resolve(wbReal, `${r.repo}.worktrees`)),
            branch: r.branch,
          });
        }
      }
      explicitRoots.sort((a, b) => b.length - a.length);

      return {
        task_id: st.task_id,
        lockedSpecFiles,
        lockedTestGlobs: scopes.has("test_spec") || scopes.has("invariant") ? [] : st.locked_test_globs,
        explicitRoots,
        unboundWorktrees,
      };
    });

    const wtBranchCache = new Map<string, string | null>();
    const getWorktreeBranch = (wtRoot: string): string | null => {
      if (wtBranchCache.has(wtRoot)) return wtBranchCache.get(wtRoot)!;
      const res = runGit(wtRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
      const b = res.code === 0 ? res.stdout.trim() : null;
      wtBranchCache.set(wtRoot, b);
      return b;
    };

    const resolveRelWithinLock = (lock: ResolvedLock, absTarget: string): string | null => {
      const relFromWb = relative(wbReal, absTarget).replace(/\\/g, "/");
      if (lock.explicitRoots.length === 0 && lock.unboundWorktrees.length === 0) {
        return relFromWb && !relFromWb.startsWith("..") ? relFromWb : null;
      }
      for (const rr of lock.explicitRoots) {
        if (absTarget === rr || absTarget.startsWith(rr + "/")) {
          return relative(rr, absTarget).replace(/\\/g, "/");
        }
      }
      for (const uw of lock.unboundWorktrees) {
        if (absTarget.startsWith(uw.worktreesDir + "/")) {
          const sub = relative(uw.worktreesDir, absTarget).replace(/\\/g, "/");
          const wtName = sub.split("/")[0];
          if (!wtName) continue;
          const wtRoot = canonicalizeMaybePath(join(uw.worktreesDir, wtName));
          if (allOpenBoundWorktrees.has(wtRoot)) continue;
          const b = getWorktreeBranch(wtRoot);
          if (b && b === uw.branch) {
            return relative(wtRoot, absTarget).replace(/\\/g, "/");
          }
        }
      }
      return null;
    };

    const matchLockedPath = (absTarget: string): string | null => {
      for (const lock of resolvedLocks) {
        for (const sf of lock.lockedSpecFiles) {
          if (absTarget === sf.abs) {
            const suggestedScope =
              sf.kind === "ssot" || sf.kind === "scope" ? "requirement|invariant" : sf.kind;
            return (
              `物理锁（冻结 Spec 保护）：任务 ${lock.task_id} 的 ${sf.rel} 处于周期冻结态，禁止直接修改。\n` +
              `如确需变更，请先经用户确认并执行 forge ledger amend ${lock.task_id} --scope ${suggestedScope} --reason "<变更原因>"`
            );
          }
        }
        if (lock.lockedTestGlobs.length > 0) {
          const relFromWb = relative(wbReal, absTarget).replace(/\\/g, "/");
          const relWithinTask = resolveRelWithinLock(lock, absTarget);
          if (
            relWithinTask &&
            lock.lockedTestGlobs.some((g) => matchesGlob(relWithinTask, g))
          ) {
            return (
              `物理锁（冻结测试防篡改）：任务 ${lock.task_id} 已锁定测试文件 (${relFromWb})，实现/修 bug 阶段禁止私自修改测试断言迎合代码。\n` +
              `如确认是测试用例本身有误，请经用户确认后执行 forge ledger amend ${lock.task_id} --scope test_spec --reason "<原因>"`
            );
          }
        }
      }
      return null;
    };

    for (const abs of touchedFilePaths) {
      const hit = matchLockedPath(abs);
      if (hit) return hit;
    }

    const segments = splitShellSegments(cmd ?? "");
    for (const [index, segment] of segments.entries()) {
      const cwd = resolveSegmentCwd(segments, index, baseWorkdir);
      const targets: string[] = [];
      // Skip quoted strings while looking for literal output redirects.
      for (const match of segment.matchAll(/"[^"]*"|'[^']*'|>>?\|?\s*("[^"]*"|'[^']*'|[^\s;&|<>]+)/g)) {
        if (match[1]) targets.push(...(splitShellTokens(match[1]) ?? []).map(p => resolve(cwd, p)));
      }
      const prefix = unwrapShellPrefix(splitShellTokens(stripUnquotedShellRedirections(segment)) ?? []);
      const git = prefix.bin === "git" ? extractGitSubcommand(["git", ...prefix.args]) : null;
      const bin = git && ["mv", "rm"].includes(git.subcmd) ? git.subcmd : prefix.bin;
      const commandDir = resolveGitDirFlags(cwd, [...prefix.dirs, ...(git?.gitDirFlags ?? [])]) ?? cwd;
      const args = git?.subArgs ?? prefix.args;
      const operands = args.filter(arg => !arg.startsWith("-")).map(p => resolve(commandDir, p));
      if (bin === "chmod" || bin === "tee" || bin === "rm" || bin === "mv" ||
          ((bin === "sed" || bin === "perl") && args.some(a => /^-[A-Za-z]*i/.test(a)))) targets.push(...operands);
      if ((bin === "cp" || bin === "mv") && operands.length >= 2) {
        const dest = operands.at(-1)!;
        targets.push(dest);
        if (statSync(dest, { throwIfNoEntry: false })?.isDirectory()) {
          for (const source of operands.slice(0, -1)) targets.push(join(dest, basename(source)));
        }
      }
      for (const target of targets) {
        const hit = matchLockedPath(canonicalizeMaybePath(target));
        if (hit) return hit;
      }
    }
  } finally {
    ledger?.closeDb();
  }

  return null;
}
