import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { verifyMergeReport, verifyRemotePair } from './acceptance-vm-policy.mjs';

const { values } = parseArgs({
  options: {
    pr: { type: 'string' },
    report: { type: 'string' },
    'reviewed-head': { type: 'string' },
    subject: { type: 'string' },
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
  verifyMergeReport(report, values['reviewed-head']);
  const common = run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const lock = path.join(common, 'cert-board-vm-merge.lock');
  try {
    await mkdir(lock);
  } catch (error) {
    if (error?.code === 'EEXIST')
      throw new Error('已有合并在进行，请等同一工作区的合并任务结束。', { cause: error });
    throw error;
  }
  try {
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
      run(gh, ['pr', 'view', values.pr, '--json', 'state,mergeCommit,url']),
    );
    run('git', ['fetch', 'origin', 'main']);
    const commit = merged.mergeCommit?.oid;
    if (
      merged.state !== 'MERGED' ||
      !commit ||
      run('git', ['show', '-s', '--format=%P', commit]) !== report.base ||
      run('git', ['show', '-s', '--format=%T', commit]) !== report.mergeTree
    )
      throw new Error('远端合并结果与虚拟机报告不同，请暂停后续合并并检查 main。');
    console.log(JSON.stringify({ commit, tree: report.mergeTree, url: merged.url }));
  } finally {
    await rmdir(lock);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : '本机合并未完成。');
  process.exitCode = 1;
});
