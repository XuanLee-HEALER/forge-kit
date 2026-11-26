---
name: feature
description: >
  AI-Native 规范驱动需求开发流程：区分轻量轨（targeted）与完整开发周期轨（full）：
  grill 产出 ssot.md -> 双独立隔离上下文并行生成 tech-spec.md 与 test-spec.md -> 独立只读评审 ->
  ledger freeze 物理锁 -> 并行代码实现（四层 review + 静态/动态检查）与独立 Hurl 编写 -> FAT/Container 验收交付。
  触发词：做需求、新需求、新功能、加个功能、开发一个、实现一下、feature、开工。
---

# feature：做需求（双轨分流）

遵守工作台根 `AGENTS.md`（共享工作树红线、交付终点×验证深度、服务端权威原则、新测试纪律、模型档位、禁自动网页测试）及目标仓 `.workbench/repos/<repo>.md`。

## 轨道分流

- **轻量轨（`targeted`）**：风险边界清晰的局部改动、低风险小修、纯文档/注释。核清口径经用户确认后，开账本（或合规 `exempt`）直接实现、跑受影响构建/测试与定向 `wrapup` 即可，不强迫写三件套 Paperwork。
- **完整开发周期轨（`full` Dev Cycle）**：涉及业务规则、资金/权限、协议/接口、迁移、并发或跨模块的新需求，严格按以下 **5 阶段状态机** 执行。

---

## Full Dev Cycle 五阶段

### Stage 0：需求定稿（`grill`）
- 调用 `.agents/skills/grill/SKILL.md`，与用户对齐口径并落盘 `.workbench/specs/<task_id>/ssot.md`（编号业务不变量 `INV-*` + 衍生流程 + **冻结的外部接口契约**，不含内部实现）。
- 若 `grill` 阶段已建账则直接复用该 `task_id`（不重复 `ledger open`，跨仓仅补 `ledger attach`）；若尚未建账则执行 `.workbench/bin/ledger open --id <task_id> --title "..." --endpoint <ep> --depth full --repo <r> --branch <b>`。

### Stage 1：独立双上下文派生 Paperwork + 评审 + 冻结
1. **双独立派生（严禁同一上下文或互相参照生成）**：
   同时派生 **2 个上下文完全隔离的 subagent（`fork_turns="none"`）**，两者**互相不可见**、各自只读 `ssot.md` 与现有代码事实：
   - **Agent A（技术方案）**：只读 `ssot.md` + 目标仓代码，产出 `.workbench/specs/<task_id>/tech-spec.md`（细枝末节的实现选择、技术选型、数据模型、事务/并发、兼容与性能设计）。
   - **Agent B（测试用例规格）**：只读 `ssot.md` + 现有接口/夹具约定（**严禁读取 `tech-spec.md`**），产出 `.workbench/specs/<task_id>/test-spec.md`（逐条映射到 `INV-*` 的 Hurl 黑盒场景矩阵、正反/边界用例与夹具清理契约；仅纯算法/计费公式/状态机/并发不变量允许列少量无 Mock 表驱动单测）。
2. **独立只读 Paperwork 评审**：
   派生 `.codex/agents/spec-reviewer.toml`（`fork_turns="none"`，只读）分别评审：
   - `tech-spec.md`：审**正确性、性能、兼容性、简单性**（以 AI-Legibility / 低状态复杂度为准，不审传统人工美学）；
   - `test-spec.md`：对照 `ssot.md` 审**完备性、正确性**（顺带反向揪出 `ssot.md` 的遗漏或歧义）。
   核实并 refine 直到两份评审零阻断项，向用户汇报三件套定稿。
3. **周期冻结（三件套物理锁生效）**：
   先冻结三件套文档（此时**不要**提前加 `--lock-tests "*.hurl"`，以免阻断 Stage 2 轨道 B 新建 Hurl 脚本；仅当目标 Hurl 已存在且需即刻锁定时才一并传入 `--lock-tests`）：
   ```bash
   .workbench/bin/ledger freeze <task_id>
   ```
   此后整个 Dev Cycle 内三件套只读，`guard` 物理拦截静默修改，且冻结前的旧验证证据不自动放行冻结后的周期；确需偏离必须经用户批准走 `ledger amend`。

### Stage 2：并行实现（代码 + 静态/动态检查 + 四层 Review ∥ Hurl 编写）
并行派生两条独立轨道（文件所有权互不重叠，必要时用独立 worktree）：
- **轨道 A（代码实现）**：委派 `.codex/agents/dev.toml` 按 `tech-spec.md` 与 `ssot.md` 实施（**刻意克制 Mock 堆砌型单测**；保持代码简单自解释）。实现后：
  1. 跑对应语言静态与动态检查（仓内原生命令或 `.workbench/bin/lang-check <repo> --mode all`：Go `go vet`/`go test -race`、TS `tsc`/`biome`/`eslint`、Python `ruff`/`pyright`/`PYTHONDEVMODE=1 pytest`）；
  2. 执行完整四层 `wrapup`（业务对齐 `ssot.md` → 语言特化实现 bug `review-quality` → 性能与简单平衡 `review-performance` + `review-simplify` → 精简内部注释 + 完备最新接口文档 `review-comments`）。
- **轨道 B（独立测试实现，并行）**：派生独立 subagent（`fork_turns="none"`），**仅读 `ssot.md` 与 `test-spec.md`**（不读实现代码），编写可执行 Hurl 脚本与幂等夹具清理逻辑；Hurl 落盘完成后执行纯加锁重冻 `.workbench/bin/ledger freeze <task_id> --lock-tests "*.hurl"`（校验三件套零漂移、保留冻结后已有证据并立即锁定 Hurl 防篡改）。

### Stage 3：FAT / Container 集成、冒烟与性能验证
- 按 `.agents/skills/ship/SKILL.md` 合入 FAT（或按 `test-environment` 用 Apple `container` 搭隔离环境），执行轨道 B 产出的 Hurl 集成/冒烟测试（以及按需的性能测试）。
- **只修实现，不偷改测试**：Hurl 失败时回到实现代码修复并重跑检查与评审，**禁止私自放宽 Hurl 断言凑绿灯**（`guard` 物理拦截）；确属用例或方案本身有误须经用户确认走 `ledger amend` 并辐射重跑受影响环节。
- 循环直至本阶段 bug-free、测试夹具残留清零，推进移交 QA（若终点为 `pr` 则同步开好 PR）。

### Stage 4：收尾与汇报
- 确认 `.workbench/bin/ledger spec-status <task_id>` 无漂移且 `ledger status` 证据齐全；完成后执行 `ledger close <task_id>`。
- 汇报分开列出：本地静态/动态检查、四层 Review 结果、FAT/Hurl 集成验收结果与夹具清零状态、已达成终点与剩余缺口；不写人天估算。
