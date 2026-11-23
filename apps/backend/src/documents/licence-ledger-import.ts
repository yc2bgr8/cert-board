import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { documentImportSchema } from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import type { DocumentBlobStore } from './blob-store.js';
import { ingestParsedDocument } from './service.js';

export async function importVerifiedLicenceLedger(
  pool: Pool,
  store: DocumentBlobStore,
  input: unknown,
) {
  const parsed = documentImportSchema.safeParse(input);
  if (
    !parsed.success ||
    parsed.data.authorType !== 'human' ||
    !parsed.data.pages.some(({ isPlaceholder, text }) => !isPlaceholder && text.trim())
  )
    throw new AppError(
      400,
      'LEDGER_IMPORT_INVALID',
      '请提供由人工核对的台账解析快照，指定资料级别并保留至少一条有效原文。',
    );
  const sourceSnapshot = createHash('sha256')
    .update('cert-board-verified-licence-ledger-v1\n')
    .update(parsed.data.sourceSnapshot)
    .digest('hex');
  return ingestParsedDocument(pool, store, {
    ...parsed.data,
    sourceSnapshot,
    sourceMetadata: {
      ...parsed.data.sourceMetadata,
      sourceRole: 'licence_ledger',
      reviewedSnapshot: parsed.data.sourceSnapshot,
    },
  });
}
