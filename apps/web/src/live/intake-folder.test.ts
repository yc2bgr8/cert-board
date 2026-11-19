import { unzipSync } from 'fflate';
import { expect, test } from 'vitest';
import { packageIntakeFolder } from './intake-folder.js';

function file(path: string) {
  return Object.defineProperty(new File(['fixture'], 'sample.pdf'), 'webkitRelativePath', {
    value: path,
  });
}

test('在浏览器目录打包时保留目录结构并统一 NFC', async () => {
  const zip = await packageIntakeFolder([file('样例/子目录/e\u0301.pdf')]);
  expect(zip.name).toBe('样例.zip');
  const entries = unzipSync(new Uint8Array(await zip.arrayBuffer()));
  expect(new TextDecoder().decode(entries['样例/子目录/é.pdf'])).toBe('fixture');
});

test('规范化后重名或选择多个目录时拒绝打包', async () => {
  await expect(
    packageIntakeFolder([file('样例/e\u0301.pdf'), file('样例/é.pdf')]),
  ).rejects.toMatchObject({ code: 'INTAKE_FOLDER_PATH' });
  await expect(packageIntakeFolder([file('甲/一.pdf'), file('乙/二.pdf')])).rejects.toMatchObject({
    code: 'INTAKE_FOLDER_PATH',
  });
});
