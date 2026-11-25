import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { measureV1 } from './v1-measurement.js';

async function main() {
  const [source, ...rest] = process.argv.slice(2);
  if (!source || rest.length) throw new Error('请提供一份脱敏测量 JSON，或使用 --synthetic。');
  const example = source === '--synthetic';
  const file = example
    ? fileURLToPath(
        new URL('../../../../../fixtures/v1/measurement-synthetic.json', import.meta.url),
      )
    : source;
  const max = 4 * 1024 * 1024;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of createReadStream(file, { start: 0, end: max })) {
    size += chunk.length;
    if (size > max) throw new Error('测量输入超过大小上限。');
    chunks.push(chunk);
  }
  const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  const report = measureV1(input);
  if (example && report.scope !== 'synthetic') throw new Error('样例须标明合成来源。');
  console.log(JSON.stringify(report, null, 2));
}

main().catch(() => {
  console.error('V1 指标汇总失败，请核对脱敏输入、提交编号和证据标识。');
  process.exitCode = 1;
});
