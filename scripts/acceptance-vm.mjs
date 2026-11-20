import { spawn, spawnSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import { homedir, release } from 'node:os';
import path from 'node:path';
import { parseArgs, parseEnv } from 'node:util';

const shaPattern = /^[0-9a-f]{40}$/u;
const { values } = parseArgs({
  options: {
    bundle: { type: 'string' },
    base: { type: 'string' },
    head: { type: 'string' },
    acceptance: { type: 'string', multiple: true },
    'model-profile': { type: 'string' },
    'config-only': { type: 'boolean' },
  },
});

function readCommand(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell: false });
  if (result.status !== 0) throw new Error(`${command} 检查失败，请核对虚拟机或提交。`);
  return result.stdout.trim();
}

async function configureModels(root, profile) {
  if (!profile || !path.isAbsolute(profile))
    throw new Error('请在虚拟机提供已授权的模型配置文件。');
  const config = parseEnv(await readFile(profile, 'utf8'));
  const fields = [
    'OPENROUTER_API_KEY',
    'CERT_CURSOR_BUNDLE',
    'CERT_CURSOR_PROFILE',
    'CERT_CURSOR_PRIVACY_CONFIRMED',
  ];
  if (
    fields.some((name) => !/^[A-Za-z0-9_./:-]+$/u.test(config[name] ?? '')) ||
    config.CERT_CURSOR_PRIVACY_CONFIRMED !== '1' ||
    !path.isAbsolute(config.CERT_CURSOR_BUNDLE) ||
    !path.isAbsolute(config.CERT_CURSOR_PROFILE)
  )
    throw new Error('请先核对虚拟机的模型凭据、Cursor 专用登录和隐私设置。');
  await appendFile(
    path.join(root, '.env.local'),
    `\n${fields.map((name) => `${name}=${config[name]}`).join('\n')}\n`,
  );
}

function verifyMachine() {
  if (process.platform !== 'linux' || /microsoft|wsl/iu.test(release()))
    throw new Error('请在独立 Linux 虚拟机内运行验收。');
  const vm = readCommand('systemd-detect-virt', ['--vm']);
  if (!/^(?:kvm|qemu|oracle|vmware|microsoft)$/u.test(vm))
    throw new Error('当前系统的虚拟机类型未通过核对。');
  return vm;
}

function testTree(root, bundle, base, head) {
  readCommand('git', ['init', '--quiet'], root);
  const refs = new Map(
    readCommand('git', ['bundle', 'list-heads', bundle], root)
      .split(/\r?\n/u)
      .map((line) => line.split(' ')),
  );
  for (const sha of [base, head]) {
    const ref = refs.get(sha);
    if (!ref || !ref.startsWith('refs/heads/')) throw new Error('Git 包未包含申报的两个分支提交。');
    readCommand('git', ['fetch', '--quiet', '--no-tags', bundle, ref], root);
    if (readCommand('git', ['rev-parse', 'FETCH_HEAD'], root) !== sha)
      throw new Error('Git 包实际提交与申报编号不同。');
  }
  const tree = readCommand('git', ['merge-tree', '--write-tree', base, head], root);
  if (!shaPattern.test(tree)) throw new Error('无法核对待合并的代码树。');
  const merged = readCommand(
    'git',
    [
      '-c',
      'user.name=Cert Board Acceptance',
      '-c',
      'user.email=acceptance@cert-board.local',
      'commit-tree',
      tree,
      '-p',
      base,
      '-p',
      head,
      '-m',
      `VM acceptance of ${head} against ${base}`,
    ],
    root,
  );
  readCommand('git', ['checkout', '--quiet', '--detach', merged], root);
  if (
    readCommand('git', ['status', '--porcelain'], root) ||
    readCommand('git', ['rev-parse', 'HEAD^{tree}'], root) !== tree
  )
    throw new Error('验收工作树不干净或版本不一致。');
  return { tree, merged };
}

