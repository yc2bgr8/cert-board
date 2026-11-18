# 开发出网代理（PR-12 前置 PR-13 子项）

使用 Ubuntu 24.04 官方基础镜像（Dockerfile 固定摘要）及官方软件源的 Squid `6.14-0ubuntu0.24.04.5`。Squid 使用 GNU GPL，内含第三方条款以镜像内 `/usr/share/doc/squid/copyright` 为准。配置不启用遥测、更新检查或外部上报；运行时只处理经过白名单的显式代理请求。

代理以 `proxy` 非 root 用户运行，根文件系统只读、全部 capabilities 移除、`no-new-privileges`，只在 `/tmp` 使用临时空间。没有凭据环境变量或数据/密钥挂载；只连接独立的 `cert-board_egress` bridge，发布 `127.0.0.1:28085`。数据库和 MinIO 仍只连接原来的无出口内部网络。

## 放行与记录

- 只允许 `CONNECT openrouter.ai:443`。`allowlist` 不带前导点，不允许子域。
- 执行方案 PR-13 既有四域名中的其他三个仅为注释，未启用；未增加新的运行时目标域名。
- 其他域名、IP 地址形式、非 443 端口、非 CONNECT 方法均拒绝。保留内网、回环、链路本地和保留地址段的拒绝规则。
- 不做 TLS 解密，不持有上游凭据。模型客户端必须自行严格验证 `openrouter.ai` 证书，代理失败不得降级为直连。
- access 日志只有时间、方法、域名、端口、状态及 Squid 结果码；不记录完整 URL、query、请求头或正文。

## 本机 Fake-IP DNS 的临时兼容

2026-11-18 本机 Meta/TUN 将 `openrouter.ai` 解析为 `198.18.0.240`；对已有以太网 DNS（223.5.5.5、180.76.76.76）的 UDP/TCP 查询也返回相同 Fake-IP。该地址被保留网段规则拒绝，未删除或放宽这条保护，也没有修改宿主机 DNS/TUN 设置。

仅在 Squid 的 `hosts_file` 中临时预解析既有主机为 `104.18.2.115`、`104.18.3.115`。来源是 [公开 DNS 观测](https://digwebinterface.com/?colorize=on&hostnames=openrouter.ai&nameservers=&ns=all&showcommand=on&type=&useresolver=8.8.4.4) 与 [域名记录观测](https://www.ipaddress.com/website/openrouter.ai/) 的一致结果。网页观测不是权威实时 DNS 保证；这些地址需要后续核对刷新，不得把失败解释为允许直连或允许私网。

2026-11-18 **08:58:45（北京时间）** 已经通过同一代理建立 TLS，使用 `servername: openrouter.ai` 与 `rejectUnauthorized: true`；未带任何密钥的 `GET /api/v1/models` 返回 HTTP 200、JSON 内容类型。证书指纹 SHA-256 为 `FB:4A:8C:19:57:F0:41:2F:26:09:37:FA:C3:50:B1:2A:F4:2D:0C:84:AE:0E:7D:38:81:5D:1F:2E:EC:1B:30:A4`，证书到期时间为 `2027-02-10 23:06:03 UTC`。没有发出模型推理请求。

## 验证

```text
pnpm dev:up
node scripts/verify-egress.mjs
node scripts/verify-egress-container.mjs
pnpm exec vitest run scripts/egress.test.mjs
```

首个脚本只连接本机代理，验证 1 项放行、13 项拒绝，再验证公开目录的 TLS；第二个脚本只读取本项目代理容器，验证隔离、Squid 版本和日志的 stdout/stderr 均没有合成的头/query/正文标记。容器已经存在时 Docker Compose 不会自动重建修改过的镜像，应先针对 `deploy/egress` 重建 `cert-board-egress`，再运行 `pnpm dev:up`；不要停止其他项目或删除数据卷。

当前实现证明应用指定的代理路径与 Squid ACL 生效，**未设置 Windows 宿主进程的操作系统级网络封锁**。模型网关必须使用固定代理 transport；全宿主流量隔离仍需后续配置，不宣称本 PR 已完成。
