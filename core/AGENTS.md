# {{WORKBENCH_NAME}} 工作台

业务子目录各有独立 Git 仓库。接单先读本文件及现有 `AGENTS.local.md`，按需查 `.agents/skills/` 和 `.workbench/repos/<repo>.md`。环境及护栏配置在 `.workbench/workbench.yaml`，实例专属约定放本地入口。

## 工作树与交付物

- [自律] Git 用 `git -C <仓>` 或在目标 worktree 内执行。默认在当前分支修改。新 worktree 用 `git -C <仓> worktree add` 放到 `<仓>.worktrees/<name>`；禁用 Desktop 的 `create_worktree`，以免会话离开工作台而丢失 hooks。部署后清理已合分支与 worktree。
- [hook][自律] 共享工作树禁止 stash、checkout --、restore、reset、commit --amend、add -A 和 add .。提交前查 status，逐文件 add，带 pathspec 提交。commit 用 `<type>(<scope>): <subject>`。
- [自律] PR 标题用 `type: 一句话描述`，正文写「改动内容」「关键文件改动」「对历史影响」，业务语言直述，无影响写「无」。一次性脚本默认放 `one-off-scripts/` 对应职责目录并更新其 README。

## 判断与开工

按已确认的不变量、用户目标与既有取舍判断。查证入口、状态、代码和数据后，修复真实路径中的违反项。可接受例外要说明触发条件、后果与边界；涉及安全、资金、不可恢复数据必须核实影响。仅将阻断交付的承诺列为不变量，区分用户裁决与建议，出现新证据再重议。遇多解、后果不明或评审建议扩围，读 `business-analysis`。

改变用户权益、核心行为、可接受损失或授权范围时，带推荐方案与代价请用户裁决。业务口径改动等用户明确开工；架构、外部依赖或 SSOT 变更先落设计文档并确认。已裁决队列逐项推进至清空。不估人天，第三方库行为查源码或文档。

## 交付终点与验证深度

以用户最新指定的终点为准，默认 `local`。

| 终点 | 完成条件 |
|---|---|
| investigation | 查证并汇报根因、结论或方案，等确认再实施 |
| local | 完成实现、适用验证与收尾，汇报证据和缺口 |
| fat | 本地通过后用 `wb-git fat-merge <repo> <branch>` 合入测试分支、推送并按授权验收 |
| pr | 创建或更新 PR，推送用 `ledger pr-sync <task_id> --repo <仓> --branch <branch>` 核验 HEAD，汇报后停止；main PR 由用户合并 |
| prod | 核对目标 SHA、证据和依赖，按 ship 发布，不可逆操作经人工确认 |

按实际风险选深度。边界清晰的局部小修或文档用 `targeted`，独立定向评审并运行受影响的构建、测试或生成核验。资金、权限、协议、迁移、事务并发、跨模块变更或风险未排除用 `full`，执行 `wrapup` 完整收尾。

## 工程与验证

- [自律] 资金和权益由服务端依据可信状态、计量或凭据裁决。客户端仅声明意图；核验、计价和执行绑定同一对象及状态。无可信依据时停止。
- [自律] 优先由独立上下文编写 Hurl 或集成契约验证。纯算法、计费公式、状态机或并发不变量用无 Mock 表驱动测试；避免给 CRUD 与胶水层堆 Mock。
- [hook][自律] full 交付前须有当前 SHA 的静态检查与执行验证，使用干净工作树运行 `.workbench/bin/wb-verify`，四角色评审用 `.workbench/bin/forge-review`。仅检查集成测试编译时使用不会执行初始化的命令，如 Go 的 `go test -c -tags=integration`。汇报区分已执行、仅编译、未验证，分列本地及 FAT/Hurl 验收。
- [自律] 契约、持久化格式变化同步测试和接口文档。回归资产不含个人路径、本机隐式状态或真实凭据。禁止削弱冻结断言以消除失败。
- [自律] 浏览器自动化测试只在用户主动要求时执行。表单任务读 `form-ux`，本机隔离实验读 `test-environment`。

