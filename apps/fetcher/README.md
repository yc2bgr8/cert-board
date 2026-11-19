# 网页抓取服务

`pnpm dev:fetcher:up` 启动 Windows 开发用抓取服务，`pnpm dev:fetcher:status` 查看状态，`pnpm dev:fetcher:down` 停止本项目。本机 worker 在 `.env.local` 读取 `CERT_FETCHER_URL=http://127.0.0.1:28084`。容器部署用 `pnpm dev:isolated:web:up`，worker 走内部固定中继，宿主不发布抓取服务端口。

抓取只用独立代理访问公开 HTTPS 域名。代理拦截内网和保留地址，服务本身位于专用网络，不持有业务凭据。抓取使用 GET，不跟随重定向。原件上限为 2 MiB，解析文本上限为 64,000 个字符。网页作为不可信资料存档，PDF 原件可下载，正文待解析服务接入。

检索使用自建 SearXNG 的 JSON 接口。需要在抓取网段提供 `searxng:8080`，启用 JSON 输出，只配置组织批准的公开检索引擎，然后在运行启动命令的环境设置 `CERT_SEARXNG_ENABLED=1`。开发默认关闭，没有部署实例时 `web_search` 返回可处理的未就绪状态，`web_fetch` 可独立使用。[SearXNG Search API](https://docs.searxng.org/dev/search_api.html)

`pnpm test:py` 在无网络的测试容器里运行抓取和检索测试，无需 SearXNG 实例或密钥。
