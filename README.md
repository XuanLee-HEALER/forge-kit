# forge-kit

面向 **Codex CLI** 的自包含多仓工程工作台工具集，基于 **Bun + TypeScript** 与 **SQLite（WAL）** 构建。

本文档定义 `forge-kit` 的架构分层、开发主流程与工具边界，作为项目的核心规范。

---

## 核心特性

- **人机协同**：人工负责关键节点确认，确认后由 Codex CLI 自动完成实现、审查、验证与交付。
- **自包含工作台**：项目级配置覆盖全局配置，可在任意空目录初始化重建。
- **单任务单线程**：每个正式开发任务对应独立的 Codex thread 与任务账本，交付后关账归档。
- **三层解耦**：核心流程与具体项目/CI/CD 环境解耦，环境与工具差异通过实例覆写层扩展。

---

## 三层架构

| 层级 | 职责 | 边界 |
|---|---|---|
| **L0 · 核心骨架（Core）** | 定义通用开发主线、质量约束、任务账本、薄安全带与标准扩展点 | 零业务/公司耦合，不写死具体测试环境与发版流水线 |
| **L1 · 实例覆写（Instance）** | 定义具体工作台的仓库卡、集成验证环境、CI/CD 交付终点、阶段工具与配置覆写 | 不写入宪法（`AGENTS.md`），由 `forge` 统一暴露给工作 thread 动态调用 |
| **L2 · 引擎与 CLI（`forge`）** | 提供统一命令行入口、独立审查引擎、任务账本与安全守卫 | 职责单一，不互相侵入核心逻辑 |

### L0 标准扩展点

核心层向实例层开放四类覆写点。

1. **集成验证环境与验证手段**：测试执行环境（如远端集成环境、容器环境、本地沙箱）及验证命令。
2. **交付终点与 CI/CD 环节**：主分支合并之外的多环境部署、标签发布、数据变更与线上验收步骤。
3. **阶段级工具与配置**：各开发阶段可挂载的自定义工具、模型档位与策略配置。
4. **整份核心技能**：按稳定 ID 指向实例私有的技能目录。发现描述、执行正文及相对资源来自同一有效版本，工作线程可以查询其来源。

### L2 核心组件

- **统一入口（`forge`）**：向工作 Codex thread 统一暴露工作台能力与实例覆写配置。
- **审查引擎（`review-agents`，经由 `forge review` 暴露）**：
  - 内部独立管理审查提示词与执行编排，输入代码变更与控制参数，输出结构化审查摘要供工作 thread 修复。
  - 实例配置透传与账本记录由 `forge review` 层完成，审查引擎本身不耦合账本概念。
  - 支持通过 flags 指定执行角色子集（默认全量，可按改动范围按需运行）及执行拓扑（并发、串行或指定顺序）。
  - 执行后端以**无内置上下文的 Codex CLI 模式优先**；确认上游服务异常（额度耗尽、限流或服务故障）时回退至**基于 API 的纯自编排模式**（支持相同拓扑），并通过评测测试集保障双端输出一致性。
- **任务账本（`ledger`）**：仅用于正式开发周期（1 任务 = 1 账本，支持归档与清理），通过被动检查机制记录客观事实、防止遗漏或跳步。
- **安全守卫（`guard`）**：针对不可逆高危动作（未授权生产库写入、保护分支推送、未审批发版）的薄安全带。

---

## 开发主流程

