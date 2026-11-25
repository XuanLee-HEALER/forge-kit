---
name: wrapup
description: >
  按实际风险执行定向或完整代码收尾：独立业务评审、隔离 CLI 专项评审（含余额不足时全角色统一原生只读回退）、
  等价精简与文档/注释核验，并将核实后的证据落入任务账本。
  触发词：收尾、代码收尾、评审加精简、wrapup、review 然后 simplify、注释 refine、合并前评审。
---

# wrapup：按风险选择代码收尾

先核对工作台 `AGENTS.md` 中的交付终点与验证深度。同固定 `base..head` SHA、同范围且环境仍适用的已有评审与测试证据可直接复用，不为相同内容重复跑全套。

## 分流原则

- **定向收尾（`targeted`）**：风险边界清晰的局部修复、低风险小改、纯文档/注释。执行：
  1. 固定 `base..head` SHA 与受影响调用链；
  2. 执行独立只读业务评审（`.workbench/bin/ledger review-native --task <id> --repo <仓> --base <base-SHA>` 或全新只读 subagent，如 `analyst` / 只读沙箱，**不要**将只读评审派给可写 `dev`），逐条核实发现并修确认问题；
  3. 跑受影响的构建、测试与生成物核验（接口语义若发现实质变化则升级为完整收尾）；
  4. 确认最终 SHA 覆盖全部验证并记录至账本，无需机械追加专项 CLI。
- **完整收尾（`full`）**：资金/权限规则、协议行为、迁移、事务/并发、复杂跨模块或风险未排除。按下方顺序执行。

## 完整收尾步骤

1. **固定范围与静态/动态基线**：
   - 记录目标仓库、`base..head` SHA 与工作树状态；评审期间不改被审代码，不混入他人未提交改动。
   - 在启动 AI 评审前，先跑完对应语言的静态与动态检查（仓内原生命令或 `.workbench/bin/lang-check <repo> --mode all`：Go `go vet`/`go test -race`、TS `tsc`/`biome`/`eslint`、Python `ruff`/`pyright`/`PYTHONDEVMODE=1 pytest`），让确定性工具先扫清语法、类型、lint 与数据竞争问题（`full` 深度任务推送前强依赖当前 SHA 的 `lint` 通过证据）。
2. **业务对齐评审（隔离上下文）**：
   - 运行 `.workbench/bin/ledger review-native --task <id> --repo <仓> --base <base-SHA>`。它在启动只读评审前记录分支 HEAD、覆盖起点与规范冻结序号，并在入账前复核。不可用时回退到全新只读 subagent（`fork_turns="none"`），并标注回退原因。
   - 必查项：对照 `ssot.md` 逐条核验 `INV-*` 业务不变量与外部契约、资金/权益服务端权威原则、测试与实现同步及可移植性、接口文档同步。
   - **逐条核实**：每条发现回到代码与数据自行确认（确认存在 / 误报），业务口径分歧交用户裁决；修复确认问题后固定新 `head` 并复审修复范围。
3. **并行专项评审（独立只读 CLI，自动注入语言坑点）**：
   - 读取 `.agents/skills/implementation-review/SKILL.md` 与 `.agents/skills/simplicity-performance-review/SKILL.md`，对同一固定 `base..head` 并行启动 `review-quality`（自动按 diff 后缀加载 Go/TS/Python 常见深坑清单）与 `review-performance`（按 `.workbench/models.toml` 显式传 `--model` 与 `--effort`，不传业务需求或前序结论）。
   - 汇总去重（按根因合并，同一问题多报不升阻断级别），验证并修复确认阻断项，固定新 `head` 后复审。
4. **代码精简（性能与简单平衡 + AI-Legibility）**：
   - 读取 `.agents/skills/code-simplification-review/SKILL.md`，对当前 `base..head` 启动 `review-simplify`。
   - 优先减少状态复杂度、冗余抽象与低信噪比 Mock 堆砌单测（保留纯算法/计费/状态机/并发不变量的无 Mock 表驱动单测）；逐条核对行为等价性后委派 `dev` 实施采纳项并重跑验证（允许全部不采纳并说明理由）。
5. **注释精简与接口文档完备化（纯前端跳过）**：
   - 先读 `review-agents/prompts/comments.md` 的通用文档质量标准；启动 `review-comments` 审查当前 `base..head`。
   - 原则：**内部注释更少更准**（删掉复述代码的废话，只保留非显然的 Why/不变量/权衡），**对外接口文档更完备并始终反映最新实现**；沿受影响接口链路检查（含 diff 外的契约、生成源与接入说明）。
   - 核实后委派 `dev` 修改并执行仓内生成命令，逐项核对「行为变化—文档位置—生成结果」（纯文档变更核对协议结构未变）。
6. **收敛核对与记账**：
   - 确认最终 `HEAD SHA` 与已审范围一致；精简若意外改变逻辑须补审。
   - 确认 `.workbench/bin/ledger spec-status <task_id>`（如有冻结 Spec）无漂移，且无未关闭 blocker。
   - **区分账本底线门禁与四层流程完备度**：账本的自动推送门禁仅核验最低机械底线（当前 SHA 静态检查 `lint` + 执行验证 `build/test/hurl` + 至少一项核心业务/质量评审通过且无任一失败角色），因为多轮精简/文档提交可能产生新 SHA；**`ready=true` 不等同于四层评审全部执行**，主线程仍须按本 SOP 完成四层评审（纯前端可跳过 `comments`），并在 `ledger status --task <task_id>` 与汇报中逐层列明各角色评审记录与最终 SHA。

## 余额不足时的统一自动回退（全 4 角色适用）

当 `review-quality`、`review-performance`、`review-simplify` 或 `review-comments` 任一独立 CLI 严格满足以下**全部三项机器条件**时：
1. 进程退出码为 `2`；
2. 输出 JSON 顶层 `status === "error"`；
3. 顶层 `errorCode === "credit_balance_exhausted"`（不匹配普通 429、`insufficient_quota`、超时、认证失败或错误文案）。

主线程自动执行**统一只读原生回退**：
- 保存原始 CLI 失败证据；
- 执行 `.workbench/bin/ledger review-fallback <task_id> --repo <repo> --role <role> --sha <完整 HEAD>`。执行器核对账本中的失败记录，以工作台 standard 模型和 effort 启动全新隔离的只读原生 Codex 会话；
- **直接加载对应角色提示词** `review-agents/prompts/{quality,performance,simplify,comments}.md` + 固定 `base..head` SHA 作为唯一审查依据（不注入实现自评，只读不改代码）；
- 主线程照常逐条核实回退建议后再委派 `dev` 实施；
- 保留原 CLI 失败和原生只读回退报告，在汇报中列明角色、SHA、回退原因和结果；可执行评审只接受实际工具或 hook 证据，禁止手工补记评审通过。

## 汇报

写清流程类型（定向/完整）、固定 `base..head`、各评审阶段结果（发现/确认/误报/处置/是否回退）、单测与环境验收分开列示及剩余缺口。
