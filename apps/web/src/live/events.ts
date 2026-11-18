import {
  conversationPublicEventSchema,
  type ConversationPublicEvent,
  type PermissionMode,
} from '@cert-board/shared';

export type LiveMessage = {
  id: string;
  seq: number;
  runId: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  messageId?: string;
  steeringId?: string;
};
export type LiveToolStep = {
  id: string;
  runId: string;
  callId?: string;
  name?: string;
  summary: string;
  status: 'running' | 'completed' | 'failed' | 'awaiting_approval';
  seq: number;
  createdAt: string;
};
export type LivePlan = {
  steps: { title: string; status: 'pending' | 'running' | 'completed' }[];
  progress: string;
};
export type LiveQuestion = {
  runId: string;
  questionId: string | null;
  question: string;
  options: string[];
};
export type LiveRun = {
  id: string;
  status:
    'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'stopped' | 'budget_exhausted';
  startedAt: string;
  updatedAt: string;
  tools: LiveToolStep[];
  plan: LivePlan | null;
  approvalId: string | null;
  question: LiveQuestion | null;
  reviewId: string | null;
  pendingSteeringCount: number;
  summary: string;
  workspaceChange: { summary: string; workspaceVersion: string | null; seq: number } | null;
};
export type ConversationStreamState = {
  conversationId: string | null;
  lastSeq: number;
  messages: LiveMessage[];
  runs: Record<string, LiveRun>;
  runOrder: string[];
  currentRunId: string | null;
  permissionMode: PermissionMode | null;
  permissionVersion: number | null;
  textCharacters: number;
};
export const conversationEventNames = conversationPublicEventSchema.options.map(
  (schema) => schema.shape.type.value,
);
export function initialConversationState(conversationId: string | null): ConversationStreamState {
  return {
    conversationId,
    lastSeq: 0,
    messages: [],
    runs: {},
    runOrder: [],
    currentRunId: null,
    permissionMode: null,
    permissionVersion: null,
    textCharacters: 0,
  };
}
export class StreamProtocolError extends Error {
  constructor() {
    super('对话记录格式或顺序未能确认，请重新连接以完整读取。');
    this.name = 'StreamProtocolError';
  }
}
export function parseConversationEvent(data: string, eventName: string, lastEventId: string) {
  let event: ConversationPublicEvent;
  try {
    event = conversationPublicEventSchema.parse(JSON.parse(data));
  } catch {
    throw new StreamProtocolError();
  }
  if (event.type !== eventName || String(event.seq) !== lastEventId)
    throw new StreamProtocolError();
  return event;
}
export function reduceConversationEvent(
  state: ConversationStreamState,
  event: ConversationPublicEvent,
): ConversationStreamState {
  if (event.conversationId !== state.conversationId) throw new StreamProtocolError();
  if (event.seq <= state.lastSeq) return state;
  if (
    event.seq !== state.lastSeq + 1 ||
    event.seq > 20000 ||
    state.messages.length > 5000 ||
    state.runOrder.length > 1000
  )
    throw new StreamProtocolError();
  const prior = state.runs[event.runId];
  const run: LiveRun = prior
    ? { ...prior, tools: [...prior.tools], updatedAt: event.createdAt }
    : {
        id: event.runId,
        status: 'queued',
        startedAt: event.createdAt,
        updatedAt: event.createdAt,
        tools: [],
        plan: null,
        approvalId: null,
        question: null,
        reviewId: null,
        pendingSteeringCount: 0,
        summary: '等待执行。',
        workspaceChange: null,
      };
  const next: ConversationStreamState = {
    ...state,
    lastSeq: event.seq,
    runs: { ...state.runs, [event.runId]: run },
    runOrder: prior ? state.runOrder : [...state.runOrder, event.runId],
    currentRunId: prior ? state.currentRunId : event.runId,
  };
  switch (event.type) {
    case 'user_message':
    case 'assistant_message': {
      const p = event.payload;
      const messageId = p.messageId;
      const steeringId = 'steeringId' in p ? p.steeringId : undefined;
      const key = messageId ?? steeringId ?? event.id;
      if (!state.messages.some((message) => message.id === key)) {
        next.textCharacters += p.content.length;
        if (next.textCharacters > 2000000) throw new StreamProtocolError();
        next.messages = [
          ...state.messages,
          {
            id: key,
            seq: event.seq,
            runId: event.runId,
            role: event.type === 'user_message' ? 'user' : 'assistant',
            text: p.content,
            createdAt: event.createdAt,
            ...(messageId ? { messageId } : {}),
            ...(steeringId ? { steeringId } : {}),
          },
        ];
      }
      break;
    }
    case 'model_started':
      run.status = 'running';
      run.summary = event.payload.summary;
      break;
    case 'tool_started':
    case 'tool_completed':
    case 'tool_failed': {
      const p = event.payload;
      const key = p.callId ?? event.id;
      const step: LiveToolStep = {
        id: key,
        runId: event.runId,
        summary: p.summary,
        status: p.awaitingApproval
          ? 'awaiting_approval'
          : event.type === 'tool_started'
            ? 'running'
            : event.type === 'tool_failed'
              ? 'failed'
              : 'completed',
        seq: event.seq,
        createdAt: event.createdAt,
        ...(p.callId ? { callId: p.callId } : {}),
        ...(p.name ? { name: p.name } : {}),
      };
      const index = run.tools.findIndex((tool) => tool.id === key);
      if (index === -1) run.tools.push(step);
      else run.tools[index] = step;
      if (run.tools.length > 1000) throw new StreamProtocolError();
      if (p.awaitingApproval) run.status = 'waiting';
      run.summary = p.summary;
      break;
    }
    case 'plan_updated':
      run.plan = event.payload;
      run.summary = event.payload.progress;
      break;
    case 'question':
      run.question = {
        runId: event.runId,
        questionId: event.payload.questionId ?? null,
        question: event.payload.question,
        options: event.payload.options,
      };
      run.status = 'waiting';
      run.summary = '等待发起人回答问题。';
      break;
    case 'question_answered':
      run.question = null;
      run.status = 'completed';
      run.summary = event.payload.summary;
      if (event.payload.newRunId) next.currentRunId = event.payload.newRunId;
      break;
    case 'approval_requested':
      run.approvalId = event.payload.approvalId ?? null;
      run.status = 'waiting';
      run.summary = event.payload.summary;
      break;
    case 'approval_resolved':
      if (event.payload.approvalId && event.payload.approvalId === run.approvalId) {
        const index = run.tools.findLastIndex((tool) => tool.status === 'awaiting_approval');
        if (index >= 0) {
          const step = run.tools[index]!;
          run.tools[index] = {
            ...step,
            status: event.payload.executed === true ? 'completed' : 'failed',
            summary:
              event.payload.executed === true
                ? '已按批准执行。'
                : event.payload.executed === false
                  ? '本次批准操作未执行，请核对处理结果。'
                  : '本次操作执行结果尚未确认，请核对处理记录。',
          };
        }
        run.approvalId = null;
        run.summary = event.payload.summary;
      }
      break;
    case 'review_submitted':
      run.reviewId = event.payload.reviewId ?? null;
      run.status = 'waiting';
      run.summary = event.payload.summary;
      break;
    case 'run_status': {
      const p = event.payload;
      run.summary =
        p.status === 'budget_exhausted' && p.summary === '运行状态已更新。'
          ? '预算或用量计量限制已停止本轮，请先核对用量后继续。'
          : p.summary;
      if (p.status) run.status = p.status;
      if (p.reviewId) run.reviewId = p.reviewId;
      if (p.approvalId) run.approvalId = p.approvalId;
      if (p.pendingSteeringCount !== undefined) run.pendingSteeringCount = p.pendingSteeringCount;
      if (p.status && ['completed', 'failed', 'stopped', 'budget_exhausted'].includes(p.status)) {
        run.question = null;
        run.approvalId = null;
        run.tools = run.tools.map((tool) =>
          tool.status === 'running' || tool.status === 'awaiting_approval'
            ? {
                ...tool,
                status: 'failed',
                summary: '运行已结束，请核对该步骤的中途结果；未自动继续执行。',
              }
            : tool,
        );
      }
      break;
    }
    case 'permission_changed':
      if (
        event.payload.permissionVersion !== undefined &&
        (state.permissionVersion === null ||
          event.payload.permissionVersion >= state.permissionVersion)
      ) {
        next.permissionVersion = event.payload.permissionVersion;
        next.permissionMode = event.payload.permissionMode ?? state.permissionMode;
      }
      break;
    case 'changes':
      run.workspaceChange = {
        summary: event.payload.summary,
        workspaceVersion: event.payload.workspaceVersion ?? null,
        seq: event.seq,
      };
      break;
    case 'progress':
      run.summary = event.payload.summary;
      break;
  }
  return next;
}
