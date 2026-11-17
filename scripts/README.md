# 开发脚本

开发任务使用跨平台 Node 脚本，不依赖 PowerShell、Bash 或本机 Python。

- `docs-html.mjs`：递归把 `docs/` 内 Markdown 转为同名离线 HTML；支持标题目录、表格、列表、引用、代码和相对图片。原始 HTML 被转义，危险协议与远程图片被阻止。相对 Markdown 链接改为 HTML 链接；外部网页链接标明后由人点击。
- `placeholder.mjs`：PR-00 尚未实现的命令入口，正常退出并明确提示，不构成功能验收。后续 PR 随能力实现替换入口。

文档转换：`pnpm docs:html`。单独转换目录：`node scripts/docs-html.mjs <目录>`。
