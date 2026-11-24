import { randomUUID } from 'node:crypto';
import { cxCases } from '../../../../../evals/r09/cx-cases.js';
import { AppError } from '../../api/errors.js';
import { nanoToUsd } from '../../budget/meter.js';
import type { ModelGateway } from '../../modelgw/service.js';
import { scoreCxExtraction, scoreWaterUse, waterUseExample } from './r09-extraction.js';

type EvaluationContext = Omit<Parameters<ModelGateway['complete']>[1], 'requestKey'>;

function parseAnswer(content: string | null | undefined): unknown {
  const text = content?.trim() ?? '';
  try {
    return JSON.parse(text.replace(/^\x60{3}(?:json)?\s+|\s*\x60{3}$/giu, '')) as unknown;
  } catch {
    return undefined;
  }
}

export async function runRealCx(
  gateway: ModelGateway,
  modelId: string,
  maxTokens: number,
  context: EvaluationContext,
) {
  let exact = 0;
  let grounded = 0;
  let cost = 0n;
  let unsettled = 0;
  const perCase = [];
  for (const example of cxCases) {
    const { source, text } = example;
    const output = await gateway.complete(
      {
        model: modelId,
        max_tokens: maxTokens,
        tool_choice: 'none',
        messages: [
          {
            role: 'system',
            content:
              '这是合成的申报字段抽取评测。只读输入资料并返回一个 JSON 对象。字段名为 model、pressure_range、software_version，每个字段含 value 和 quote。value 使用对应资料里的原样文字并包含单位；quote 是包含该值的真实原文。针对当前器械，忽略历史型号的干扰。原文无软件版本时省略软件字段。不要输出其他文字。',
          },
          { role: 'user', content: `${source}\n${text}` },
        ],
      },
      { ...context, requestKey: randomUUID() },
    );
    if (output.usage?.costNano == null) unsettled++;
    else cost += BigInt(output.usage.costNano);
    const score = scoreCxExtraction(example, parseAnswer(output.message.content));
    perCase.push({ id: example.id, ...score });
    exact += Number(score.exact);
    grounded += Number(score.quotesValid);
  }
  const contextCase = await gateway.complete(
    {
      model: modelId,
      max_tokens: maxTokens,
      tool_choice: 'none',
      messages: [
        {
          role: 'system',
          content:
            '这是两段合成试验文本。判定水温是否用于同一过程。只返回 JSON 对象，sameUse 为布尔，evidence 为分别含用途和水温的两条逐字原文。',
        },
        { role: 'user', content: waterUseExample.join('\n') },
      ],
    },
    { ...context, requestKey: randomUUID() },
  );
  if (contextCase.usage?.costNano == null) unsettled++;
  else cost += BigInt(contextCase.usage.costNano);
  const differentUses = scoreWaterUse(parseAnswer(contextCase.message.content));
  console.log(
    `CX 真实评测 ${JSON.stringify({
      cases: cxCases.length,
      exact,
      grounded,
      differentUses,
      settledUsd: nanoToUsd(cost),
      unsettled,
      perCase,
    })}`,
  );
  if (exact !== cxCases.length || !differentUses)
    throw new AppError(
      422,
      'R09_CX_REGRESSION',
      '合成字段抽取存在错误或原文欠缺，详细结果保留在本机。',
    );
}
