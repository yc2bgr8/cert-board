// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { PrototypeApp } from './PrototypeApp.js';

afterEach(cleanup);

function openQueuedReview() {
  fireEvent.click(screen.getByRole('button', { name: /待我处理/ }));
  fireEvent.click(screen.getByRole('button', { name: /对比器械 K 号写法核查/ }));
  return screen.getByRole('complementary', { name: '审核详情' });
}

async function openMaintenanceReview() {
  fireEvent.click(screen.getByRole('button', { name: 'L08 年度注册' }));
  fireEvent.click(screen.getByRole('button', { name: '查看核查结果' }));
  fireEvent.click(await screen.findByRole('button', { name: /查看审核卡/ }, { timeout: 3_000 }));
  return screen.getByRole('complementary', { name: '审核详情' });
}

const registrationContent = /K\s*号|K\d{6}|对比器械|示例对比表|示例摘要|predicate\s+device|510\(k\)/i;

describe('可点击界面稿', () => {
  test('检查、展开工具过程、提修改意见、审核第二版后通过', async () => {
    render(<PrototypeApp />);
    expect(screen.getByText('界面稿 · 待确认')).toBeTruthy();
    expect(screen.getByText('示例数据 · 未调用模型')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /开始检查/ }));
    await screen.findByRole('button', { name: /查看审核卡/ }, { timeout: 3_000 });
    fireEvent.click(screen.getByRole('button', { name: '已读取 2 份示例资料，完成 3 步检查' }));
    expect(screen.getByText('doc_search → doc_read')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /查看审核卡/ }));
    let review = screen.getByRole('complementary', { name: '审核详情' });
    for (const heading of [
      '结论',
      '需要你做什么',
      '改动',
      '关键依据',
      'AI 自检',
      '不确定事项',
      '操作',
    ]) {
      expect(within(review).getByRole('heading', { name: new RegExp(heading) })).toBeTruthy();
    }
    fireEvent.click(within(review).getByRole('button', { name: /\[1\] 示例对比表/ }));
    expect(screen.getByRole('heading', { name: '同一差异的两处来源' })).toBeTruthy();
    expect(screen.getByText('EXAMPLE-01 · v1 · 第 2 页')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('发送给器械认证Agent的消息'), {
      target: { value: '请把第1条列为待确认差异，补充资料来源。' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await screen.findByRole('button', { name: /工作区第 2 版.*查看审核卡/ }, { timeout: 3_000 });
    fireEvent.click(screen.getByRole('button', { name: /查看审核卡/ }));
    review = screen.getByRole('complementary', { name: '审核详情' });
    expect(within(review).getByText('工作区第 2 版 · 虚构示例')).toBeTruthy();
    fireEvent.click(within(review).getByRole('button', { name: '通过' }));
    expect(screen.getByRole('button', { name: /审核已通过/ })).toBeTruthy();
    expect(within(review).queryByRole('button', { name: '通过' })).toBeNull();
  });

  test('维护结果和待我处理入口能打开相应示例审核', async () => {
    render(<PrototypeApp />);
    fireEvent.click(screen.getByRole('button', { name: 'L08 年度注册' }));
    expect(screen.getByRole('heading', { name: '本次维护概览' })).toBeTruthy();
    expect(
      screen.getByText('这是演示提醒，不是真实逾期。请先核对依据，再确认维护状态。'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '查看核查结果' }));
    await screen.findByRole('button', { name: /查看审核卡/ }, { timeout: 3_000 });
    fireEvent.click(screen.getByRole('button', { name: '已读取 3 份示例资料，完成 3 步检查' }));
    expect(screen.getByText('读取项目说明与 M02 技能')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /查看审核卡/ }));
    expect(
      within(screen.getByRole('complementary', { name: '审核详情' })).getByRole('heading', {
        name: '年度维护核查',
      }),
    ).toBeTruthy();
    const review = openQueuedReview();
    expect(within(review).getByRole('heading', { name: '对比器械 K 号写法' })).toBeTruthy();
  });

  test('M02展开过程核查三项维护资料，不展示K号检查步骤', async () => {
    render(<PrototypeApp />);
    await openMaintenanceReview();
    const trigger = screen.getByRole('button', { name: /已读取.*份示例资料/ });
    fireEvent.click(trigger);
    const process = trigger.parentElement;
    expect(process?.textContent).not.toMatch(registrationContent);
    expect(process?.textContent).toContain('企业注册');
    expect(process?.textContent).toMatch(/年费|年度费用/);
    expect(process?.textContent).toContain('美国代理人');
  });

  test('M02审核依据和证据是三项维护来源，不复用注册K号证据', async () => {
    render(<PrototypeApp />);
    const review = await openMaintenanceReview();
    expect(review.textContent).not.toMatch(registrationContent);
    expect(within(review).getByRole('button', { name: /企业注册示例记录/ })).toBeTruthy();
    expect(within(review).getByRole('button', { name: /年费付款凭据示例/ })).toBeTruthy();
    expect(within(review).getByRole('button', { name: /美国代理人协议示例/ })).toBeTruthy();
    fireEvent.click(within(review).getByRole('button', { name: /^\[1\]/ }));
    const evidence = screen.getByRole('complementary', { name: '审核详情' });
    expect(evidence.textContent).not.toMatch(registrationContent);
    for (const name of ['企业注册示例记录', '年费付款凭据示例', '美国代理人协议示例']) {
      expect(within(evidence).getByRole('heading', { name })).toBeTruthy();
    }
    for (const id of ['MAINT-EXAMPLE-01', 'MAINT-EXAMPLE-02', 'MAINT-EXAMPLE-03']) {
      expect(evidence.textContent).toContain(id);
    }
  });

  test('M02改动对比与资料库展示维护记录，不复用注册检查文件', async () => {
    render(<PrototypeApp />);
    const review = await openMaintenanceReview();
    fireEvent.click(within(review).getByRole('button', { name: /(?:核查|检查)记录\.md/ }));
    const changes = screen.getByRole('complementary', { name: '审核详情' });
    expect(changes.textContent).not.toMatch(registrationContent);
    expect(within(changes).getByRole('heading', { name: '年度维护核查记录.md' })).toBeTruthy();
    expect(changes.textContent).toContain('企业注册');
    expect(changes.textContent).toMatch(/年费|年度费用/);
    expect(changes.textContent).toContain('美国代理人');
    fireEvent.mouseDown(screen.getByRole('tab', { name: /^资料/ }), { button: 0, ctrlKey: false });
    for (const name of ['企业注册示例记录', '年费付款凭据示例', '美国代理人协议示例']) {
      expect(screen.getByRole('button', { name: new RegExp(name) })).toBeTruthy();
    }
  });

  test('销售视图只展示合规报告和自己的示例请求', () => {
    render(<PrototypeApp />);
    fireEvent.change(screen.getByRole('combobox', { name: '原型角色' }), {
      target: { value: 'SALES' },
    });
    expect(screen.getByRole('heading', { name: '我的报告请求' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'L08 美国市场销售资料包' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /待我处理/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'L08 510(k)' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'L08 年度注册' })).toBeNull();
    expect(screen.queryByLabelText('发送给器械认证Agent的消息')).toBeNull();
  });

  test('高风险审核每个新版本都必须先提交独立判断', async () => {
    render(<PrototypeApp />);
    let review = openQueuedReview();
    fireEvent.click(within(review).getByRole('checkbox', { name: '演示高风险审核' }));
    expect(within(review).queryByRole('heading', { name: /结论/ })).toBeNull();
    expect(within(review).queryByRole('button', { name: '通过' })).toBeNull();
    fireEvent.change(within(review).getByLabelText('你的独立判断'), {
      target: { value: '需要补充原始资料后再判断。' },
    });
    fireEvent.click(within(review).getByRole('button', { name: '提交判断' }));
    expect(within(review).getByRole('heading', { name: /结论/ })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('发送给器械认证Agent的消息'), {
      target: { value: '请补充资料后重新提交。' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    fireEvent.click(
      await screen.findByRole('button', { name: /工作区第 2 版.*查看审核卡/ }, { timeout: 3_000 }),
    );
    review = screen.getByRole('complementary', { name: '审核详情' });
    expect(within(review).queryByRole('heading', { name: /结论/ })).toBeNull();
    expect((within(review).getByLabelText('你的独立判断') as HTMLTextAreaElement).value).toBe('');
  });

  test('停止后不会由旧计时器生成审核结果', async () => {
    render(<PrototypeApp />);
    fireEvent.click(screen.getByRole('button', { name: /开始检查/ }));
    fireEvent.click(screen.getByRole('button', { name: '停止' }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    });
    expect(screen.getByText('已停止')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /查看审核卡/ })).toBeNull();
  });

  test('文件、资料页签及反馈原因可操作', async () => {
    render(<PrototypeApp />);
    expect(screen.getByRole('tab', { name: /^文件/ }).textContent).toBe('文件1');
    fireEvent.mouseDown(screen.getByRole('tab', { name: /^文件/ }), { button: 0, ctrlKey: false });
    expect(screen.getByRole('heading', { name: '项目工作区' })).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole('tab', { name: /^资料/ }), { button: 0, ctrlKey: false });
    expect(screen.getByRole('heading', { name: '项目资料库' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /示例对比表.pdf/ }));
    expect(screen.getByRole('heading', { name: '同一差异的两处来源' })).toBeTruthy();
    const review = openQueuedReview();
    fireEvent.click(within(review).getByRole('button', { name: '没用' }));
    const dialog = screen.getByRole('dialog', { name: '告诉我们哪里没用' });
    fireEvent.change(within(dialog).getByLabelText('反馈原因'), {
      target: { value: '需要更清晰的来源。' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '提交反馈' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText(/已记录反馈原因/)).toBeTruthy();
  });
});
