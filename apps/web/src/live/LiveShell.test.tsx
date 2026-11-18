// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type {
  AuthResponse,
  ConversationRecord,
  GoalRecord,
  ProjectRecord,
} from '@cert-board/shared';
import type { ConversationDetail } from './api.js';
import { ApiError } from './api.js';
import { LiveApp } from '../LiveApp.js';

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  notifications: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  refresh: vi.fn(),
  api: {
    projects: vi.fn(),
    project: vi.fn(),
    goals: vi.fn(),
    conversations: vi.fn(),
    conversation: vi.fn(),
    createConversation: vi.fn(),
  },
}));
vi.mock('./useSession.js', () => ({ useSession: mocks.session }));
vi.mock('./useMemberNotifications.js', () => ({ useMemberNotifications: mocks.notifications }));
vi.mock('./LiveConversation.js', () => ({
  LiveConversation: ({ conversationId }: { conversationId: string }) => (
    <section aria-label="已打开的真实对话">{conversationId}</section>
  ),
}));
vi.mock('./api.js', async (original) => {
  const actual = await original<typeof import('./api.js')>();
  return { ...actual, api: { ...actual.api, ...mocks.api } };
});
const ownerId = '10000000-0000-4000-8000-000000000001';
const otherId = '10000000-0000-4000-8000-000000000002';
const projectId = '10000000-0000-4000-8000-000000000003';
const goalId = '10000000-0000-4000-8000-000000000004';
const ownId = '10000000-0000-4000-8000-000000000005';
const sharedId = '10000000-0000-4000-8000-000000000006';
const newId = '10000000-0000-4000-8000-000000000007';
const now = '2026-11-18T11:30:00Z';
const session: AuthResponse = {
  user: { id: ownerId, username: 'zhangsan', displayName: '张三', isManagement: false },
  csrfToken: 'c'.repeat(48),
  expiresAt: '2026-11-19T11:30:00Z',
};
const project: ProjectRecord = {
  id: projectId,
  code: 'PRJ-1',
  name: 'L08 510(k)',
  projectType: 'registration',
  market: 'US',
  pathway: '510(k)',
  modelId: null,
  ownerUserId: ownerId,
  reviewerUserId: null,
  applicantEntityId: null,
  holderEntityId: null,
  targetAt: null,
  jurisdictionTz: 'America/New_York',
  status: 'preparing',
  submissionNumber: null,
  submittedAt: null,
  acceptedAt: null,
  nextAction: '核对申报资料中的编号写法。',
  version: 1,
  createdAt: now,
  updatedAt: now,
};
const goal: GoalRecord = {
  id: goalId,
  projectId,
  ownerUserId: ownerId,
  title: '检查对比器械K号写法',
  acceptanceCriteria: '逐页核对',
  dueAt: null,
  budgetUsd: 10,
  status: 'active',
  directionVersion: 1,
  version: 1,
  createdAt: now,
  updatedAt: now,
};
function conversationRecord(id = ownId, title = '我的核对'): ConversationRecord {
  return {
    id,
    projectId,
    goalId,
    userId: ownerId,
    title,
    permissionMode: 'ask',
    agentCode: 'registration',
    maxDataLevel: 'internal',
    status: 'active',
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}
const own: ConversationDetail = {
  ...conversationRecord(),
  ownerName: '张三',
  permissionVersion: 1,
  currentRunId: null,
  lastMessageSeq: 0,
  lastEventSeq: 0,
  canWrite: true,
};
const shared: ConversationDetail = {
  ...own,
  id: sharedId,
  title: '同事的核对',
  userId: otherId,
  ownerName: '王敏',
  canWrite: false,
};
const clients: QueryClient[] = [];
function app() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<LiveApp />, { wrapper });
}
function authenticated() {
  return {
    status: 'authenticated',
    session,
    error: null,
    login: mocks.login,
    logout: mocks.logout,
    refresh: mocks.refresh,
  };
}
async function projectView() {
  fireEvent.click(await screen.findByRole('button', { name: 'L08 510(k)' }));
  await screen.findByRole('button', { name: '打开对话：我的核对' });
}
async function newProjectDialog() {
  await projectView();
  fireEvent.click(screen.getByRole('button', { name: '新对话' }));
  const dialog = screen.getByRole('dialog', { name: '新对话' });
  await waitFor(() =>
    expect(
      (within(dialog).getByRole('combobox', { name: '工作目标' }) as HTMLSelectElement).value,
    ).toBe(goalId),
  );
  return dialog;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockReturnValue(authenticated());
  mocks.login.mockResolvedValue(undefined);
  mocks.logout.mockResolvedValue(undefined);
  mocks.refresh.mockResolvedValue(undefined);
  mocks.notifications.mockReturnValue({
    snapshot: { generatedAt: now, items: [], truncated: false },
    connection: 'open',
    error: null,
  });
  mocks.api.projects.mockResolvedValue({ items: [project], hasMore: false, nextCursor: null });
  mocks.api.project.mockResolvedValue(project);
  mocks.api.goals.mockResolvedValue({ items: [goal], hasMore: false, nextCursor: null });
  mocks.api.conversations.mockImplementation(
    async (options: { projectId?: string; scope?: string }) => ({
      items: options.projectId || options.scope === 'all' ? [own, shared] : [],
      hasMore: false,
      nextCursor: null,
    }),
  );
  mocks.api.conversation.mockImplementation(async (id: string) =>
    id === sharedId ? shared : id === newId ? { ...own, id: newId, title: '新的核对对话' } : own,
  );
  mocks.api.createConversation.mockResolvedValue({
    conversation: conversationRecord(newId, '新的核对对话'),
    permissionVersion: 1,
    replayed: false,
  });
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
});

