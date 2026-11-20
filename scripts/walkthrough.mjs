import { spawn, spawnSync } from 'node:child_process';
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

async function main() {
  if (verificationOnly && !diagnostic) throw new Error('正式走查需要完整执行全部场景。');
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
  const { runtime } = await previewEnvironment('walkthrough');
  const live = diagnostic ? null : await startPreview('walkthrough');
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
          CERT_WALKTHROUGH_DIAGNOSTIC: diagnostic ? '1' : '0',
          CERT_WALKTHROUGH_VERIFICATION_ONLY: verificationOnly ? '1' : '0',
        },
      },
    );
    process.exitCode = await new Promise((resolve) => {
      child.once('error', () => resolve(1));
      child.once('close', (code) => resolve(code ?? 1));
    });
    if (process.exitCode === 0 && !diagnostic) {
      const result = JSON.parse(await readFile(path.join(folder, 'result.json'), 'utf8'));
      const current = clean();
      if (
        result.status !== 'passed' ||
        result.commit !== commit ||
        current.status !== 0 ||
        current.stdout.trim() ||
        previewGitHead() !== commit
      )
        throw new Error('走查期间提交发生变化，请在同一提交下复跑。');
      const staged = `${previewEvidence}.tmp`;
      await writeFile(
        staged,
        JSON.stringify({ status: 'passed', commit, evidence: folder }, null, 2),
        'utf8',
      );
      await rename(staged, previewEvidence);
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
