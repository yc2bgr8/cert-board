import { z } from 'zod';
import {
  verificationChannelStatusSchema,
  verificationModelSchema,
  verificationReplySchema,
  type VerificationMessage,
  type VerificationModel,
  type VerificationReply,
  type VerificationRoom,
} from '@cert-board/shared';

export const verificationCatalog = verificationModelSchema.array().parse([
  { id: 'gpt-flagship', label: 'GPT', family: 'openai', channel: 'cursor' },
  { id: 'claude-flagship', label: 'Claude', family: 'anthropic', channel: 'cursor' },
]);

export const moderatorTurnSchema = z
  .object({
    text: z.string().trim().min(1).max(2000),
    call: z.string().nullable(),
    finish: z.boolean(),
  })
  .strict();
export const moderatorSummarySchema = z
  .object({
    summary: z.string().trim().min(1).max(2000),
    selections: z.record(z.string().max(160), z.string().trim().min(1).max(1600)),
  })
  .strict();
export const cursorCallStateSchema = z.enum([
  'not_installed',
  'not_signed_in',
  'privacy_unverified',
  'quota',
  'timeout',
  'failed',
]);
export type CursorCallState = z.infer<typeof cursorCallStateSchema>;
export type VerificationChannelStatus = z.infer<typeof verificationChannelStatusSchema>;
export type ModeratorContext = {
  room: VerificationRoom;
  ownerId: string;
  transcript: readonly VerificationMessage[];
  eligible: readonly VerificationModel[];
  attempts: Readonly<Record<string, number>>;
  activeHuman: VerificationMessage | null;
};
export type VerificationPrompt = {
  instructions: string;
  transcript: Array<{ role: string; text: string }>;
};

export class VerificationChannelError extends Error {
  constructor(readonly code: CursorCallState) {
    super(code);
    this.name = 'VerificationChannelError';
  }
}

export type VerificationRuntime = {
  kind: 'fixture' | 'cursor';
  catalog: readonly VerificationModel[];
  status: VerificationChannelStatus;
  moderate(context: ModeratorContext): Promise<unknown>;
  summarize(context: ModeratorContext): Promise<unknown>;
  compact(
    posts: readonly VerificationMessage[],
    scope: Pick<ModeratorContext, 'room' | 'ownerId'>,
  ): Promise<string>;
  send(model: VerificationModel, prompt: VerificationPrompt): Promise<unknown>;
};

export function verificationReply(value: unknown): {
  raw: Record<string, unknown>;
  reply: VerificationReply;
} {
  const archive = z.record(z.string(), z.unknown()).safeParse(value);
  if (!archive.success) throw new VerificationChannelError('failed');
  const reply = verificationReplySchema.safeParse({
    text: archive.data.text,
    claims: archive.data.claims,
  });
  if (!reply.success) throw new VerificationChannelError('failed');
  return { raw: archive.data, reply: reply.data };
}

export const channelFailureText: Record<CursorCallState, string> = {
  not_installed: '开发机未安装 Cursor 命令行。',
  not_signed_in: 'Cursor 命令行尚未登录。',
  privacy_unverified: 'Cursor 隐私模式尚未确认。',
  quota: 'Cursor 订阅额度已用完。',
  timeout: 'Cursor 等待回复超时。',
  failed: 'Cursor 没有返回可读取的回答。',
};