test('真实登录表单使用密码框和POST，阻止重复提交并在结束后清空密码', async () => {
  mocks.session.mockReturnValue({ ...authenticated(), status: 'anonymous', session: null });
  let finish!: () => void;
  mocks.login.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const storage = vi.spyOn(Storage.prototype, 'setItem');
  app();
  const password = screen.getByLabelText('密码') as HTMLInputElement;
  expect(password.type).toBe('password');
  const form = password.closest('form')!;
  expect(form.method).toBe('post');
  fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'zhangsan' } });
  fireEvent.change(password, { target: { value: 'synthetic-password-for-test' } });
  fireEvent.submit(form);
  fireEvent.submit(form);
  expect(mocks.login).toHaveBeenCalledTimes(1);
  expect(mocks.login).toHaveBeenCalledWith('zhangsan', 'synthetic-password-for-test');
  await act(async () => {
    finish();
  });
  expect(password.value).toBe('');
  expect(storage).not.toHaveBeenCalled();
});

test('项目和对话由真实接口结果展示，不补造维护事项；可切到同事对话', async () => {
  app();
  await projectView();
  expect(screen.getByText('准备中', { exact: true })).toBeTruthy();
  const goals = await screen.findByRole('region', { name: '工作目标' });
  expect(await within(goals).findByText(goal.title)).toBeTruthy();
  expect(within(goals).getByText('进行中', { exact: true })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'L08 年度注册' })).toBeNull();
  expect(screen.getByText('暂无维护事项')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '打开对话：同事的核对' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '部门对话' }));
  fireEvent.click(screen.getByRole('button', { name: '打开对话：同事的核对' }));
  expect((await screen.findByRole('region', { name: '已打开的真实对话' })).textContent).toBe(
    sharedId,
  );
  expect(mocks.api.conversation).toHaveBeenCalledWith(sharedId, expect.any(AbortSignal));
  expect(screen.queryByRole('combobox', { name: '原型角色' })).toBeNull();
});

test('项目内新对话固定真实Agent和目标，默认ask，创建成功打开持久对话', async () => {
  app();
  const dialog = await newProjectDialog();
  expect(within(dialog).getByText('注册Agent')).toBeTruthy();
  expect(within(dialog).queryByRole('combobox', { name: '选择Agent' })).toBeNull();
  expect(
    (within(dialog).getByRole('combobox', { name: '权限模式' }) as HTMLSelectElement).value,
  ).toBe('ask');
  fireEvent.change(within(dialog).getByLabelText('对话标题'), {
    target: { value: '新的核对对话' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: '创建对话' }));
  expect((await screen.findByRole('region', { name: '已打开的真实对话' })).textContent).toBe(newId);
  expect(mocks.api.createConversation).toHaveBeenCalledWith(
    expect.objectContaining({
      title: '新的核对对话',
      agentCode: 'registration',
      permissionMode: 'ask',
      goalId,
      requestKey: expect.any(String),
    }),
    projectId,
  );
  expect(screen.queryByRole('dialog', { name: '新对话' })).toBeNull();
});

test('创建响应不确定时重试保持同一gesture请求编号，不重复生成意图', async () => {
  mocks.api.createConversation.mockRejectedValueOnce(
    new ApiError(0, 'NETWORK_UNAVAILABLE', '连接中断，原操作可能已保存。'),
  );
  app();
  const dialog = await newProjectDialog();
  fireEvent.click(within(dialog).getByRole('button', { name: '创建对话' }));
  await within(dialog).findByRole('alert');
  fireEvent.click(within(dialog).getByRole('button', { name: '创建对话' }));
  await screen.findByRole('region', { name: '已打开的真实对话' });
  expect(mocks.api.createConversation).toHaveBeenCalledTimes(2);
  expect(mocks.api.createConversation.mock.calls[0]?.[0].requestKey).toBe(
    mocks.api.createConversation.mock.calls[1]?.[0].requestKey,
  );
});

