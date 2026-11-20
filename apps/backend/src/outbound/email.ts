import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { testEmailOptionsSchema } from '@cert-board/shared';
import { AppError } from '../api/errors.js';

type SenderReply = 'accepted' | 'rejected' | 'disconnected';
type SentLookup = 'found' | 'missing' | 'unavailable';

export async function emailDispatchResult(
  reply: SenderReply,
  findInSent: () => Promise<SentLookup>,
) {
  if (reply === 'accepted') return 'done';
  if (reply === 'rejected') return 'failed';
  try {
    return (await findInSent()) === 'found' ? 'done' : 'reconcile';
  } catch {
    return 'reconcile';
  }
}

export async function simulateEmail(
  tx: PoolClient,
  queueId: string,
  dispatchId: string,
  options: z.output<typeof testEmailOptionsSchema>,
) {
  const { simulate, sentFolder } = options;
  const filed = simulate !== 'failure' && sentFolder === 'auto_store';
  const recorded = await tx.query(
    `INSERT INTO simulated_email_delivery(queue_id,reply,sent_folder,provider_filed)
     SELECT id,$3,$4,$5 FROM outbound_message WHERE id=$1 AND dispatch_id=$2
     ON CONFLICT(queue_id) DO NOTHING`,
    [queueId, dispatchId, simulate, sentFolder, filed],
  );
  if (recorded.rowCount !== 1)
    throw new AppError(
      409,
      'OUTBOUND_TEST_ID_USED',
      '发送编号已使用，无法确认结果时请查对账记录。',
    );
  const reply = { success: 'accepted', failure: 'rejected', uncertain: 'disconnected' } as const;
  return emailDispatchResult(reply[simulate], async () => {
    if (sentFolder === 'unavailable') return 'unavailable';
    const found = await tx.query(
      `SELECT 1 FROM simulated_email_delivery d JOIN outbound_message q ON q.id=d.queue_id
       WHERE q.dispatch_id=$1 AND d.provider_filed`,
      [dispatchId],
    );
    return found.rowCount ? 'found' : 'missing';
  });
}

const incomingIdentity = z
  .object({
    messageId: z.string().trim().min(1).max(998).optional(),
    sender: z.string().trim().min(1).max(320),
    sentAt: z.string().datetime({ offset: true }),
    body: z.string(),
  })
  .strict();

export function incomingEmailSourceId(raw: unknown) {
  const mail = incomingIdentity.parse(raw);
  if (mail.messageId) return mail.messageId;
  const normalized = [
    mail.sender.normalize('NFC'),
    new Date(mail.sentAt).toISOString(),
    mail.body.replace(/\r\n?/gu, '\n').normalize('NFC'),
  ];
  return `sha256:${createHash('sha256').update(JSON.stringify(normalized)).digest('hex')}`;
}
