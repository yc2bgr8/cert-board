# cert-board

AI原生器械认证板块，形态是器械认证版的Claude Code：人在自建的网页界面中进入项目，和器械认证Agent对话；Agent在项目工作区里直接干活，把交付物和改动交给人审核；人在对话中提修改意见，或在审核卡上批准。

- 开发约定：`AGENTS.md`
- 文档：`docs/`（需求文档V0.9、总体方案v0.4、技术方案v0.3、执行方案v0.3）
- 技能：`skills/`（每项能力一个目录）
- 测试资料：`fixtures/`（L08派生资料为「内部」级别；L08原始文件不在仓库中）

开发按执行方案逐个PR进行，从PR-00开始。

## 本地开发

```text
pnpm install
pnpm env:init
pnpm dev:up
pnpm dev:api
```

另一个终端运行 `pnpm dev:worker`。后端健康检查：`http://127.0.0.1:28081/health`。
当前尚未实现网页和登录，后续 PR 接入 `http://127.0.0.1:28080`。

`pnpm lint`、`pnpm typecheck`、`pnpm test` 运行基础检查；依赖服务启动后运行 `pnpm test:int`。
`pnpm dev:down` 仅停止 cert-board 项目并保留命名卷。已有项目的服务不受影响。

密码与密钥只在 `.env.local`，初始化不会覆盖已有值；不要输出完整配置或将它加入提交。
