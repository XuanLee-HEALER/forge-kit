---
name: ready
description: >
  新会话工作台快速热身与现场定位：锁定工作台根目录、补读 AGENTS.local.md 与 workbench.yaml、
  查询活跃任务账本（ledger status）与多仓分支/worktree 现场（wb-git status），按需预载目标仓配置卡，
  输出精简就绪卡片后等待派活。
  触发词：ready、准备接活、热身、初始化上下文、加载工作台、切工作目录、看下工作台现状、boot。
---

# ready：新会话工作台热身与现场定位

用于新开 Codex 会话（或刚恢复/切换目标仓的会话）在极低上下文开销下完成工作台就绪检查。**全程只读、零副作用**：不建分支、不切分支、不开账本、不改文件、不读取凭据。

## 步骤

1. **锁定工作台根目录**：
   - 从当前 `cwd` 向上查找 `.workbench/workbench.yaml`（或 `.workbench/kit-lock.json`）确定工作台根路径 `<WB_ROOT>`。
   - 若用户指定了目标仓库、分支或 worktree，一并核对对应绝对路径是否存在；后续所有命令统一用 `workdir` 或 `git -C <目标路径>` 锚定到正确目录（若当前会话开在非工作台目录，明确提醒用户）。

2. **补齐私有规则与受管清单（禁止全量灌入）**：
   - 读取 `<WB_ROOT>/AGENTS.local.md`（若存在）与 `<WB_ROOT>/.workbench/workbench.yaml`，确认本工作台私有约定、受管业务仓清单与环境边界。
   - **不要**批量读取所有 `.workbench/repos/*.md` 或其他 `.agents/skills/*/SKILL.md`；绝不读取 `.workbench/env/environments.json` 或任何凭据文件。

3. **采集实时现场**：
   - 执行 `"<WB_ROOT>/.workbench/bin/ledger" status` 查看当前 `OPEN` 账本、关联 `(repo, branch)` 与未闭项。
   - 执行 `"<WB_ROOT>/.workbench/bin/wb-git" status` 查看受管业务仓当前分支、未提交改动与已有 worktree。

4. **按需预载目标仓卡**：
   - 仅当用户在本次指令中明确指定了某个仓库、分支、worktree 或具体 `task_id` 时，定位到实际检出目录，按需只读取对应那一份 `<WB_ROOT>/.workbench/repos/<repo>.md`（以及该任务的 `ledger status <task_id>`）；否则跳过仓卡读取。

## 输出格式（保持 ≤ 10 行）

- **工作台**：`<名称>`（`<WB_ROOT>`；若当前 `cwd` 不同则标出并说明已锚定目录）
- **活跃账本**：列出 `OPEN` 任务 `task_id` + 绑定 `(repo:branch)`（无则写「无」）
- **受管仓现场**：每仓一行简报（当前分支、是否 dirty、活跃 worktree 数；若用户已指定目标仓/worktree，高亮其路径并注明已预载仓卡）
- **就绪提示**：一句话确认已就绪，询问本次要接手的任务或目标分支（若用户已同时派活，直接按对应流程 `feature`/`bugfix`/`ship` 等衔接推进）。
