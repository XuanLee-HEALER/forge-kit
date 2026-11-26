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
- 多环境部署、发版标签、数据迁移等 CI/CD 流程由实例层挂载；高风险动作在确认精确 Runbook 后自动推进。

---

## 正交模式：快速通道（同意前置）

快速通道把已确定的交付动作在执行前一起提交主会话批准。

- runbook 逐项绑定目标资源、动作与内容摘要、适用版本、有效会话和期限。只有主会话整句批准才激活相应授权。
- Codex 按既定主线自动连续推进，直至完成该任务的最终交付终点（包含实例定义的上线环节）。
- 未确定的动作、漂移的目标版本、授权过期或撤销、评审及 CI 失败，均在该步执行前停止。保留已确认的回执，对外部结果不确定的步骤交由人工核实。

---

## 快速开始

```bash
# 1. 构建工作台工具集并运行测试
bun install --frozen-lockfile
bun run build
bun run test:all

# 2. 在空目录初始化自包含工作台
./bin/forge init ~/work/my-workbench --name my-workbench --git-org my-org

# 3. 注册业务仓库（自动生成仓库卡并更新配置）
git clone <repo-url> ~/work/my-workbench/backend
./bin/forge add-repo ~/work/my-workbench/backend

# 4. 健康检查与升级同步
./bin/forge doctor ~/work/my-workbench
./bin/forge sync ~/work/my-workbench
```

### 在本仓库自举

```bash
bun install --frozen-lockfile
bun run build
./bin/forge init . --name forge-kit
./bin/forge add-repo . --workbench .
./bin/forge doctor .
```

## 实例配置示例

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

## 升级到 v0.5

从新的发行目录运行 `./bin/forge sync <实例目录>`，再执行 `./bin/forge doctor <实例目录> --json`。对比迁移报告中的路径，遇到已改动的受管文件或归属不明的同名文件时，先保留内容，按实际归属迁入私有位置后再重试。账本、旧见证与私有脚本原位保留。旧实例的 `review-agents/` 可含私有修改，升级后使用新发行附带的引擎。

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
| dbcred | 生产读用 `forge dbcred <env> --ro`。原先用 `dbcred --rw` 获取生产写凭据的脚本，改为登记精确 SQL 并由已获批准的 `forge ship` 执行。非生产环境继续使用 `forge dbcred <env> --ro` 或 `--rw`。 |
| cmdfmt | forge cmdfmt |
| lang-check | forge lang-check |

迁移评审脚本时，将旧 `--roles perf` 或 `--roles performance` 改为 `--roles simplify`，该角色同时检查性能与简洁性。原先同时选择 performance、simplify 的脚本只传一次 simplify。需要锁定后端时，用 `--backend codex` 或 `--backend api` 替换 `--no-fallback`。默认 `auto` 先运行独立 Codex 会话，上游服务异常时尝试 API。自动化从报告的 `roles` 数组读取每个已选角色的结果。`attempts` 为空表示该角色未启动，可查看 `missing_materials` 确认缺什么材料。整体退出码为 0（通过）、1（阻断）、2（执行错误）和 3（未完成）。

默认技能为 ready、grill、feature、bugfix、review、verify、pr-triage 和 ship。原业务取舍方法并入 grill，收尾拆给 review、verify 和 ship，四个专项评审统一由 review 选角色。环境配方与专业技能由实例维护。代理按 scanner、analyst、implementer 和 reviewer 四种专长委派，后两者分别承接原 dev 与 spec-reviewer 的任务。独立引擎的四个评审维度由引擎参数选择。

## 信任边界

执行器记录当前 SHA 的实际验证和评审结果。账本通过 SQLite 事务和追加事件摘要保存历史，外部保留的 Ledger-Tip 可以核验相应前缀。同一系统用户的文件权限由操作系统控制。守卫识别高危操作并核对授权，远端分支保护、数据库授权、凭据作用域和必需 CI 检查由部署方设置。通用阶段使用最小权限，受控写操作在匹配精确授权后单独兑现。