```mermaid
flowchart TD
    Start["任务入口"] --> Triage{"任务类型"}
    Triage -->|"非开发杂活: 运维/查数/一次性脚本"| Direct["直接执行, 不开账本"]
    Triage -->|"正式开发周期: 1 thread = 1 任务 = 1 账本"| Entry{"任务起点"}

    Entry -->|"新需求 / 架构重构"| Mode{"复杂度判定"}
    Mode -->|"完整模式 (默认)"| FullDoc["需求对齐 -> SSOT -> 双独立上下文背靠背生成技术方案与测试用例 -> 评审定稿"]
    Mode -->|"轻量模式 (满足准入条件)"| LiteDoc["产出单文档: 修改范围 + 补充测试用例"]

    Entry -->|"缺陷 / 报警 (QA 与生产统一)"| Diag["前置环境诊断: 测试环境或生产只读日志与数据"]
    Diag --> BugType{"根因定性"}
    BugType -->|"需求变更"| FullDoc
    BugType -->|"需求未变: 方案/不变量/实现问题"| LocalFix["局部变更并向方案/用例/实现/审查全链路辐射"]

    FullDoc --> Gate["人工确认并冻结"]
    LiteDoc --> Gate
    LocalFix --> Gate

    Gate --> Impl["并行实现: 代码实现 || 测试用例编写"]
    Impl --> Review["按需独立 Review: forge review 选角色与拓扑 -> 依摘要修复"]
    Review --> Verify["集成验证: 实例覆写环境执行集成/冒烟/性能测试, 修至 bug-free"]
    Verify --> Ship{"交付与收尾"}

    Ship -->|"默认通用终点"| MainMerge["PR 合并至 main -> 关账并归档 thread"]
    Ship -->|"通用协同形态"| Handoff["功能 thread 带见证 PR 移交 -> 发布 thread 批量核验合并收口"]
    Ship -->|"实例扩展终点"| InstanceCD["执行实例挂载的 CI/CD 与发布流程 (高危动作确认 Runbook 后自动推进)"]
```

### 阶段规则说明

#### 1. Paperwork 分档规则
- **完整模式（默认）**：
  - 沉淀三份产物：**SSOT（业务不变量与衍生流程）**、**技术方案**、**测试用例**。
  - **独立生成**：技术方案与测试用例由两个独立上下文的 Agent 分别基于 SSOT 生成，互不参照。
  - **前置评审**：技术方案评审关注**正确性、性能、兼容性、简单**；测试用例评审关注**完备性、正确性**。确认后冻结。
- **轻量模式（严格准入）**：
  - 仅在**同时满足以下全部条件**时启用（边界不清时默认走完整模式或先确认）：
    1. 改动局限且单纯：如纯 UI / 样式 / 文案调整、单实体简单增删改查、简单字段/筛选/排序增补或局部接线；
    2. 不新增也不修改核心业务不变量、关键状态机、跨服务契约、鉴权/资金/核心数据模型；
    3. 主干行为已被现有测试用例覆盖，仅需增补局部用例。
  - Paperwork 合并为单文档：**修改范围 + 补充测试用例**。
  - 确认冻结后的实现、独立 Review、集成验证与交付标准与完整模式完全一致。

#### 2. 实现与测试原则
- 代码实现与测试用例编写双轨并行。
- 刻意减少低性价比单元测试，以**静态检查、语言动态特性检查、契约测试与集成测试**为主。
- 保持代码模块化与清晰逻辑层级，控制单文件与单次迭代变更边界。

#### 3. 四维独立 Review
工作 thread 在每次调用评审 CLI 前先运行 `forge ledger reviews <task-id>`。根据实际改动、历史版本和已有结果选择角色，随后通过 `forge review` 运行以下维度。

1. **业务对齐**：验证实现与 SSOT 或修改范围一致。
2. **实现层 Bug**：按目标语言特性排查常见缺陷与边界错误。
3. **Simplify**：平衡性能与实现简洁度。
4. **Comment Refine**：保持基本可读性与注释准确性，减少冗余注释，确保接口文档完备且与实现同步。

#### 4. 集成验证与交付
- 集成验证在实例覆写指定的验证环境中运行集成测试、冒烟测试（按需含性能测试），修复直至 bug-free。
- 默认交付终点为 PR 合并至主分支（`main`）；支持功能 thread 止于带见证的 PR 移交、由发布 thread 批量合并收口。
- 多环境部署、发版标签、数据迁移等 CI/CD 流程由实例层挂载。PR 自动合并要求托管端在同一事务核验获批的 PR 状态、版本、合并内容与分支保护。公有 GitHub 的标准合并接口无法同时锁定目标分支 SHA，执行器在写入前转人工。操作者在托管平台选择保留获批 HEAD 祖先关系的合并方式，例如创建合并提交。发布线程刷新固定目标分支的 origin 跟踪引用后，再核验合入结果。[GitHub 合并接口参数](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request)

---

## 正交模式：快速通道（同意前置）

快速通道把已确定的交付动作在执行前一起提交主会话批准。

