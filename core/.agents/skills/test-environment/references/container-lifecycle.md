# Apple container 生命周期、网络与存储

版本变化或命令报错时先查当前 `container <子命令> --help`，不套用 Docker 参数。

## 创建与就绪

- 检查 `container --version` 与 `container system status`；服务未启且任务需要时用 `container system start`，不为单次实验停止共享服务。
- 用 `mktemp -d` 建受限临时目录，生成带业务/场景/随机后缀的唯一名称；创建前核验同名不存在，禁止接管已有容器。
- `container list` / `inspect` 输出按白名单提取名称、状态、label，不直接打印或保存可能含环境变量凭据的整份 dump。
- 首次创建前持久化本次资源清单并注册 `EXIT`/`INT`/`TERM` trap；使用真实服务就绪检查加有期限超时。

## 最小网络与存储

- 单容器无需宿主访问时不发布端口；需宿主访问仅绑定 `127.0.0.1:<随机/参数化端口>:<容器端口>`；跨容器按需创建本次专用网络 `container network create`。
- 优先容器内临时路径或本次专用卷；确需 bind mount 仅挂受限临时目录或最小只读文件，不挂载整个 home、仓库或远程凭据。

## 幂等清理与恢复

- 按依赖逆序精确删除：`container stop` → `container delete` → `container network delete` → `container volume delete` → 删临时目录。
- 清理必须幂等且不吞掉原始验证退出码；清理失败须显式报告残留名称与手动恢复入口。严禁 `prune`、`--all` 或 `container system stop`。
