import {
  apiErrorSchema,
  authResponseSchema,
  loginInputSchema,
  projectListSchema,
  projectRecordSchema,
  goalListSchema,
  projectListOptionsSchema,
  projectIdSchema,
  conversationListQuerySchema,
  conversationPublicListSchema,
  conversationPublicRecordSchema,
  conversationCreateInputSchema,
  conversationCreateResultSchema,
  conversationMessageInputSchema,
  conversationWriteResultSchema,
  conversationAnswerInputSchema,
  conversationStopInputSchema,
  conversationStopResultSchema,
  conversationModeInputSchema,
  conversationModeResultSchema,
  toolApprovalViewSchema,
  toolApprovalDecisionInputSchema,
  toolApprovalDecisionResultSchema,
  type AuthResponse,
  type ConversationCreateInput,
  type ConversationMessageInput,
  type ConversationAnswerInput,
  type ConversationStopInput,
  type ConversationModeInput,
  type ToolApprovalDecisionInput,
} from '@cert-board/shared';

export type ConversationDetail = ReturnType<typeof conversationPublicRecordSchema.parse>;
export type ApprovalView = ReturnType<typeof toolApprovalViewSchema.parse>;
export type ProjectPage = ReturnType<typeof projectListSchema.parse>;
export type ConversationPage = ReturnType<typeof conversationPublicListSchema.parse>;
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
export const isStaleError = (error: unknown): error is ApiError =>
  error instanceof ApiError && error.status === 409;
export const errorMessage = (error: unknown) =>
  error instanceof ApiError ? error.message : '操作暂未完成，请稍后重试。';
export const createRequestKey = () => crypto.randomUUID();
let csrfToken: string | null = null;
let credentialGeneration = 0;
const expired = new Set<() => void>();
export function setSessionCredentials(session: AuthResponse | null) {
  csrfToken = session?.csrfToken ?? null;
  credentialGeneration++;
}
export function subscribeSessionExpired(listener: () => void) {
  expired.add(listener);
  return () => {
    expired.delete(listener);
  };
}
function expire(generation: number) {
  if (generation !== credentialGeneration || !csrfToken) return;
  setSessionCredentials(null);
  for (const listener of expired) listener();
}
type Parser<T> = { parse(value: unknown): T };
function checked<T>(schema: Parser<T>, value: unknown): T {
  try {
    return schema.parse(value);
  } catch {
    throw new ApiError(400, 'INPUT_INVALID', '填写的内容或编号无效，请检查后重试。');
  }
}
function identifier(value: string) {
  return checked(projectIdSchema, value);
}
function search(values: Record<string, unknown>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined) params.set(key, String(value));
  return params.size ? `?${params}` : '';
}
async function request<T>(
  path: string,
  schema: Parser<T> | null,
  options: { method?: string; body?: unknown; signal?: AbortSignal; login?: boolean } = {},
): Promise<T> {
  const generation = credentialGeneration;
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && !options.login) {
    if (!csrfToken) throw new ApiError(401, 'LOGIN_REQUIRED', '请先登录，再继续操作。');
    headers['x-csrf-token'] = csrfToken;
  }
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch {
    throw new ApiError(
      0,
      options.signal?.aborted ? 'REQUEST_CANCELLED' : 'NETWORK_UNAVAILABLE',
      options.signal?.aborted
        ? '请求已取消。'
        : '网络连接中断，请确认连接后重试；原操作可能已经保存。',
    );
  }
  if (!response.ok) {
    if (response.status === 401 && !options.login) expire(generation);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    const failure = apiErrorSchema.safeParse(body);
    throw new ApiError(
      response.status,
      failure.success ? failure.data.error.code : 'REQUEST_FAILED',
      failure.success ? failure.data.error.message : '请求未完成，请刷新状态后重试。',
    );
  }
  if (!schema) return undefined as T;
  try {
    return schema.parse(await response.json());
  } catch {
    throw new ApiError(502, 'RESPONSE_INVALID', '服务器返回的内容不完整，请刷新后重试。');
  }
}
const signalOption = (signal: AbortSignal | undefined) => (signal ? { signal } : {});
export const api = {
  me: (signal?: AbortSignal) => request('/api/auth/me', authResponseSchema, signalOption(signal)),
  login: (username: string, password: string) =>
    request('/api/auth/login', authResponseSchema, {
      method: 'POST',
      body: checked(loginInputSchema, { username, password }),
      login: true,
    }),
  logout: () => request<void>('/api/auth/logout', null, { method: 'POST', body: {} }),
  projects: (options: { cursor?: string; limit?: number } = {}, signal?: AbortSignal) =>
    request(
      `/api/projects${search(checked(projectListOptionsSchema, options))}`,
      projectListSchema,
      signalOption(signal),
    ),
  project: (id: string, signal?: AbortSignal) =>
    request(`/api/projects/${identifier(id)}`, projectRecordSchema, signalOption(signal)),
  goals: (id: string, options: { cursor?: string; limit?: number } = {}, signal?: AbortSignal) =>
    request(
      `/api/projects/${identifier(id)}/goals${search(checked(projectListOptionsSchema, options))}`,
      goalListSchema,
      signalOption(signal),
    ),
  conversations: (
    options: {
      projectId?: string;
      scope?: 'unassigned' | 'all';
      cursor?: string;
      limit?: number;
    } = {},
    signal?: AbortSignal,
  ) => {
    const { projectId, ...page } = options;
    return request(
      `${projectId ? `/api/projects/${identifier(projectId)}/conversations` : '/api/conversations'}${search(checked(conversationListQuerySchema, page))}`,
      conversationPublicListSchema,
      signalOption(signal),
    );
  },
  conversation: (id: string, signal?: AbortSignal) =>
    request(
      `/api/conversations/${identifier(id)}`,
      conversationPublicRecordSchema,
      signalOption(signal),
    ),
  createConversation: (input: ConversationCreateInput, projectId?: string) =>
    request(
      projectId ? `/api/projects/${identifier(projectId)}/conversations` : '/api/conversations',
      conversationCreateResultSchema,
      { method: 'POST', body: checked(conversationCreateInputSchema, input) },
    ),
  send: (id: string, input: ConversationMessageInput) =>
    request(`/api/conversations/${identifier(id)}/messages`, conversationWriteResultSchema, {
      method: 'POST',
      body: checked(conversationMessageInputSchema, input),
    }),
  answer: (id: string, input: ConversationAnswerInput) =>
    request(`/api/conversations/${identifier(id)}/answers`, conversationWriteResultSchema, {
      method: 'POST',
      body: checked(conversationAnswerInputSchema, input),
    }),
  stop: (id: string, input: ConversationStopInput) =>
    request(`/api/conversations/${identifier(id)}/stop`, conversationStopResultSchema, {
      method: 'POST',
      body: checked(conversationStopInputSchema, input),
    }),
  setMode: (id: string, input: ConversationModeInput) =>
    request(`/api/conversations/${identifier(id)}/permission-mode`, conversationModeResultSchema, {
      method: 'PATCH',
      body: checked(conversationModeInputSchema, input),
    }),
  approval: (id: string, signal?: AbortSignal) =>
    request(`/api/approvals/${identifier(id)}`, toolApprovalViewSchema, signalOption(signal)),
  decideApproval: (id: string, input: ToolApprovalDecisionInput) =>
    request(`/api/approvals/${identifier(id)}`, toolApprovalDecisionResultSchema, {
      method: 'POST',
      body: checked(toolApprovalDecisionInputSchema, input),
    }),
};
