---
name: dbop
description: >
  多环境数据库只读与写操作通用协议（基于 usql 与 .workbench/bin/dbcred）。
  具体环境连接元数据维护在工作台私有的 .workbench/env/environments.json（不入库、不进模板）。
  触发词：数据库、SQL、查表、改表、db、database、migration、schema。
---

# dbop：多环境数据库操作（通用包）

## 凭据与安全边界

- 环境元数据位于 `.workbench/env/environments.json`（格式参考 `environments.example.json`），**严禁把凭据全文输出到对话或日志**。
- `dev` / `fat` 按工作台授权执行；`prod` 仅允许只读查询，写操作由 `.codex/hooks.json` 的物理保险丝拦截，须经事前只读演练、交用户确认/亲自执行，再做事后只读验证。
- 禁止 `DROP DATABASE`、`prod` 环境 `TRUNCATE` 以及打印明文密码/token 字段。

## 执行方式

使用 `usql` 配合 `.workbench/bin/dbcred` 注入认证（库地址明文写在命令中以便 `guard` 准确识别环境，密码绝不出现在命令行文本中）：

```bash
usql "postgres://$(.workbench/bin/dbcred <env>)@<host>:<port>/<database>?sslmode=<sslmode>" -c "<sql>"
```

- 明细查询未指定条数时显式 `LIMIT 100`；显式注意连接与查询超时。
- 多条写 SQL 优先事务包裹并设 `SET LOCAL lock_timeout='5s'`（`CREATE INDEX CONCURRENTLY` 等不可事务化语句单独执行）。
