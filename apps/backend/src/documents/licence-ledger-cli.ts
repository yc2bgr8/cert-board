import { readFile, stat } from 'node:fs/promises';
import { parseBackendConfig } from '@cert-board/shared';
import { createDependencies } from '../dependencies.js';
import { BlobStore } from './blob-store.js';
import {
  decodeLicenceLedgerSnapshot,
  importVerifiedLicenceLedger,
} from './licence-ledger-import.js';

async function main() {
  const file = process.argv[2];
  const config = parseBackendConfig(process.env);
  if (!file || process.argv.length !== 3 || config.NODE_ENV === 'production')
    throw new Error('LEDGER_IMPORT_UNAVAILABLE');
  const source = await stat(file);
  if (!source.isFile() || source.size > 30 * 1024 * 1024) throw new Error('LEDGER_IMPORT_SIZE');
  const parsed = decodeLicenceLedgerSnapshot(await readFile(file));
  const dependencies = createDependencies(config);
  try {
    const store = new BlobStore(dependencies.storage, config.MINIO_BUCKET);
    const snapshot = await importVerifiedLicenceLedger(dependencies.database, store, parsed);
    console.log(`证照台账资料 ${snapshot.documentId} 版本 ${snapshot.version} 已登记。`);
  } finally {
    await dependencies.close();
  }
}

main().catch(() => {
  console.error('证照台账登记失败。请核对开发环境、人工确认的台账 JSON、来源快照和资料存储。');
  process.exitCode = 1;
});
