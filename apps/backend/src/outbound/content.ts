import { createHash } from 'node:crypto';

export function proposalContentHash(content: { subject: string; body: string }) {
  return createHash('sha256')
    .update(JSON.stringify({ subject: content.subject, body: content.body }), 'utf8')
    .digest('hex');
}
