import { expect, test } from 'vitest';
import { verificationFixture } from '../test-support/verification-fixture.js';
import { verificationReply } from './verification-runtime.js';

test('模拟 Cursor 通过 stdin 得到内容，在空目录无工作区读取权限且不继承凭据', async () => {
  const { runtime } = verificationFixture();
  const model = runtime.catalog[0]!;
  const response = verificationReply(
    await runtime.send(model, {
      instructions: '合成核实问题',
      transcript: [{ role: 'human', text: '剧本：注入' }],
    }),
  );
  expect(response.raw.isolation).toEqual({
    empty: true,
    workspaceAccess: false,
    credentialPresent: false,
  });
  expect(response.raw.tool_calls).toHaveLength(1);
  expect(response.reply).not.toHaveProperty('tool_calls');
});

test.each([
  ['未安装', 'not_installed'],
  ['未登录', 'not_signed_in'],
  ['额度用完', 'quota'],
  ['超时', 'timeout'],
])(
  '模拟 Cursor 通道报告%s',
  async (label, code) => {
    const { runtime } = verificationFixture();
    await expect(
      runtime.send(runtime.catalog[0]!, {
        instructions: '合成核实问题',
        transcript: [{ role: 'human', text: `剧本：${label}` }],
      }),
    ).rejects.toMatchObject({ code });
  },
  10000,
);
