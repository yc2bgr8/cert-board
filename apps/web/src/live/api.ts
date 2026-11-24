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
  evaluationStatusViewSchema,
  reviewDecisionInputSchema,
  reviewDecisionResultSchema,
  proposalRecordSchema,
  outboundReconciliationSchema,
  outboundResolutionInputSchema,
  outboundResolutionResultSchema,
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
  intakeStartSchema,
  intakeStartResultSchema,
  intakeReportSchema,
  intakeCategoryEditSchema,
  intakeHistorySchema,
  webArchiveInfoSchema,
  workspaceFileQuerySchema,
  workspaceFileListSchema,
  workspacePathSchema,
  workspaceReadQuerySchema,
  workspaceReadFileSchema,
  workspaceDiffQuerySchema,
  workspaceDiffResponseSchema,
  externalModelWordInputSchema,
  externalModelWordSchema,
  externalModelWordListSchema,
  externalModelArchiveSchema,
  externalModelArchivePageSchema,
  verificationCreateSchema,
  verificationRoomSchema,
  verificationRoomPageSchema,
  verificationDetailSchema,
  verificationInviteSchema,
  verificationMessageInputSchema,
  verificationSettingsSchema,
  verificationSettingsInputSchema,
  verificationShareSchema,
  verificationLinkPageSchema,
  verificationReviewInputSchema,
  skillPageSchema,
  skillVersionViewSchema,
  skillActionSchema,
  skillActionResultSchema,
  skillRollbackPolicySchema,
  skillRollbackPolicyInputSchema,
  skillRollbackListSchema,
  skillRollbackDecisionInputSchema,
  skillRollbackDecisionResultSchema,
  type AuthResponse,
  type DataLevel,
  type IntakeCategory,
  type ConversationCreateInput,
  type ConversationMessageInput,
  type ConversationAnswerInput,
  type ConversationStopInput,
  type ConversationModeInput,
  type ToolApprovalDecisionInput,
  type ReviewDecisionInput,
  type ProposalDecision,
  type OutboundResolutionInput,
  type SkillRollbackPolicyInput,
  type SkillRollbackDecisionInput,
  type ExternalModelWordInput,
  type VerificationCreate,
  type VerificationMessageInput,
  type VerificationSettingsInput,
  type SkillActionInput,
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
    readonly requestId: string = code,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
export const isStaleError = (error: unknown): error is ApiError =>
  error instanceof ApiError && error.status === 409;
export const errorMessage = (error: unknown) =>
  error instanceof ApiError
    ? `${error.message}（错误编号 ${error.requestId}）`
    : '操作暂未完成，请稍后重试。（错误编号 CLIENT_ERROR）';
export const createRequestKey = () => crypto.randomUUID();
let csrfToken: string | null = null;
let credentialGeneration = 0;
export const currentSessionGeneration = () => credentialGeneration;
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
  options: {
    method?: string;
    body?: unknown;
    binary?: Blob;
    signal?: AbortSignal;
    login?: boolean;
  } = {},
): Promise<T> {
  const generation = credentialGeneration;
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.binary) headers['content-type'] = 'application/octet-stream';
  else if (options.body !== undefined) headers['content-type'] = 'application/json';
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
      ...(options.binary
        ? { body: options.binary }
        : options.body !== undefined
          ? { body: JSON.stringify(options.body) }
          : {}),
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
      failure.success
        ? failure.data.error.requestId
        : (response.headers.get('x-request-id') ?? 'REQUEST_FAILED'),
    );
  }
  if (!schema) return undefined as T;
  try {
    return schema.parse(await response.json());
  } catch {
    throw new ApiError(
      502,
      'RESPONSE_INVALID',
      '服务器返回的内容不完整，请刷新后重试。',
      response.headers.get('x-request-id') ?? 'RESPONSE_INVALID',
    );
  }
}
const signalOption = (signal: AbortSignal | undefined) => (signal ? { signal } : {});
const externalPage = (cursor: string | null) =>
  cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