- runbook 逐项绑定目标资源、动作与内容摘要、适用版本、有效会话和期限。只有主会话整句批准才激活相应授权。
- Codex 按既定主线自动连续推进，直至完成该任务的最终交付终点（包含实例定义的上线环节）。
- 未确定的动作、漂移的目标版本、授权过期或撤销、评审及 CI 失败，均在该步执行前停止。保留已确认的回执，对外部结果不确定的步骤交由人工核实。

---

## 快速开始

从**已构建的根发行包**解压后，在含 `kit.toml` 的目录运行下列命令。运行时需 Bun、Bash 和 Git。发行包已包含 CLI 和审查引擎的 Bun bundle，初始化、健康检查和使用已安装的命令均可跳过 `bun install` 和 `bun run build`。保留整个解包目录以供后续同步，其中 `core/` 含隐藏的技能和 Codex 配置，`templates/` 提供实例模板。

```bash
./bin/forge init ~/work/my-workbench --name my-workbench --git-org my-org
git clone <repo-url> ~/work/my-workbench/backend
cd ~/work/my-workbench
export PATH="$PWD/.workbench/bin:$PATH"
forge add-repo backend
forge doctor . --json
```

**从源码开发或打包**时，在根目录执行以下命令。根 `bun.lock` 同时锁定根包和 `review-agents/`，根目录的一次安装即可为两个包提供依赖。Bun 使用 `node_modules/` 解析这些模块。根包使用 YAML 解析器，内嵌的审查引擎使用 OpenAI SDK 和 Zod。静态检查另需各包对应的 TypeScript 和 Bun 类型声明。

```bash
export BUN_INSTALL_CACHE_DIR="${BUN_INSTALL_CACHE_DIR:-$HOME/.bun/install/cache}"
bun install --frozen-lockfile
bun run check
(cd review-agents && bun run check)
bun run test:all
(cd review-agents && bun run eval)
bun tests/v051-version.ts
bun run build
bun pm pack
(cd review-agents && bun pm pack)
```

`test:all` 运行两个包的测试。`eval` 使用本地模拟的 Codex 和 API 后端。独立的 `tests/v051-version.ts` 用 `forge verify` 在隔离检出中读取实际提交，分别核对预期版本匹配和不匹配时的退出状态、账本回执及临时目录清理。运行真实审查还需可用的 Codex CLI 会话或 API 凭据与网络连接。

**只从源码初始化工作台**时，可以仅安装生产依赖。源码启动器运行 `src/bin/cli.ts`，初始化时按当前源码构建实例使用的 bundle，无需预建 `dist/`。在新的 forge-kit 克隆根目录自举可执行：

```bash
bun install --production --frozen-lockfile
./bin/forge init . --name forge-kit
./bin/forge add-repo .
.workbench/bin/forge doctor . --json
```

**独立审查包**解压后可直接运行 `./bin/review`。它加载 `dist/review.js`，可以跳过依赖安装和构建。在根工作区之外开发该包、修改提示或运行源码测试与离线评估时，在独立目录执行以下命令。工作区内继续使用根锁文件。

```bash
cp standalone/bun.lock bun.lock
bun install --frozen-lockfile
bun run check
bun run build
bun test tests
bun run eval
```

角色、后端及凭据配置见[独立引擎说明](review-agents/README.md)。

### 浅克隆的离线升级测试

完整克隆可直接运行升级测试。浅克隆可从含相应提交、目录树和文件对象的可信历史仓生成两份 tar。测试先核对归档的 SHA-256，再解包并在临时目录运行旧版安装器。

| 升级起点 | 用例及保护行为 | tar 的 SHA-256 |
| --- | --- | --- |
| v0.4.1 | `tests/v05-upgrade.test.ts` 核对旧账本、历史见证、私有文件及受管入口迁移 | `0fb9dc3bab1714fcdf54e514e46561e4ceca516784301bd98efb00e6e9355468` |
| v0.5.0 | `tests/v051-upgrade.test.ts` 连续同步两次，核对私有验证动作、决定、历史回执和见证 | `dd59b1771a3e19e9b588dd3b46d21a714c79b6226e848f55539664c81ece80eb` |

