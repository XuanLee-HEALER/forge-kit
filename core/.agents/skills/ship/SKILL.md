---
name: ship
description: 将已验证的版本交付到授权终点，核验回执并关账；支持 PR 移交、批次和精确预授权快轨。
---

# 交付与归档

**输入**为任务、冻结规格、各挂载仓与分支、待交付 SHA、实际验证和审查证据、实例终点及授权。用 `forge instance list --json` 确定阶段，用 `forge ledger status` 核对任务；缺省交付终点为 PR 合入 main。

## 单任务

1. 确认冻结摘要、锁定测试和干净工作树；核对静态、执行、集成验证及独立审查均属于当前冻结周期和目标 SHA。当前范围仍有 blocked、error、incomplete 的已执行角色或未关闭 blocker 时暂停。历史结果保持原始归属。
2. 按实例阶段创建或更新 PR。通过 `forge ledger pr-sync <task-id> --repo <repo> --branch <branch>` 核对远端 HEAD，将 `forge ledger tip <task-id>` 的见证附入 PR。外部意见用 pr-triage。检查目标分支、固定 HEAD 及必需 CI。
3. 需要受保护动作时，先用 `forge ledger runbook create` 登记精确动作。向用户展示仓、远端、资源、版本、内容摘要和适用时效。主会话单独发送 `批准 <rb-id>` 或 `approve <rb-id>` 后方可兑现。若由人工合并，等待远端结果并核对。
4. 核验远端 main 包含待交付提交或相应受核验的合并结果，再登记回执。实例另有终点时按已授权的阶段、顺序和版本继续，记录实际外部状态。到达本次终点后执行 `forge ledger close <task-id>`。

## 功能线程移交与发布批次

功能线程完成验证及 PR 分诊，逐仓同步 HEAD 后执行 `forge ledger handoff <task-id>`，把 Forge-Task、Verified-Head、Ledger-Tip 见证附入 PR，止于 HANDED_OFF。需改实现时先 `forge ledger resume <task-id>`，复验后重新移交。

发布线程用 `forge ledger release create --title "<title>" --from-handoffs` 或显式任务列表建批，`forge ledger release verify <rel-id>` 核验实时 PR。出现版本漂移时暂停相应批次并退回功能线程。使用 `forge ledger release runbook <rel-id>` 汇集确定的动作，在主会话取得精确批准。将返回的 human_merges 清单交给操作者在托管平台核对目标分支、HEAD 和必需检查后合并。发布线程运行 `forge ledger release verify <rel-id>` 核验远端结果，记录其余已批准动作的回执，再完成 runbook 及 release。

命名交付终点会在批次 runbook 的 `actions.release_observers` 中列出各阶段的动作 ID、目标和版本。发布后执行 `forge ledger release observe <rel-id>` 读取目标侧状态。所有观察器确认对应版本已完成后，账本记录工具回执，再执行 `forge ledger release complete <rel-id>`。重复观察会记录目标状态的变化；若观察器执行失败、返回未知状态或目标回报的动作及版本不符，本次观察会使先前的通过回执失效。须等同一批次、动作和版本重新确认完成后方可关账。

## Fast-Track

从实例交付配置中读取有序阶段。用 `forge ledger runbook create --task "$TASK" --title "$TITLE" --pr "$REPO:$PR"` 登记精确合并；有自定义上线步骤时按声明顺序重复传入 `--stage <stage-id>`。登记时解析目标版本、动作参数及脚本摘要。内建 ship 在实例阶段列表的位置决定精确 PR/tag/SQL 的执行顺序。同名实例实现也按其位置运行。只有受信托管端可原子核验全部获批条件时才自动合并。公有 GitHub 和未提供此能力的实例在写入前转人工，操作者通过托管端的受保护 PR 流程合并。把返回的具体目标和内容提供给批准人。

实例终点为 FAT 时，按每个挂载仓登记 `--fat <repo>:fat`，绑定远端现有的 `refs/heads/fat`、旧 SHA、来源 head 及预期更新 SHA。该 runbook 只允许指定测试引用的条件更新。

规格冻结后，使用 `forge ledger fast-track prepare <task-id> --to <endpoint> --paths <globs> --runbook <rb-id>` 绑定终点、范围和精确 runbook。向用户展示逐项资源、动作、版本和时效。用户在主会话单独发送 `快轨批准 <ft-id>`。撤销 ACTIVE 授权时，须回到原批准主会话单独发送 `快轨撤销 <ft-id>`；若已有 claimed 项，核对其回执与目标状态。PENDING 授权可用 `forge ledger fast-track revoke <ft-id>` 撤销。快轨可覆盖整个实例交付路径。实例交付动作可以运行部署程序，需要生产级终点和策略许可。准备后变更任务终点会使原授权失效，须按新范围重新准备并批准。

