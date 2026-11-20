export const shaPattern = /^[0-9a-f]{40}$/u;

export const originalChecks = [
  'install',
  'lint',
  'typecheck',
  'unit',
  'build',
  'python',
  'agent-eval',
  'env-init',
  'dev-up',
  'integration',
  'browser',
  'dev-down',
  'secrets',
];

export function bundledBranches(list) {
  const entries = list.split(/\r?\n/u).map((line) => line.split(' '));
  return new Map(
    entries.filter(([sha, ref]) => shaPattern.test(sha) && ref?.startsWith('refs/heads/')),
  );
}

export function validateConfigurationPaths(paths) {
  const allowed = new Set([
    'AGENTS.md',
    'scripts/acceptance-vm.mjs',
    'scripts/acceptance-vm-policy.mjs',
    'scripts/acceptance-vm.test.mjs',
    'scripts/merge-vm-pr.mjs',
    'scripts/egress.test.mjs',
  ]);
  if (
    paths.some(
      (file) => !allowed.has(file) && !file.startsWith('.github/') && !file.startsWith('docs/'),
    )
  )
    throw new Error('配置专项仅用于验收制度、文档和虚拟机验收脚本。');
}

export function validateAcceptanceScripts(names, registered) {
  if (
    names.some(
      (name) =>
        !/^[a-z][a-z0-9:.-]*$/u.test(name) ||
        !Object.hasOwn(registered, name) ||
        typeof registered[name] !== 'string' ||
        !registered[name].trim(),
    )
  )
    throw new Error('业务验收只接受仓库根 package.json 中已登记的 pnpm 脚本。');
}

export function skippedAcceptance(script, log) {
  return (
    (script === 'test:real' || script === 'test:l08') &&
    /^\s*(?:已)?跳过(?:真实模型测试|\s*L08\s*实物对照)/mu.test(log)
  );
}

export function verifyMergeReport(report, reviewedHead, expectedAcceptance) {
  const required = [
    ...originalChecks,
    report?.scope === 'configuration' ? 'workflow-retired' : 'walkthrough',
  ];
  const steps = Array.isArray(report?.steps) ? report.steps : [];
  const actualAcceptance = steps
    .filter((step) => /^pr-/u.test(step.name))
    .map(({ script }) => script);
  if (
    report?.status !== 'passed' ||
    !['configuration', 'business'].includes(report.scope) ||
    !['kvm', 'qemu', 'oracle', 'vmware', 'microsoft'].includes(report.vm) ||
    !Number.isInteger(report.landlockAbi) ||
    report.landlockAbi < 6 ||
    ![report.base, report.head, report.mergeTree, reviewedHead].every(
      (sha) => typeof sha === 'string' && shaPattern.test(sha),
    ) ||
    report.head !== reviewedHead ||
    !report.completedAt ||
    new Set(steps.map(({ name }) => name)).size !== steps.length ||
    steps.some((step) => step.exitCode !== 0 || (/^pr-/u.test(step.name) && !step.script)) ||
    required.some((name) => !steps.some((step) => step.name === name)) ||
    !Array.isArray(expectedAcceptance) ||
    expectedAcceptance.some((script) => !/^[a-z][a-z0-9:.-]*$/u.test(script)) ||
    (report.scope === 'configuration' && !expectedAcceptance.includes('docs:html')) ||
    actualAcceptance.length !== expectedAcceptance.length ||
    expectedAcceptance.some((script, index) => script !== actualAcceptance[index])
  )
    throw new Error('缺少当前已复审提交的完整通过报告。');
}

export function verifyMergedCommit(report, { state, baseRefName, parent, tree, inMain }) {
  if (
    state !== 'MERGED' ||
    baseRefName !== 'main' ||
    parent !== report.base ||
    tree !== report.mergeTree ||
    !inMain
  )
    throw new Error('远端合并结果与虚拟机报告不同，请暂停后续合并并检查 main。');
}

export function verifyRemotePair(report, pr, main) {
  if (
    pr.state !== 'OPEN' ||
    pr.isDraft ||
    pr.baseRefName !== 'main' ||
    pr.baseRefOid !== report.base ||
    main !== report.base ||
    pr.headRefOid !== report.head
  )
    throw new Error('远端 main 或 PR 头与验收报告不一致，请重新验收再合并。');
}
