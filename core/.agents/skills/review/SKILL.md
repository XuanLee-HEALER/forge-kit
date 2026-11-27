---
name: review
description: 需要独立审查固定版本的变更或复核修复时，查看历史并选择角色，输出独立评审结果。
---

# 独立评审

1. 运行 `forge ledger reviews <task-id>`。核对当前冻结规格、挂载仓与分支、任务基线、待交付 HEAD、已有报告的原始范围和未决项。查看固定 base..head 的实际差异。
2. 按改动选择 reviewer-business（业务承诺）、reviewer-quality（实现缺陷）、reviewer-simplify（简单性与性能）、reviewer-comments（注释与接口文档）。用 Codex 原生 `spawn_agent` 按角色名派发，每位使用 `fork_turns="none"` 的独立上下文。默认并行，有依赖时可串行或按指定顺序执行。通用 reviewer 评规格与用例。
3. 任务书给出仓路径、分支、固定 base/head、冻结规格路径、历史摘要和报告路径，例如 `.workbench/runs/<task-id>/review-<round>-<role>.md`。复核列出上轮已审 SHA、未决项和本轮修复范围。子代理只读核对代码、调用方与测试，返回含结论、阻断项、建议及未核验项的 Markdown 全文。
4. 逐角色记录真实会话 ID、派发与收到最终报告的时间及耗时。主线程将返回稿原样写入任务书指定路径，阅读后逐份登记。CLI 可省略会话 ID；实际派发使用可核验的原生会话标识。若角色未载入或会话标识缺失，保留现场，接续到能够核验的原生会话。单次覆盖模型或 effort 时传入各自实际值，其余字段沿用角色配置。

```bash
forge ledger review-record "$TASK" --repo "$REPO" --branch "$BRANCH" \
  --role "$ROLE" --base "$BASE" --head "$HEAD" --status "$STATUS" \
  --report "$REPORT" --summary "$SUMMARY" --session-id "$SESSION_ID"
```

登记角色为 business、quality、simplify 或 comments。状态为 pass、blocked 或 incomplete。发现阻断时写明对应承诺、触发条件、错误结果及证据。缺少关键材料时登记 incomplete，补齐后复核。

修复后查询历史，仅派受影响角色，对照原报告逐项核实阻断的处理结果。报告与账本均填写实际审查的 base/head。全范围或增量复核要解除旧阻断，均须在 `--summary` 中逐项引用同角色原失败事件的序号（如 `#12`），并在报告正文对应说明修复依据及核验结果。未引用的失败继续阻断交付。若 base 晚于失败 head，还须解释跳过区间与该阻断的关系，并给出相应修复或验证证据。交付前至少一份通过报告覆盖当前冻结周期内任务基线至最终 HEAD 的非空差异。旧版评审可通过 reviews 查看原角色、范围与归属。
