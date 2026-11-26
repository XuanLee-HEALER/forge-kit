---
name: ready
description: 开始工作或恢复会话时，核对检出、实例配置及活跃账本，生成可接续的现场摘要。
---

# 工作台就绪核查

**输入**为工作台目录、当前会话及可选的仓库或任务标识。

1. 定位包含 `.workbench/workbench.yaml` 的工作台根，读根约定、实例补充、kit-lock 和相关仓库卡。对目标仓运行 `git -C <仓> status --short --branch`，保留未提交改动。
2. 运行 `forge doctor . --json`、`forge instance list --json`、`forge git status` 与 `forge ledger status`。标记配置问题对应的字段和路径。已指定任务则核对交付终点、冻结状态、已完成证据及待决事项。
3. 通过 `forge instance show skill <id> --json` 查看下一阶段有效的技能描述、正文和来源。根目录只有显式登记为仓时才作为开发目标。

**输出与完成条件**为一份就绪摘要，说明目标仓与分支、已有改动、任务与下一步、阻断项或缺少的输入。已有明确任务即可接续，单独热身在报告后结束。
