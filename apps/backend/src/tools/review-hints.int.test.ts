import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { expect, test } from 'vitest';
import { createReviewTestContext } from '../reviews/test-support.js';
import { ToolRegistry, type ToolDefinition } from './registry.js';
import { AppError } from '../api/errors.js';

test('缺读回执时提供固定可修复提示，不透传原始业务异常', async () => {
  const context = await createReviewTestContext({ autoRead: false });
  try {
    let rejected: unknown;
    try {
      await context.submit();
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toMatchObject({ code: 'TOOL_DATA_REJECTED' });
    expect((rejected as Error).message.includes('doc_read')).toBe(true);
    const probe: ToolDefinition = {
      metadata: {
        name: 'hint_probe',
        version: 'test-v1',
        publication: 'published',
        effect: 'read',
        modes: ['ask', 'full'],
        approvalInAsk: false,
        outputDataLevel: 'internal',
        authorizationAction: 'project.read',
        description: {
          purpose: '测试安全提示。',
          whenToUse: '仅测试。',
          avoid: '不用于业务。',
          parameters: '无参数。',
          example: {},
        },
      },
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({}),
      async execute() {
        throw new AppError(422, 'REVIEW_READ_REQUIRED', 'PRIVATE_ORIGINAL_BODY');
      },
    };
    const registry = new ToolRegistry(context.pool, [probe], { environment: 'test' });
    let failure: unknown;
    try {
      await registry.execute({ ...context.caller, callId: randomUUID() }, 'hint_probe', {});
    } catch (error) {
      failure = error;
    }
    expect((failure as Error).message.includes('doc_read')).toBe(true);
    expect((failure as Error).message.includes('PRIVATE_ORIGINAL_BODY')).toBe(false);
  } finally {
    await context.close();
  }
});
