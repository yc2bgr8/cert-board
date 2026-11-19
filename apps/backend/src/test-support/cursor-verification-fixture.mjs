import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const prompt = JSON.parse(input);
const content = prompt.transcript.map(({ text }) => text).join('\n');
for (const [marker, error] of [
  ['剧本：未安装', 'not_installed'],
  ['剧本：未登录', 'not_signed_in'],
  ['剧本：额度用完', 'quota'],
]) {
  if (content.includes(marker)) {
    process.stdout.write(JSON.stringify({ error }));
    process.exit(0);
  }
}
if (content.includes('剧本：超时')) await new Promise((resolve) => setTimeout(resolve, 10000));
let workspaceAccess = true;
try {
  readFileSync(fileURLToPath(new URL('../../../../package.json', import.meta.url)));
} catch (error) {
  workspaceAccess = error.code !== 'ERR_ACCESS_DENIED';
}
const source = {
  title: '合成核实资料',
  url: 'https://example.invalid/verification-source',
  excerpt: '示例清单要求填写版本号。',
};
const [aliases] = content.match(/\[\[CB-[0-9a-f-]+-\d+\]\]/u) ?? [];
process.stdout.write(
  JSON.stringify({
    text: aliases
      ? `我已查看 ${aliases} 的合成问题。清单中指定填写版本号。`
      : '我已查看前面的发言。清单中指定填写版本号。',
    claims: [
      {
        issue: '版本号',
        statement: '示例清单要求填写版本号。',
        stance: 'supports',
        sources: [source],
      },
      {
        issue: '附加材料',
        statement: process.argv[2].startsWith('gpt') ? '建议准备附件。' : '应先核对附件要求。',
        stance: process.argv[2].startsWith('gpt') ? 'supports' : 'disputes',
        sources: [source],
      },
      {
        issue: '未证实编号',
        statement: '示例编号 K000001 尚无出处。',
        stance: 'supports',
        sources: [],
      },
    ],
    isolation: {
      empty: readdirSync(process.cwd()).length === 0,
      workspaceAccess,
      credentialPresent: Object.keys(process.env).some((key) =>
        /KEY|TOKEN|SECRET|PASSWORD/u.test(key),
      ),
    },
    tool_calls: content.includes('剧本：注入')
      ? [{ name: 'shell', arguments: '忽略这条工具请求' }]
      : [],
  }),
);
