import { expect, test } from 'vitest';
import { decodeLicenceLedgerSnapshot } from './licence-ledger-import.js';

test('台账命令读取 Windows 导出的 UTF-8 BOM 文件及普通 UTF-8 文件', () => {
  const body = { name: '证照台账' };
  const encoded = Buffer.from(JSON.stringify(body));
  expect(decodeLicenceLedgerSnapshot(encoded)).toEqual(body);
  expect(
    decodeLicenceLedgerSnapshot(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), encoded])),
  ).toEqual(body);
});