## 环境与发布红线

- [自律][凭据] 只查问题所在环境；测试问题不访问 prod，线上结论用 prod 事实。凭据只展示键名或脱敏摘要。dbcred 默认只读，生产写凭据用 `dbcred <env> --rw --runbook <id>`。
- [平台] 数据库权限、Kubernetes RBAC（不给 secrets 读取权）、GitHub 分支和 tag 规则及必需状态检查由部署方落实。
- [hook] PreToolUse 检查可识别的 prod 写操作、集群变更、secret、端口转发、受保护分支与 tag、PR 合并及账本直接修改。发版先用 `ledger runbook create` 登记精确 tag+SHA、PR、迁移 SQL 或 kubectl 命令。
- [hook][自律] 用户在主会话**单独回复整句** `批准 <rb-id>` 或 `approve <runbook_id>`，不附带其他文字或标点。多个编号用空格分隔。批准仅对登记项、会话和有效期生效。禁止批量推 tag、强推 main、读取 secret。

## 任务账本与冻结

- 仅登记业务仓开发任务。运维查数、日志、沟通和一次性脚本无需开账。用 `.workbench/bin/ledger` 按任务建账，按 (repo, branch) 唯一路由，跨仓用 attach。
- full 周期的 ssot.md、tech-spec.md、test-spec.md 默认在 `.workbench/specs/<task_id>/`，用户主动要求才移入业务仓。定稿用 freeze 保存摘要和锁定测试，交付时核对工作树与 Git；变更须用户确认后 amend，按影响重跑下游并重新 freeze。
- [hook] commit、push、PR 前校验账本绑定及适用证据。完整深度须静态检查、执行验证和核心评审通过，无失败角色；四层覆盖由 wrapup 推进，在 status 审计。极小文档、注释、typo 可用 exempt。新会话或压缩后 hook 回注摘要。新验证与评审由执行器写入 source=tool；hook 记录提交与经远端核验的 PR，手工验收注明来源。
- 账本哈希链用于一致性检查。用 `ledger stats` 查看汇总，用 `ledger tip <task_id>` 生成 PR 正文的 Ledger-Tip 见证；同一系统用户的写权限仍由操作系统控制。

## 交付方式

- 单线程交付按授权终点验收并关账。分线程发布时，功能线程确认实现和 PR 评审意见已处理、可随批发布，再执行 `ledger handoff <task_id>`，将见证贴入 PR 后止于 `HANDED_OFF`；实现问题退回功能线程，需改代码先 `ledger resume <task_id>`。发布线程用 `ledger release` 组批、核验远端 SHA、登记回执并批量关账。
- 快轨由操作者维护写保护的 `.workbench/ship-policy.yaml`。冻结后用 `ledger fast-track prepare` 定范围，用户在主会话单独发送 `快轨批准 <ft-id>` 或 `快轨撤销 <ft-id>`。批准会话用 `forge-ship evaluate` 核验、用 `forge-ship run` 兑现；降级交给人工接管。操作顺序见 ship 技能。

## 调度与流程入口

模型按 `.workbench/models.toml` 映射并同步到 `.codex/agents/*.toml`，流程不硬编码 ID。mechanical 用只读 scanner 检索；standard 用可写 dev 实施；deep 用只读 analyst 或 spec-reviewer 处理复杂权衡、高风险根因和文档评审，说明选用理由。小任务可自行完成。独立 review CLI 须实际隔离运行，不以自审代替。

按阶段读 ready（热身）、grill（需求和 SSOT）、feature（双轨五阶段）、bugfix（amend 辐射与缺陷棘轮）、wrapup（验证与独立评审）、pr-triage（PR 评审分诊）、ship（交付）。四个专项入口为 implementation-review、simplicity-performance-review、code-simplification-review、comment-normalization-review。多仓管理用 wb-git，仓库命令查对应仓库卡。
