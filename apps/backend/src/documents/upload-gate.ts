import { pipeline, Transform, type Readable } from 'node:stream';

const maximumConcurrentUploads = 2;
const uploadIdleMs = 30_000;
const uploadDeadlineMs = 12 * 60_000;

export function createDocumentUploadGate<Key>(capacity = maximumConcurrentUploads) {
  const uploads = new Map<Key, { idle: NodeJS.Timeout; deadline: NodeJS.Timeout } | null>();

  function finishBody(key: Key) {
    const timers = uploads.get(key);
    if (!timers) return;
    clearTimeout(timers.idle);
    clearTimeout(timers.deadline);
    uploads.set(key, null);
  }

  function release(key: Key) {
    finishBody(key);
    uploads.delete(key);
  }

  return {
    acquire(key: Key, abort: () => void) {
      if (uploads.size >= capacity || uploads.has(key)) return false;
      const expire = () => {
        release(key);
        abort();
      };
      uploads.set(key, {
        idle: setTimeout(expire, uploadIdleMs).unref(),
        deadline: setTimeout(expire, uploadDeadlineMs).unref(),
      });
      return true;
    },
    receive(key: Key) {
      uploads.get(key)?.idle.refresh();
    },
    finishBody,
    release,
  };
}

export function monitorDocumentUpload(payload: Readable, receive: () => void) {
  const body = Object.assign(
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        receive();
        body.receivedEncodedLength += chunk.length;
        callback(null, chunk);
      },
    }),
    { receivedEncodedLength: 0 },
  );
  // 解析器提前退出时，管道仍接管随后到达的流错误。
  pipeline(payload, body, () => undefined);
  return body;
}
