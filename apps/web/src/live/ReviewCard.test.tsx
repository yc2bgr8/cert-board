// @vitest-environment jsdom
import { randomUUID } from 'node:crypto';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReviewCardView, WorkspaceRecord } from '@cert-board/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api, ApiError } from './api.js';
import { ReviewCard } from './ReviewCard.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function fixture(configure?: (card: ReviewCardView) => void) {
  const now = '2026-11-18T12:00:00.000Z';
  const workspaceVersion = randomUUID();
  const projectId = randomUUID();
  const documentId = randomUUID();
  const source = { documentId, version: 1, page: 1, quote: '编号 K123456' };
  const second = { ...source, page: 5, quote: '编号 K123465' };
  const evidenceRefs = [source, second].map((citation) => ({
    ...citation,
    readInvocationId: randomUUID(),
  }));
  const workspace: WorkspaceRecord = {
    id: randomUUID(),
    projectId,
    currentVersionId: workspaceVersion,
    dataLevel: 'internal',
    version: 2,
    createdAt: now,
    updatedAt: now,
  };
  const card: ReviewCardView = {
    id: randomUUID(),
    projectId,
    goalId: randomUUID(),
    conversationId: randomUUID(),
    workspaceVersion,
    skill: { id: 'R09', version: '0.1.0' },
    risk: 'high',
    cardType: 'finalize',
    status: 'pending',
    version: 1,
    createdAt: now,
    decidedAt: null,
    legacySubmission: false,
    sections: [
      'conclusion',
      'requestedAction',
      'decisions',
      'changes',
      'evidence',
      'checks',
      'uncertainties',
      'actions',
    ],
    requiresJudgment: false,
    judgment: null,
    decision: null,
    submission: {
      skill: { id: 'R09', version: '0.1.0' },
      workspaceVersion,
      conclusion: '两处编号写法不同。',
      nextStep: '请核对原件并决定。',
      missing: [],
      uncertain: ['正确编号待确认。'],
      claims: [
        {
          id: 'KNumber',
          object: '对比器械',
          field: '编号',
          unit: null,
          value: 'K123456',
          sources: [source],
          status: 'checked',
        },
      ],
      decisions: [
        {
          id: 'KeepBoth',
          subject: '对比器械编号',
          choice: '保留两种写法',
          alternatives: ['统一第一处'],
          reason: '等待核对原件。',
          sources: [source, second],
          risk: 'high',
        },
      ],
      evidence: [source, second],
    },
    checks: {
      passed: true,
      dataLevel: 'internal',
      checks: [
        { code: 'V1', status: 'passed', issues: [] },
        { code: 'V3', status: 'passed', issues: [] },
      ],
      notRun: ['V2', 'V4', 'V5', 'V6', 'V7', 'V8'],
      citations: [source, second].map(({ quote: _quote, ...citation }) => ({
        ...citation,
        sourceKey: 'D035',
        locatorKind: 'physical_page',
        method: 'text',
        ocrScore: null,
      })),
    },
    diff: {
      baseVersionId: randomUUID(),
      changes: [
        {
          path: 'reports/核对.md',
          change: 'added',
          beforeSha256: null,
          afterSha256: 'a'.repeat(64),
        },
      ],
    },
    evidenceRefs,
  };
  configure?.(card);
  vi.spyOn(api, 'review').mockResolvedValue(card);
  vi.spyOn(api, 'workspace').mockResolvedValue(workspace);
  vi.spyOn(api, 'workspaceVersions').mockResolvedValue({
    items: [
      {
        id: workspaceVersion,
        workspaceId: workspace.id,
        projectId,
        number: 2,
        parentVersionId: card.diff.baseVersionId,
        authorUserId: randomUUID(),
        authorType: 'ai',
        summary: '编号核对',
        dataLevel: 'internal',
        createdAt: now,
      },
    ],
    hasMore: false,
    nextAfterNumber: null,
  });
  const callbacks = { onOpenEvidence: vi.fn(), onOpenDiff: vi.fn(), onOpenFile: vi.fn() };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ReviewCard reviewId={card.id} {...callbacks} />
    </QueryClientProvider>,
  );
  return { card, workspace, callbacks };
}

