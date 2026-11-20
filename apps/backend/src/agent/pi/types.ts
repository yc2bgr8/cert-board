import type { ChatRequest, GatewayResponse, RuntimeModelConfig } from '@cert-board/shared';

export type KernelMessage = ChatRequest['messages'][number];
export type KernelUserMessage = Extract<KernelMessage, { role: 'user' }>;
export type KernelUsage = { steps: number; totalTokens: number; costNano: string | null };
export type KernelTerminal =
  'review' | 'proposal' | 'approval' | 'question' | 'verification' | 'goal_wait';
export type KernelTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    input: unknown,
    context: { callId: string; signal: AbortSignal },
  ): Promise<{
    data: unknown;
    terminal?: KernelTerminal;
  }>;
};
export type KernelEvent =
  | { type: 'model_started'; requestKey: string }
  | { type: 'message'; message: KernelMessage }
  | { type: 'tool_started'; callId: string; name: string }
  | { type: 'tool_completed'; callId: string; name: string; data: unknown; isError: boolean }
  | { type: 'waiting'; reason: KernelTerminal };
export type AgentKernelOptions = {
  systemPrompt: string;
  history: KernelMessage[];
  messages: KernelMessage[];
  continuation?: { initialUsage: KernelUsage };
  takeSteering?(signal: AbortSignal): Promise<readonly KernelUserMessage[]>;
  refreshCatalog?(signal: AbortSignal): Promise<{ names: readonly string[]; modeNote?: string }>;
  model: RuntimeModelConfig;
  tools: KernelTool[];
  complete(
    request: ChatRequest,
    context: { requestKey: string; signal: AbortSignal },
  ): Promise<GatewayResponse>;
  signal: AbortSignal;
  onEvent?(event: KernelEvent): Promise<void> | void;
  onTurn?(usage: KernelUsage): Promise<void> | void;
};
export type AgentKernelResult = {
  status:
    | 'completed'
    | 'waiting_review'
    | 'waiting_proposal'
    | 'waiting_approval'
    | 'waiting_question'
    | 'waiting_verification'
    | 'waiting_goal_wait'
    | 'stopped'
    | 'failed';
  reasonCode?: string;
  messages: KernelMessage[];
  usage: KernelUsage;
};

export class KernelToolError extends Error {
  readonly code: string;
  readonly recoverable: boolean;
  constructor(code: string, message: string, options: { recoverable: boolean }) {
    super(message);
    this.name = 'KernelToolError';
    this.code = /^[A-Z][A-Z0-9_]{1,79}$/.test(code) ? code : 'TOOL_FAILED';
    this.recoverable = options.recoverable;
  }
}
