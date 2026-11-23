---
name: bugfix
description: >
  AI-Native 缺陷修复流程：先判定属于「需求变更（全周期重走）」还是「技术方案/不变量/实现缺陷（局部变更 + 辐射下游）」，
  通过 ledger amend 解锁并标脏受影响下游，修代码不偷改冻结测试，并执行缺陷棘轮回写不变量。
  触发词：修 bug、修复、fix、有个 bug、这个问题修一下、线上 bug、hotfix、打补丁、回归、QA 反馈。
---

# bugfix：修缺陷（双路径辐射 + 缺陷棘轮）

遵守工作台根 `AGENTS.md` 与目标仓 `.workbench/repos/<repo>.md`。

## 步骤

1. **定终点、深度与归类（必做第一关）**：
   先定位根因与事实证据（线上问题只查 prod 数据，第三方库先查源码/文档），然后明确把本次 bugfix 归为以下 **3 类之一** 并向用户确认：
   - **类型 A · 需求变了（Requirement Change）**：业务口径或外部契约发生变化。
     → 若有现存冻结账本，执行 `.workbench/bin/ledger amend <task_id> --scope requirement --reason "<变更说明>"`；**按 `feature` Full Dev Cycle 完整重走**（更新 `ssot.md` → 独立双上下文更新 `tech-spec.md` & `test-spec.md` → 独立评审 → 重新 `ledger freeze` → 并行实现/Hurl → 静态/动态检查 + 四层 Review → FAT 验证）。
   - **类型 B · 需求没变，但涉及不变量或技术方案局部变更（Spec/Invariant Amendment）**：例如发现未预见的并发边界、第三方真实行为差异或漏写的不变量。
     → 经用户确认后执行 `.workbench/bin/ledger amend <task_id> --scope invariant|tech_spec|test_spec --reason "<根因>"`。
     → 账本会自动标脏受影响下游（`invariant` 辐射 `tech-spec`/`test-spec`/静态检查/测试/Review/FAT；`tech_spec` 辐射静态检查/测试/Review/FAT；`test_spec` 辐射测试/FAT），修订对应文档并重新 `ledger freeze <task_id>` 后，**按标脏清单逐项辐射重跑，不得跳过**。
   - **类型 C · 纯实现偏差（既有 Spec 正确，仅代码写错）**：
     → **绝不解冻或修改 `ssot.md` / `tech-spec.md` / 冻结 Hurl**（除非需额外追加一条新回归 Hurl 场景，此时走 `amend --scope test_spec` 后重冻）。直接修代码，并按实际风险选 `targeted` 或 `full` 验证。

2. **分支与账本**：
   复用已有任务分支/worktree（需要新建时从 `origin/main` 切出）；独立线上/零星缺陷用 `ledger open` 建账（极小无逻辑改动可合规 `exempt`）。

3. **修复、检查与防篡改纪律**：
   - 委派 `.codex/agents/dev.toml` 修复（小改动可直接完成），克制无价值 Mock 单测；优先用 Hurl 回归用例覆盖（纯算法/计费/状态机/并发不变量补最小无 Mock 表驱动单测）。
   - 运行静态检查与动态检查（`.workbench/bin/lang-check` 或仓原生命令）及 `wrapup`；涉及接口语义变化时同步接口文档与生成产物。

4. **缺陷棘轮（Failure-to-Invariant Ratchet）**：
   对每条 QA 打回或线上确认的真 bug，在收尾前用 2 句话复盘：
   - 是否属于 `ssot.md` 漏写的不变量（若是，通过 `ledger amend --scope invariant` 补入 `INV-*`）？
   - 是否属于某仓库/语言的通用深坑（若是，提议追加一行到对应 `.workbench/repos/<repo>.md` 或语言坑点清单）？

5. **交付与汇报**：
   按授权终点推进（`local` 直接汇报，`fat`/`pr`/`prod` 走 `ship`，生产修 bug 默认打 hotfix tag），完成后 `ledger close`。汇报写清：缺陷类型（A/B/C）、根因与证据、是否触发 `ledger amend` 及辐射重跑结果、静态/动态检查与 FAT/Hurl 分列证据、棘轮结论与剩余缺口。
