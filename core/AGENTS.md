# {{WORKBENCH_NAME}} 工作台

本目录是多仓库工程工作台，每个带 `.git` 的业务子目录为独立仓库；工作台根目录本身不是业务仓库。本文件是工作台唯一常驻入口，按任务需要读取 `AGENTS.local.md`、`.agents/skills/` 中的流程 skill 以及 `.workbench/repos/` 对应仓库配置。

## 目录与基本规矩

- **Git**：根目录无默认仓库，执行 Git 一律用 `git -C <仓库路径>` 或在目标仓/worktree 目录内执行；commit 遵循 `<type>(<scope>): <subject>`。新建 worktree 一律用 `git -C <仓> worktree add` 置于 `<仓>.worktrees/<name>`，**禁止调用 Codex Desktop 内置 `create_worktree`**（会把会话 `cwd` 切离工作台导致 `.codex/hooks.json` 失效）；合并部署后及时清理 worktree 与本地已合分支。
- **共享工作树红线**：禁止 `git stash`、`git checkout --`、`git restore`、`git reset`、`git commit --amend`、`git add -A`、`git add .`。提交前检查 `git status`，逐文件 `git add` 并带 pathspec 提交。
- **PR 格式**：标题 `type: 一句话描述`；正文固定三节：「改动内容」（直白业务语言）、「关键文件改动」、「对历史影响」（无影响写「无」）。
- **一次性脚本**：未另指定位置时归档至 `one-off-scripts/`，按职责分目录并更新该目录 `README.md`，不散放工作台根目录。
- **工作台扩展**：本工作台特有约定与公司专属规则放 `AGENTS.local.md`，仓库命令与专属边界放 `.workbench/repos/<repo>.md`，环境/护栏配置放 `.workbench/workbench.yaml`。

## 需求与问题判断

简单任务直接按以下四条裁决；需求存在多解、缺陷后果不明或评审意见可能扩大范围时，读取 `.agents/skills/business-analysis/SKILL.md`。

- **应修**：有证据表明实际路径违反已确认不变量，或妨碍核心目标，且修正符合既有取舍。
- **可放过**：已有取舍覆盖，或后果轻微、可恢复且修复成本高于收益（一句话说明触发条件与接受的后果）。**涉及安全、资金或不可恢复数据损失，必须核实影响，低概率本身不足以放过。**
- **先查事实，再决定是否问**：入口、状态、代码与数据事实自行查证；仅当改变用户权益、核心行为、可接受损失或超出授权时，带着推荐方案与具体代价询问用户。
- **接受的例外有终点**：只把足以阻断交付的承诺记为不变量；区分用户裁决与 agent 建议，不在新证据出现前反复推翻已定取舍。

## 交付终点 × 验证深度

接单或派工先明确两个正交决定（用户新指定的停止位置优先；未明说默认在**本地**交付）：

| 交付终点 | 完成条件 |
|---|---|
| `investigation` | 查证事实，交付根因/结论/方案，等待确认后才动手 |
| `local` | 完成实现、适用验证与收尾，汇报证据与缺口即停 |
| `fat` | 本地验证与收尾通过后合入测试分支、推送并按授权验收 |
| `pr` | 创建或更新目标 PR 并汇报证据，开好即停（`main` PR 始终由用户合并） |
| `prod` | 核对目标提交、既有证据与生产依赖，按 `ship` / 发布规则执行；不可逆操作保留人工确认 |

- **验证深度只由实际影响决定**（与分支来源、worktree 或文件数无关）：
  - **定向验证（`targeted`）**：风险边界清晰的局部修改、低风险小修、纯文档/注释。执行独立定向评审 + 受影响的构建/测试/生成核验。
  - **完整验证（`full`）**：资金/计费、权限规则、协议行为变化、数据库迁移、事务/并发、跨模块变更或关键风险未排除。按 `.agents/skills/wrapup/SKILL.md` 执行完整收尾。

## 工程底线

- **资金与权益的服务端权威原则**：金额、积分、额度、折扣、结算或权益发放，客户端输入仅作意图声明，服务端必须依据自身状态、可信计量或已校验凭据独立裁决，且**核验、计价与实际执行必须绑定同一业务对象与状态**；无法取得可信依据时不得静默采信客户端数据。
- **什么时候动手与连续推进**：业务口径类改动须等用户明确“开工/按方案做”（确认问题存在不等于批准）；架构性、外部依赖或 SSOT 变更先落设计文档确认后再实现；**已经用户裁决的待办队列不清空不停，完成一项立刻推进下一项**；未要求新建分支/worktree 时在当前分支修改；方案与汇报不写人天估算；第三方库行为先查源码或文档。
- **验证与测试纪律（AI-Native 契约优先）**：
  - **刻意克制低价值 Mock 单测**：业务 CRUD 与胶水层不堆砌 Mock 单元测试，优先用独立上下文生成的黑盒 **Hurl / 集成测试** 验证真实接口与不变量；**仅对纯算法、计费/额度公式、状态机跃迁或并发不变量**编写无 Mock 表驱动单测。
  - **静态与动态基线前置**：`full` 深度任务在推分支/提 PR 前必须具备当前 SHA 的静态检查（`lint`/typecheck，可用仓原生命令或 `.workbench/bin/lang-check`）与执行验证通过证据；未实际运行集成测试时用真正不执行初始化的编译检查（如 Go `go test -c -tags=integration`）。
  - 单测通过不等于验收通过，汇报须区分「已执行」「仅编译/静态检查」「未验证」，并将本地检查与 FAT/Hurl 验收分开列示。
  - 契约或持久化格式变化须同步相关测试与接口文档，不靠弱化断言或偷改冻结 Hurl 消错；提交的测试/回归资产必须可移植（无个人路径、本机隐式状态与真实凭据）。
  - **网页/浏览器自动化测试必须由用户主动要求**，适用于所有项目与环境；不得因开发或验收授权自行打开浏览器测试。
  - 表单任务默认遵循 `.agents/skills/form-ux/SKILL.md`；本机隔离组件实验默认遵循 `.agents/skills/test-environment/SKILL.md`。

