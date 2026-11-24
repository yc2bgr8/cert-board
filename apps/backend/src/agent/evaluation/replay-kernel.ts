import { z } from 'zod';
import { documentCitationSchema, officialLookupInputSchema } from '@cert-board/shared';
import { runAgentKernel, type AgentKernelOptions } from '../pi/index.js';
import {
  archivedOfficialReplay,
  redactReplayInput,
  replayEvidenceValidity,
  replayScopeSchema,
  type ReplayScope,
} from './replay.js';

const page = z.strictObject({
  documentId: z.uuid(),
  version: z.number().int().positive(),
  page: z.number().int().positive(),
  availableOn: z.iso.date(),
  text: z.string().min(1).max(12_000),
});
const pageAddress = page.pick({ documentId: true, version: true, page: true });
const response = z.object({ evidence: z.array(documentCitationSchema).max(40) });
const replayCase = z.strictObject({
  scope: replayScopeSchema,
  prompt: z.string().min(1).max(12_000),
  pages: z.array(page).max(80),
});

const key = ({ documentId, version, page }: z.infer<typeof pageAddress>) =>
  `${documentId}:${version}:${page}`;
function redactResult(
  value: z.infer<ReturnType<typeof z.json>>,
  scope: ReplayScope,
): z.infer<ReturnType<typeof z.json>> {
  if (typeof value === 'string') return redactReplayInput(value, scope);
  if (Array.isArray(value)) return value.map((item) => redactResult(item, scope));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([setting, item]) => [setting, redactResult(item, scope)]),
    );
  return value;
}

function includesHiddenIdentity(
  value: z.infer<ReturnType<typeof z.json>>,
  scope: ReplayScope,
): boolean {
  if (typeof value === 'string') return redactReplayInput(value, scope) !== value;
  if (Array.isArray(value)) return value.some((item) => includesHiddenIdentity(item, scope));
  return (
    !!value &&
    typeof value === 'object' &&
    Object.entries(value).some(
      ([setting, item]) =>
        includesHiddenIdentity(setting, scope) || includesHiddenIdentity(item, scope),
    )
  );
}

export async function runRecordedReplay(
  input: unknown,
  archives: ReadonlyMap<string, { payload: unknown }>,
  model: Pick<AgentKernelOptions, 'model' | 'complete' | 'signal'>,
) {
  const { scope, prompt, pages } = replayCase.parse(input);
  const indexed = new Map(pages.map((item) => [key(item), item]));
  if (indexed.size !== pages.length) throw new Error('回放资料页编号重复。');
  const available = pages.filter((item) => item.availableOn <= scope.asOf);
  const reads = new Map<string, string>();
  const kernel = await runAgentKernel({
    ...model,
    history: [],
    systemPrompt:
      '执行给定的器械认证回放题。资料仅来自工具的录制来源。先用 doc_search 找资料，再用 doc_read 读取引用。回复用 JSON，evidence 写实际读取的引语，并包括 documentId、version、page 和 quote。资料不足时将结论留待核实。',
    messages: [{ role: 'user', content: redactReplayInput(prompt, scope) }],
    tools: [
      {
        name: 'doc_search',
        description: '列本题可访问的录制资料位置，之后用 doc_read 读取。',
        parameters: { type: 'object', additionalProperties: false },
        execute: async () => ({
          data: available.map(({ documentId, version, page }) => ({ documentId, version, page })),
        }),
      },
      {
        name: 'doc_read',
        description: '按 documentId、version 和 page 读截至日期可用的录制页。',
        parameters: z.toJSONSchema(pageAddress, { io: 'input' }),
        execute: async (value) => {
          const address = pageAddress.parse(value);
          const item = indexed.get(key(address));
          if (!item || item.availableOn > scope.asOf) return { data: { status: 'unavailable' } };
          const text = redactReplayInput(item.text, scope);
          reads.set(key(address), text);
          return { data: { ...address, text } };
        },
      },
      {
        name: 'official_lookup',
        description: '按公开编号查本题已有的官方回放记录，使用本题截至日期。',
        parameters: z.toJSONSchema(officialLookupInputSchema, {
          io: 'input',
          unrepresentable: 'any',
        }),
        execute: async (value) => ({
          data: redactResult(
            z
              .json()
              .parse(
                archivedOfficialReplay(officialLookupInputSchema.parse(value), scope, archives),
              ),
            scope,
          ),
        }),
      },
    ],
  });
  const text = kernel.messages.findLast(
    (message) => message.role === 'assistant' && message.content,
  )?.content;
  let submitted: z.infer<typeof response> | undefined;
  let leakedIdentity = false;
  if (kernel.status === 'completed' && typeof text === 'string') {
    try {
      const payload = z.json().parse(JSON.parse(text));
      const parsed = response.safeParse(payload);
      if (parsed.success) {
        submitted = parsed.data;
        leakedIdentity = includesHiddenIdentity(payload, scope);
      }
    } catch {
      // 回放报告只记录固定的失败原因。
    }
  }
  if (!submitted) return { valid: false, findings: ['response_invalid'], usage: kernel.usage };
  const validity = replayEvidenceValidity(
    scope,
    submitted.evidence.map((ref) => ({
      quote: ref.quote,
      availableOn: indexed.get(key(ref))?.availableOn ?? null,
    })),
  );
  const unread = submitted.evidence.some((ref) => !reads.get(key(ref))?.includes(ref.quote));
  const altered = submitted.evidence.some(
    (ref) =>
      reads.get(key(ref))?.includes(ref.quote) && !indexed.get(key(ref))?.text.includes(ref.quote),
  );
  return {
    valid: validity.valid && !unread && !altered && !leakedIdentity,
    findings: [
      ...validity.findings,
      ...(unread ? ['unread_evidence'] : []),
      ...(altered ? ['quote_mismatch'] : []),
      ...(leakedIdentity ? ['target_identity_in_response'] : []),
    ],
    usage: kernel.usage,
  };
}
