# 评测

剧本模型测试不需要模型密钥。真实模型测试只在本地运行，费用必须累计记录。

`pnpm eval:agent` 根据 `evals/agent/suites.json` 运行内核剧本、依赖隔离和合成业务场景。剧本通过与后台相同的 `runAgentKernel`、真实 Pi 1.3 事件流和工具适配器执行。模型回执和业务工具结果由合成夹具提供。

覆盖多轮读写、串行工具、插话、停止、审核或提案等待、权限拒绝、错误回执、预算与历史。`evals/agent/scenarios.json` 另外覆盖合成 L08 核查送审、保存冲突、M02 缺证据及使用既有核实回执继续。默认命令使用脱敏环境，独立于 `.env.local` 和测试库。

启动隔离测试服务后，`pnpm eval:agent --integration` 运行复用的 PostgreSQL 场景，覆盖真实授权、工作区冲突、浏览器命令语义、子任务冲突、后台唤醒和 L08 送审。它们也纳入通用 `pnpm test:int`。

真实模型基线以通过的独立虚拟机报告和标准走查回执为来源。执行 `pnpm eval:agent:baseline <report.json> <result.json>` 得到脱敏时长、场景结果和费用。[真实回归基线](../docs/evidence/Agent真实模型回归基线.md)
