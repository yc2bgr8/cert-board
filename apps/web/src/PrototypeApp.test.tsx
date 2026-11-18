// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { PrototypeApp } from './PrototypeApp.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const registrationContent =
  /K\s*号|K\d{6}|对比器械|示例对比表|示例摘要|predicate\s+device|510\(k\)/i;
const maintenanceNames = ['企业注册记录', '年费付款凭据', '美国代理人协议'];

function expectActiveTabPanel(name: string) {
  const tab = screen.getByRole('tab', { name, selected: true });
  const panelId = tab.getAttribute('aria-controls');
  expect(panelId).toBeTruthy();
  const panel = document.getElementById(panelId!);
  expect(panel?.getAttribute('role')).toBe('tabpanel');
  expect(panel?.getAttribute('aria-labelledby')).toBe(tab.id);
}

function sendMessage(message = '检查L08申报资料中对比器械K号的写法') {
  fireEvent.change(screen.getByRole('textbox', { name: '给Agent的消息' }), {
    target: { value: message },
  });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
}

async function approvalRequest() {
  return screen.findByRole('region', { name: '批准请求' }, { timeout: 3_000 });
}

async function openReview() {
  fireEvent.click(await screen.findByRole('button', { name: '审核' }, { timeout: 3_000 }));
  return screen.getByRole('complementary', { name: '审核详情' });
}

async function completeRegistration() {
  sendMessage();
  const approval = await approvalRequest();
  fireEvent.click(within(approval).getByRole('button', { name: '允许' }));
  return openReview();
}

async function completeMaintenance() {
  fireEvent.click(screen.getByRole('button', { name: 'L08 年度注册' }));
  fireEvent.change(screen.getByRole('combobox', { name: '权限模式' }), {
    target: { value: 'full' },
  });
  sendMessage('核查企业注册、年费和美国代理人，更新提醒并催办。');
  return openReview();
}

