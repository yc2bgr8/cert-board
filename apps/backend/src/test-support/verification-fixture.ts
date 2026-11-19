import { fileURLToPath } from 'node:url';
import { runCursorFixture } from '../external-model/cursor-channel.js';
import {
  verificationCatalog,
  type VerificationRuntime,
  type VerificationPrompt,
} from '../external-model/verification-runtime.js';

export function verificationFixture() {
  if (process.env.NODE_ENV !== 'test') throw new Error('VERIFICATION_FIXTURE_TEST_ONLY');
  const executable = fileURLToPath(new URL('./cursor-verification-fixture.mjs', import.meta.url));
  const requests: { model: string; prompt: VerificationPrompt }[] = [];
  const runtime: VerificationRuntime = {
    kind: 'fixture',
    status: 'fixture',
    catalog: verificationCatalog,
    async moderate({ eligible, attempts, activeHuman }) {
      const next = [...eligible].sort(
        (left, right) => (attempts[left.id] ?? 0) - (attempts[right.id] ?? 0),
      )[0];
      return {
        text: next
          ? `@${next.label} 请核对上述问题并附上出处。`
          : activeHuman
            ? '已收到补充，请与出处一起核对。'
            : '已完成本轮交叉核实，开始整理。',
        call: activeHuman?.mention === 'host' ? null : (next?.id ?? null),
        finish: !next && !activeHuman,
      };
    },
    async summarize() {
      return {
        summary: '采用两家都有出处的意见。分歧和无出处事项继续核对。',
        selections: { 附加材料: '先回查示例清单中的附件要求。' },
      };
    },
    async compact(posts) {
      return posts
        .map(({ author, text }) => `${author}：${text.slice(0, 80)}`)
        .join('\n')
        .slice(-4000);
    },
    async send(model, prompt, beforeDispatch) {
      const preflight = prompt.transcript.map(({ text }) => text).join('\n');
      if (['未安装', '未登录', '额度用完'].some((label) => preflight.includes(`剧本：${label}`)))
        return runCursorFixture(executable, model.id, prompt, 3000);
      await beforeDispatch();
      requests.push({ model: model.id, prompt });
      return runCursorFixture(executable, model.id, prompt, 3000);
    },
  };
  return { runtime, requests };
}