async function main() {
  const { bundle, base, head, acceptance = [], 'config-only': configOnly } = values;
  if (
    !bundle ||
    !path.isAbsolute(bundle) ||
    !shaPattern.test(base ?? '') ||
    !shaPattern.test(head ?? '') ||
    base === head
  )
    throw new Error('请输入本机 Git 包的绝对路径、main 提交和最终提交的完整编号。');
  if (acceptance.some((name) => !/^[a-z][a-z0-9:.-]*$/u.test(name)))
    throw new Error('业务验收只接受仓库内已登记的 pnpm 命令。');
  const vm = verifyMachine();
  if ((await readFile('/etc/cert-board-acceptance-vm', 'utf8')).trim() !== 'cert-board-acceptance')
    throw new Error('请使用 cert-board 的专用验收虚拟机。');
  if (process.versions.node !== '24.22.2' || readCommand('pnpm', ['--version']) !== '9.15.9')
    throw new Error('请使用 Node 24.22.2 和 pnpm 9.15.9。');
  if (
    readCommand('docker', ['ps', '-aq', '--filter', 'label=com.docker.compose.project=cert-board'])
  )
    throw new Error('验收虚拟机内发现上次的开发容器，请使用干净的虚拟机快照。');
  const directory = await mkdtemp(path.join(homedir(), 'cert-board-acceptance-'));
  const root = path.join(directory, 'source');
  await mkdir(root);
  const { tree, merged } = testTree(root, bundle, base, head);
  const report = {
    status: 'running',
    base,
    head,
    mergeTree: tree,
    testCommit: merged,
    vm,
    startedAt: new Date().toISOString(),
    steps: [],
  };
  const receipt = path.join(directory, 'report.json');
  const save = () => writeFile(receipt, JSON.stringify(report, null, 2), { mode: 0o600 });
  const step = async (name, command, args) => {
    const log = await open(path.join(directory, `${name}.log`), 'wx', 0o600);
    const started = Date.now();
    let code;
    try {
      const child = spawn(command, args, {
        cwd: root,
        stdio: ['ignore', log.fd, log.fd],
        shell: false,
      });
      code = await new Promise((resolve) => {
        child.once('error', () => resolve(1));
        child.once('close', (exit) => resolve(exit ?? 1));
      });
    } finally {
      await log.close();
    }
    report.steps.push({ name, exitCode: code, seconds: Math.round((Date.now() - started) / 1000) });
    await save();
    console.log(`${name} ${code === 0 ? '通过' : '失败'}。`);
    if (code !== 0) throw new Error(`${name} 未通过。详细日志保存在虚拟机。`);
  };
  const pnpm = (name, ...args) => step(name, 'pnpm', args);
  console.log(`虚拟机验收报告 ${receipt}`);
  await save();
  try {
    const changed = readCommand('git', ['diff', '--name-only', '-z', base, merged], root)
      .split('\0')
      .filter(Boolean);
    if (configOnly) {
      if (
        changed.some(
          (file) =>
            !/^(?:AGENTS\.md$|\.github\/|docs\/|scripts\/(?:acceptance-vm\.mjs|egress\.test\.mjs)$)/u.test(
              file,
            ),
        )
      )
        throw new Error('配置专项仅用于验收制度、文档和虚拟机验收脚本。');
      if (readCommand('git', ['ls-files', '--', '.github/workflows/'], root))
        throw new Error('虚拟机配置验收发现仍有 GitHub Actions 工作流。');
      report.steps.push({ name: 'workflow-retired', exitCode: 0, seconds: 0 });
      await save();
    }
    await pnpm('install', 'install', '--frozen-lockfile');
    await pnpm('lint', 'lint');
    await pnpm('typecheck', 'typecheck');
    await pnpm('unit', 'test');
    await pnpm('build', 'build');
    await pnpm('python', 'test:py');
    await pnpm('agent-eval', 'eval:agent');
    await pnpm('env-init', 'env:init');
    try {
      await pnpm('dev-up', 'dev:up');
      await pnpm('integration', 'test:int');
      await pnpm('browser', 'test:e2e');
      for (const [index, name] of acceptance.entries()) await pnpm(`pr-${index + 1}`, name);
      if (!configOnly) {
        await configureModels(root, values['model-profile']);
        await pnpm('walkthrough', 'walkthrough:real');
      }
    } finally {
      await pnpm('dev-down', 'dev:down');
    }
    await step('secrets', 'docker', [
      'run',
      '--rm',
      '--network',
      'none',
      '-v',
      `${root}:/repo:ro`,
      'zricethezav/gitleaks:v8.24.3',
      'git',
      '/repo',
      '--redact',
      '--no-banner',
    ]);
    if (readCommand('git', ['status', '--porcelain'], root))
      throw new Error('测试改变了验收工作树。');
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    throw error;
  } finally {
    report.completedAt = new Date().toISOString();
    await save();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : '虚拟机验收未完成。');
  process.exitCode = 1;
});
