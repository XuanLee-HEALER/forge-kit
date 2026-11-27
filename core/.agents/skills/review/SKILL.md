---
name: review
description: 需要独立审查固定版本的变更或复核修复时，查看历史并选择角色，输出独立评审结果。
---

# 独立评审

1. 运行 `forge ledger reviews <task-id>`。核对当前冻结规格、挂载仓与分支、任务基线、待交付 HEAD、已有报告的原始范围和未决项。查看固定 base..head 的实际差异。
2. 按改动选择 reviewer-business（业务承诺）、reviewer-quality（实现缺陷）、reviewer-simplify（简单性与性能）、reviewer-comments（注释与接口文档）。首轮用 Codex 原生 `spawn_agent` 按角色名派发，每位使用 `fork_turns="none"` 的独立上下文。收稿后保留会话以便复核。默认并行，有依赖时可串行或按指定顺序执行。通用 reviewer 评规格与用例。
3. 任务书提供工作台根、仓路径与分支、固定 base/head、冻结规格、历史摘要及报告路径。自举评审另给候选检出的标尺路径。复核列出上轮已审 SHA、未决项和修复范围。子代理只读核对代码、调用方和测试，返回完整 Markdown 报告。
4. 主线程依据[风险标尺](references/risk-rubric.md)处理意见。逐角色记录可核验的原生会话 ID、派发及收稿时间与耗时，将报告原样保存后逐份登记。角色或会话无法核验时保留现场，接续到可核验的原生会话。单次覆盖模型或 effort 时登记实际值。

```bash
forge ledger review-record "$TASK" --repo "$REPO" --branch "$BRANCH" \
  --role "$ROLE" --base "$BASE" --head "$HEAD" --status "$STATUS" \
  --report "$REPORT" --summary "$SUMMARY" --session-id "$SESSION_ID"
```

登记角色为 business、quality、simplify 或 comments。状态为 pass、blocked 或 incomplete。

修复后先查历史，仅续聊受影响角色。以 `followup_task` 唤回已完成的审稿人，或以 `send_message` 联系仍在审查的审稿人。给出该角色上次实际审到的 H1、新提交 H2 和对应问题序号，可附简短变更说明或短 diff。按实际审查的 H1..H2 和原会话 ID 登记本轮报告。原会话不可续聊或规格 amend 后，以 `fork_turns="none"` 新开会话全审任务基线至 HEAD。操作者改写已审历史时，走 amend 和重冻流程，从基线重新评审。

解除失败时，在 `--summary` 中逐项引用同角色原失败序号（如 `#12`），在报告中给出复核证据。`blocked` 可在核验修复的增量中解除，若起点晚于原失败 HEAD，说明跳过区间及核验依据。`incomplete` 须在原会话扩大范围，复核原失败报告的完整区间并补齐缺证区间的证据，再登记通过报告。

交付前，当前冻结周期内至少有一个角色沿 Git 祖先链连续覆盖任务基线至交付 HEAD 的非空差异。相接或重叠的已审区间可以拼接。所有已启动角色的失败都须解除，已通过且未受后续修复影响的角色可以停在原提交。
