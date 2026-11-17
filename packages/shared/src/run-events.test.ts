import { describe, expect, it } from 'vitest';
import {
  claimRunLeaseSchema,
  renewRunLeaseSchema,
  runEventInputSchema,
  runEventListOptionsSchema,
  runLeaseIdentitySchema,
} from './run-events.js';

const id = '10000000-0000-4000-8000-000000000001';
describe('执行事件与租约边界', () => {
  it('未知正文、参数、错误及凭据字段被剔除，不成为执行事件', () => {
    const result = runEventInputSchema.parse({
      type: 'model_started',
      requestId: id,
      inputTokens: 12,
      message: '正文示例',
      body: '正文示例',
      error: { message: '错误正文' },
      arguments: { document: '资料正文' },
      headers: { authorization: '合成凭据' },
      toolName: '任意字符串',
      callId: '任意字符串',
      data: { text: '正文' },
    });
    expect(result).toEqual({ type: 'model_started', requestId: id, inputTokens: 12 });
  });
  it('已知字段仍严格检查，不能在事件类型或原因中夹带自由文本', () => {
    expect(runEventInputSchema.safeParse({ type: '模型返回的正文' }).success).toBe(false);
    expect(
      runEventInputSchema.safeParse({ type: 'run_failed', reasonCode: '原始错误正文' }).success,
    ).toBe(false);
    expect(runEventInputSchema.safeParse({ type: 'model_completed', costNano: '-1' }).success).toBe(
      false,
    );
    expect(
      runEventInputSchema.safeParse({ type: 'tool_completed', invocationId: '非编号' }).success,
    ).toBe(false);
    expect(
      runEventInputSchema.safeParse({ type: 'model_completed', totalTokens: Number.NaN }).success,
    ).toBe(false);
  });
  it('领取和续期有期限上限，后续操作必须携带正代数', () => {
    const identity = { runId: id, userId: id, ownerId: id };
    expect(claimRunLeaseSchema.parse(identity).ttlSeconds).toBe(60);
    expect(claimRunLeaseSchema.safeParse({ ...identity, ttlSeconds: 301 }).success).toBe(false);
    expect(runLeaseIdentitySchema.safeParse({ ...identity, generation: 0 }).success).toBe(false);
    expect(
      renewRunLeaseSchema.safeParse({ ...identity, generation: 1, ttlSeconds: 60 }).success,
    ).toBe(true);
    expect(
      renewRunLeaseSchema.safeParse({ ...identity, generation: 1, expiresAt: '2099-01-01' })
        .success,
    ).toBe(false);
  });
  it('事件读取限制最多100项', () => {
    expect(runEventListOptionsSchema.parse({})).toEqual({ afterSeq: 0, limit: 50 });
    expect(runEventListOptionsSchema.safeParse({ afterSeq: -1 }).success).toBe(false);
    expect(runEventListOptionsSchema.safeParse({ limit: 101 }).success).toBe(false);
  });
});
