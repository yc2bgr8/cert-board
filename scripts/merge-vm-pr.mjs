import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  shaPattern,
  verifyMergedCommit,
  verifyMergeReport,
  verifyRemotePair,
} from './acceptance-vm-policy.mjs';

const { values } = parseArgs({
  options: {
    pr: { type: 'string' },
    report: { type: 'string' },
    'reviewed-head': { type: 'string' },
    subject: { type: 'string' },
    acceptance: { type: 'string', multiple: true },
    'no-special-checks': { type: 'boolean' },
  },
});
const gh = process.env.CERT_BOARD_GH_EXECUTABLE || 'gh';

function run(executable, args) {
  const result = spawnSync(executable, args, { encoding: 'utf8', shell: false, windowsHide: true });
  if (result.status !== 0) throw new Error('合并命令未完成，请核对远端实际状态。');
  return result.stdout.trim();
}

async function main() {
  if (!/^[1-9]\d*$/u.test(values.pr ?? '') || !values.report || !values.subject?.trim())
    throw new Error('请输入 PR 编号、虚拟机通过报告、已复审提交及合并标题。');
  const report = JSON.parse(await readFile(values.report, 'utf8'));
  if (Boolean(values.acceptance) === Boolean(values['no-special-checks']))
    throw new Error('请输入已复审的专项清单，或明确确认本 PR 无专项。');
  verifyMergeReport(report, values['reviewed-head'], values.acceptance ?? []);
  const common = run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const lock = path.join(common, 'cert-board-vm-merge.lock');
  const owner = path.join(lock, 'owner.json');
  try {
    await mkdir(lock);
  } catch (error) {
    if (error?.code === 'EEXIST')
      throw new Error('已有合并锁。请按仓库验收说明核对 owner.json 和远端 PR 状态。', {
        cause: error,
      });
    throw error;
  }
  let recorded = false;
  try {
    await writeFile(
      owner,
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        pr: values.pr,
        base: report.base,
        head: report.head,
      }),
      { flag: 'wx', mode: 0o600 },
    );
    recorded = true;
    if (run('git', ['status', '--porcelain'])) throw new Error('请先保存工作区改动再合并。');
    const pr = JSON.parse(
      run(gh, [
        'pr',
        'view',
        values.pr,
        '--json',
        'baseRefName,baseRefOid,headRefOid,state,isDraft,reviewDecision',
      ]),
    );
    if (pr.reviewDecision === 'CHANGES_REQUESTED') throw new Error('先处理 PR 复审意见再合并。');
    if (run('git', ['merge-tree', '--write-tree', report.base, report.head]) !== report.mergeTree)
      throw new Error('本机合并树与虚拟机报告不同，请重新验收。');
    const mainRef = run('git', ['ls-remote', '--exit-code', 'origin', 'refs/heads/main']).split(
      /\s+/u,
    )[0];
    verifyRemotePair(report, pr, mainRef);
    run(gh, [
      'pr',
      'merge',
      values.pr,
      '--squash',
      '--delete-branch',
      '--match-head-commit',
      report.head,
      '--subject',
      values.subject,
    ]);
    const merged = JSON.parse(
      run(gh, ['pr', 'view', values.pr, '--json', 'state,baseRefName,mergeCommit,url']),
    );
    const commit = merged.mergeCommit?.oid;
    if (typeof commit !== 'string' || !shaPattern.test(commit))
      throw new Error('找不到已合并的提交，请检查 GitHub 上的 PR 状态。');
    run('git', ['fetch', 'origin', 'refs/heads/main']);
    const fetchedMain = run('git', ['rev-parse', 'FETCH_HEAD']);
    const inMain =
      spawnSync('git', ['merge-base', '--is-ancestor', commit, fetchedMain], {
        stdio: 'ignore',
        windowsHide: true,
        shell: false,
      }).status === 0;
    verifyMergedCommit(report, {
      state: merged.state,
      baseRefName: merged.baseRefName,
      inMain,
      parent: inMain ? run('git', ['show', '-s', '--format=%P', commit]) : null,
      tree: inMain ? run('git', ['show', '-s', '--format=%T', commit]) : null,
    });
    console.log(JSON.stringify({ commit, tree: report.mergeTree, url: merged.url }));
  } finally {
    if (recorded) await unlink(owner);
    await rmdir(lock);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : '本机合并未完成。');
  process.exitCode = 1;
});
