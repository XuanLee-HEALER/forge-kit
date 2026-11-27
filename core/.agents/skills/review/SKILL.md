---
name: review
description: 需要独立审查固定版本的变更或复核修复时，查看历史并选择角色，输出独立评审结果。
---

# 独立评审

1. 运行 `forge ledger reviews <task-id>`。核对当前冻结规格、挂载仓与分支、任务基线、待交付 HEAD、已有报告的原始范围和未决项。查看固定 base..head 的实际差异。
2. 按改动选择 reviewer-business（业务承诺）、reviewer-quality（实现缺陷）、reviewer-simplify（简单性与性能）、reviewer-comments（注释与接口文档）。用 Codex 原生 `spawn_agent` 按角色名派发，每位使用 `fork_turns="none"` 的独立上下文。默认并行，有依赖时可串行或按指定顺序执行。通用 reviewer 评规格与用例。
3. 任务书提供工作台根、仓路径与分支、固定 base/head、冻结规格、历史摘要及报告路径。自举评审另给候选检出的标尺路径。复核列出上轮已审 SHA、未决项和修复范围。子代理只读核对代码、调用方和测试，返回完整 Markdown 报告。
4. 主线程依据[风险标尺](references/risk-rubric.md)处理意见。逐角色记录可核验的原生会话 ID、派发及收稿时间与耗时，将报告原样保存后逐份登记。角色或会话无法核验时保留现场，接续到可核验的原生会话。单次覆盖模型或 effort 时登记实际值。

```bash
forge ledger review-record "$TASK" --repo "$REPO" --branch "$BRANCH" \
  --role "$ROLE" --base "$BASE" --head "$HEAD" --status "$STATUS" \
  --report "$REPORT" --summary "$SUMMARY" --session-id "$SESSION_ID"
```

登记角色为 business、quality、simplify 或 comments。状态为 pass、blocked 或 incomplete。

修复后查历史，仅派受影响角色按实际 base/head 复核。解除失败时，在 `--summary` 逐项引用同角色原失败序号（如 `#12`），报告逐项给出修复证据。未解除的失败继续阻断交付。若 base 晚于原失败 head，说明跳过区间及核验依据。交付前至少一份当前冻结周期的原生通过报告覆盖任务基线至最终 HEAD 的非空差异。
