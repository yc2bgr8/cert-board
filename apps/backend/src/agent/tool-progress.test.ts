import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { toolSummary } from './tool-progress.js';

test('读取摘要只有资料和页码定位，保留后续读取提示', () => {
  const summary = toolSummary(
    'doc_read',
    {
      sourceKey: 'S1',
      version: 2,
      page: 3,
      locatorKind: 'extraction_unit',
      truncated: true,
      text: '此处是完整私有文本，不进入工具过程摘要',
    },
    false,
  );
  expect(summary).toBe('已读 S1 第 2 版，第 3 提取单元，还有内容可继续读取');
});

test('待批准的本地消息只显示等待，没有排队或发送回执', () => {
  expect(
    toolSummary('queue_internal_message', { approvalId: randomUUID(), status: 'pending' }, false),
  ).toBe('等待发起人在浏览器批准后继续');
});