在同一获批会话运行 `forge ship evaluate --envelope <ft-id>` 后用 `forge ship run --envelope <ft-id>` 兑现。每一步核对策略、时效、冻结范围、版本、CI、评审与外部状态。只执行已确定动作；超界、漂移、后来才确定的动作或异常均须在调用前停止。重试前读取逐项回执，外部结果不确定时交还人工核实。存量授权缺精确绑定时重新登记并批准。

**输出与完成条件**为每仓版本、终点、远端观测结果、回执和账本状态。移交要有可核验的见证；中断保留已完成项与待人工处理的具体条件。

### 自定义上线阶段的回执

在实例的 `extensions` 下分别登记提交动作和只读观察动作。两者都要列出相对各自工作目录的输入文件，包括脚本隐式读取的部署清单、配置及模块。没有额外输入时显式填写 `inputs: []`。登记时将可执行程序、可识别的解释器入口脚本、参数值与已声明输入的内容绑定到 runbook，调用前重新校验。输出路径以参数值登记，允许工具写入和更新。

```yaml
actions:
  submit: {purpose: deliver, cwd: ".", argv: ["bun", "ops/submit.ts"], inputs: ["ops/manifest.json"]}
  status: {purpose: observe, cwd: ".", argv: ["bun", "ops/status.ts"], inputs: []}
stages:
  rollout: {action: submit, observe: status}
delivery: {endpoint: rollout, stages: [ship, rollout]}
```

两个程序接收相同的 `FORGE_ACTION_ID`、`FORGE_ENDPOINT`、`FORGE_ACTIVE_STAGE` 与 `FORGE_APPROVED_HEADS`。最后一项是按仓排列的 `[{repo,head}]`。提交程序使用动作 ID 标记目标作业。观察程序通过只读凭据查询目标端的实际作业、部署版本与终点，在标准输出返回 JSON。例如：

```json
{"state":"completed","action_id":"ft-123/1","endpoint":"rollout","versions":[{"repo":"api","head":"0123456789abcdef0123456789abcdef01234567"}]}
```

观察程序使用 `absent` 表示目标不存在，`pending` 表示执行中，`failed` 表示失败。初次观察为 absent 时可以提交一次。提交后目标返回 absent 时，保留提交意图并转人工核对。目标返回 pending 时，在原批准会话使用本次授权编号重跑 `forge ship run --envelope <ft-id>` 查询进度。只有目标返回 `completed` 且动作、终点及全部版本匹配时才记录成功。观察程序非零退出、被终止或超时时，快轨转人工并保留提交意图。检查具体动作在目标端的状态并修复观察程序后再人工恢复。目标返回失败或版本不符时也暂停核验。

### 托管端原子 PR 合并接口

默认的 `atomic_pr_hosts` 为空。实例运维方在验证自托管平台确实实现以下事务后，可在 `extensions.delivery.atomic_pr_hosts` 列出该平台的 HTTPS 主机及非默认端口，例如 `forge.example.test:8443`。默认 443 端口使用主机名登记。授权绑定 HTTPS 仓库、PR 编号、base 分支及 SHA、head SHA、合并结果的 Git tree SHA 和协议版本。

- 在已登记仓库的 REST API 根下，`GET repos/<owner>/<repo>/forge/atomic-pr/v1/capabilities` 返回 `protocol: "forge.atomic-pr.v1"`、`repository`（完整 HTTPS 仓库 URL）及 `preconditions`。列表须包含 `open_pr`、`head_oid`、`base_branch`、`base_oid`、`merge_tree`、`protected_branch_rules` 和 `required_checks`。
- 唯一写请求为同仓的 `POST repos/<owner>/<repo>/forge/atomic-pr/v1/pulls/<number>/merge`。JSON 字段为 `protocol`、`pull_request`（完整 PR URL）、`expected_state`（OPEN）、`expected_head_oid`、`expected_base_branch`、`expected_base_oid`、`expected_merge_tree` 和 `policy`（protected_branch_rules_and_required_checks）。
- 平台在发布新提交的同一事务中校验全部前置条件与当前调用者权限，并记录该 PR 已合并。任一条件改变须拒绝写入，保留原目标分支。执行器使用独立的 PR 与 Git 对象读取接口核对实际合并提交、父提交和 tree 后记录回执。托管端不支持此协议或无法确认结果时，检查现有 PR 后手工交付。
