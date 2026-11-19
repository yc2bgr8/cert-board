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
  reviewCardViewSchema,
  reviewDecisionInputSchema,
  reviewDecisionResultSchema,
  proposalRecordSchema,
  proposalDecisionSchema,
  proposalDecisionResultSchema,
  proposalListOptionsSchema,
  proposalSummaryListSchema,
  workspaceRecordSchema,
  workspaceVersionListOptionsSchema,
  workspaceVersionListSchema,
  documentListOptionsSchema,
  documentListSchema,
  documentRecordSchema,
  documentVersionListOptionsSchema,
  documentVersionListSchema,
  documentPageParamsSchema,
  documentPageReadOptionsSchema,
  documentPageReadSchema,
  workspaceFileQuerySchema,
  workspaceFileListSchema,
  workspacePathSchema,
  workspaceReadQuerySchema,
  workspaceReadFileSchema,
  workspaceDiffQuerySchema,
  workspaceDiffResponseSchema,
  externalModelSetupSchema,
  externalModelConversationInputSchema,
  externalModelConversationSchema,
  externalModelConversationListSchema,
  externalModelMessageInputSchema,
  externalModelExchangeSchema,
  externalModelExchangeListSchema,
  externalModelWordInputSchema,
  externalModelWordSchema,
  externalModelWordListSchema,
  externalModelArchiveSchema,
  externalModelArchivePageSchema,
  externalModelShareInputSchema,
  type AuthResponse,
  type ConversationCreateInput,
  type ConversationMessageInput,
  type ConversationAnswerInput,
  type ConversationStopInput,
  type ConversationModeInput,
  type ToolApprovalDecisionInput,
  type ReviewDecisionInput,
  type ProposalDecision,
  type ExternalModelMessageInput,
  type ExternalModelWordInput,
} from '@cert-board/shared';

export type ConversationDetail = ReturnType<typeof conversationPublicRecordSchema.parse>;
export type ApprovalView = ReturnType<typeof toolApprovalViewSchema.parse>;
export type ProjectPage = ReturnType<typeof projectListSchema.parse>;
export type ConversationPage = ReturnType<typeof conversationPublicListSchema.parse>;
export type ReviewView = ReturnType<typeof reviewCardViewSchema.parse>;
export type WorkspaceVersions = ReturnType<typeof workspaceVersionListSchema.parse>;
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
const externalPage = (cursor: string | null) =>
  cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
