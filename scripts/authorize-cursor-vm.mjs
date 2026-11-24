import { execFileSync } from 'node:child_process';
import { cursorAcceptanceTargets } from '../apps/backend/src/modelgw/cursor-acceptance-scope.ts';

const [number, candidate] = process.argv.slice(2);
const sha = /^[0-9a-f]{40}$/u;
const repo = 'yc2bgr8/cert-board';
const pr = Object.keys(cursorAcceptanceTargets).find(
  (key) => String(cursorAcceptanceTargets[key]) === number,
);
const gh = process.env.CERT_BOARD_GH_EXECUTABLE || 'gh';
const run = (command, args) =>
  execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

try {
  if (!pr || !sha.test(candidate ?? '')) throw new Error();
  const pull = JSON.parse(run(gh, ['api', `repos/${repo}/pulls/${number}`]));
  const base = run(gh, ['api', `repos/${repo}/git/ref/heads/main`, '--jq', '.object.sha']);
  const observedHead = pull.head?.sha;
  if (
    pull.state !== 'open' ||
    pull.head?.repo?.full_name !== repo ||
    pull.base?.repo?.full_name !== repo ||
    pull.base.ref !== 'main' ||
    pull.base.sha !== base ||
    !sha.test(base) ||
    !sha.test(observedHead ?? '') ||
    run('git', ['branch', '--show-current']) !== pull.head.ref ||
    run('git', ['rev-parse', 'HEAD']) !== candidate ||
    run('git', ['status', '--porcelain=v1', '--untracked-files=normal'])
  )
    throw new Error();
  run('git', ['merge-base', '--is-ancestor', observedHead, candidate]);
  const mergeTree = run('git', ['merge-tree', '--write-tree', base, candidate]);
  if (!sha.test(mergeTree)) throw new Error();
  console.log(
    JSON.stringify({ pr, number: Number(number), head: candidate, observedHead, base, mergeTree }),
  );
} catch {
  console.error('Cursor 验收授权未生成。请核对获准 PR、远端 main、当前分支及候选提交。');
  process.exitCode = 1;
}