test('项目外新对话可选择维护Agent，保存后明确尚不能运行', async () => {
  const metadata = {
    ...conversationRecord(newId),
    projectId: null,
    goalId: null,
    agentCode: 'maintenance' as const,
  };
  mocks.api.createConversation.mockResolvedValue({
    conversation: metadata,
    permissionVersion: 1,
    replayed: false,
  });
  mocks.api.conversation.mockResolvedValue({ ...own, ...metadata });
  app();
  await screen.findByRole('button', { name: 'L08 510(k)' });
  fireEvent.click(screen.getByRole('button', { name: '新对话' }));
  const dialog = screen.getByRole('dialog', { name: '新对话' });
  fireEvent.change(within(dialog).getByRole('combobox', { name: '选择Agent' }), {
    target: { value: 'maintenance' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: '创建对话' }));
  await screen.findByText('对话已保存，尚未关联项目，暂不能启动任务。');
  expect(screen.queryByRole('region', { name: '已打开的真实对话' })).toBeNull();
  expect(mocks.api.createConversation).toHaveBeenCalledWith(
    expect.objectContaining({ agentCode: 'maintenance', permissionMode: 'ask' }),
    undefined,
  );
});

test('待我处理用服务器快照替换，真实通知可打开对应对话', async () => {
  mocks.notifications.mockReturnValue({
    snapshot: {
      generatedAt: now,
      items: [{ id: newId, kind: 'approval', conversationId: ownId, projectId, createdAt: now }],
      truncated: false,
    },
    connection: 'open',
    error: null,
  });
  const view = app();
  fireEvent.click(screen.getByRole('button', { name: /待我处理/ }));
  const inbox = screen.getByRole('region', { name: '待我处理事项' });
  fireEvent.click(within(inbox).getByRole('button', { name: /批准请求/ }));
  expect((await screen.findByRole('region', { name: '已打开的真实对话' })).textContent).toBe(ownId);
  mocks.notifications.mockReturnValue({
    snapshot: { generatedAt: now, items: [], truncated: false },
    connection: 'open',
    error: null,
  });
  view.rerender(<LiveApp />);
  fireEvent.click(screen.getByRole('button', { name: /待我处理/ }));
  expect(screen.getByText('暂时没有需要你处理的事项。')).toBeTruthy();
  expect(screen.queryByText('批准请求', { exact: true })).toBeNull();
});

test('Ctrl+K和Esc保持搜索焦点，设置为非模态且真实调用logout', async () => {
  app();
  await screen.findByRole('button', { name: 'L08 510(k)' });
  const searchButton = screen.getByRole('button', { name: '搜索' });
  searchButton.focus();
  const styles = document.querySelectorAll('style').length;
  fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
  const searchInput = screen.getByRole('textbox', { name: '搜索项目或对话' });
  await waitFor(() => expect(document.activeElement).toBe(searchInput));
  expect(
    screen.getByRole('dialog', { name: '搜索项目或对话' }).getAttribute('aria-modal'),
  ).not.toBe('true');
  expect(document.querySelectorAll('style').length).toBe(styles);
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => expect(document.activeElement).toBe(searchButton));
  fireEvent.click(screen.getByRole('button', { name: '设置' }));
  const settings = screen.getByRole('dialog', { name: '设置' });
  expect(within(settings).getByText('zhangsan')).toBeTruthy();
  expect(settings.textContent).not.toContain(session.csrfToken);
  expect(document.querySelectorAll('style').length).toBe(styles);
  fireEvent.click(within(settings).getByRole('button', { name: '退出登录' }));
  await waitFor(() => expect(mocks.logout).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '设置' })).toBeNull());
});

test('会话失效后卸载项目和活动对话，回到真实登录表单', async () => {
  const view = app();
  await projectView();
  fireEvent.click(screen.getByRole('button', { name: '打开对话：我的核对' }));
  await screen.findByRole('region', { name: '已打开的真实对话' });
  mocks.session.mockReturnValue({
    ...authenticated(),
    status: 'anonymous',
    session: null,
    error: '登录已失效，请重新登录。',
  });
  view.rerender(<LiveApp />);
  expect(screen.getByLabelText('用户名')).toBeTruthy();
  expect(screen.queryByRole('region', { name: '已打开的真实对话' })).toBeNull();
  expect(screen.queryByRole('complementary', { name: '项目导航' })).toBeNull();
});

test('搜索请求失败时明确提示重试，不把网络失败展示成没有匹配结果', async () => {
  mocks.api.conversations.mockImplementation(async (options: { scope?: string }) => {
    if (options.scope === 'all') throw new ApiError(503, 'UNAVAILABLE', '对话列表暂时不可用。');
    return { items: [], hasMore: false, nextCursor: null };
  });
  app();
  await screen.findByRole('button', { name: 'L08 510(k)' });
  fireEvent.click(screen.getByRole('button', { name: '搜索' }));
  const dialog = screen.getByRole('dialog', { name: '搜索项目或对话' });
  fireEvent.change(within(dialog).getByRole('textbox', { name: '搜索项目或对话' }), {
    target: { value: '尚未加载的标题' },
  });
  expect(await within(dialog).findByRole('alert')).toBeTruthy();
  expect(within(dialog).queryByText('当前列表没有匹配结果。')).toBeNull();
  expect(within(dialog).getByRole('button', { name: '重新加载对话' })).toBeTruthy();
});
