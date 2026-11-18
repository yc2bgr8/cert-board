import { randomUUID } from 'node:crypto';
import {
  internalMessageInputSchema,
  internalMessageQueuedSchema,
  internalMessageUndoSchema,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import {
  previewInternalMessage,
  enqueueInternalMessage,
  internalMessageVersion,
  cancelInternalMessage,
  refreshInternalMessageLevel,
} from '../outbound/internal.js';
import type { ToolDefinition } from './registry.js';

export function queueInternalMessageTool(): ToolDefinition {
  return {
    metadata: {
      name: 'queue_internal_message',
      version: 'builtin-internal-v1',
      publication: 'published',
      effect: 'reversible_write',
      modes: ['ask', 'full'],
      approvalInAsk: true,
      outputDataLevel: 'dynamic',
      authorizationAction: 'record.write',
      description: {
        purpose: '为已登记并绑定身份的内部同事排入本地测试消息；不直接发送，不支持真实渠道。',
        whenToUse:
          '资料请求或催办对象为本项目已绑定的开发成员；请求批准模式先等浏览器批准，完全允许模式直接排队。',
        avoid:
          '公司外部对象必须用propose_external逐条审核；未知联系人不要猜地址；最终工作结果用submit_for_review。',
        parameters:
          'contactId使用登记联系人编号，subject是单行主题，body是拟发送正文；不得传地址、身份绑定或批准字段。',
        example: {
          contactId: '00000000-0000-4000-8000-000000000001',
          subject: '核对资料',
          body: '请核对资料。此联系人编号仅为格式示例，必须换成实际登记编号。',
        },
      },
    },
    inputSchema: internalMessageInputSchema,
    outputSchema: internalMessageQueuedSchema,
    prepareApproval: previewInternalMessage,
    refreshDataLevel: refreshInternalMessageLevel,
    async execute(ctx, input, before) {
      if (
        !before ||
        before.targetType !== 'internal_outbound_message' ||
        before.beforeVersion !== null ||
        !internalMessageUndoSchema.safeParse(before.beforeState).success
      )
        throw new AppError(
          403,
          'INTERNAL_UNDO_REQUIRED',
          '缺少已登记的排队撤销记录，不能生成内部消息。',
        );
      return enqueueInternalMessage(ctx, input, before.targetId);
    },
    undo: {
      beforeSchema: internalMessageUndoSchema,
      async capture() {
        return {
          targetType: 'internal_outbound_message',
          targetId: randomUUID(),
          beforeState: { created: false },
          beforeVersion: null,
        };
      },
      currentVersion: (ctx, record) => internalMessageVersion(ctx, record.targetId),
      apply: cancelInternalMessage,
    },
  };
}
