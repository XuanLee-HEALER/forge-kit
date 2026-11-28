---
name: apply
description: 接入现有仓库、接手陌生模块或复核已变更领域卡时，根据本地 Git 事实维护个人关注域的薄地图。
---

# 按需维护仓库地图

一个工作台使用一个 Forge 实例。单仓同址时，真实项目的仓名为 `.`，领域目录为 `root`。多个兄弟项目共用上层工作台；当前目录下有独立子项目（含子模块）时，当前目录只组织项目。按真实子仓名归属领域，如 `root` 子仓的卡写 `repo: root`。

## 三种入口

- **冷启动**。运行 `forge apply --json`，用清单、命令和 Git 热区定位操作者关注的 1~3 个域。只读抽样入口、实体和边界，起草或增补仓卡和这些域的卡。向操作者展示验证动作及 `forbidden_paths` 草案，取得确认后才写入相应实例配置。
- **局部接手**。运行 `forge apply --repo <repo> --focus <path> --json`，结合局部骨架及共改邻居，核对关键入口与调用方。长期关注或复杂模块可建一张领域卡，并在仓卡索引登记；一次性小修可直接使用扫描结果。
- **语义复核**。运行 `forge apply check --repo <repo> --path <path> --json`。UNCHANGED 时沿用；UNMAPPED 时按需局部接手。CHANGED 时读卡、摘要和必要 diff，可请 scanner 只读核实。格式化、测试或内部调整可沿用旧卡并按需推进 SHA；局部字段、入口或约束变化可微调 1~3 行；核心实体、状态机或边界重构以及 BROKEN 时按当前代码重建。已退出关注范围的卡可标 archived 或删除，并维护索引。

## 卡片契约

薄仓卡使用工作台已有的根仓卡或子仓卡。先写稳定的工程契约（技术栈、验证命令、风格、禁区），再用 `## Domain Index` 记录关注域的 slug、一句话边界、锚定路径和相对领域卡链接。

领域卡写入实例的 `.workbench/domains/<repo-slug>/<domain>.md`。以 YAML Frontmatter 记录 `repo`、`domain`、非空的仓内相对路径列表 `anchored_paths` 和实际核对的完整提交 `last_verified_sha`，可选 `status: active` 或 `archived`，默认 active。正文分别说明核心实体与状态机、外部入口、持久化与下游、历史债务或补丁区；未查明的事实注明待核实。

每张卡建议控制在 120 行以内。保存实例卡后运行 `forge doctor` 核对结构与链接。平时只探当前路径，需要查看全部关注域时运行 `forge apply status --json`。
