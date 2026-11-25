import { type WorkbenchConfig } from "../config";
import { getBranchDiffStats, getHeadAndParents, getStagedDiffStats, locateRepo, runGit } from "../git";
import { isApprovedTagPushRefspec, parseDeliverySegment } from "./git-gh";
import { type ApprovedRunbookEntry } from "./runbook-state";
import { Ledger } from "../ledger/store";
import { resolve } from "node:path";
import {
  ghDefaultMatchesOrigin,
  parseGhPrCreateArgs,
  parseGhRepoSpec,
  parseGitRemoteRepo,
  qualifyGhRepoSpec,
} from "../shared/gh-remote";
import { isImplicitPushAmbiguous, parseGitPushArgs, resolveGitDirFlags } from "../shared/git-cmd";
import { matchesGlob } from "../shared/path";
import {
  hasPrecedingDynamicCd,
  hasShellExpansion,
  resolveSegmentCwd,
  splitShellSegments,
  splitShellTokens,
} from "../shared/shell";

function evaluateDiffExemptEligibility(
  stats: { files: string[]; changedLines: number },
  cfg: WorkbenchConfig,
): { eligible: boolean; files: string[]; changedLines: number; reason?: string } {
  if (stats.files.length === 0) {
    return { eligible: true, ...stats };
  }
  if (stats.files.length > cfg.ledger.exempt_max_files) {
    return {
      eligible: false,
      ...stats,
      reason: `改动文件数 (${stats.files.length}) 超出豁免上限 (${cfg.ledger.exempt_max_files})`,
    };
  }
  if (stats.changedLines > cfg.ledger.exempt_max_lines) {
    return {
      eligible: false,
      ...stats,
      reason: `改动行数 (${stats.changedLines}) 超出豁免上限 (${cfg.ledger.exempt_max_lines})`,
    };
  }
  const protectedHit = stats.files.find((f) =>
    cfg.ledger.protected_code_globs.some((g) => matchesGlob(f, g)),
  );
  if (protectedHit) {
    return {
      eligible: false,
      ...stats,
      reason: `涉及受保护业务代码文件 (${protectedHit})`,
    };
  }
  if (cfg.ledger.exempt_allowed_globs.length > 0) {
    const disallowed = stats.files.find(
      (f) => !cfg.ledger.exempt_allowed_globs.some((g) => matchesGlob(f, g)),
    );
    if (disallowed) {
      return {
        eligible: false,
        ...stats,
        reason: `文件 ${disallowed} 不在允许免账本范围 (exempt_allowed_globs) 内`,
      };
    }
  }
  return { eligible: true, ...stats };
}

function isStagedDiffExemptEligible(
  checkoutDir: string,
  cfg: WorkbenchConfig,
): { eligible: boolean; files: string[]; changedLines: number; reason?: string } {
  return evaluateDiffExemptEligibility(getStagedDiffStats(checkoutDir), cfg);
}

function pathBelongsToRegisteredRepo(
  workbenchRoot: string,
  targetDir: string,
  registeredRepos: Set<string>,
): string | null {
  const abs = resolve(targetDir);
  for (const r of registeredRepos) {
    const repoPath = resolve(workbenchRoot, r);
    const wtRoot = resolve(workbenchRoot, `${r}.worktrees`);
    if (
      abs === repoPath ||
      abs.startsWith(repoPath + "/") ||
      abs === wtRoot ||
      abs.startsWith(wtRoot + "/")
    ) {
      return r;
    }
  }
  return null;
}