describe('按新变更单设计的可点击界面稿', () => {
  test('注册请求批准路径先展示计划和进度，批准判断后提交八部分审核并通过', async () => {
    render(<PrototypeApp />);
    expectActiveTabPanel('对话');
    expect((screen.getByRole('combobox', { name: '权限模式' }) as HTMLSelectElement).value).toBe(
      'ask',
    );
    sendMessage();
    expect(screen.getByRole('region', { name: '计划与待办' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '停止' }).length).toBeGreaterThan(0);
    const approval = await approvalRequest();
    expect(approval.textContent).toMatch(/K123465.*笔误|笔误.*K123465/);
    expect(within(approval).getByRole('button', { name: '本对话中都允许' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '审核' })).toBeNull();
    fireEvent.click(within(approval).getByRole('button', { name: '允许' }));
    const review = await openReview();
    for (const heading of [
      '结论',
      '需要你做什么',
      '过程中作出的判断',
      '改动',
      '依据',
      '自检',
      '不确定事项',
    ]) {
      expect(within(review).getByRole('heading', { name: heading })).toBeTruthy();
    }
    expect(review.textContent).toMatch(/工作区第\s*1\s*版/);
    expect(within(review).queryByLabelText('你的独立判断')).toBeNull();
    expect(within(review).queryByRole('button', { name: '提交判断' })).toBeNull();
    fireEvent.click(within(review).getByRole('button', { name: '通过' }));
    expect(review.textContent).toContain('审核已通过');
    expect(within(review).queryByRole('button', { name: '通过' })).toBeNull();
  });

  test('拒绝判断并填写原因后，Agent保留待确认差异并调整结果', async () => {
    render(<PrototypeApp />);
    sendMessage();
    const approval = await approvalRequest();
    fireEvent.click(within(approval).getByRole('button', { name: '拒绝' }));
    fireEvent.change(screen.getByLabelText('拒绝原因'), {
      target: { value: '原始资料不足，不应判定为笔误，请保留待确认。' },
    });
    fireEvent.click(screen.getByRole('button', { name: '确认拒绝' }));
    expect(screen.queryByRole('button', { name: '审核' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '仅列差异并继续' }));
    const review = await openReview();
    expect(screen.getByRole('region', { name: '对话记录' }).textContent).toContain('原始资料不足');
    expect(review.textContent).toContain('保留差异');
    expect(review.textContent).toContain('暂不选择正确编号');
    expect(review.textContent).not.toContain('已确认是笔误');
    expect(within(review).getByRole('heading', { name: '过程中作出的判断' })).toBeTruthy();
  });

  test('维护完全允许路径直接更新提醒和内部催办，再交人审核且不产生网络请求', async () => {
    const fetch = vi.fn(() => Promise.reject(new Error('静态界面不应联网')));
    vi.stubGlobal('fetch', fetch);
    const xhrSend = vi.spyOn(XMLHttpRequest.prototype, 'send').mockImplementation(() => {
      throw new Error('静态界面不应联网');
    });
    render(<PrototypeApp />);
    const review = await completeMaintenance();
    const conversation = screen.getByRole('region', { name: '对话记录' });
    expect(conversation.textContent).toContain('维护Agent');
    expect(conversation.textContent).toMatch(/已更新.*提醒|提醒.*已更新/);
    expect(conversation.textContent).toMatch(/已(?:向.*?)?发送.*催办|催办.*已发送/);
    expect(screen.queryByRole('region', { name: '批准请求' })).toBeNull();
    expect(review.textContent).not.toMatch(registrationContent);
    fireEvent.click(within(review).getByRole('button', { name: '通过' }));
    expect(review.textContent).toContain('审核已通过');
    expect(fetch).not.toHaveBeenCalled();
    expect(xhrSend).not.toHaveBeenCalled();
  });

  test('M02展开工具过程覆盖三类维护资料，不复用注册检查步骤', async () => {
    render(<PrototypeApp />);
    await completeMaintenance();
    fireEvent.click(screen.getByRole('button', { name: /已执行\s*\d+\s*步/ }));
    const process = screen.getByRole('region', { name: '工具过程' });
    expect(process.textContent).not.toMatch(registrationContent);
    expect(process.textContent).toContain('企业注册');
    expect(process.textContent).toMatch(/年费|年度费用/);
    expect(process.textContent).toContain('美国代理人');
  });

  test('M02审核依据打开维护原文，保留资料编号版本页码且不混入K号资料', async () => {
    render(<PrototypeApp />);
    const review = await completeMaintenance();
    for (const name of maintenanceNames) {
      expect(
        within(review).getAllByRole('button', { name: new RegExp(name) }).length,
      ).toBeGreaterThan(0);
    }
    for (const [index, name] of maintenanceNames.entries()) {
      const currentReview = index === 0 ? review : await openReview();
      fireEvent.click(within(currentReview).getAllByRole('button', { name: new RegExp(name) })[0]!);
      const evidence = screen.getByRole('complementary', { name: '原文依据' });
      expect(evidence.textContent).not.toMatch(registrationContent);
      expect(evidence.textContent).toContain(name);
      expect(evidence.textContent).toContain(`MAINT-0${index + 1}`);
      expect(evidence.textContent).toMatch(/资料第\s*1\s*版/);
      expect(evidence.textContent).toMatch(/第\s*1\s*页/);
      const quote = [
        '适用年度：等待核对。',
        '付款年度与金额：等待核对原件。',
        '协议有效期：等待核对签署页。',
      ][index]!;
      expect(within(evidence).getByRole('region', { name: '解析原文' }).textContent).toContain(
        quote,
      );
      expect(within(evidence).getByRole('region', { name: '原页' }).textContent).toContain(quote);
    }
  });

  test('M02改动、文件和资料使用维护内容，不复用K号检查文件', async () => {
    render(<PrototypeApp />);
    const review = await completeMaintenance();
    fireEvent.click(within(review).getByRole('button', { name: '查看文件改动' }));
    const changes = screen.getByRole('complementary', { name: '文件改动' });
    expect(changes.textContent).not.toMatch(registrationContent);
    expect(changes.textContent).toContain('企业注册');
    expect(changes.textContent).toMatch(/年费|年度费用/);
    expect(changes.textContent).toContain('美国代理人');
    fireEvent.mouseDown(screen.getByRole('tab', { name: '文件' }), {
      button: 0,
      ctrlKey: false,
    });
    expectActiveTabPanel('文件');
    const files = screen.getByRole('region', { name: '项目文件' });
    expect(files.textContent).toContain('年度注册核查记录.md');
    expect(files.textContent).not.toMatch(registrationContent);
    fireEvent.mouseDown(screen.getByRole('tab', { name: '资料' }), {
      button: 0,
      ctrlKey: false,
    });
    expectActiveTabPanel('资料');
    const documents = screen.getByRole('region', { name: '项目资料' });
    for (const name of maintenanceNames) {
      expect(within(documents).getByRole('button', { name: new RegExp(name) })).toBeTruthy();
    }
    expect(documents.textContent).not.toMatch(registrationContent);
  });

  test('待我处理分别打开批准请求和待审核结果，项目状态不混用', async () => {
    render(<PrototypeApp />);
    sendMessage();
    await approvalRequest();
    await completeMaintenance();
    fireEvent.click(screen.getByRole('button', { name: /待我处理/ }));
    const todo = screen.getByRole('region', { name: '待我处理事项' });
    expect(within(todo).getByText('批准请求', { exact: true })).toBeTruthy();
    expect(within(todo).getByText('待审核', { exact: true })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /处理批准/ }));
    expect(screen.getByRole('region', { name: '批准请求' }).textContent).toContain('K123465');
    fireEvent.click(screen.getByRole('button', { name: /待我处理/ }));
    fireEvent.click(screen.getByRole('button', { name: /查看审核/ }));
    const review = screen.getByRole('complementary', { name: '审核详情' });
    expect(within(review).getByRole('heading', { name: '过程中作出的判断' })).toBeTruthy();
    expect(within(review).getByRole('button', { name: '通过' })).toBeTruthy();
    expect(review.textContent).not.toMatch(registrationContent);
  });

  test('停止清理当前运行，旧计时器不能生成迟到的批准或结果', async () => {
    render(<PrototypeApp />);
    sendMessage();
    fireEvent.click(screen.getAllByRole('button', { name: '停止' })[0]!);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    });
    expect(screen.getByRole('region', { name: '对话记录' }).textContent).toContain('已停止');
    expect(screen.queryByRole('region', { name: '批准请求' })).toBeNull();
    expect(screen.queryByRole('button', { name: '审核' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /已执行\s*\d+\s*步/ }));
    expect(screen.getByRole('region', { name: '工具过程' }).textContent).not.toMatch(
      /记录经确认的笔误判断|核对原文并提交审核/,
    );
  });

  test('只读不更新维护提醒或发送催办，仍可读取和检查', async () => {
    render(<PrototypeApp />);
    fireEvent.click(screen.getByRole('button', { name: 'L08 年度注册' }));
    fireEvent.change(screen.getByRole('combobox', { name: '权限模式' }), {
      target: { value: 'read_only' },
    });
    sendMessage('核查企业注册、年费和美国代理人。');
    await screen.findByText(/只读检查已完成：/, {}, { timeout: 3_000 });
    const conversation = screen.getByRole('region', { name: '对话记录' });
    expect(conversation.textContent).not.toMatch(/已更新.*提醒|已(?:向.*?)?发送.*催办/);
    expect(screen.queryByRole('region', { name: '批准请求' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /已执行\s*\d+\s*步/ }));
    expect(screen.getByRole('region', { name: '工具过程' }).textContent).not.toMatch(
      /更新年度资料核对提醒|向内部同事.*发送催办/,
    );
  });

  test('运行中从完全允许切为请求批准，下一个写入动作先等人批准', async () => {
    render(<PrototypeApp />);
    fireEvent.click(screen.getByRole('button', { name: 'L08 年度注册' }));
    const mode = screen.getByRole('combobox', { name: '权限模式' });
    fireEvent.change(mode, { target: { value: 'full' } });
    sendMessage('核查年度注册资料，更新提醒并催办。');
    fireEvent.change(mode, { target: { value: 'ask' } });
    const approval = await approvalRequest();
    expect(approval.textContent).toMatch(/提醒|催办/);
    const conversation = screen.getByRole('region', { name: '对话记录' });
    expect(conversation.textContent).not.toMatch(/已更新.*提醒|已(?:向.*?)?发送.*催办/);
    expect(screen.queryByRole('button', { name: '审核' })).toBeNull();
  });

  test('等待批准时短暂切为完全允许再切回请求批准，仍须等待批准', async () => {
    render(<PrototypeApp />);
    fireEvent.click(screen.getByRole('button', { name: 'L08 年度注册' }));
    sendMessage('核查年度注册资料，更新提醒并催办。');
    await approvalRequest();
    const mode = screen.getByRole('combobox', { name: '权限模式' });
    fireEvent.change(mode, { target: { value: 'full' } });
    fireEvent.change(mode, { target: { value: 'ask' } });
    await approvalRequest();
    const conversation = screen.getByRole('region', { name: '对话记录' });
    expect(conversation.textContent).not.toMatch(/已更新.*提醒|已(?:向.*?)?发送.*催办/);
    expect(screen.queryByRole('button', { name: '审核' })).toBeNull();
  });

  test('新对话默认注册Agent和请求批准，可选择维护Agent，项目对话不切换Agent', () => {
    render(<PrototypeApp />);
    expect(screen.queryByRole('combobox', { name: '选择Agent' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '新对话' }));
    const agent = screen.getByRole('combobox', { name: '选择Agent' }) as HTMLSelectElement;
    expect(agent.value).toBe('registration');
    expect((screen.getByRole('combobox', { name: '权限模式' }) as HTMLSelectElement).value).toBe(
      'ask',
    );
    fireEvent.change(agent, { target: { value: 'maintenance' } });
    expect(screen.getByPlaceholderText('让维护Agent做什么？')).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: '原型角色' })).toBeNull();
    expect(screen.queryByText('我的报告请求')).toBeNull();
  });

  test('Ctrl+K搜索，Esc关闭右栏并回到触发按钮，回车发送而Shift+回车不发送', async () => {
    render(<PrototypeApp />);
    const styleCount = document.querySelectorAll('style').length;
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    const search = screen.getByRole('textbox', { name: '搜索项目或对话' });
    await waitFor(() => expect(document.activeElement).toBe(search));
    expect(document.querySelectorAll('style').length).toBe(styleCount);
    expect(screen.getByRole('dialog', { name: '搜索' }).getAttribute('aria-modal')).not.toBe(
      'true',
    );
    expect(document.body.hasAttribute('data-scroll-locked')).toBe(false);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '搜索' })).toBeNull());
    const input = screen.getByRole('textbox', { name: '给Agent的消息' });
    fireEvent.change(input, { target: { value: '检查L08申报资料中对比器械K号的写法' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(screen.queryByRole('button', { name: '停止' })).toBeNull();
    fireEvent.keyDown(input, { key: 'Enter' });
    const approval = await approvalRequest();
    fireEvent.click(within(approval).getByRole('button', { name: '允许' }));
    const trigger = await screen.findByRole('button', { name: '审核' }, { timeout: 3_000 });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole('complementary', { name: '审核详情' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('complementary', { name: '审核详情' })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  test('中文输入法确认候选的Enter不发送消息', () => {
    render(<PrototypeApp />);
    const input = screen.getByRole('textbox', { name: '给Agent的消息' });
    fireEvent.change(input, { target: { value: '检查资料' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(screen.queryByRole('button', { name: '停止' })).toBeNull();
    expect((input as HTMLTextAreaElement).value).toBe('检查资料');
  });

  test('运行中回车追加补充意见，保留原消息和原步骤进度而不重启计时', async () => {
    vi.useFakeTimers();
    try {
      render(<PrototypeApp />);
      sendMessage();
      await act(async () => {
        vi.advanceTimersByTime(250);
      });
      const input = screen.getByRole('textbox', { name: '给Agent的消息' });
      fireEvent.change(input, { target: { value: '请先保留两处原文，不改写原始资料。' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect((input as HTMLTextAreaElement).value).toBe('');
      expect(screen.getByText('检查L08申报资料中对比器械K号的写法')).toBeTruthy();
      expect(screen.getByText('请先保留两处原文，不改写原始资料。')).toBeTruthy();
      expect(screen.getByText(/已收到补充/)).toBeTruthy();
      expect(screen.getByRole('button', { name: '停止' })).toBeTruthy();
      await act(async () => {
        vi.advanceTimersByTime(400);
      });
      expect(screen.getByRole('region', { name: '批准请求' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  test('开发说明只在设置内出现，设置不注入样式且可用Esc关闭', async () => {
    render(<PrototypeApp />);
    const styleCount = document.querySelectorAll('style').length;
    expect(screen.queryByText(/界面稿.*待确认|示例数据.*未调用模型/)).toBeNull();
    expect(screen.queryByRole('combobox', { name: '原型角色' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: '演示高风险审核' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    const settings = screen.getByRole('dialog', { name: '设置' });
    expect(settings.textContent).toContain('所有资料和人物均为虚构示例');
    expect(settings.textContent).toContain('仅本地交互，不调用模型或后端');
    expect(document.querySelectorAll('style').length).toBe(styleCount);
    expect(settings.getAttribute('aria-modal')).not.toBe('true');
    expect(document.body.hasAttribute('data-scroll-locked')).toBe(false);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '设置' })).toBeNull());
  });

  test('退回修改后可提出意见并审核新工作区版本', async () => {
    render(<PrototypeApp />);
    const review = await completeRegistration();
    fireEvent.click(within(review).getByRole('button', { name: '退回修改' }));
    fireEvent.change(screen.getByLabelText('退回原因'), {
      target: { value: '请补充原始记录，再确认差异。' },
    });
    fireEvent.click(screen.getByRole('button', { name: '确认退回' }));
    sendMessage('请将差异保留为待确认，补充核对依据。');
    const approval = await approvalRequest();
    fireEvent.click(within(approval).getByRole('button', { name: '允许' }));
    const updated = await openReview();
    expect(updated.textContent).toMatch(/工作区第\s*2\s*版/);
    expect(within(updated).getByRole('heading', { name: '过程中作出的判断' })).toBeTruthy();
  });

  test('本对话中允许可继续本项目，不能替另一项目的内部催办批准', async () => {
    render(<PrototypeApp />);
    sendMessage();
    const registrationApproval = await approvalRequest();
    fireEvent.click(within(registrationApproval).getByRole('button', { name: '本对话中都允许' }));
    await openReview();
    sendMessage('请继续核对原文并重新整理结果。');
    await openReview();
    expect(screen.queryByRole('region', { name: '批准请求' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'L08 年度注册' }));
    sendMessage('核查年度注册资料并催办。');
    const maintenanceApproval = await approvalRequest();
    expect(maintenanceApproval.textContent).toContain('催办');
    expect(maintenanceApproval.textContent).not.toMatch(registrationContent);
  });

  test('消息反馈可说明原因并提交，不丢失原有反馈操作', async () => {
    render(<PrototypeApp />);
    await completeRegistration();
    const styleCount = document.querySelectorAll('style').length;
    fireEvent.click(screen.getAllByRole('button', { name: '没用' })[0]!);
    const feedback = screen.getByRole('dialog', { name: '反馈' });
    expect(document.querySelectorAll('style').length).toBe(styleCount);
    expect(feedback.getAttribute('aria-modal')).not.toBe('true');
    expect(document.body.hasAttribute('data-scroll-locked')).toBe(false);
    fireEvent.change(within(feedback).getByLabelText('反馈原因'), {
      target: { value: '请把引用的原文展示得更清楚。' },
    });
    fireEvent.click(within(feedback).getByRole('button', { name: '提交反馈' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '反馈' })).toBeNull());
    expect(screen.getByText('已记录反馈', { exact: true })).toBeTruthy();
  });

  test.each([
    ['尚未运行', false],
    ['只读检查完成', true],
  ] as const)('%s时从资料打开原文，不能凭导航生成审核结果', async (_state, readOnly) => {
    render(<PrototypeApp />);
    if (readOnly) {
      fireEvent.change(screen.getByRole('combobox', { name: '权限模式' }), {
        target: { value: 'read_only' },
      });
      sendMessage();
      await screen.findByText(/只读检查已完成：/, {}, { timeout: 3_000 });
    }
    fireEvent.mouseDown(screen.getByRole('tab', { name: '资料' }), { button: 0, ctrlKey: false });
    const documents = screen.getByRole('region', { name: '项目资料' });
    fireEvent.click(within(documents).getByRole('button', { name: /对比器械对照表/ }));
    const evidence = screen.getByRole('complementary', { name: '原文依据' });
    expect(evidence.textContent).toContain('REG-01');
    expect(within(evidence).queryByRole('button', { name: '返回审核' })).toBeNull();
    expect(screen.queryByRole('complementary', { name: '审核详情' })).toBeNull();
  });

  test('新对话发送不能覆盖项目中仍待批准的对话', async () => {
    render(<PrototypeApp />);
    sendMessage();
    await approvalRequest();
    fireEvent.click(screen.getByRole('button', { name: '新对话' }));
    sendMessage('新的检查请求，不得覆盖原有待批准对话。');
    expect(screen.getByText(/请先处理当前对话/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'L08 510(k)' }));
    expect(screen.getByRole('region', { name: '批准请求' }).textContent).toContain('K123465');
    const conversation = screen.getByRole('region', { name: '对话记录' });
    expect(conversation.textContent).toContain('检查L08申报资料中对比器械K号的写法');
    expect(conversation.textContent).not.toContain('新的检查请求，不得覆盖原有待批准对话。');
  });
});
