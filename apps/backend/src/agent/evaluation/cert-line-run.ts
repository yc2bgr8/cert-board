import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ChatRequest, GatewayResponse } from '@cert-board/shared';
import type { EvalCase, EvalTouchpoint } from '../../../../../evals/cert-line/contracts.js';
import { score, validate } from '../../../../../evals/cert-line/score.js';
import { nanoToUsd } from '../../budget/meter.js';

const referencePrompts = {
  cx: ['cx_fields', '82ced8f04859c841e95225e0c7fcb8d16eb695a62477bfee1a6df0dccb21f60b'],
  dx: ['dx_split', '67866a9afc42963d18357858ced662a7742114750c29e23d49b5acb009cc36eb'],
  dr: ['dr_draft', 'ca12afac99b735b30f2381b73d1f5d2dfd5b5862301610319f1b90e0fb957852'],
  rg: ['rg_summary', 'c9ee608186f5557ed0ba84dddf519d244b17cf048a137a501d0fc6097e04f63f'],
  pd: ['pd_candidates', '40e9b411e71ba9778985dc23949cabc70e0eb6379f100ee842d128599a6fae75'],
  rp: ['rp_paragraph', '1b4f469a866a94a2404099455a1f0a9720fbf08ee3605b1f800dd1d633f35ed3'],
} as const;
export const certLinePromptVersions = Object.values(referencePrompts).map(([id]) => `${id} v0.1`);
export const certLinePromptHashes = Object.fromEntries(Object.values(referencePrompts));
export const certLineOutputTokens = 4000;
const temperature = 0.2;
const maxAttempts = 3;
type Prompt = { system: string; user: string };

export async function prepareCertLineRequests(cases: readonly EvalCase[], model: string) {
  const prompts = new Map<EvalTouchpoint, Prompt>();
  for (const touchpoint of Object.keys(referencePrompts) as EvalTouchpoint[]) {
    const [name, digest] = referencePrompts[touchpoint];
    const source = await readFile(
      new URL(`../../../../../evals/cert-line/prompts/${name}.v0.1.md`, import.meta.url),
    );
    if (createHash('sha256').update(source).digest('hex') !== digest)
      throw new Error('CERT_LINE_PROMPT_CHANGED');
    const sections = /^---\n[\s\S]*?\n---\n# system\n([\s\S]*?)\n# user\n([\s\S]*)$/u.exec(
      source.toString('utf8'),
    );
    if (!sections?.[1]?.trim() || !sections[2]?.trim()) throw new Error('CERT_LINE_PROMPT_INVALID');
    prompts.set(touchpoint, { system: sections[1].trim(), user: sections[2].trim() });
  }
  return cases.map((item): ChatRequest => {
    const { system, user } = prompts.get(item.touchpoint)!;
    return {
      model,
      tool_choice: 'none',
      temperature,
      max_tokens: certLineOutputTokens,
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: user.replace(
            /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/gu,
            (_match, key: string) => {
              if (!Object.hasOwn(item.vars, key))
                throw new Error('CERT_LINE_PROMPT_VARIABLE_MISSING');
              return item.vars[key]!;
            },
          ),
        },
      ],
    };
  });
}

export async function evaluateCertLineCase(
  item: EvalCase,
  request: ChatRequest,
  complete: (request: ChatRequest, requestKey: string) => Promise<GatewayResponse>,
  beforeRequest: (requestKey: string) => Promise<void>,
) {
  let inputTokens = 0;
  let outputTokens = 0;
  let measuredTokenAttempts = 0;
  let settled = 0n;
  let unpricedAttempts = 0;
  for (let attempts = 1; attempts <= maxAttempts; attempts++) {
    const requestKey = randomUUID();
    await beforeRequest(requestKey);
    const { message, usage } = await complete(request, requestKey);
    inputTokens += usage?.inputTokens ?? 0;
    outputTokens += usage?.outputTokens ?? 0;
    if (usage) measuredTokenAttempts++;
    if (usage?.costNano == null) unpricedAttempts++;
    else settled += BigInt(usage.costNano);
    const settledUsd = nanoToUsd(settled);
    const base = {
      id: item.id,
      touchpoint: item.touchpoint,
      attempts,
      inputTokens: measuredTokenAttempts === attempts ? inputTokens : null,
      outputTokens: measuredTokenAttempts === attempts ? outputTokens : null,
      settledUsd,
      unpricedAttempts,
      costUsd: unpricedAttempts ? null : Number(settledUsd),
    };

    let parsed: unknown;
    try {
      if (message.tool_calls?.length) throw new Error('CERT_LINE_TOOL_CALL');
      const text = message.content?.trim() ?? '';
      parsed = JSON.parse(text.replace(/^\x60{3}(?:json)?\s+|\s*\x60{3}$/giu, '')) as unknown;
    } catch {
      // 只重试已有计量的 JSON 格式错误。工具回执、未结算答复或派发异常不重发。
      if (!message.tool_calls?.length && !unpricedAttempts && attempts < maxAttempts) continue;
      return { ...base, valid: false, pass: false, reasonCode: 'invalid_json' as const };
    }
    const validated = validate(item, parsed);
    if (!validated.ok)
      return { ...base, valid: false, pass: false, reasonCode: 'validation_failed' as const };
    const { pass } = score(item, validated.value);
    return { ...base, valid: true, pass, reasonCode: pass ? null : ('score_failed' as const) };
  }
  throw new Error('CERT_LINE_ATTEMPTS_INVALID');
}

export type CertLineResult = Awaited<ReturnType<typeof evaluateCertLineCase>>;
