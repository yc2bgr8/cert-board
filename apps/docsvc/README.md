# 文档解析服务

文档解析只在隔离的 Python 3.12 容器中运行。`pnpm dev:docsvc:up` 启动本机回环服务 `127.0.0.1:28082`，`pnpm dev:docsvc:status` 查看状态，`pnpm dev:docsvc:down` 停止本项目。

调用方先从已授权的资料版本读取原件，按原始字节计算 SHA-256。`POST /parse?kind=pdf` 与 `POST /text?kind=docx` 接收 `application/octet-stream` 正文和 `X-Content-Sha256` 请求头。`kind` 支持 `pdf`、`estar`、`doc`、`docx`、`xlsx`。返回的页码或提取单元从 1 开始。eSTAR 的 XFA 数据包和附件以 Base64 返回，附件按 SHA-256 去重。

上传哈希通过并解析成功后，`GET /render?kind=pdf&sha256=…&page=1` 返回 PNG。Office 文档先在一次性的 LibreOffice 配置中转换成 PDF。缓存限本进程内存，原件被淘汰时接口返回 `DOC_SOURCE_NOT_CACHED`，调用方可重新提交已授权的原件。

上传上限 96 MiB，每次只处理一个解析或渲染请求。服务没有出网网络或资料库凭据。`pnpm test:py` 在无网络的容器中测试合成文档；`pnpm test:l08` 在本机只读挂载 L08 申报包和 T1 输出，对照日志使用资料编号与页码。