export const api = {
  externalSetup: (signal?: AbortSignal) =>
    request('/api/external-model/setup', externalModelSetupSchema, signalOption(signal)),
  externalConversations: (cursor: string | null, signal?: AbortSignal) =>
    request(
      `/api/external-model/conversations${externalPage(cursor)}`,
      externalModelConversationListSchema,
      signalOption(signal),
    ),
  externalCreate: (data: { title: string; requestKey: string }) =>
    request('/api/external-model/conversations', externalModelConversationSchema, {
      method: 'POST',
      body: checked(externalModelConversationInputSchema, data),
    }),
  externalMessages: (id: string, cursor: string | null, signal?: AbortSignal) =>
    request(
      `/api/external-model/conversations/${identifier(id)}/messages${externalPage(cursor)}`,
      externalModelExchangeListSchema,
      signalOption(signal),
    ),
  externalSend: (id: string, data: ExternalModelMessageInput) =>
    request(
      `/api/external-model/conversations/${identifier(id)}/messages`,
      externalModelExchangeSchema,
      {
        method: 'POST',
        body: checked(externalModelMessageInputSchema, data),
      },
    ),
  externalWords: (signal?: AbortSignal) =>
    request('/api/external-model/words', externalModelWordListSchema, signalOption(signal)),
  externalSaveWord: (data: ExternalModelWordInput) =>
    request('/api/external-model/words', externalModelWordSchema, {
      method: 'POST',
      body: checked(externalModelWordInputSchema, data),
    }),
  externalRemoveWord: (id: string) =>
    request(`/api/external-model/words/${identifier(id)}`, null, { method: 'DELETE' }),
  externalArchive: (id: string, signal?: AbortSignal) =>
    request(
      `/api/external-model/exchanges/${identifier(id)}/archive`,
      externalModelArchiveSchema,
      signalOption(signal),
    ),
  externalArchiveDay: (day: string, cursor?: string | null, signal?: AbortSignal) =>
    request(
      `/api/external-model/archive${search({ day, cursor: cursor ?? undefined })}`,
      externalModelArchivePageSchema,
      signalOption(signal),
    ),
  externalShare: (id: string, data: { conversationId: string; requestKey: string }) =>
    request(
      `/api/external-model/exchanges/${identifier(id)}/share`,
      conversationWriteResultSchema,
      {
        method: 'POST',
        body: checked(externalModelShareInputSchema, data),
      },
    ),
  review: (id: string, signal?: AbortSignal) =>
    request(`/api/reviews/${identifier(id)}`, reviewCardViewSchema, signalOption(signal)),
  decideReview: (id: string, input: ReviewDecisionInput) =>
    request(`/api/reviews/${identifier(id)}/decision`, reviewDecisionResultSchema, {
      method: 'POST',
      body: checked(reviewDecisionInputSchema, input),
    }),
  proposal: (id: string, signal?: AbortSignal) =>
    request(`/api/proposals/${identifier(id)}`, proposalRecordSchema, signalOption(signal)),
  conversationProposals: (
    id: string,
    options: { cursor?: string; limit?: number },
    signal?: AbortSignal,
  ) =>
    request(
      `/api/conversations/${identifier(id)}/proposals${search(checked(proposalListOptionsSchema, options))}`,
      proposalSummaryListSchema,
      signalOption(signal),
    ),
  decideProposal: (id: string, input: ProposalDecision) =>
    request(`/api/proposals/${identifier(id)}/decision`, proposalDecisionResultSchema, {
      method: 'POST',
      body: checked(proposalDecisionSchema, input),
    }),
  workspace: (projectId: string, signal?: AbortSignal) =>
    request(
      `/api/projects/${identifier(projectId)}/workspace`,
      workspaceRecordSchema,
      signalOption(signal),
    ),
  workspaceVersions: (
    id: string,
    options: { afterNumber?: number; limit?: number; view?: 'recent' } = {},
    signal?: AbortSignal,
  ) =>
    request(
      `/api/workspaces/${identifier(id)}/versions${search(checked(workspaceVersionListOptionsSchema, options))}`,
      workspaceVersionListSchema,
      signalOption(signal),
    ),
  documents: (
    projectId: string,
    options: { cursor?: string; limit?: number } = {},
    signal?: AbortSignal,
  ) =>
    request(
      `/api/projects/${identifier(projectId)}/documents${search(checked(documentListOptionsSchema, options))}`,
      documentListSchema,
      signalOption(signal),
    ),
  document: (id: string, signal?: AbortSignal) =>
    request(`/api/documents/${identifier(id)}`, documentRecordSchema, signalOption(signal)),
  documentVersions: (
    id: string,
    options: { afterVersion?: number; limit?: number } = {},
    signal?: AbortSignal,
  ) =>
    request(
      `/api/documents/${identifier(id)}/versions${search(checked(documentVersionListOptionsSchema, options))}`,
      documentVersionListSchema,
      signalOption(signal),
    ),
  documentPage: (
    id: string,
    version: number,
    page: number,
    options: { offset?: number; limit?: number } = {},
    signal?: AbortSignal,
  ) => {
    const location = checked(documentPageParamsSchema, { id, version, page });
    return request(
      `/api/documents/${location.id}/versions/${location.version}/pages/${location.page}${search(checked(documentPageReadOptionsSchema, options))}`,
      documentPageReadSchema,
      signalOption(signal),
    );
  },
  workspaceFiles: (
    id: string,
    options: { versionId?: string; cursor?: string; limit?: number } = {},
    signal?: AbortSignal,
  ) =>
    request(
      `/api/workspaces/${identifier(id)}/files${search(checked(workspaceFileQuerySchema, options))}`,
      workspaceFileListSchema,
      signalOption(signal),
    ),
  workspaceFile: (
    id: string,
    path: string,
    options: { versionId?: string; offset?: number; limit?: number } = {},
    signal?: AbortSignal,
  ) => {
    const pathname = checked(workspacePathSchema, path)
      .split('/')
      .map(encodeURIComponent)
      .join('/');
    return request(
      `/api/workspaces/${identifier(id)}/files/${pathname}${search(checked(workspaceReadQuerySchema, options))}`,
      workspaceReadFileSchema,
      signalOption(signal),
    );
  },
  workspaceDiff: (
    id: string,
    options: {
      from: string;
      to: string;
      path?: string;
      cursor?: string;
      offset?: number;
      limit?: number;
    },
    signal?: AbortSignal,
  ) =>
    request(
      `/api/workspaces/${identifier(id)}/diff${search(checked(workspaceDiffQuerySchema, options))}`,
      workspaceDiffResponseSchema,
      signalOption(signal),
    ),
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
