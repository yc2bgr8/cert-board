# Pi 类型兼容包

本地包只满足 Pi 1.3 的 `TelemetryContext` 类型引用。`index.js` 仅有空导出，不创建上下文、不记录事件、不访问文件或网络；本项目不传入 `telemetryContext`。不是原 `pi-telemetry` 的完整实现。

根目录 pnpm override 强制所有依赖使用此 workspace 包，原遥测包不得出现在锁文件的注册表下载记录中。升级 Pi 前重新核对运行时导入；若开始依赖遥测运行接口，必须先停下解决兼容性，不能自动放行原包。

接口核对来源：<https://github.com/earendil-works/pi/blob/v1.3.0/packages/telemetry/src/index.ts>。本包不包含原包的内存记录器或任何上报实现。