将 `HISTORY_REPO` 设为完整历史仓的绝对路径，`FIXTURES` 设为存放归档的本地绝对路径。以下命令从当前开发检出运行。

```bash
mkdir -p "$FIXTURES"
export FORGE_V04_TEST_ARCHIVE="$FIXTURES/forge-kit-v0.4.1.tar"
export FORGE_V05_TEST_ARCHIVE="$FIXTURES/forge-kit-v0.5.0.tar"
git -C "$HISTORY_REPO" --no-replace-objects -c core.attributesFile=/dev/null -c tar.umask=0002 archive \
  --format=tar --output="$FORGE_V04_TEST_ARCHIVE" eb139c117be733173648abce723b6eaaf975f7bc
git -C "$HISTORY_REPO" --no-replace-objects -c core.attributesFile=/dev/null -c tar.umask=0002 archive \
  --format=tar --output="$FORGE_V05_TEST_ARCHIVE" e2d7453ab08bee29cf174425e84012819a74bcc3
bun test ./tests/v05-upgrade.test.ts ./tests/v051-upgrade.test.ts
```

在已建账并冻结的工作台中，`TASK` 为任务 ID，`CHECKOUT` 为该任务的 forge-kit 检出。离线执行需预先准备 Bun、Git、tar，以及包含本仓冻结安装所需包的 `BUN_INSTALL_CACHE_DIR`。历史评审由本地替身执行。通过工作台入口把两份归档显式传入隔离检出。

```bash
forge verify --task "$TASK" --cwd "$CHECKOUT" --offline \
  --fixture-env "FORGE_V04_TEST_ARCHIVE=$FORGE_V04_TEST_ARCHIVE" \
  --fixture-env "FORGE_V05_TEST_ARCHIVE=$FORGE_V05_TEST_ARCHIVE" \
  --kind test -- bun test ./tests/v05-upgrade.test.ts ./tests/v051-upgrade.test.ts
```

T10 使用三个独立 Codex CLI 会话读取安装后的 bugfix 说明，为 QA 缺陷、生产缺陷和报警选择诊断命令。运行 `FORGE_LIVE_T10=1 bun test tests/v05-incident-workflow.test.ts` 需可用的 Codex CLI 与模型访问权限。诊断目标均为本机临时 HTTP 服务；测试输出展示会话、选择的命令及服务端收到的请求。

## 实例配置示例

在私有 `.workbench/models.toml` 中按需配置 `tiers.mechanical`、`tiers.standard` 或 `tiers.deep`。每个声明的层级需有 `model` 和 `effort`；省略的层级沿用默认值。

在已初始化的工作台根目录，创建私有文件 `.workbench/overrides/ready/SKILL.md`，写入以下全文。

```markdown
---
name: ready
description: 检查本实例的 smoke 验证阶段是否可用。
---

输入是当前工作台。运行 `forge instance show stage smoke --json`，返回动作 ID 和来源后完成。
```

在现有的 `.workbench/workbench.yaml` 增加下列配置。只配置验证动作时可省略 skills 一项。

```yaml
extensions:
  actions:
    smoke-check:
      argv: ["bun", "-e", "console.log('smoke ok')"]
      cwd: "."
      purpose: verify
  stages:
    smoke:
      action: smoke-check
  verification:
    environment: isolated
    stages: [smoke]
  skills:
    ready: .workbench/overrides/ready
```

在实例根执行以下命令。最后一个命令打印 `smoke ok`。以后升级时，私有源文件与本地配置继续保留。

```bash
export PATH="$PWD/.workbench/bin:$PATH"
forge sync .
forge doctor . --json
forge instance list --json
forge instance show skill ready --json
forge instance run smoke
```

技能正文可用 Markdown 行内链接、引用式链接或图片引用同目录下的资源，链接可带标题。同步时只投影引用的本地文件。技能查询读取实例上次成功同步的受管副本。修改或撤销私有技能覆写后，先运行同步再查询。原发行目录移动后，实例仍可查询和使用已交付的技能；下次同步从所需发行目录运行。

## 升级到 v0.5

