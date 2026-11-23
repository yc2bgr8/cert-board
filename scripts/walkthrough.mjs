import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backendEnvironment } from './start-backend.mjs';
import { previewEnvironment, previewEvidence, previewGitHead, startPreview } from './preview.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const clean = () =>
  spawnSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
const diagnostic = process.argv.includes('--diagnostic');
const verificationOnly = process.argv.includes('--verification-only');
const batch = process.argv.includes('--batch');
const specialties = [
  {
    flag: '--official-only',
    environment: 'CERT_WALKTHROUGH_OFFICIAL_ONLY',
    receipt: 'official-result.json',
  },
  {
    flag: '--rules-only',
    environment: 'CERT_WALKTHROUGH_RULES_ONLY',
    receipt: 'rules-result.json',
  },
  { flag: '--r09-only', environment: 'CERT_WALKTHROUGH_R09_ONLY', receipt: 'r09-result.json' },
].filter(({ flag }) => process.argv.includes(flag));
const specialty = specialties[0];
const officialOnly = specialty?.flag === '--official-only';

async function main() {
  if (verificationOnly && (!diagnostic || batch)) throw new Error('正式走查需要完整执行全部场景。');
  if (specialty && (batch || diagnostic || specialties.length > 1))
    throw new Error('正式走查每次只能运行一个专项。');
  const initial = clean();
  if (!diagnostic && (initial.status !== 0 || initial.stdout.trim()))
    throw new Error('正式走查须使用已提交的代码。');
  const commit = previewGitHead();
  const folder = path.join(
    root,
    '.local',
    'preview',
    'evidence',
    new Date().toISOString().replace(/[:.]/gu, '-'),
  );
  await mkdir(folder, { recursive: true });
  const { runtime } = await previewEnvironment('walkthrough', officialOnly);
  const live = diagnostic ? null : await startPreview('walkthrough', undefined, officialOnly);
  try {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'apps/backend/src/e2e/real-walkthrough.ts'],
      {
        cwd: root,
        windowsHide: true,
        shell: false,
        stdio: 'inherit',
        env: {
          ...backendEnvironment('api', runtime),
          DEV_ZHANGSAN_PASSWORD: runtime.DEV_ZHANGSAN_PASSWORD,
          CERT_WALKTHROUGH_EVIDENCE_DIR: folder,
          CERT_WALKTHROUGH_COMMIT: commit,
          ...(live ? { CERT_WALKTHROUGH_INSTANCE: live.instance } : {}),
          CERT_WALKTHROUGH_DIAGNOSTIC: diagnostic ? '1' : '0',
          CERT_WALKTHROUGH_VERIFICATION_ONLY: verificationOnly ? '1' : '0',
          CERT_WALKTHROUGH_BATCH: batch ? '1' : '0',
          ...(specialty ? { [specialty.environment]: '1' } : {}),
        },
      },
    );
    const completed = new Promise((resolve) => {
      child.once('error', () => resolve(1));
      child.once('close', (code) => resolve(code ?? 1));
    });
    process.exitCode = live
      ? await Promise.race([completed, live.done.then(() => 1)])
      : await completed;
    if (live?.exited()) {
      child.kill('SIGTERM');
      throw new Error('预览进程在正式走查结束前退出。');
    }
    if (process.exitCode === 0 && !diagnostic) {
      const resultFile = batch ? 'q2-result.json' : (specialty?.receipt ?? 'result.json');
      const rawResult = await readFile(path.join(folder, resultFile));
      const result = JSON.parse(rawResult.toString('utf8'));
      const current = clean();
      if (
        result.status !== 'passed' ||
        result.commit !== commit ||
        result.instance !== live?.instance ||
        current.status !== 0 ||
        current.stdout.trim() ||
        previewGitHead() !== commit
      )
        throw new Error('走查期间提交发生变化，请在同一提交下复跑。');
      if (!batch && !specialty) {
        const resultSha256 = createHash('sha256').update(rawResult).digest('hex');
        const receipt = JSON.stringify(
          {
            status: 'passed',
            commit,
            evidence: folder,
            resultSha256,
          },
          null,
          2,
        );
        await writeFile(path.join(folder, 'receipt.json'), receipt, {
          encoding: 'utf8',
          flag: 'wx',
        });
        const staged = `${previewEvidence}.tmp`;
        await writeFile(staged, receipt, 'utf8');
        await rename(staged, previewEvidence);
        console.log(`标准走查回执 ${path.basename(folder)} ${resultSha256}`);
      }
    }
  } finally {
    if (live) await live.stop();
  }
}

main().catch((error) => {
  console.error(
    error instanceof Error && /^(?:正式走查|走查期间|预览)/u.test(error.message)
      ? error.message
      : '真实走查未能启动。请核对独立预览、浏览器和模型配置。',
  );
  process.exitCode = 1;
});
