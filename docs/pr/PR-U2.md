# PR-U2 对话界面

对话气泡、工具过程、计划、过程批准与运行详情使用 v3 主题。按公开的会话事件显示序号对应的工具步骤，用同源浏览器 API 记录批准和停止。打开的运行详情随 SSE 更新。首条消息成为新会话草稿，切换会话后保留当前编辑。已有项目资料可通过附件按钮加入编号和版本。

## 1440×900 截图

| 场景 | 实现 | 参考 | 差异 |
|---|---|---|---|
| 过程批准 | [04 过程批准](../evidence/pr-u2-04-approval.png) | [04 设计稿](../变更单/界面设计稿/04-对话-批准请求.png) | 隔离库中等待批准的内部提醒，字段来自当前工具返回 |
| 中途停止和运行详情 | [11 停止详情](../evidence/pr-u2-11-stop-details.png) | [11 设计稿](../变更单/界面设计稿/11-中途停止与运行详情.png) | 截图为人工停止的实际测试运行，显示真实步骤和状态。用量与子 Agent 字段待对应接口 |
| Markdown | [Markdown 样例](../evidence/pr-u2-markdown.png) | 04、11 对话区域 | 使用可复现的表格、代码、HTML 与图片样例，外部图片在浏览器测试中被本地响应拦截 |

05 与 10 的会话部分共享本次的界面。审核、证据和外发提案由 PR-U3 验收。附件入口展示已有资料引用，原件上传随真实接口接入。界面按 SSE 事件增量更新，上游 token 流式留模型网关。

## 来源和依赖

从 VisaFlow 的 `app/packages/ui/src/components/chat/UserMessageBubble.tsx` 和 `InlineExecution.tsx` 取气泡与工具活动行，按源码文件头标注已修改。许可证与 NOTICE 位于 `third_party/craft-agents/`。

- `rehype-raw@7.0.0`、`remark-gfm@4.0.1`、`rehype-highlight@7.0.2` 是本地 Markdown 处理依赖，`@types/hast@3.0.5` 仅用于类型。均为 MIT，安装包无安装生命周期脚本。解析和高亮在进程内完成。[rehype-raw](https://github.com/rehypejs/rehype-raw) · [remark-gfm](https://github.com/remarkjs/remark-gfm)

## 验收

- lint、类型检查、396 项单元与构建通过。全量集成的 390 项通过。
- 35 项隔离库浏览器验收，包含可见 HTML、表格、代码高亮、HTTPS 测试图片、样式表去除、首条草稿与切换后的编辑、资料引用、SSE 续连、插话、授权，以及详情打开期间的停止状态更新。
- 浏览器完成 1 次本地拦截的图片请求，真实外部请求、页面错误、CSP 违规和真实模型费用均为 0。
- Chrome 的内联 CSS 图片来源兼容性见[待办](../待办.md)。普通正文图片按独立属性抑制来源头。
