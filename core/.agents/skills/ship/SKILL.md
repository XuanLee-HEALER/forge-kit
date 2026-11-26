---
name: ship
description: 交付已验证的功能至 FAT、PR 或生产，按授权选择单线程交付、PR 移交与批量发布，或使用预授权快轨。
---

# 按授权终点交付

在工作台根目录执行 `export PATH="$PWD/.workbench/bin:$PATH"`。先核对任务、仓库卡、分支、终点和待交付的 SHA。
每个挂载分支分别进入其干净功能工作树运行 `wb-verify` 和 `forge-review`；也可在根目录为两条命令都指定 `--task <task_id> --cwd <工作树绝对路径>`。

| 当前情况 | 模式 | 谁负责收尾 |
|---|---|---|
| 一个线程负责本次功能的全部交付 | A 单线程 | 功能线程验收到授权终点并关账 |
| 功能线程在 PR 停止，多个任务一起发版 | B 移交与发布列车 | 发布线程按批次核验并关账 |
| 操作者愿意提前批准冻结规格内的有限改动 | C 预授权快轨 | 同一会话兑现一次性授权，按终点接续 |

## A · 单线程交付

1. 在干净工作树运行 `wb-verify` 和 `forge-review`，核对证据对应当前 SHA。
2. FAT 用 `wb-git fat-merge <repo> <branch> --task <task_id>`。记录功能与 FAT SHA，跟踪部署，验收后在功能 SHA 登记 FAT 结果。
3. PR 核对目标分支、推送并创建 PR，正文附 `ledger tip <task_id>` 的见证。对每个挂载分支运行 `ledger pr-sync <task_id> --repo <repo> --branch <branch>` 核对远端 HEAD。
4. 生产用 `ledger runbook create` 登记精确 PR、tag/SHA、SQL 主机与文件或 kubectl 命令，向用户展示范围及回滚方案。用户在主会话单独发送 `批准 <rb-id>`。
5. 执行已批准动作，跟踪部署并只读回查。完成运行手册，按功能 SHA 用 `ledger record` 登记实际验收结果。

**完成条件**　授权终点的证据齐全，`ledger close <task_id>` 成功。

## B · PR 移交与批量发布

**功能线程**

1. 运行 `wb-verify`、`forge-review`，推送并创建 PR。用 `ledger pr-sync <task_id> --repo <repo> --branch <branch>` 逐个同步挂载分支的 PR。
2. 功能线程负责实现和评审意见。有外部意见时先用 pr-triage 完成裁决和已确认的修复，验证并同步最终 HEAD。确认 PR 已就绪可发版，再执行 `ledger handoff <task_id> [--sql <host>:<path>] [--rollback "<note>"]`，将输出的 `Forge-Task`、`Verified-Head`、`Ledger-Tip` 三条见证贴入对应 PR。
3. 状态为 `HANDED_OFF` 后停止。若需按评审修改代码，先 `ledger resume <task_id>`，再验证新 HEAD 并重新移交。

**发布线程**

接手者负责把已就绪的 PR 随批次发布。HEAD 漂移或新发现的问题需要改实现时，暂停受影响批次并退回功能线程，待重新移交后再发版。

1. 用 `ledger release create --title "<title>" --from-handoffs` 选取全部尚未被发布批次占用的 `HANDED_OFF` 任务。要指定批次成员，将 `--from-handoffs` 换成 `--tasks <id1>,<id2>`。再运行 `ledger release verify <rel-id>`。复用已移交的验证证据，通过实时 `gh pr view` 核对 SHA；出现 `STALE_PR` 时停止发布。
2. 用 `ledger release runbook <rel-id> [--tag <repo>:<tag>:<sha>]` 将 PR、移交的 SQL 和发布标签汇入同一运行手册。用户单独发送 `批准 <rb-id>`。
3. 执行输出的固定 HEAD 合并命令及获批动作。对 SQL、tag、kubectl 在对应任务的移交 SHA 登记 prod 回执，元数据含 `runbook_id` 和 `execution_actions` 给出的 `action_id`；生产任务另记部署验收。
4. PR 远端合并后，在每个相关仓库执行 `git fetch origin` 更新目标引用，再执行 `ledger runbook complete <rb-id>` 和 `ledger release complete <rel-id>`。批次关闭后用 `wb-git sweep` 预览清理范围。

**完成条件**　功能线程止于有见证的移交；发布线程完成批次，所有子任务原子关闭。

## C · 预授权快轨

1. 执行 `ledger freeze <task_id>`，按只读策略 `.workbench/ship-policy.yaml` 选择终点和路径。运行 `ledger fast-track prepare <task_id> --to <pr|fat|prod> --paths '<globs>' [--ttl <min>]`。
2. 用户在主会话单独发送 `快轨批准 <ft-id>` 或 `fast-track approve <ft-id>`。`快轨撤销 <ft-id>` 可撤销 `PENDING` 或 `ACTIVE` 信封。生产信封一旦 `REDEEMED`，用 `ledger runbook revoke <rb-id>` 撤销运行手册中尚未执行的生产动作。
3. 编码后在干净工作树运行 `wb-verify` 和 `forge-review`。PR 或生产终点须先推送已验证的 HEAD，创建或更新对应 PR，让远端 HEAD 与本地一致；生产还须等待必需 CI 通过。
4. PR 快轨兑现会直接移交，功能线程先确认已有评审意见均有结论，PR 已就绪。评估前在各相关功能工作树执行 `git fetch origin` 更新目标引用。在批准会话执行 `forge-ship evaluate --envelope <ft-id>`，得到 `ELIGIBLE` 后运行 `forge-ship run --envelope <ft-id>`。越界、禁区、改动量超限、规格漂移或生产 CI 失败会进入 `DEGRADED`，交由人工接管；过期状态为 `EXPIRED`。

**完成条件**　信封为 `REDEEMED`。FAT 检查推送回执，PR 自动移交至模式 B，停止前将返回的 `trailers`（`Forge-Task`、`Verified-Head`、`Ledger-Tip`）贴入对应 PR 正文；生产生成精确 SHA 的已批准运行手册，按其执行并记录验收。
