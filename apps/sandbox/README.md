# 代码沙箱

沙箱在独立容器执行 Agent 的 Python 程序。工作进程把指定资料版本或工作区文件复制到本次任务的 `inputs/`。程序在 `outputs/` 写产出，在 `TMPDIR` 写临时文件。任务结束后清理该目录。

| 操作 | 命令 |
|---|---|
| 启动本机沙箱 | `pnpm dev:sandbox:up` |
| 查看状态 | `pnpm dev:sandbox:status` |
| 运行独立容器测试 | `node scripts/sandbox-dev.mjs test` |
| 关闭本机沙箱 | `pnpm dev:sandbox:down` |

本机工作进程使用 `CERT_SANDBOX_URL=http://127.0.0.1:28083`。隔离部署配置固定为 `http://sandbox-relay:28083`。后端按当前权限提供 `code_run` 和 `code_run_save`。`code_run` 返回日志及产出摘要，`code_run_save` 将产出登记为本对话工作副本的新文件并返回撤销所需的记录。

用户代码无网络、无凭据，以非 root 用户运行。部署使用 x86_64 Linux，内核须支持 Landlock ABI 6 和 seccomp。启动时以同一执行路径验证隔离，就绪后仍对每次任务重新建立限制。程序可以读取已交给它的文件及用于执行的镜像组件。Python 文件复制通过已授权的文件描述符同步文件权限。每个容器同时运行一个任务，默认 30 秒、最长 120 秒。单进程虚拟内存上限 768 MiB，监控任务进程组总 RSS 并在超过 768 MiB 时终止，容器硬上限 1 GiB。容器 init 回收后代进程。输入和产出分别最多 12 MiB，最多 16 个输入和 32 个产出。工具回执列出全部产出，标准输出和标准错误有截断标记。
