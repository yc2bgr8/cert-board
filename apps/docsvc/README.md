# 文档解析服务

文档解析只在隔离的 Python 3.12 容器中运行。`pnpm dev:docsvc:up` 启动本机回环服务 `127.0.0.1:28082`，`pnpm dev:docsvc:status` 查看状态，`pnpm dev:docsvc:down` 停止本项目。

调用方先从已授权的资料版本读取原件，按原始字节计算 SHA-256。`POST /parse?kind=pdf` 与 `POST /text?kind=docx` 接收 `application/octet-stream` 正文和 `X-Content-Sha256` 请求头。`kind` 支持 `pdf`、`estar`、`doc`、`docx`、`xlsx`。返回的页码或提取单元从 1 开始。eSTAR 的 XFA 数据包和附件以 Base64 返回，附件按 SHA-256 去重。

授权调用方提交原件并通过哈希校验和解析后，在响应头拿到 `X-Docsvc-Preview`。每次预览先重新核对资料身份和读取权限，再带该值调用 `GET /render?kind=pdf&sha256=…&page=1`。该值仅在服务进程内用于本次原件缓存，调用方不把它交给浏览器或写进日志。原件被淘汰时返回 `DOC_SOURCE_NOT_CACHED`，调用方可重新提交已授权的原件。

预览返回 PNG 和 `X-Docsvc-Preview-Pages` 物理页数。Office 文档先在独立的 LibreOffice 配置中转换为 PDF，超过 800 页时返回 `DOC_PREVIEW_PAGE_LIMIT`。AcroForm 预览绘制填写内容。无法保真绘制的 XFA 表单返回 `DOC_XFA_PREVIEW_UNAVAILABLE`，仍可读取解析得到的 XML、逐页文字及附件。

上传上限 96 MiB。解析、文本转换和渲染在带终止时限的独立进程中运行，每次处理一个操作。服务在操作结束或硬超时后回收子进程的临时目录。Word 的 `/parse` 保留 T1 文字提取顺序，`/text` 按正文顺序提取段落和表格，保留内容相同的独立单元格。Excel 的 `/text` 保留公式及文件中已保存的计算结果。

服务没有出网网络或资料库凭据。`pnpm test:py` 在无网络的容器中测试合成文档。`pnpm test:l08` 在本机只读挂载 L08 申报包和 T1 输出，对照日志使用资料编号与页码。未提供 L08 原件目录时跳过，已有原件而对照文件缺失时返回失败。