## 环境与安全红线

- **问题出在哪个环境，就只查哪个环境**；线上问题看 prod 事实，不拿测试环境数据推断；测试环境问题不主动访问 prod（只读亦同）。
- **凭据不回显**：读取配置或接口返回时只输出键名或脱敏摘要，不打印密钥、token 或完整敏感字段。
- **物理保险丝由 `.codex/hooks.json` 强制执行**：prod 库写操作、非只读 `kubectl`、读 k8s `secret`、`gh pr merge`、推生产 tag、破坏共享工作树及直接改 `.workbench/ledger/` 均由底层护栏拦截。**发版 Runbook 签发**：需自动推进发版时，先用 `.workbench/bin/ledger runbook create` 登记精确项（单 tag+SHA / PR / 迁移 SQL / 非只读 `kubectl`）并给用户确认；用户于本会话回复 `批准 <id>` 后由 `UserPromptSubmit` Hook 签发短期白名单通行证自动放行（`--tags`/强推 `main`/读 `secret` 永久禁止）。

## 开发任务账本（Ledger）、Spec 冻结与被动机制

- 仅针对 `.workbench/workbench.yaml` 登记的**业务仓库开发任务**；运维查数、查日志、沟通与 `one-off-scripts/` 无需开账本。
- 账本通过 `.workbench/bin/ledger` 管理，**按任务建账、以 `(repo, branch)` 唯一路由**（跨仓任务用 `ledger attach` 挂入同一 `task_id`）。
- `full` 开发周期的三件套文档（`ssot.md`、`tech-spec.md`、`test-spec.md`）默认存于 `.workbench/specs/<task_id>/`（仅用户主动要求时移入业务仓）；定稿后通过 `ledger freeze` 写入哈希链并由 `guard` 物理锁定（含锁定 Hurl 测试防篡改），周期内确需修改须经用户确认执行 `ledger amend` 并按依赖辐射重跑下游。
- 被动 Hook 在 `git commit` / `git push` / `gh pr create` 前校验账本底线门禁（静态检查、执行验证、核心评审通过且无失败角色；完整四层评审覆盖由 `wrapup` SOP 推进并在 `ledger status` 审计），并在新会话或压缩后回注活跃任务摘要；纯文档/注释/typo 极小改动可用 `ledger exempt` 豁免。

## 模型与子代理调度

模型映射统一维护在 `.workbench/models.toml` 与 `.codex/agents/*.toml`，禁止在流程中硬编码模型 ID：

| 逻辑档位 | 适用任务 | 对应代理 |
|---|---|---|
| `mechanical` | 边界清晰的只读检索、核查与机械整理 | `.codex/agents/scanner.toml` |
| `standard` | 常规开发、修复、测试与文档修改（仅写操作） | `.codex/agents/dev.toml` |
| `deep` | 复杂架构权衡、高不确定性根因、高风险/Paperwork 只读评审（需写明理由） | `.codex/agents/analyst.toml` / `spec-reviewer.toml` |

按职责选代理（只读检索用 `scanner`，只读评审用 `codex review` / `analyst` / `spec-reviewer`，勿将只读任务派给可写 `dev`）；小任务可直接处理。独立 review CLI 必须实际调用并保持隔离，不可自审替代。

## 流程 Skills 与仓库配置

- **开发与交付**：`ready`（新会话热身定位）、`grill`（需求追问与 `ssot.md` 定稿）、`feature`（双轨/5阶段规范驱动开发）、`bugfix`（需求变更全周期 vs 局部 `amend` 辐射 + 缺陷棘轮）、`wrapup`（静态/动态检查 + 四层独立评审）、`ship`（FAT/PR/发布交付）、`business-analysis`（口径权衡）、`form-ux`（表单规范）、`test-environment`（隔离容器实验）。
- **独立只读评审 CLI**：`implementation-review`（自动注入 Go/TS/Python 坑点）、`simplicity-performance-review`、`code-simplification-review`、`comment-normalization-review`（位于 `.agents/skills/` 相对软链）。
- **工具与仓库配置**：仓库卡见 `.workbench/repos/`；多仓分支与清理用 `.workbench/bin/wb-git`；跨语言静态/动态检查用 `.workbench/bin/lang-check`。
- **工作台特有规则**：如存在 `AGENTS.local.md`，开工一并读取。
