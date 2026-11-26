---
name: review
description: 需要独立审查固定版本的变更或复核修复时，查看历史并选择角色，输出独立评审结果。
---

# 独立评审

**输入**为任务、目标仓、固定 base/head、冻结规格、实际变更和以往评审记录。

1. 每次调用评审 CLI 前先执行 `forge ledger reviews <task-id>`，核对记录的仓库、原始角色、base/head、状态及范围，并检查本次 diff。由工作 agent 选择本轮角色与理由，保留旧记录的版本归属。
2. 四个维度分别为 business（业务承诺及规格）、quality（实现缺陷）、simplify（性能及简单性）、comments（注释及接口文档）。默认全量，可按范围传入子集。不同角色独立运行。按需选 parallel、serial，或用 ordered 与完整的 --order 排列。
3. 在干净的待审版本运行，例如 `forge review --task "$TASK" --repo "$REPO" --base "$BASE" --head "$HEAD" --roles quality,comments --mode parallel --backend auto`。auto 优先全新只读 Codex CLI；仅确认上游服务异常时回退 API。材料缺失、执行错误、中断和阻断发现均须保留原状态。
4. 读每个实际角色的发现和摘要。对可重现的阻断项修正实现，按新版本重看账本再决定复核范围。未运行的角色单独标明。

**输出与完成条件**为对应固定范围的独立报告与账本记录。报告列出角色、实际后端、状态、关键发现和位置。执行错误或未完成时保留缺口，已有阻断项须在相应范围复核。