export const api = {
  skills: (signal?: AbortSignal) => request('/api/skills', skillPageSchema, signalOption(signal)),
  skillRollbackPolicy: (signal?: AbortSignal) =>
    request('/api/skill-rollback-policy', skillRollbackPolicySchema, signalOption(signal)),
  saveSkillRollbackPolicy: (input: SkillRollbackPolicyInput) =>
    request('/api/skill-rollback-policy', skillRollbackPolicySchema, {
      method: 'POST',
      body: checked(skillRollbackPolicyInputSchema, input),
    }),
  skillRollbackProposals: (signal?: AbortSignal) =>
    request('/api/skill-rollback-proposals', skillRollbackListSchema, signalOption(signal)),
  decideSkillRollback: (id: string, input: SkillRollbackDecisionInput) =>
    request(
      `/api/skill-rollback-proposals/${identifier(id)}/decision`,
      skillRollbackDecisionResultSchema,
      {
        method: 'POST',
        body: checked(skillRollbackDecisionInputSchema, input),
      },
    ),
  skillVersion: (id: string, versionId: string, signal?: AbortSignal) =>
    request(
      `/api/skills/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}`,
      skillVersionViewSchema,
      signalOption(signal),
    ),
  skillDecision: (id: string, input: SkillActionInput) =>
    request(`/api/skills/${encodeURIComponent(id)}/actions`, skillActionResultSchema, {
      method: 'POST',
      body: checked(skillActionSchema, input),
    }),
  acknowledgeVerificationNotice: (id: string) =>
    request<void>(`/api/me/verification-notices/${identifier(id)}/acknowledge`, null, {
      method: 'POST',
      body: {},
    }),
  acknowledgeDeadline: (id: string, seenAt: string) =>
    request(`/api/deadline-notifications/${encodeURIComponent(id)}/acknowledge`, null, {
      method: 'POST',
      body: { seenAt },
    }),
  verificationRooms: (cursor: string | null, query: string, signal?: AbortSignal) =>
    request(
      `/api/verification/rooms${search({ cursor: cursor ?? undefined, query })}`,
      verificationRoomPageSchema,
      signalOption(signal),
    ),
  verificationRoom: (id: string, cursor: string | null, signal?: AbortSignal) =>
    request(
      `/api/verification/rooms/${identifier(id)}${externalPage(cursor)}`,
      verificationDetailSchema,
      signalOption(signal),
    ),
  linkedVerifications: (conversationId: string, cursor: string | null, signal?: AbortSignal) =>
    request(
      `/api/conversations/${identifier(conversationId)}/verifications${externalPage(cursor)}`,
      verificationLinkPageSchema,
      signalOption(signal),
    ),
  reviewVerifications: (reviewId: string, cursor: string | null, signal?: AbortSignal) =>
    request(
      `/api/reviews/${identifier(reviewId)}/verifications${externalPage(cursor)}`,
      verificationLinkPageSchema,
      signalOption(signal),
    ),
  verificationFromReview: (id: string, payload: { question: string; requestKey: string }) =>
    request(`/api/reviews/${identifier(id)}/verification`, verificationRoomSchema, {
      method: 'POST',
      body: checked(verificationReviewInputSchema, payload),
    }),
  verificationCreate: (data: VerificationCreate) =>
    request('/api/verification/rooms', verificationRoomSchema, {
      method: 'POST',
      body: checked(verificationCreateSchema, data),
    }),
  verificationPost: (id: string, data: VerificationMessageInput) =>
    request(`/api/verification/rooms/${identifier(id)}/posts`, null, {
      method: 'POST',
      body: checked(verificationMessageInputSchema, data),
    }),
  verificationStop: (id: string) =>
    request(`/api/verification/rooms/${identifier(id)}/stop`, null, { method: 'POST' }),
  verificationInvite: (id: string, model: string) =>
    request(`/api/verification/rooms/${identifier(id)}/models`, null, {
      method: 'POST',
      body: checked(verificationInviteSchema, { model }),
    }),
  verificationShare: (id: string, data: { conversationId: string; requestKey: string }) =>
    request(`/api/verification/rooms/${identifier(id)}/share`, conversationWriteResultSchema, {
      method: 'POST',
      body: checked(verificationShareSchema, data),
    }),
  verificationSettings: (signal?: AbortSignal) =>
    request('/api/verification/settings', verificationSettingsSchema, signalOption(signal)),
  verificationSaveSettings: (data: VerificationSettingsInput) =>
    request('/api/verification/settings', verificationSettingsSchema, {
      method: 'PUT',
      body: checked(verificationSettingsInputSchema, data),
    }),
  verificationRecheck: () =>
    request('/api/verification/settings/recheck', null, { method: 'POST' }),
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
  review: (id: string, signal?: AbortSignal) =>
    request(`/api/reviews/${identifier(id)}`, reviewCardViewSchema, signalOption(signal)),
  retryReviewEvaluation: (id: string) =>
    request(`/api/reviews/${identifier(id)}/evaluation/retry`, evaluationStatusViewSchema, {
      method: 'POST',
      body: {},
    }),
  decideReview: (id: string, input: ReviewDecisionInput) =>
    request(`/api/reviews/${identifier(id)}/decision`, reviewDecisionResultSchema, {
      method: 'POST',
      body: checked(reviewDecisionInputSchema, input),
    }),
  proposal: (id: string, signal?: AbortSignal) =>
    request(`/api/proposals/${identifier(id)}`, proposalRecordSchema, signalOption(signal)),
  outboundReconciliation: (id: string, signal?: AbortSignal) =>
    request(
      `/api/proposals/${identifier(id)}/reconciliation`,
      outboundReconciliationSchema,
      signalOption(signal),
    ),
  resolveOutbound: (id: string, input: OutboundResolutionInput) =>
    request(`/api/proposals/${identifier(id)}/reconciliation`, outboundResolutionResultSchema, {
      method: 'POST',
      body: checked(outboundResolutionInputSchema, input),
    }),
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
  startIntake: (projectId: string, file: File, dataLevel: DataLevel) => {
    const input = checked(intakeStartSchema, { projectId, name: file.name, dataLevel });
    return request('/api/intake' + search(input), intakeStartResultSchema, {
      method: 'POST',
      binary: file,
    });
  },
  intakeReport: (id: string, signal?: AbortSignal) =>
    request('/api/intake/' + identifier(id), intakeReportSchema, signalOption(signal)),
  intakeHistory: (projectId: string, cursor?: string, signal?: AbortSignal) =>
    request(
      `/api/projects/${identifier(projectId)}/intakes` + search({ cursor }),
      intakeHistorySchema,
      signalOption(signal),
    ),
  retryIntake: (id: string) =>
    request('/api/intake/' + identifier(id) + '/retry', intakeStartResultSchema, {
      method: 'POST',
    }),
  editIntakeCategory: (id: string, path: string, category: IntakeCategory) =>
    request('/api/intake/' + identifier(id) + '/category', intakeReportSchema, {
      method: 'PATCH',
      body: checked(intakeCategoryEditSchema, { path, category }),
    }),
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
  webArchiveInfo: (id: string, version: number, signal?: AbortSignal) =>
    request(
      `/api/documents/${identifier(id)}/versions/${version}/web-archive-info`,
      webArchiveInfoSchema,
      signalOption(signal),
    ),
  webArchiveHref: (id: string, version: number) =>
    `/api/documents/${identifier(id)}/versions/${version}/web-archive`,
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
