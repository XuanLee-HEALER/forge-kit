---
name: ready
description: >
  工作台热身、现场定位与规则刷新：同时适用于全新会话与恢复/升级后的旧会话；锁定工作台根目录、重读最新
  AGENTS.md / AGENTS.local.md / workbench.yaml / kit-lock.json、盘点最新 skills 与 agents 清单、
  查询活跃任务账本（ledger status）与多仓分支/worktree 现场（wb-git status），按需预载目标仓配置卡，
  输出精简就绪卡片后等待派活。
  触发词：ready、准备接活、热身、初始化上下文、刷新规则、加载工作台、切工作目录、看下工作台现状、boot。
---

# ready：工作台热身与最新 Harness 刷新

同时适用于**全新会话**与**`resume`/经过 `forge sync` 升级后的旧会话**，在极低上下文开销下将工作台最新规则与实时现场一次性对齐。**全程只读、零副作用**：不建分支、不切分支、不开账本、不改文件、不读取凭据。

## 步骤

1. **锁定工作台根目录**：
   - 从当前 `cwd` 向上查找 `.workbench/workbench.yaml`（或 `.workbench/kit-lock.json`）确定工作台根路径 `<WB_ROOT>`。
   - 若用户指定了目标仓库、分支或 worktree，一并核对对应绝对路径是否存在；后续所有命令统一用 `workdir` 或 `git -C <目标路径>` 锚定到正确目录。
   - **护栏可达性提醒**：若当前会话 `cwd` 不在 `<WB_ROOT>`（例如开在旧目录或漂移到了 `~/.codex/worktrees/...`），在就绪卡片首行明确提醒用户——Codex 仅在会话启动于 `<WB_ROOT>` 且已在 `/hooks`（或 Codex Desktop 设置）信任 `.codex/hooks.json` 时才会自动触发底层 `guard`/`ledger-hook` 护栏；后续新建 worktree 一律走 `git -C <仓> worktree add` 放到 `<仓>.worktrees/<name>`，不调用内置 `create_worktree`。

2. **重读最新工作台 Harness 与私有规则（禁止全量灌入）**：
   - **必读最新规则**：读取 `<WB_ROOT>/AGENTS.md`、`<WB_ROOT>/AGENTS.local.md`（若存在）、`<WB_ROOT>/.workbench/workbench.yaml` 与 `<WB_ROOT>/.workbench/kit-lock.json`；**无论是否已在开局读过旧版，一律以本次磁盘最新内容为准**（若与旧上下文冲突，按最新规则覆盖记忆）。
   - **仅看目录索引**：列出 `<WB_ROOT>/.agents/skills/` 与 `<WB_ROOT>/.codex/agents/` 的名称清单，感知最新可用 skill 与 subagent；**不要**批量读取所有 `.workbench/repos/*.md` 或其他 `.agents/skills/*/SKILL.md` 正文；绝不读取 `.workbench/env/environments.json` 或任何凭据文件。

3. **采集实时现场**：
   - 执行 `"<WB_ROOT>/.workbench/bin/ledger" status` 查看当前 `OPEN` 账本、关联 `(repo, branch)` 与未闭项。
   - 执行 `"<WB_ROOT>/.workbench/bin/wb-git" status` 查看受管业务仓当前分支、未提交改动与已有 worktree。

4. **按需预载目标仓卡**：
   - 仅当用户在本次指令中明确指定了某个仓库、分支、worktree 或具体 `task_id` 时，定位到实际检出目录，按需只读取对应那一份 `<WB_ROOT>/.workbench/repos/<repo>.md`（以及该任务的 `ledger status --task <task_id>`）；否则跳过仓卡读取。

## 输出格式（保持 ≤ 10 行）

- **工作台**：`<名称>`（`<WB_ROOT>`；`forge-kit <version>@<short-commit>`；若当前 `cwd` 不同则标出并提醒 Hook 可达性）
- **最新规则**：一句话确认已重读最新 `AGENTS.md` / `AGENTS.local.md` 及可用 skills/agents 清单（旧会话刷新时如有关键变更顺带点出）
- **活跃账本**：列出 `OPEN` 任务 `task_id` + 绑定 `(repo:branch)`（无则写「无」）
- **受管仓现场**：每仓一行简报（当前分支、是否 dirty、活跃 worktree 数；若用户已指定目标仓/worktree，高亮其路径并注明已预载仓卡）
- **就绪提示**：一句话确认已就绪，询问本次要接手的任务或目标分支（若用户已同时派活，直接按对应流程 `feature`/`bugfix`/`ship` 等衔接推进）。
