import * as http from 'node:http';
import * as https from 'node:https';

export function createStorageTransport(useSSL: boolean, timeoutMs = 5_000) {
  const transport = useSSL ? https : http;
  return new Proxy(transport, {
    get(target, property, receiver) {
      if (property !== 'request') return Reflect.get(target, property, receiver);
      return (...args: unknown[]) => {
        const request = Reflect.apply(target.request, target, args) as http.ClientRequest;
        // MinIO SDK没有监听socket timeout；超时必须销毁请求，不能只返回503后遗留连接。
        request.setTimeout(timeoutMs, () => request.destroy(new Error('文件存储连接超时')));
        return request;
      };
    },
  });
}
