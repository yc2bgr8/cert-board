// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ConversationComposer } from './ConversationComposer.js';

afterEach(cleanup);

const reference = '资料引用：D035（文档编号 aaaa0000-1111-4222-8333-bbbbbbbbbbbb，第 1 版）';

it('引用在草稿和请求中保持原格式，修改正文或移除引用互不影响', () => {
  const send = vi.fn();
  function Fixture() {
    const [draft, setDraft] = useState(`原来的正文\n${reference}`);
    return (
      <ConversationComposer
        conversationId="c1"
        projectId="p1"
        text={draft}
        setText={setDraft}
        mode="full"
        mayWrite
        blocked={false}
        status="发送"
        stopBusy={false}
        onSubmit={(event) => {
          event.preventDefault();
          send(draft);
        }}
        onMode={() => {}}
      />
    );
  }
  render(<Fixture />);
  const textbox = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '消息' });
  expect(textbox.value).toBe('原来的正文');
  fireEvent.change(textbox, { target: { value: '更新后的正文' } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  expect(send).toHaveBeenLastCalledWith(`更新后的正文\n${reference}`);
  fireEvent.click(screen.getByRole('button', { name: '移除 D035' }));
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  expect(send).toHaveBeenLastCalledWith('更新后的正文');
});
