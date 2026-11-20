import { spawnSync } from 'node:child_process';

for (const service of ['fetcher', 'docsvc', 'sandbox']) {
  const test = spawnSync(process.execPath, [`scripts/${service}-dev.mjs`, 'test'], {
    stdio: 'inherit',
    windowsHide: true,
    shell: false,
  });
  if (test.status !== 0) {
    process.exitCode = test.status ?? 1;
    break;
  }
}
