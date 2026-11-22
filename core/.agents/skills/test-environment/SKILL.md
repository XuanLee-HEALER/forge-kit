---
name: test-environment
description: 为本机开发验证创建、使用和清理隔离容器测试环境（macOS 首选 Apple container），并按复用价值沉淀配方；不替代远程环境验收。
---

# 本机隔离测试环境

在已授权的开发验证范围内，自主准备最小必要的真实组件实验。先明确验证目标、最小组件与成功条件，简单逻辑不必起容器。

## 不变边界

- 本机隔离环境在 macOS 上唯一入口为 Apple `container`（不用 Docker/Compose/kind/minikube 替代；如需 Kubernetes 亦限于 `container` 隔离环境内）。
- 本地实验只证明当前版本与配置下的行为，不可冒充测试/生产环境验收；外部资源不可达时如实报告缺口。
- 每次使用唯一名称与本次资源清单，**严禁全局 prune、`--all`、`container system stop` 或删除他人资源**。
- 临时凭据放权限受限临时目录（`0700`），不默认挂载整个 home、工作区、宿主机 kubeconfig 或生产凭据。

## 执行与清理

1. 确定最小配置与就绪条件，按需读 [container-lifecycle.md](references/container-lifecycle.md)。
2. 创建前写清唯一资源清单并安装 `EXIT/INT/TERM` 逆序清理；服务就绪必须用真实健康探针，进程启动不等于就绪。
3. 执行断言并区分初始化失败、验证失败与清理失败；无论成败均按清单逆序清理并核对残留为零（除非用户明确保留现场）。
4. 按 [persistence.md](references/persistence.md) 判断是否将可复用场景沉淀到 `one-off-scripts/test-environments/<业务>/<场景>/`。
