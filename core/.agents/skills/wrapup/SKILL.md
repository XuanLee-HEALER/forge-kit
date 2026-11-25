---
name: wrapup
description: >
  按实际风险执行定向或完整代码收尾：独立业务评审、隔离 CLI 专项评审（含余额不足时全角色统一原生只读回退）、
  等价精简与文档/注释核验，并将核实后的证据落入任务账本。
  触发词：收尾、代码收尾、评审加精简、wrapup、review 然后 simplify、注释 refine、合并前评审。
---

# 收尾

| 深度 | 适用范围 | 独立评审 |
|---|---|---|
| targeted | 局部修复、文档或边界清楚的改动 | 对照需求与不变量，运行定向业务评审 |
| full | 资金、权限、协议、迁移、并发、跨模块或风险未排除 | 审查固定 base..head 的质量、性能、精简和接口文档 |

1. 确认任务、挂载仓库、基线与最终 HEAD。将本次改动提交到任务分支，确保工作树干净。
2. full 运行 `.workbench/bin/wb-verify --task <task_id> --repo <repo> --mode all` 取得静态 lint 与动态 test 证据。targeted 按影响选择 `--mode static`、`--mode dynamic` 或下述单项执行。按仓库卡补跑构建或接口验证，用同一执行器传 `--kind build` 或 `--kind hurl`，后接 `-- <命令及参数>`。分别记录本地与环境验收结果。
3. targeted 用 `.workbench/bin/ledger review-native --task <task_id> --repo <repo> --base <base>` 核验业务范围。full 运行四角色评审；功能任务先运行同一独立业务评审，对照冻结的 ssot.md 逐项核验不变量。用 `.workbench/bin/forge-review --task <task_id> --repo <repo>` 并行启动四角色。某角色返回退出码 2、JSON status=error 且 errorCode=credit_balance_exhausted 时，执行器自动对该角色使用隔离只读回退。其他失败按报告处理。
4. 核实发现、修复阻断项，提交后按新 SHA 重跑相关检查。查 `.workbench/bin/ledger spec-status <task_id>` 和 `.workbench/bin/ledger status --task <task_id>`，核对冻结状态、角色结果和 blocker。

**完成条件**　最终 SHA 具有所选深度的验证与评审记录，冻结文件无漂移，未关闭 blocker 为 0，交接说明列明 SHA、环境验收与剩余缺口。
