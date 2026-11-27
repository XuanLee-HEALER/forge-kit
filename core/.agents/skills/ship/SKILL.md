---
name: ship
description: 将已验证的版本交付到授权终点，核验回执并关账；支持 PR 移交、批次和精确预授权快轨。
---

# 交付与归档

**输入**为任务、冻结规格、各挂载仓与分支、待交付 SHA、实际验证和审查证据、实例终点及授权。用 `forge instance list --json` 确定阶段，用 `forge ledger status` 核对任务；缺省交付终点为 PR 合入 main。

## 单任务

1. 确认冻结摘要、锁定测试和干净工作树；核对静态、执行、集成验证及独立审查均属于当前冻结周期和目标 SHA。当前范围仍有 blocked、error、incomplete 的已执行角色或未关闭 blocker 时暂停。历史结果保持原始归属。
2. 按实例阶段创建或更新 PR。通过 `forge ledger pr-sync <task-id> --repo <repo> --branch <branch>` 核对远端 HEAD，将 `forge ledger tip <task-id>` 的见证附入 PR。外部意见用 pr-triage。检查目标分支、固定 HEAD 及必需 CI。
3. 采用精确动作批准时，先用 `forge ledger runbook create` 登记动作。普通发版单可以通过 `--task <id>` 关联任务；即使实例未启用快轨，也可按普通批准与回执流程完成。向用户展示仓、远端、资源、版本、内容摘要和适用时效。主会话单独发送 `批准 <rb-id>` 或 `approve <rb-id>` 后方可兑现。若由人工合并，等待远端结果并核对。
4. 核验远端 main 包含待交付提交或相应受核验的合并结果，再登记回执。实例另有终点时按已授权的阶段、顺序和版本继续，记录实际外部状态。到达本次终点后执行 `forge ledger close <task-id>`。

## 功能线程移交与发布批次

功能线程完成验证及 PR 分诊，逐仓同步 HEAD 后执行 `forge ledger handoff <task-id>`，把 Forge-Task、Verified-Head、Ledger-Tip 见证附入 PR，止于 HANDED_OFF。需改实现时先 `forge ledger resume <task-id>`，复验后重新移交。

发布线程用 `forge ledger release create --title "<title>" --from-handoffs` 或显式任务列表建批，`forge ledger release verify <rel-id>` 核验实时 PR。出现版本漂移时暂停相应批次并退回功能线程。使用 `forge ledger release runbook <rel-id>` 汇集确定的动作，在主会话取得精确批准。按返回的 human_merges 清单核对目标分支、HEAD 和必需检查，在获批节点内通过托管平台合并。发布线程运行 `forge ledger release verify <rel-id>` 核验远端结果，记录其余已批准动作的回执，再完成 runbook 及 release。

命名交付终点会在批次 runbook 的 `actions.release_observers` 中列出各阶段的动作 ID、目标和版本。发布后执行 `forge ledger release observe <rel-id>` 读取目标侧状态。所有观察器确认对应版本已完成后，账本记录工具回执，再执行 `forge ledger release complete <rel-id>`。重复观察会记录目标状态的变化；若观察器执行失败、返回未知状态或目标回报的动作及版本不符，本次观察会使先前的通过回执失效。须等同一批次、动作和版本重新确认完成后方可关账。

## Fast-Track

规格冻结后可立即运行 `forge ledger fast-track prepare <task-id> --to <endpoint> --paths <globs>`，将任务、冻结摘要、仓库、路径、规模上限及有序交付阶段展示给批准人。后期已有精确动作时可另传 `--runbook <rb-id>`。操作者在主会话单独发送 `快轨批准 <ft-id>`。同一会话可单独发送 `快轨撤销 <ft-id>` 撤销 ACTIVE 授权。PENDING 授权可用 revoke 撤销。

按任务 base_sha..HEAD 校验范围，核对冻结测试锁、候选版本、评审、验证与必需 CI。已批准的交付节点覆盖发布对应工作分支、创建 PR 和通过平台合并该候选版本所需的动作。按绑定的目标与 HEAD 调用合并，随后读取平台合并提交与目标引用。独立部署按实际声明的阶段直接查询部署端。直推使用普通 Git 快进推送并独立读取远端 SHA。遇非快进拒绝时记录分叉及当前版本，保留现场。仅登记了标签动作时才核对标签目标。

在同一获批会话运行 `forge ship evaluate --envelope <ft-id>` 后用 `forge ship run --envelope <ft-id>` 兑现。每一步核对策略、时效、冻结范围、版本、CI、评审与外部状态。前置授权在已批准边界内解析最终版本和资源。每次写入前重新核验，遇越界、漂移或无法核验的目标即停止。重试前读取逐项回执，外部结果不确定时交还人工核实。存量授权缺精确绑定时重新登记并批准。

**输出与完成条件**为每仓版本、终点、远端观测结果、回执和账本状态。移交要有可核验的见证；中断保留已完成项与待人工处理的具体条件。

### 自定义上线阶段的回执

在实例的 `extensions` 下分别登记交付动作和只读观察动作。阶段绑定动作、终点、版本和观察入口。影响目标的部署清单可列入 `inputs`，路径相对动作工作目录，执行时核对已登记清单。程序与文件访问由运行环境控制。

```yaml
actions:
  submit: {purpose: deliver, cwd: ".", argv: ["bun", "ops/submit.ts"], inputs: ["ops/manifest.json"]}
  status: {purpose: observe, cwd: ".", argv: ["bun", "ops/status.ts"], inputs: []}
stages:
  rollout: {action: submit, observe: status}
delivery: {endpoint: rollout, stages: [ship, rollout]}
```

两个程序接收相同的 `FORGE_ACTION_ID`、`FORGE_ENDPOINT`、`FORGE_ACTIVE_STAGE` 与 `FORGE_APPROVED_HEADS`。独立部署直接执行获批动作，并核对目标侧部署回执。项目使用合并事件触发部署时，按该项目配置先核对合并结果，再观察部署状态。`FORGE_APPROVED_HEADS` 是按仓排列的 `[{repo,head}]`。提交程序使用动作 ID 标记目标作业。观察程序通过只读凭据查询目标端的实际作业、部署版本与终点，在标准输出返回 JSON。例如：

```json
{"state":"completed","action_id":"ft-123/1","endpoint":"rollout","versions":[{"repo":"api","head":"0123456789abcdef0123456789abcdef01234567"}]}
```

观察程序使用 `absent` 表示目标不存在，`pending` 表示执行中，`failed` 表示失败。初次观察为 absent 时可以提交一次。提交后目标返回 absent 时，保留提交意图并转人工核对。目标返回 pending 时，在原批准会话使用本次授权编号重跑 `forge ship run --envelope <ft-id>` 查询进度。只有目标返回 `completed` 且动作、终点及全部版本匹配时才记录成功。观察程序非零退出、被终止或超时时，快轨转人工并保留提交意图。检查具体动作在目标端的状态并修复观察程序后再人工恢复。目标返回失败或版本不符时也暂停核验。
