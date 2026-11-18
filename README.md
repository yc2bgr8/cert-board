# cert-board

AI原生器械认证板块，形态是器械认证版的Claude Code：人在自建的网页界面中进入项目，和注册Agent或维护Agent对话；Agent在项目工作区里直接干活，把交付物和改动交给人审核；人在对话中提修改意见，或在审核卡上批准。

- 开发约定：`AGENTS.md`
- 文档从需求 V1.0 和执行方案 v0.4 开始阅读。[需求 V1.0](docs/需求文档/AI原生器械认证板块_需求文档_V1.0.md)、[执行方案 v0.4](docs/执行方案/AI原生器械认证板块_执行方案_v0.4.md)
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
`pnpm dev:web` 启动界面稿：`http://127.0.0.1:28080`。也可 `pnpm build` 后 `pnpm preview` 查看严格CSP下的构建。当前界面稿只有虚构交互，尚未接入登录和真实业务；开发说明在设置中，截图与操作步骤见[界面稿评审](docs/界面稿评审.md)。

`pnpm lint`、`pnpm typecheck`、`pnpm test` 运行基础检查；依赖服务启动后运行 `pnpm test:int`。
`pnpm dev:down` 仅停止 cert-board 项目并保留命名卷。已有项目的服务不受影响。

密码与密钥只在 `.env.local`，初始化不会覆盖已有值；不要输出完整配置或将它加入提交。

`pnpm budget:status` 显示北京时间月度和整晚批次的已计费用、未结算预占和停止原因，不输出请求内容。当前开发默认单次1美元、月度9美元、整晚10美元；种子不覆盖已有政策。用量未知时保留预占并停止后续调用，不能把未结算金额当作零费用。

`pnpm test:real` 经本机代理验证合成文本的模型调用，`pnpm test:real --agent` 验证合成多轮内核工具调用，`pnpm test:real --l08` 使用日常开发项目已经导入的 L08 解析资料验证检索、原文读取、保存草稿及送审。三种验收均计入日常持久账本。模型从 `deploy/models.yaml` 读取，密钥只取 `.env.local`，缺少密钥时跳过。开发代理与 Fake-IP 临时映射见[代理说明](deploy/egress/README.md)。

真实模型请求原文默认不持久化。`pnpm requests:purge` 每批最多清理100条到期的私有请求内容，同时留下不含正文的审计；非零保留目前只允许隔离测试库中的合成记录。

开发账号为 `zhangsan`（张三）、`wangmin`（王敏）、`admin`（李晨）；三者业务权限相同，只有admin额外具有系统管理权限。密码分别在`.env.local`的`DEV_ZHANGSAN_PASSWORD`、`DEV_WANGMIN_PASSWORD`、`DEV_ADMIN_PASSWORD`，不写入文档。先运行env:init补新变量，再db:setup迁移/种子；旧角色开发账号停用，但历史用户和审计保留。重复种子不恢复人工撤销的管理权限、禁用或密码。种子只在development/test执行，生产禁止开发账号种子和登录。真实登录页在PR-26接入。

对话权限为只读、请求批准、完全允许，默认请求批准。C3批准接口只记录浏览器决定，精确执行和续跑在PR-21接入；审批/批准不是模型工具。内部消息目前仅本地测试队列，不发给真实对象，真实渠道和非登录员工身份目录后续接入。

数据库结构改动先改 Drizzle schema，再运行 `pnpm db:generate` 并审阅生成的 SQL；`pnpm db:migrate` 执行迁移。已应用/已合并的迁移不可修改，必须另建迁移。执行器会校验历史文件哈希，重复运行不会重复执行。
