# PR-D6 外部模型核实群聊

按 v4 重做 PR [#35](https://github.com/yc2bgr8/cert-board/pull/35)。手动发起时可关联项目，注册或维护 Agent 担任主持人。群里可以点名、人直接发言、停止并整理，以及在原记录继续。无人工插话时按每个模型分别限制轮数，管理人员可修改默认 7 轮。

| 场景 | 实现截图 | 参考设计 |
|---|---|---|
| 14a 核实进行中 | [1440×900](../evidence/pr-d6-14a-verification.png) | [14a](../变更单/界面设计稿/14a-外部模型-核实进行中.png) |
| 14b 核实结论 | [1440×900](../evidence/pr-d6-14b-verification.png) | [14b](../变更单/界面设计稿/14b-外部模型-核实结论.png) |
| 15 模型设置、保密词表和外发记录 | [1440×900](../evidence/pr-d6-15-privacy.png) | [15](../变更单/界面设计稿/15-设置.png) |
| 16 外部核实次数与模型配置 | [1440×900](../evidence/pr-d6-16-budget.png) | [16](../变更单/界面设计稿/16-维护页.png) |

## 真实 Cursor 验证

Windows 命令行版为 `2026.11.19-f005e9d`。使用 Lan 已登录的团队订阅。Lan 提供的设置界面显示团队锁定 Privacy Mode，并提示某些功能仍可能存储代码。核实使用本机 Ask 会话、临时空工作目录、空 MCP 列表和拒绝工具权限的独立配置。发送仅包含合成问题，未启用后台 Agent 或联网搜索。[Cursor ACP 说明](https://cursor.com/docs/cli/acp) · [Cursor 隐私说明](https://cursor.com/help/security-and-privacy/privacy)

- 真实模型选择为 GPT-5.6 Sol 和 Claude Opus 5.5，使用命令行 ACP 列出的标准参数。明确标注无零数据保留的 Fable 未列为参与模型。
- 两次连通测试、一次隔离后端群聊和两次隔离浏览器群聊，共 8 次 Cursor 调用，计入订阅次数。最新一次浏览器核实验证了派发前复核、回复和原样回执的入库。合成事实无出处时归为「待核实」。OpenRouter 新费用为 0。[浏览器真实核实截图](../evidence/pr-d6-real-cursor-verification.png)
- 没有文件、工具、真实项目材料或真实收件人参与验收。网页本身的外部请求为 0。

## 开发机启动

合并后运行 `pnpm db:migrate`。用 `pnpm dev:api`、`pnpm dev:worker` 和 `pnpm dev:verification` 启动相应进程，前端由 `pnpm build` 与 `pnpm preview` 提供。共享工作台沿用 28080。

在本机 `.env.local` 设置 `CERT_CURSOR_BUNDLE` 和 `CERT_CURSOR_PROFILE` 为绝对路径。前者是已验证的 Windows Cursor 命令行包目录，后者是只含核实权限与空 MCP 的独立配置目录。团队隐私模式确认后使用 `CERT_CURSOR_PRIVACY_CONFIRMED=1`。配置无效或账号不可用时，手动核实保存在本机并暂停派发。

## 实施差异与后续

- D6 的主持职责、点名和四类结论在群聊中验收。项目关联只提供访问和主持身份。原 Agent 发起核实、审核卡「让Agent核实」和审核证据链接使用设计稿 04、05，由 PR-D4 实现。
- 关联项目且发起人已有活动目标对话时，主持请求走现有主网关，按该目标记账。无活动目标或主网关暂不可用时，由程序组织点名并保守分类。隔离验收验证网关约束，包括保密替换与禁用工具。
- 来源链接和摘录来自回答。真实出处的逐字核验、降级和可信结果纳入审核留 PR-D5。当前已按提供方、观点与出处分组。
- API Key/OpenRouter 网关通道保留配置入口和独立预算边界。Cursor 只统计调用次数。真实联网与本地模型出网检查随对应能力接入。
- 14a 截图截取首轮在途状态。14b 展开一条出网存档便于与替换后的文本互验。15 的外发记录在设置页继续向下滚动。16 只接入外部核实用量、模型和相关状态。

## 本地验收

- `pnpm lint`、`pnpm typecheck`、`pnpm test` 通过，共 413 项单元测试。
- 专项集成通过 23 项，覆盖浏览器授权、每个模型 7／3 轮、实时插话、停止续聊、停用后拦截、误拒保护词重复、跨月计次和原样回执。
- `pnpm eval:agent` 通过 30 项。`pnpm build` 和 `pnpm test:e2e` 通过 55 项。
