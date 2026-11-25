---
name: ship
description: >
  按授权终点执行交付：测试环境（FAT）合并推送与验收、准备与创建 PR、生产发布核对与发布后分支清理。
  触发词：合 fat、推 fat、上 fat、fat 验收、提 PR、进 main、上线流程、走发布流程、清理分支、ship。
---

# 按授权终点交付

| 阶段 | 进入条件 | 完成条件 |
|---|---|---|
| FAT | wrapup 通过且已授权测试环境 | 记录推送的 FAT SHA、部署结果和实际验收情况 |
| PR | 已授权创建或更新 PR | PR 正文含账本见证，远端 HEAD 与验证 SHA 一致 |
| Prod | 已明确授权生产且精确 Runbook 已获批 | 登记动作完成，部署、只读回查与回滚条件已核对 |
| Cleanup | PR 已合并且部署成功 | 本次临时工作树与分支已清理，账本按终点关闭 |

1. 核对任务、仓库卡、目标分支和已验证 SHA。同任务升级终点用 ledger set-endpoint 或 reopen。
2. **FAT**　运行 `.workbench/bin/wb-git fat-merge <repo> <branch> [--cherry-pick]`，依仓库卡选择策略。保存 feat_sha、fat_sha，跟踪部署。后端执行受影响的接口验收，按本轮运行 ID 逆序清理夹具并核验残留。真实业务记录引用夹具时保留真实记录，报告受阻的夹具 ID，验收记为失败，前端交由用户测试。实际验收通过后在功能 SHA 登记 fat 证据。
3. **PR**　核对相对 origin/main 的差异与历史。用 `.workbench/bin/ledger tip <task_id>` 取得整行 `Ledger-Tip: <task_id>@<hash>`，附在 PR 正文末尾。标题用 type 加一句话描述，正文写改动内容、关键文件及历史影响。后续推送运行 `.workbench/bin/ledger pr-sync <task_id> --repo <repo>` 更新远端证据。授权终点为 PR 时交给用户合并。
4. **Prod**　获取最新 origin/main，核对发布范围只含授权改动。发布 tag 前用 `git merge-base --is-ancestor <sha> origin/main` 确认目标已合入。列明仓库、解析后的目标 SHA、PR、annotated tag、SQL 文件及主机、准确的 kubectl 命令、回滚方案和新旧版本兼容性。通过 `.workbench/bin/ledger runbook create` 登记精确动作，向用户展示上述清单及生成的编号。用户须在主会话**单独发送整句** `批准 <runbook_id>` 或 `approve <runbook_id>`，不附说明或标点。仅在签发会话及有效期内执行登记操作。数据库默认用只读 `.workbench/bin/dbcred <env>`，批准迁移才用 `.workbench/bin/dbcred <env> --rw --runbook <id>`。监测部署、错误日志及只读核验结果，再执行 `ledger runbook complete <runbook_id>`。若关联 prod 任务，以部署回查的实际结果运行 `ledger record <task_id> --kind prod --status <pass|fail> --repo <repo> --branch <branch> --sha <sha> --summary "<验收结果>"`。
5. **Cleanup**　用 wb-git sweep 或按范围删除已合入的本地临时分支和工作树，核对 git worktree list。解绑已废弃的临时挂载，运行 ledger close，汇报实际交付记录。
