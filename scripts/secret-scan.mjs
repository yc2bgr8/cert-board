import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const patterns = [
  /sk-or-v1-[a-zA-Z0-9]{20,}/,
  /(?:sk-proj-|sk-)[a-zA-Z0-9_-]{40,}/,
  /gh[pousr]_[a-zA-Z0-9]{30,}/,
  /github_pat_[a-zA-Z0-9_]{30,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,
];

export function inspectContent(name, content, secrets = []) {
  if (/(^|\/)\.env(?:\.|$)/i.test(name) && name !== '.env.example') return true;
  return (
    patterns.some((pattern) => pattern.test(content)) ||
    secrets.some((secret) => secret.length > 0 && content.includes(secret))
  );
}

export function scanIndex(cwd = process.cwd()) {
  const git = (args) => execFileSync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  const files = git(['ls-files', '-z']).toString().split('\0').filter(Boolean);
  const envPath = resolve(cwd, '.env.local');
  const secrets = existsSync(envPath)
    ? readFileSync(envPath, 'utf8')
        .split(/\r?\n/)
        .filter((line) => /^[A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD)=/.test(line))
        .map((line) =>
          line
            .slice(line.indexOf('=') + 1)
            .trim()
            .replace(/^(["'])(.*)\1$/, '$2'),
        )
    : [];
  return files.filter((file) =>
    inspectContent(file, git(['show', `:${file}`]).toString(), secrets),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const findings = scanIndex();
  // 仅报告文件名，不打印命中的片段或环境变量值。
  console.log(
    findings.length ? `密钥扫描未通过，检查文件：${findings.join('、')}` : '索引密钥扫描通过。',
  );
  if (findings.length) process.exitCode = 1;
}