export function checkLedgerGate(
  workbenchRoot: string,
  cmd: string,
  toolWorkdir: string,
  cfg: WorkbenchConfig,
  approvedRunbooks: ApprovedRunbookEntry[] = [],
): string | null {
  if (!cfg.ledger.enabled) return null;
  const registeredRepos = new Set(cfg.repos);
  if (registeredRepos.size === 0) return null;

  const segments = splitShellSegments(cmd);
  let ledger: Ledger | null = null;

  try {
    for (let i = 0; i < segments.length; i++) {
      const toks = splitShellTokens(segments[i]);
      if (!toks || toks.length === 0) continue;

      const segCwd = resolveSegmentCwd(segments, i, toolWorkdir);
      const { prefix, gh, git } = parseDeliverySegment(toks);
      const isGhPrCreate = gh?.subcmd === "create" || gh?.subcmd === "new";

      const isGitCommit = git?.subcmd === "commit";
      const isGitPush = git?.subcmd === "push";

      if (!isGitCommit && !isGitPush && !isGhPrCreate) continue;
      if (prefix.ambiguous) return "账本门禁：无法解析 env 交付命令。";

      if (
        prefix.dirs.some(hasShellExpansion) ||
        (git && git.gitDirFlags.some((f) => hasShellExpansion(f))) ||
        hasPrecedingDynamicCd(segments, i)
      ) {
        return "账本门禁（fail-closed）：检测到未展开的 shell 变量路径用于 git/gh 交付命令，请改用明确字面路径。";
      }

      const targetDir = resolveGitDirFlags(segCwd, [...prefix.dirs, ...(git?.gitDirFlags ?? [])], true);
      if (!targetDir) {
        return "账本门禁（fail-closed）：无法解析 git -C 目标目录，拒绝放行交付操作。";
      }
      const loc = locateRepo(workbenchRoot, targetDir);
      if (!loc) {
        const regName = pathBelongsToRegisteredRepo(workbenchRoot, targetDir, registeredRepos);
        if (regName) {
          return `账本门禁（fail-closed）：无法识别已登记仓库 ${regName} (${targetDir}) 的 Git 状态，拒绝放行交付操作。`;
        }
        continue;
      }
      if (!registeredRepos.has(loc.repo)) {
        continue;
      }

      if (!ledger) ledger = new Ledger(workbenchRoot);

      type DeliveryTarget = {
        branch: string;
        sha: string | null;
        isDetached: boolean;
      };

      const targets: DeliveryTarget[] = [];
      if (isGitPush && git) {
        const parsedPush = parseGitPushArgs(git.subArgs);
        const reason = isImplicitPushAmbiguous(parsedPush, git.configs, targetDir, new Set(cfg.guard.protected_branches));
        if (reason) return `账本门禁：${reason}`;
        if (parsedPush.isDelete) {
          // Deleting a remote feature branch (protected branches already blocked by Tier 1)
          continue;
        }
        if (parsedPush.hasAllOrMirror) {
          return "账本门禁（fail-closed）：禁止 `git push --all` / `--branches` / `--mirror` 或批量 refspec，请显式指定目标分支。";
        }
        const { refspecs } = parsedPush;
        if (refspecs.length === 0) {
          targets.push({
            branch: loc.branch,
            sha: loc.headSha,
            isDetached: loc.isDetached,
          });
        } else {
          for (const spec of refspecs) {
            const rawSrc = spec.includes(":") ? spec.split(":")[0] : spec;
            const srcRef = rawSrc.replace(/^\+/, "");
            if (!srcRef) {
              // Empty source refspec (`:branch`) is remote branch deletion
              continue;
            }
            if (
              isApprovedTagPushRefspec({
                workbenchRoot,
                targetDir,
                refspec: spec,
                isForce: parsedPush.isForce,
                isDelete: false,
                approvedRunbooks,
                cmd,
                segments,
                segmentIndex: i,
                toolWorkdir,
                pushSegmentTokens: toks,
              })
            ) {
              // Approved release tag push targets an already-merged main commit, not an unmerged feature branch.
              continue;
            }
            if (srcRef === "HEAD" || srcRef === "@") {
              targets.push({
                branch: loc.branch,
                sha: loc.headSha,
                isDetached: loc.isDetached,
              });
            } else {
              const rev = runGit(loc.checkoutDir, ["rev-parse", "--verify", srcRef], 3000);
              if (rev.code !== 0 || !rev.stdout.trim()) {
                return `账本门禁（fail-closed）：无法解析推送源 ref \`${srcRef}\`，拒绝放行 git push。`;
              }
              targets.push({
                branch: srcRef.replace(/^refs\/heads\//, ""),
                sha: rev.stdout.trim(),
                isDetached: false,
              });
            }
          }
          if (targets.length === 0) continue;
        }
      } else if (isGhPrCreate) {
        const parsedGh = parseGhPrCreateArgs(gh.subArgs);
        // Fail closed if `-R` / `--repo` (including attached `-Rowner/repo`) points to a different repository than origin
        const explicitGhRepo = parsedGh.repo ?? (prefix.effective("GH_REPO") || null);
        const envHost = prefix.effective("GH_HOST").toLowerCase();
        const originUrl = runGit(loc.checkoutDir, ["remote", "get-url", "origin"], 3000).stdout.trim();
        const originIdentity = parseGitRemoteRepo(originUrl);

        if (explicitGhRepo) {
          const targetIdentity = parseGhRepoSpec(qualifyGhRepoSpec(explicitGhRepo, prefix.effective, targetDir));
          if (!targetIdentity || !originIdentity) {
            return `账本门禁（fail-closed）：无法完整核验 \`gh pr create -R ${explicitGhRepo}\` 与当前仓 origin (${originUrl || "未配置"}) 的 owner/repo 身份，拒绝放行。`;
          }
          if (
            targetIdentity.host !== originIdentity.host ||
            targetIdentity.owner !== originIdentity.owner ||
            targetIdentity.repo !== originIdentity.repo
          ) {
            return `账本门禁（fail-closed）：\`gh pr create\` 指定目标仓 ${explicitGhRepo} 与当前仓 origin (${originIdentity.host}/${originIdentity.owner}/${originIdentity.repo}) 不一致，请在目标仓内执行。`;
          }
        }

        if (!explicitGhRepo && envHost && envHost !== originIdentity?.host) {
          return "账本门禁：GH_HOST 与当前仓 origin 不一致。";
        }

        if (!explicitGhRepo && !ghDefaultMatchesOrigin(loc.checkoutDir, originIdentity)) {
          return "账本门禁：无法确认 gh 默认目标仓与当前仓 origin 一致，请显式指定 -R。";
        }

        const prHead = parsedGh.head;
        if (prHead) {
          let branchName = prHead;
          if (prHead.includes(":")) {
            const [owner, ...restParts] = prHead.split(":");
            branchName = restParts.join(":");
            if (
              !owner ||
              !originIdentity ||
              owner.toLowerCase() !== originIdentity.owner
            ) {
              return `账本门禁（fail-closed）：PR head \`${prHead}\` 的 owner 与当前仓 origin 不匹配，拒绝放行跨 fork 未核验 PR。`;
            }
          }
          const cleanBranch = branchName.replace(/^refs\/heads\//, "");
          const rev = runGit(
            loc.checkoutDir,
            ["rev-parse", "--verify", `refs/heads/${cleanBranch}`],
            3000,
          );
          if (rev.code !== 0 || !rev.stdout.trim()) {
            return `账本门禁（fail-closed）：无法解析本地 PR head 分支 \`${prHead}\`，拒绝放行 gh pr create。`;
          }
          const localSha = rev.stdout.trim();
          // If origin/<branch> exists locally and has diverged from local branch, fail closed!
          const remoteRev = runGit(
            loc.checkoutDir,
            ["rev-parse", "--verify", `refs/remotes/origin/${cleanBranch}`],
            3000,
          );
          if (remoteRev.code === 0 && remoteRev.stdout.trim() && remoteRev.stdout.trim() !== localSha) {
            return `账本门禁（fail-closed）：本地分支 \`${cleanBranch}\` (${localSha.slice(0, 8)}) 与远端跟踪分支 \`origin/${cleanBranch}\` (${remoteRev.stdout.trim().slice(0, 8)}) 已分叉，请先推送对齐后再创建 PR。`;
          }
          targets.push({
            branch: cleanBranch,
            sha: localSha,
            isDetached: false,
          });
        } else {
          if (!loc.isDetached && loc.headSha) {
            const remoteRev = runGit(
              loc.checkoutDir,
              ["rev-parse", "--verify", `refs/remotes/origin/${loc.branch}`],
              3000,
            );
            if (remoteRev.code === 0 && remoteRev.stdout.trim() && remoteRev.stdout.trim() !== loc.headSha) {
              return `账本门禁（fail-closed）：当前分支 \`${loc.branch}\` (${loc.headSha.slice(0, 8)}) 与远端跟踪分支 \`origin/${loc.branch}\` (${remoteRev.stdout.trim().slice(0, 8)}) 已分叉，请先推送对齐后再创建 PR。`;
            }
          }
          targets.push({
            branch: loc.branch,
            sha: loc.headSha,
            isDetached: loc.isDetached,
          });
        }
      } else {
        targets.push({
          branch: loc.branch,
          sha: loc.headSha,
          isDetached: loc.isDetached,
        });
      }

      for (const target of targets) {
        const deliveryBranch = target.branch;
        const deliverySha = target.sha;
        const deliveryDetached = target.isDetached;

        // Resolve owning OPEN task(s)
        const openTasks = deliveryDetached
          ? ledger.findOpenTasksByRepoCommits(loc.repo, getHeadAndParents(loc.checkoutDir))
          : ledger.findOpenTasksByRepoBranch(loc.repo, deliveryBranch);
        const exemption = deliveryDetached
          ? null
          : ledger.findActiveExemption(loc.repo, deliveryBranch);

        if (isGitCommit) {
          if (openTasks.length === 1) continue;
          if (openTasks.length > 1) {
            const ids = openTasks.map((t) => t.task_id).join(", ");
            return `账本门禁：${loc.repo}:${deliveryBranch} 命中多个 OPEN 账本 (${ids})，请先收敛归属后再提交。`;
          }

          const eligibility = isStagedDiffExemptEligible(loc.checkoutDir, cfg);
          if (exemption && eligibility.eligible) {
            continue;
          }

          const allOpen = ledger.listOpenTasks();
          const attachHint =
            allOpen.length > 0
              ? `\n  2) 归属已有跨仓任务：.workbench/bin/ledger attach <task_id> --repo ${loc.repo} --branch ${deliveryBranch}（当前 OPEN：${allOpen.map((t) => t.task_id).join(", ")}）`
              : "";

          if (!eligibility.eligible) {
            return (
              `账本门禁：业务仓 ${loc.repo} (${deliveryBranch}) 即将提交（${eligibility.files.length} 文件 / ${eligibility.changedLines} 行：${eligibility.reason}），不可沿用或静默豁免。\n` +
              `请选择：\n` +
              `  1) 新开账本：.workbench/bin/ledger open --id <YYYYMMDD-slug> --title "<标题>" --endpoint <local|fat|pr> --depth <targeted|full> --repo ${loc.repo} --branch ${deliveryBranch}${attachHint}\n` +
              `  3) 若确认完全不涉及逻辑/设定，拿不准请先询问用户确认。`
            );
          }

          return (
            `账本门禁：业务仓 ${loc.repo} (${deliveryBranch}) 尚未绑定开发账本。\n` +
            `请选择：\n` +
            `  1) 新开账本：.workbench/bin/ledger open --id <YYYYMMDD-slug> --title "<标题>" --endpoint <local|fat|pr> --depth <targeted|full> --repo ${loc.repo} --branch ${deliveryBranch}${attachHint}\n` +
            `  3) 若为不涉及逻辑/设定的极小改动（纯文档/注释/typo）：.workbench/bin/ledger exempt --repo ${loc.repo} --branch ${deliveryBranch} --reason "<原因>"`
          );
        }

        if (isGitPush || isGhPrCreate) {
          if (!deliverySha) {
            return `账本门禁（fail-closed）：无法解析 ${loc.repo} (${deliveryBranch}) 的有效 HEAD SHA，拒绝放行 ${isGitPush ? "git push" : "gh pr create"}。`;
          }

          // Exemption passes push/PR ONLY if bound to this exact SHA AND aggregate branch diff qualifies!
          if (exemption && exemption.head_sha === deliverySha) {
            const branchStats = getBranchDiffStats(
              loc.checkoutDir,
              deliverySha,
              cfg.guard.protected_branches,
            );
            if (branchStats && evaluateDiffExemptEligibility(branchStats, cfg).eligible) {
              continue;
            }
            return `账本门禁：${loc.repo}@${deliverySha.slice(0, 8)} 的实际提交改动不满足免账本豁免条件，请开立正式开发账本并完成验证。`;
          }

          if (openTasks.length === 0) {
            return (
              `账本门禁：${loc.repo} (${deliveryBranch}${deliveryDetached ? " detached" : ""}) 尚未绑定有效开发账本（或豁免未绑定当前 SHA ${deliverySha.slice(0, 8)}），禁止直接执行 ${isGitPush ? "git push" : "gh pr create"}。\n` +
              `请先绑定账本（跨仓或独立 FAT 分支可用 ledger attach；极小无逻辑改动须登记当前 SHA 的合规 exempt）。`
            );
          }
          if (openTasks.length > 1) {
            return `账本门禁：${loc.repo} 命中多个 OPEN 账本 (${openTasks.map((t) => t.task_id).join(", ")})，无法自动校验推送条件。`;
          }

          const task = openTasks[0];

          // On detached FAT merge worktree: check merged HEAD first; ONLY fall back to parent feature SHA
          // if merged HEAD had NO explicit test/build/review failure!
          let readiness = ledger.checkPushReadiness({
            task_id: task.task_id,
            repo: loc.repo,
            head_sha: deliverySha,
          });
          if (!readiness.ready && !readiness.hasExplicitFailure && deliveryDetached) {
            const parents = new Set(getHeadAndParents(loc.checkoutDir));
            const boundRepo = ledger
              .getTaskRepos(task.task_id)
              .find((r) => r.repo === loc.repo && r.head_sha && parents.has(r.head_sha));
            if (boundRepo?.head_sha) {
              readiness = ledger.checkPushReadiness({
                task_id: task.task_id,
                repo: loc.repo,
                head_sha: boundRepo.head_sha,
              });
            }
          }

          if (!readiness.ready) {
            return (
              `账本门禁：任务 ${task.task_id} (${loc.repo}@${deliverySha.slice(0, 8)}) 尚未满足交付前检查：\n` +
              readiness.missing.map((m) => `  - ${m}`).join("\n") +
              `\n请补跑对应验证/评审（PostToolUse 将自动记账）或通过 ledger record 补录证据后再重试。`
            );
          }
        }
      }
    }
  } finally {
    ledger?.closeDb();
  }

  return null;
}
