import { PassThrough } from 'node:stream';
import { afterEach, expect, test, vi } from 'vitest';
import { createDocumentUploadGate, monitorDocumentUpload } from './upload-gate.js';

afterEach(() => vi.useRealTimers());

test('按收到数据刷新空闲时限，持续上传仍受总时限限制', () => {
  vi.useFakeTimers();
  const gate = createDocumentUploadGate<string>();
  const abort = vi.fn();
  expect(gate.acquire('first', abort)).toBe(true);
  for (let tick = 0; tick < 28; tick++) {
    vi.advanceTimersByTime(25_000);
    expect(abort).not.toHaveBeenCalled();
    gate.receive('first');
  }
  vi.advanceTimersByTime(19_999);
  expect(abort).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(abort).toHaveBeenCalledOnce();
  expect(gate.acquire('first', vi.fn())).toBe(true);
});

test('空闲超时释放名额，正文已读完的请求持有名额直到回应', () => {
  vi.useFakeTimers();
  const gate = createDocumentUploadGate<string>();
  const abortIdle = vi.fn();
  const abortComplete = vi.fn();
  expect(gate.acquire('idle', abortIdle)).toBe(true);
  expect(gate.acquire('complete', abortComplete)).toBe(true);
  gate.finishBody('complete');
  expect(gate.acquire('next', vi.fn())).toBe(false);
  vi.advanceTimersByTime(30_000);
  expect(abortIdle).toHaveBeenCalledOnce();
  expect(abortComplete).not.toHaveBeenCalled();
  expect(gate.acquire('next', vi.fn())).toBe(true);
  expect(gate.acquire('last', vi.fn())).toBe(false);
  gate.release('complete');
  expect(gate.acquire('last', vi.fn())).toBe(true);
});

test('下游提前停止读取时，后续源流错误仍由管道接管', async () => {
  const payload = new PassThrough();
  const receive = vi.fn();
  const body = monitorDocumentUpload(payload, receive);
  const closed = new Promise<void>((resolve) => body.once('close', resolve));
  payload.write(Buffer.from('fixture'));
  expect(body.receivedEncodedLength).toBe(7);
  expect(receive).toHaveBeenCalledOnce();
  payload.destroy(new Error('fixture connection interrupted'));
  await closed;
  expect(body.destroyed).toBe(true);
});