从新的发行目录运行 `./bin/forge sync <实例目录>`，再执行 `./bin/forge doctor <实例目录> --json`。对比迁移报告中的路径，遇到已改动的受管文件或归属不明的同名文件时，先保留内容，按实际归属迁入私有位置后再重试。账本、旧见证与私有脚本原位保留。旧实例的 `review-agents/` 可含私有修改，升级后使用新发行附带的引擎。

普通任务发版单继续使用 `forge ledger runbook create --task <id>`。需要快轨兑现的脚本显式传 `--exact --task <id>`（包括使用 `--stage` 或 `--fat` 的脚本）。已有精确计划保留其专属执行器与审批范围。

实例自己的脚本按下表迁移。受管命令统一通过 `.workbench/bin/forge` 提供。

| v0.4 入口 | v0.5 调用 |
| --- | --- |
| wb-git | forge git |
| wb-verify | forge verify |
| forge-review | forge review |
| forge-ship | forge ship |
| ledger | forge ledger |
| guard | forge guard |
| ledger-hook | forge ledger-hook |
| dbcred | 生产读取使用 `forge dbcred <env> --ro`。生产写入交给实例已有的受控交付流程。使用内建 PostgreSQL 快轨的实例见下方条件。非生产环境继续使用 `forge dbcred <env> --ro` 或 `--rw`。 |
| cmdfmt | forge cmdfmt |
| lang-check | forge lang-check |

**使用内建 PostgreSQL 生产快轨的条件**

升级会保留实例原有的交付策略。仅当操作者已经启用生产 SQL 快轨时才走以下流程。保留 v0.4 默认策略的实例继续使用各自已有的受控生产写入流程。

1. 核对实例策略。快轨须启用，`max_endpoint` 为 `prod`，`allow_prod` 与 `require_ci_green_for_prod` 为 true，`forbid_db_rw` 为 false。
2. 数据库条目须设置 `engine: postgres`、唯一的 `host`、`database` 与 `rw.user`。登记时 `psql` 须在 PATH 中。
3. 每个挂载仓须有可核验的同仓 PR，来源分支与任务 HEAD 对应，目标为 main。只执行 SQL 和实例阶段时，也须能按来源分支查到该 PR。交付链使用内建 ship 合并时，每仓显式传 `--pr <repo>:<number>` 并遵守托管端原子合并条件。
4. 实例须配置部署阶段及独立 observe 动作，两者均声明输入文件。用 `forge ledger runbook create --exact --task <id>` 登记精确计划，按实例顺序传 `--stage <id>`，用 `--sql <host>:<path>` 登记 SQL。按 ship 技能批准、兑现并核验目标端回执。

迁移评审脚本时，将旧 `--roles perf` 或 `--roles performance` 改为 `--roles simplify`，该角色同时检查性能与简洁性。若升级时 v0.4 任务仍有未解决的 performance 失败，可在原基线、HEAD 和评审周期显式单选 `--roles performance`，复核结果会关联这条旧记录。其他情况下，原先同时选择两个角色的脚本只传一次 simplify。需要锁定后端时，用 `--backend codex` 或 `--backend api` 替换 `--no-fallback`。默认 `auto` 先运行独立 Codex 会话，上游服务异常时尝试 API。自动化从报告的 `roles` 数组读取每个已选角色的结果。`attempts` 为空表示该角色未启动，可查看 `missing_materials` 确认缺什么材料。整体退出码为 0（通过）、1（阻断）、2（执行错误）和 3（未完成）。

默认技能为 ready、grill、feature、bugfix、review、verify、pr-triage 和 ship。原业务取舍方法并入 grill，收尾拆给 review、verify 和 ship，四个专项评审统一由 review 选角色。环境配方与专业技能由实例维护。代理按 scanner、analyst、implementer 和 reviewer 四种专长委派，后两者分别承接原 dev 与 spec-reviewer 的任务。独立引擎的四个评审维度由引擎参数选择。

## 信任边界

执行器记录当前 SHA 的实际验证和评审结果。账本通过 SQLite 事务和追加事件摘要保存历史，外部保留的 Ledger-Tip 可以核验相应前缀。同一系统用户的文件权限由操作系统控制。守卫识别高危操作并核对授权，远端分支保护、数据库授权、凭据作用域和必需 CI 检查由部署方设置。通用阶段使用最小权限，受控写操作在匹配精确授权后单独兑现。
