import { describe, expect, it } from 'vitest';
import {
  goalOutboundControlSchema,
  localTestReceiptSchema,
  outboundProcessOptionsSchema,
  proposalCreateSchema,
  proposalDecisionSchema,
  proposalToolResultSchema,
} from './proposals.js';

const id = '10000000-0000-4000-8000-000000000001';
describe('提案与浏览器决定输入边界', () => {
  it('提案仅允许登记联系人、主题和正文，不能直接指定审批或外发渠道', () => {
    const input = { contactId: id, subject: ' 核对资料 ', body: '  请核对\r\n原始写法。\n' };
    expect(proposalCreateSchema.parse(input)).toEqual({ ...input, subject: '核对资料' });
    for (const field of ['approved', 'channel', 'actorUserId', 'sessionId', 'attachments']) {
      expect(proposalCreateSchema.safeParse({ ...input, [field]: '越权字段' }).success).toBe(false);
    }
  });
  it('主题拒绝头部控制字符，正文有上限且不接受损坏Unicode', () => {
    for (const subject of [' ', 'x'.repeat(201), '正常\n注入', '正常\t注入']) {
      expect(proposalCreateSchema.safeParse({ contactId: id, subject, body: '正文' }).success).toBe(
        false,
      );
    }
    for (const body of [' ', 'x'.repeat(8001), '\ud800', 'x\0y']) {
      expect(proposalCreateSchema.safeParse({ contactId: id, subject: '主题', body }).success).toBe(
        false,
      );
    }
  });
  it('模型工具回执只能是尚未发送的提案', () => {
    const result = {
      proposalId: id,
      version: 1,
      status: 'proposed',
      channel: 'local_test',
      sent: false,
    };
    expect(proposalToolResultSchema.safeParse(result).success).toBe(true);
    expect(proposalToolResultSchema.safeParse({ ...result, sent: true }).success).toBe(false);
    expect(proposalToolResultSchema.safeParse({ ...result, status: 'approved' }).success).toBe(
      false,
    );
  });
  it('决定必须带版本与幂等请求号，身份和内容哈希只能从浏览器会话及数据库取得', () => {
    const decision = { expectedVersion: 1, action: 'approved', requestKey: id };
    expect(proposalDecisionSchema.safeParse(decision).success).toBe(true);
    expect(proposalDecisionSchema.safeParse({ action: 'approved', requestKey: id }).success).toBe(
      false,
    );
    expect(proposalDecisionSchema.safeParse({ ...decision, actorUserId: id }).success).toBe(false);
    expect(
      proposalDecisionSchema.safeParse({ ...decision, contentHash: 'a'.repeat(64) }).success,
    ).toBe(false);
    expect(proposalDecisionSchema.safeParse({ ...decision, action: 'sent' }).success).toBe(false);
  });
  it('暂停控制有版本检查，本地测试回执不接受正文或真实渠道', () => {
    expect(goalOutboundControlSchema.safeParse({ expectedVersion: 1, paused: true }).success).toBe(
      true,
    );
    expect(goalOutboundControlSchema.safeParse({ paused: false }).success).toBe(false);
    const receipt = { id, recordedAt: '2026-11-18T00:00:00+08:00', channel: 'local_test' };
    expect(localTestReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(localTestReceiptSchema.safeParse({ ...receipt, body: '不应复制的正文' }).success).toBe(
      false,
    );
    expect(localTestReceiptSchema.safeParse({ ...receipt, channel: 'email' }).success).toBe(false);
    expect(outboundProcessOptionsSchema.parse({})).toEqual({ simulate: 'success' });
    expect(outboundProcessOptionsSchema.safeParse({ simulate: 'uncertain' }).success).toBe(true);
    expect(
      outboundProcessOptionsSchema.safeParse({ simulate: 'success', sender: '自定义发送器' })
        .success,
    ).toBe(false);
  });
});
