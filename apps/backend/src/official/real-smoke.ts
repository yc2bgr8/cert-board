import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';
import { officialLookupInputSchema } from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { FetcherClient } from '../documents/fetcher-client.js';
import { downloadPublicWebSnapshot } from '../documents/public-web.js';
import { normalizeOfficialResponse, officialRequestUrl } from './providers.js';

async function main() {
  const fetcher = new FetcherClient('http://127.0.0.1:28084/', 'host');
  if (process.argv.includes('--m02')) {
    const input = officialLookupInputSchema.parse({
      dataset: 'fda_gudid_search',
      productCode: 'LRK',
      brandNames: ['EMA Now'],
    });
    const downloaded = await downloadPublicWebSnapshot(fetcher, officialRequestUrl(input));
    assert.equal(downloaded.snapshot.mediaType, 'application/json');
    const result = normalizeOfficialResponse(input, JSON.parse(downloaded.bytes.toString('utf8')));
    assert.ok(
      result.records.some(
        (record) =>
          record.gudidRecordKey &&
          record.primaryDeviceIdentifier &&
          record.gudidRecordKey !== record.primaryDeviceIdentifier &&
          record.productCode === 'LRK' &&
          record.name === 'EMA Now',
      ),
    );
    console.log('官方 UDI 非空专项通过，已分别核对公开记录键与主 DI。');
    return;
  }
  for (const kNumber of ['K253845', 'K170825']) {
    const input = officialLookupInputSchema.parse({ dataset: 'fda_510k', kNumber });
    const downloaded = await downloadPublicWebSnapshot(fetcher, officialRequestUrl(input));
    assert.equal(downloaded.snapshot.mediaType, 'application/json');
    const result = normalizeOfficialResponse(input, JSON.parse(downloaded.bytes.toString('utf8')));
    assert.equal(result.records.length, 1);
    const record = result.records[0];
    assert.ok(record);
    const { identifier, productCode, regulationNumber, deviceClass } = record;
    assert.deepEqual(
      [identifier, productCode, regulationNumber, deviceClass],
      [kNumber, 'LRK', '872.5570', '2'],
    );
    await wait(1000);
  }
  const historical = officialLookupInputSchema.parse({
    dataset: 'fda_510k',
    kNumber: 'K170825',
    asOf: '2017-08-17',
  });
  const empty = await downloadPublicWebSnapshot(fetcher, officialRequestUrl(historical));
  assert.deepEqual(
    normalizeOfficialResponse(historical, JSON.parse(empty.bytes.toString('utf8'))),
    {
      records: [],
      nextOffset: null,
    },
  );
  console.log('官方回查通过，两个 K 号均为 LRK、21 CFR 872.5570、Class II，截止日前确认无匹配。');
}

main().catch((error) => {
  const code = error instanceof AppError ? error.code : 'OFFICIAL_VALIDATION_FAILED';
  console.error(`官方回查未通过，${code}。请核对隔离抓取服务或官方字段。`);
  process.exitCode = 1;
});
