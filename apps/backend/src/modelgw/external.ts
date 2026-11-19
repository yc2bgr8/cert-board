import {
  externalModelReferenceSchema,
  nanoAmountSchema,
  type BudgetPrices,
} from '@cert-board/shared';
import { z } from 'zod';

export type ExternalModelMessage = { role: 'user' | 'assistant'; content: string };

export type ExternalModelProfile = {
  id: string;
  label: string;
  upstreamModel: string;
  providers: string[];
  prices: BudgetPrices;
  maxOutputTokens: number;
  searchReserveNano: bigint;
};

export function buildExternalModelRequest(
  profile: ExternalModelProfile,
  messages: ExternalModelMessage[],
  search: boolean,
) {
  return {
    model: profile.upstreamModel,
    messages,
    max_tokens: profile.maxOutputTokens,
    stream: false as const,
    provider: {
      only: profile.providers,
      require_parameters: true as const,
      allow_fallbacks: false as const,
      data_collection: 'deny' as const,
      zdr: true as const,
      max_price: {
        prompt: Number(profile.prices.inputUsdPerMillion),
        completion: Number(profile.prices.outputUsdPerMillion),
      },
    },
    ...(search
      ? {
          tools: [
            {
              type: 'openrouter:web_search' as const,
              parameters: { engine: 'native' as const, max_uses: 1, max_total_results: 5 },
            },
          ],
        }
      : {}),
  };
}

export type ExternalModelRequest = ReturnType<typeof buildExternalModelRequest>;

export type ExternalModelRuntime = {
  kind: 'fixture';
  profiles: readonly ExternalModelProfile[];
  monthlyLimitNano?: bigint;
  checkLocally(messages: readonly ExternalModelMessage[]): Promise<boolean>;
  send(request: ExternalModelRequest): Promise<unknown>;
};

const gatewayArchive = z.record(z.string(), z.unknown());
const displayableContent = z
  .string()
  .min(1)
  .max(32000)
  .refine((content) => content.trim().length > 0 && !content.includes('\0'));

export async function callExternalModel(
  runtime: ExternalModelRuntime,
  request: ExternalModelRequest,
) {
  const archive = gatewayArchive.safeParse(await runtime.send(request));
  const raw =
    archive.success && Buffer.byteLength(JSON.stringify(archive.data), 'utf8') <= 256 * 1024
      ? archive.data
      : null;
  const cost = nanoAmountSchema.safeParse(archive.success ? archive.data.costNano : undefined);
  if (!cost.success) return { kind: 'unknown' as const, raw };
  const answer = displayableContent.safeParse(raw?.content);
  const citations = Array.isArray(raw?.citations)
    ? raw.citations.slice(0, 20).flatMap((value) => {
        const parsed = externalModelReferenceSchema.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
  return {
    kind: 'settled' as const,
    content: answer.data ?? null,
    citations,
    costNano: cost.data,
    raw,
  };
}
