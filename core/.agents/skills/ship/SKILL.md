---
name: ship
description: >
  按授权终点执行交付：测试环境（FAT）合并推送与验收、准备与创建 PR、生产发布核对与发布后分支清理。
  触发词：合 fat、推 fat、上 fat、fat 验收、提 PR、进 main、上线流程、走发布流程、清理分支、ship。
---

# ship：开发交付与发布

按 `AGENTS.md` 与目标仓 `.workbench/repos/<repo>.md` 执行；若存在公司专属发布 skill（如 `release`），生产发布阶段协同调用。

## 选择阶段

- **上测试环境（FAT）**：已完成本地验证与 `wrapup`，且本次授权包含 FAT。
- **准备 PR**：按目标分支整理干净分支与证据，创建或更新 PR 后即停（`main` PR 始终由用户合并）。
- **生产发布**：仅在本次明确授权生产发布时执行，核对目标提交、既有验收与生产依赖，不为发布重跑整套开发 FAT 流程。
- **发布后清理**：PR 已合并且部署确认成功后，清理本次创建的临时分支与 worktree（或使用 `.workbench/bin/wb-git sweep`）。

## 1. 上测试环境（FAT）

1. 确认当前 `HEAD SHA` 已通过 `wrapup` 且账本无未关闭 blocker。
2. 使用 `<仓>.worktrees/<临时名>` 下的 detached worktree 合并至测试分支（不在共享工作树切分支，**禁止调用 Codex Desktop 内置 `create_worktree`** 切离工作台根目录；若仓库配置指定了 cherry-pick 规则，按仓库配置执行）：
   ```bash
   git -C <仓> fetch origin
   git -C <仓> worktree add --detach <临时目录> origin/fat
   git -C <临时目录> merge <功能分支>
   # 在临时目录跑受影响构建/测试后推送
   git -C <临时目录> push origin HEAD:fat
   git -C <仓> worktree remove <临时目录>
   ```
3. 测试环境历史漂移不补、不顺手修；仅确保本次改动正确落地。
4. 跟踪部署状态；按授权执行测试环境迁移与验收：
   - **后端接口变更**：须运行覆盖变化的 Hurl/接口测试并彻底清理本轮夹具——建第一条数据前注册失败/中断兜底清理，用运行 ID 归属整组按依赖逆序清理，提供按同一运行 ID 幂等补清入口，核验残留数为零；清理失败须返回失败并列剩余 ID；若真人业务引用了测试夹具，保留真人订单并报告外键约束，绝不级联删除真人数据。
   - **前端变更**：完成类型检查、lint、构建、相关组件测试与 `wrapup` 并合入测试环境后，明确汇报“已合测试环境，待用户测试”，不表述为页面已验收；网页自动化测试仍须用户主动要求。

## 2. 准备 PR

1. 核对分支来源相对 `origin/main`：从 `main` 切出且未混入测试分支独有历史的功能分支直接复用；仅在混入脏历史时才从最新 `origin/main` 重建干净分支移植提交（严禁将 `fat` 合并进 `main`）。
2. 创建或更新 PR 时固定使用工作台格式：
   - 标题：`type: 一句话描述`
   - 正文：
     ```markdown
     ## 改动内容

     - <直白准确的业务语言概括实际变化，可省略实现细节>

     ## 关键文件改动

     - `<仓库相对路径>`：<一句话说明改动>

     ## 对历史影响

     <对已有数据、进行中任务或旧行为的实际影响；确实无影响写「无」>
     ```

## 3. 生产发布

1. 核对目标 SHA 位于 `origin/main` 历史且无夹带未授权提交；发布期间新增冲突修复按实际风险补查。
2. **Runbook 签发自动推进**：先整理完整可读的发版 Runbook（精确列出仓库、目标 SHA、待合 PR 号、annotated tag 名、如需的 prod 迁移 SQL 文件路径 / `kubectl` 命令与回滚方案），执行：
   ```bash
   .workbench/bin/ledger runbook create --title "<发版标题>" \
     [--pr <repo>:<pr号>] [--tag <repo>:<tag>:<sha>] \
     [--sql <prod-host>:<sql路径>] [--kubectl "<精确kubectl命令>"]
   ```
   将 Runbook 与生成的 `rb-...` 编号发给用户确认；用户在本会话回复 **`批准 <runbook_id>`** 后，`UserPromptSubmit` Hook 自动为本会话签发 30 分钟精确白名单通行证，随后 Agent 自动推进合 PR、打 tag 并显式 `git push origin <tag>`、执行已登记迁移/`kubectl`、跟踪部署、只读核验与错误日志观察；全部完成后执行 `.workbench/bin/ledger runbook complete <runbook_id>`（未批准前绝不强行绕过；`git push --tags`、读 k8s `secret`、未登记的 prod 写操作永久禁止）。
3. 涉及共享队列任务格式/语义变化时，核对滚动部署与回滚期间新旧版本共存兼容性。

## 4. 清理与收尾

1. PR 已合并且部署确认成功后，立刻清理本次创建的 `<仓>.worktrees/<name>`、`git -C <仓> worktree prune` 及已合入远端的本地临时分支（或运行 `.workbench/bin/wb-git sweep`），核验 `git -C <仓> worktree list` 无本次残留；若 PR 尚未合并则明确标注留待合并后清理。
2. 执行 `.workbench/bin/ledger close <task_id>` 归档本次账本。
3. 仅汇报实际发生的 PR、tag、部署、验收与清理结果。
