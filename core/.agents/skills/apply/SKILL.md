---
name: apply
description: 冷启动仓库、接手陌生模块或复核领域卡时，结合离线扫描、近期样本和操作者确认维护个人关注域地图。
---

# 按需维护仓库地图

单仓同址时仓名为 `.`，领域目录为 `root`。多个兄弟仓共用上层工作台；含独立子仓或子模块时，上层只组织项目。领域归属实际子仓，如名为 root 的子仓写 `repo: root`。

## 冷启动

1. 在工作台运行 `forge apply --json`，需要时用 `--repo <repo>` 选仓。核对 HEAD、时间窗、浅历史、截断和权限提示。静默仓可加大 `--days`。
2. 用目录骨架、workspaces 和带来源的 entrypoints 核实包边界、命令及工作目录。结合 git_flow、workflows 和禁区草案定位协作与发布约束。
3. 从 convention_files 打开适用的仓库说明和规则。从 style_samples 抽读 3~5 个近期业务源文件，结合仓内 `git log -20 --oneline` 的近期 15~20 条提交交叉核对。样本或历史不足时列出实际依据。
4. 在薄仓卡摘要中回答下面五项。每项尽量附真实样板路径，证据不足写“待核实”。

   - 分层与命名采用什么约定？从一个入口追到业务实现，标出实际模块边界。
   - 数据访问与事务在哪里收口？生成代码和新检出工作树的第一条准备命令是什么？
   - 错误在哪里转换，日志记在哪一层，对外响应信封长什么样？
   - 团队用哪些单元、契约、集成或 e2e 测试？指出最小快检和交付全量命令。
   - 哪些历史旧范式勿照抄？结合仓库说明、旧实现和近期样板给出适用边界，仅有文件年龄时保留待核实。

5. 用三类锚点拟定关注域。沿 entry_signals 找外部入口，沿 persistence_signals 查表、Schema 和下游，用 dir_hotspots 或 cochange_neighbors 核对共同演进的代码。按业务职责命名，缺少的锚点注明待核实。
6. 一次向操作者展示三份可删改的清单。

   | 清单 | 供操作者核对 |
   |---|---|
   | 薄仓卡摘要 | 工程契约、上述五项偏好、分支与 CI 流、禁区和证据路径 |
   | 候选关注域 | 域名、一句话边界、锚定路径、建议先建卡的 1~3 个热区域 |
   | 实例配置草案 | workbench.yaml 的验证动作及 cwd，ship-policy.yaml 的 forbidden_paths |

7. 等操作者删改、合并或暂缓。确认后写入薄仓卡和选定的 1~3 张领域卡，仅应用获准的配置项。暂缓时保留预览。

## 局部接手

运行 `forge apply --repo <repo> --focus <path> --json`。从局部文件树出发，沿调用方和共改邻居核对职责、边界及现有卡。
长期关注或复杂模块经确认可建一张领域卡并登记索引。一次性任务可直接使用扫描结果。

## 变更语义复核

运行 `forge apply check --repo <repo> --path <path> --json`，结合卡片和必要的 diff 判断。

- UNCHANGED 可沿用已提交快照。任务涉及未提交改动时另核对工作树。
- UNMAPPED 按局部接手处理。
- CHANGED 中仅格式、测试或内部调整可沿用并按需推进 SHA。局部字段、入口或约束变化可微调 1~3 行。
- 核心实体、状态机或边界重构，以及 BROKEN 的失效锚点，须核对当前代码后重建。退出关注的卡可标 archived 或删除，并维护索引。

## 卡片契约

薄仓卡使用已有的根仓卡或子仓卡。在 `## Domain Index` 登记域 slug、一句话边界、锚定路径和领域卡相对链接。
领域卡写入 `.workbench/domains/<repo-slug>/<domain>.md`。YAML frontmatter 记录 repo、domain、非空仓内相对路径列表 anchored_paths 和实际核对的完整 last_verified_sha。status 可取 active 或 archived，省略时为 active。
正文写核心实体与状态机、外部入口、持久化与下游、历史债务或补丁区。两类卡各控制在 120 行以内。
保存后运行 `forge doctor` 核对结构和链接。全局查看关注域时运行 `forge apply status --json`。