it('结构化期限通过 V6 时仍提示人工核对同卡的叙述期限', async () => {
  fixture((card) => {
    if (card.legacySubmission) throw new Error('TEST_REVIEW_STRUCTURE_MISSING');
    card.submission.nextStep = '请人工核对 2026-05-01 是否为其他事项的期限。';
    card.submission.claims.push({
      ...card.submission.claims[0]!,
      id: 'Deadline',
      field: '截止日期',
      value: '2026-03-09T03:59:59.999Z',
      deadlineCalculation: {
        startDate: '2026-03-08',
        quantity: 0,
        unit: 'calendar_days',
        jurisdictionTz: 'America/New_York',
      },
    });
    card.checks.checks.push({ code: 'V6', status: 'passed', issues: [] });
    card.checks.notRun = ['V2', 'V4', 'V5', 'V7', 'V8'];
  });
  await screen.findByText('V6 · 结构化期限');
  expect(screen.getByText('V6 复算结构化期限。请人工核对叙述中的期限。')).toBeTruthy();
});

it('展示八部分、过程判断、版本和精确证据，只用浏览器批准接口冻结', async () => {
  const { card, callbacks } = fixture();
  const decide = vi.spyOn(api, 'decideReview').mockResolvedValue({
    cardId: card.id,
    status: 'approved',
    version: 2,
    decisionId: randomUUID(),
    snapshotId: randomUUID(),
    replayed: false,
  });
  await screen.findByRole('heading', { name: '过程中作出的判断' });
  for (const name of [
    '结论',
    '需要你做什么',
    '过程中作出的判断',
    '改动',
    '依据',
    '自检',
    '不确定事项',
    '操作',
  ])
    expect(screen.getByRole('heading', { name })).toBeTruthy();
  await screen.findByText('第 2 版');
  expect(screen.getByText('保留两种写法')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '并排查看两处依据' }));
  expect(callbacks.onOpenEvidence).toHaveBeenCalledWith(card.evidenceRefs);
  fireEvent.click(screen.getByRole('button', { name: '查看对比' }));
  expect(callbacks.onOpenDiff).toHaveBeenCalledWith({
    projectId: card.projectId,
    from: card.diff.baseVersionId,
    to: card.workspaceVersion,
    path: 'reports/核对.md',
  });
  expect(decide).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '通过' }));
  await screen.findByText('已通过，工作区版本已冻结。');
  expect(decide).toHaveBeenCalledWith(card.id, {
    expectedVersion: card.version,
    workspaceVersion: card.workspaceVersion,
    action: 'approved',
    reason: null,
    requestKey: expect.any(String),
  });
});

it('工作区已保存新版本时，历史卡可读且冻结按钮不可操作', async () => {
  const { workspace } = fixture();
  vi.mocked(api.workspace).mockResolvedValue({ ...workspace, currentVersionId: randomUUID() });
  await screen.findByText('工作区已保存为新版本。请核对并打开最新提交的审核卡。');
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '通过' }).disabled).toBe(true);
  expect(screen.getByText('两处编号写法不同。')).toBeTruthy();
});

it('服务端拒绝过期决定后先刷新，更新卡片并等待人工确认', async () => {
  const { card } = fixture();
  const decide = vi
    .spyOn(api, 'decideReview')
    .mockRejectedValue(new ApiError(409, 'REVIEW_CONFLICT', '审核版本已变化。'));
  const approve = await screen.findByRole<HTMLButtonElement>('button', { name: '通过' });
  await waitFor(() => expect(approve.disabled).toBe(false));
  fireEvent.click(approve);
  await screen.findByText('审核版本已变化。');
  expect(approve.disabled).toBe(true);
  vi.mocked(api.review).mockResolvedValue({ ...card, status: 'cancelled', version: 2 });
  fireEvent.click(screen.getByRole('button', { name: '刷新审核卡' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: '通过' })).toBeNull());
  expect(decide).toHaveBeenCalledTimes(1);
});

it('退回修改要求清楚的原因，并保留同一审核版本', async () => {
  const { card } = fixture();
  const decide = vi.spyOn(api, 'decideReview').mockResolvedValue({
    cardId: card.id,
    status: 'rejected',
    version: 2,
    decisionId: randomUUID(),
    snapshotId: null,
    replayed: false,
  });
  const reject = await screen.findByRole<HTMLButtonElement>('button', { name: '退回修改' });
  await waitFor(() => expect(reject.disabled).toBe(false));
  fireEvent.click(reject);
  const confirm = screen.getByRole<HTMLButtonElement>('button', { name: '确认退回' });
  expect(confirm.disabled).toBe(true);
  fireEvent.change(screen.getByRole('textbox', { name: '退回原因' }), {
    target: { value: '请核对第 5 页。' },
  });
  fireEvent.click(confirm);
  await waitFor(() =>
    expect(decide).toHaveBeenCalledWith(
      card.id,
      expect.objectContaining({
        action: 'rejected',
        reason: '请核对第 5 页。',
        expectedVersion: card.version,
        workspaceVersion: card.workspaceVersion,
      }),
    ),
  );
});
