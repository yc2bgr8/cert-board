import { expect, test } from 'vitest';
import { expandIntakeArchive, intakeFormat, intakePath } from './archive.js';
import { classifyIntakePath } from './classify.js';
import { fixtureZip } from './test-archives.js';

test('按层展开正常 ZIP，路径和文件名统一 NFC', async () => {
  const nested = fixtureZip([{ name: '资料/e\u0301.pdf', bytes: Buffer.from('fictional') }]);
  const result = await expandIntakeArchive(fixtureZip([{ name: '测试.zip', bytes: nested }]));
  expect(result.files).toEqual([{ path: '测试.zip!/资料/é.pdf', bytes: Buffer.from('fictional') }]);
  expect(result.expandedBytes).toBe(nested.length + 9);
});

test('拒绝相同规范化路径、越界路径和超出展开比率的合成样本', async () => {
  await expect(
    expandIntakeArchive(
      fixtureZip([
        { name: 'é.pdf', bytes: Buffer.from('1') },
        { name: 'e\u0301.pdf', bytes: Buffer.from('2') },
      ]),
    ),
  ).rejects.toMatchObject({ code: 'INTAKE_PATH_DUPLICATE' });
  expect(() => intakePath('../outside.pdf')).toThrow();
  expect(() => intakePath('C:\\example.pdf')).toThrow();
  expect(() => intakePath('资料'.repeat(450) + '.pdf')).toThrow();
  await expect(
    expandIntakeArchive(
      fixtureZip([
        { name: 'repeated-fixture.pdf', bytes: Buffer.alloc(1_100_000, 'a'), compress: true },
      ]),
    ),
  ).rejects.toMatchObject({ code: 'INTAKE_ARCHIVE_LIMIT' });
});

test('四层压缩和无文件包给出确定失败', async () => {
  let archive = fixtureZip([{ name: 'report.pdf', bytes: Buffer.from('fixture') }]);
  for (let depth = 0; depth < 3; depth++)
    archive = fixtureZip([{ name: 'inner.zip', bytes: archive }]);
  await expect(expandIntakeArchive(archive)).rejects.toMatchObject({
    code: 'INTAKE_ARCHIVE_LIMIT',
  });
  await expect(expandIntakeArchive(fixtureZip([]))).rejects.toMatchObject({
    code: 'INTAKE_ARCHIVE_EMPTY',
  });
  const tooMany = fixtureZip(
    Array.from({ length: 501 }, (_, index) => ({
      name: `fixture-${index}.pdf`,
      bytes: Buffer.from('a'),
    })),
  );
  await expect(expandIntakeArchive(tooMany)).rejects.toMatchObject({
    code: 'INTAKE_ARCHIVE_LIMIT',
  });
});

test('文件扩展名不改变 PDF 识别，文件名只用于草稿归类', () => {
  expect(intakeFormat('申报/汇总_eSTAR.PDF')).toBe('pdf');
  expect(intakeFormat('unknown.dat')).toBeUndefined();
  expect(classifyIntakePath('eSTAR.pdf!/01-predicate comparison.pdf').category).toBe('predicate');
  expect(classifyIntakePath('编号.jpg')).toEqual({ category: 'review_needed', confidence: null });
});

test('压缩目录中的资料经过 CRC 完整性校验', async () => {
  const archive = fixtureZip([{ name: 'source.pdf', bytes: Buffer.from('fictional document') }]);
  archive[archive.indexOf('fictional document')] = 0x46;
  await expect(expandIntakeArchive(archive)).rejects.toMatchObject({
    code: 'INTAKE_ENTRY_CORRUPT',
  });
});
