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
pnpm db:setup
pnpm dev:api
```

另一个终端运行 `pnpm dev:worker`。后端健康检查：`http://127.0.0.1:28081/health`。
`pnpm dev:web` 启动界面稿：`http://127.0.0.1:28080`。也可 `pnpm build` 后 `pnpm preview` 查看严格CSP下的构建。当前界面稿只有虚构示例交互，尚未接入登录和真实业务，页面有明确标识。

`pnpm lint`、`pnpm typecheck`、`pnpm test` 运行基础检查；依赖服务启动后运行 `pnpm test:int`。
`pnpm dev:down` 仅停止 cert-board 项目并保留命名卷。已有项目的服务不受影响。

密码与密钥只在 `.env.local`，初始化不会覆盖已有值；不要输出完整配置或将它加入提交。

`pnpm budget:status` 显示北京时间月度和整晚批次的已计费用、未结算预占和停止原因，不输出请求内容。当前开发默认单次1美元、月度9美元、整晚10美元；种子不覆盖已有政策。用量未知时保留预占并停止后续调用，不能把未结算金额当作零费用。真实网关接入前累计费用为零。

真实模型请求原文默认不持久化。`pnpm requests:purge` 每批最多清理100条到期的私有请求内容，同时留下不含正文的审计；非零保留目前只允许隔离测试库中的合成记录。

开发账号为 `ra`、`rb`、`gm`、`sales`、`tech`；密码分别读取 `.env.local` 的 `DEV_RA_PASSWORD` 等对应变量。种子只在 development/test 环境执行；生产环境禁止开发账号种子和登录。登录接口已实现，真实登录页在 PR-26 接入。

数据库结构改动先改 Drizzle schema，再运行 `pnpm db:generate` 并审阅生成的 SQL；`pnpm db:migrate` 执行迁移。已应用/已合并的迁移不可修改，必须另建迁移。执行器会校验历史文件哈希，重复运行不会重复执行。
