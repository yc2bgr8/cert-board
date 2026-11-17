# 本地依赖服务

PR-01 部署 PostgreSQL 16（镜像含 pgvector 扩展）、MinIO 与固定端口转发中继。Windows 上由 Node 脚本调用 `wsl.exe -d Ubuntu-24.04 --exec docker compose`；Linux 直接调用 Docker。Compose 项目名固定为 `cert-board`。

在仓库 `.env.local` 配置 `POSTGRES_PASSWORD`、`MINIO_ROOT_USER`、`MINIO_ROOT_PASSWORD`。脚本仅传递这三个配置给 Compose；模型密钥不会进入数据库和存储容器。不要把密码写在命令行，不要运行会展开秘密的 `docker compose config`。

| 操作                 | 命令                          |
| -------------------- | ----------------------------- |
| 启动并等待健康       | `pnpm dev:up`                 |
| 状态                 | `node scripts/dev.mjs status` |
| 停止本项目，保留数据 | `pnpm dev:down`               |

数据库为 `cert_board`，用户为 `cert_board`，端口 `127.0.0.1:25432`。首次创建数据卷时建立单独测试库 `cert_board_test`，PR-02 后续提供业务表迁移。镜像已包含 pgvector，但启用扩展仍由需要向量检索的迁移负责。

MinIO S3 端口为 `127.0.0.1:29000`，管理界面为 `127.0.0.1:29001`。数据存储在 `cert-board_postgres_data` 与 `cert-board_minio_data` 命名卷，不使用 `/mnt/c` 存数据。初始化 SQL 只读挂载。数据库与存储只加入没有出口的 `internal` 网络。`dev:down` 不删除数据卷，也不操作其他 Compose 项目或组长容器。

本机 Docker 29 对仅加入 `internal: true` 网络的容器没有发布回环端口，Windows 上的 Node 因而无法连接。为保持隔离，PR-01 提前实现开发中继的最小部分：Nginx stream 同时加入 `internal` 与专有 `ingress` bridge，只把上述三个回环端口转发给固定的数据库/存储目标，不提供通用代理，不持有凭据；容器只读、移除所有 capabilities。数据库和 MinIO 自身没有外网出口。

解析服务、代码沙箱与网页抓取服务尚未加入，按各自 PR 实现后仅接入规定的内部网段。PR-13 将扩展中继并落实出网代理；沙箱必须使用没有出口的独立网段，不能接入 `ingress`。

新建依赖镜像：`pgvector/pgvector:0.8.1-pg16`（PostgreSQL License）、`pgsty/minio:RELEASE.2026-08-04T00-00-00Z`（AGPL-3.0）、`nginxinc/nginx-unprivileged:1.30.6-alpine3.24`（BSD-2-Clause）。无遥测或错误上报集成；MinIO 自动更新检查关闭，且服务网络无出口。
