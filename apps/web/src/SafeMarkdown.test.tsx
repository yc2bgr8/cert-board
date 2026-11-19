// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { SafeMarkdown } from './SafeMarkdown.js';

afterEach(cleanup);

describe('模型 Markdown 显示安全', () => {
  test('正式界面显示 HTML 正文，隔离文档设置和可执行内容', () => {
    const markdown = [
      '<section><strong>报告片段</strong><style>p { color: red }</style></section>',
      '<link rel="alternate stylesheet" href="https://example.invalid/demo.css">',
      '<title>资料标题</title><meta name="description" content="资料摘要">',
      '<script async src="/assets/fixture.js"></script>',
      '<input type="file" value="样例.pdf">',
      '| 字段 | 结果 |\n| --- | --- |\n| 版本 | 已核对 |',
      '```javascript\nconst state = "review";\n```',
      '![示例](https://example.invalid/sample.png)',
    ].join('\n\n');
    const { container } = render(<SafeMarkdown workbench>{markdown}</SafeMarkdown>);
    expect(container.querySelector('section strong')?.textContent).toBe('报告片段');
    expect(container.querySelector('style, link')).toBeNull();
    expect(document.title).not.toBe('资料标题');
    expect(document.head.querySelector('meta[content="资料摘要"]')).toBeNull();
    expect(document.querySelector('script[src="/assets/fixture.js"]')).toBeNull();
    expect(container.querySelector<HTMLInputElement>('input[type="file"]')?.value).toBe('');
    expect(screen.getByRole('table')).toBeTruthy();
    expect(container.querySelector('code.hljs')?.textContent).toContain('const state');
    const image = screen.getByRole('img', { name: '示例' });
    expect(image.getAttribute('src')).toBe('https://example.invalid/sample.png');
    expect(image.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  test('脚注链接可在正文与注释之间往返', () => {
    const { container } = render(
      <>
        <SafeMarkdown workbench>{'已核对原文。[^1]\n\n[^1]: 资料 D001。'}</SafeMarkdown>
        <SafeMarkdown workbench>{'已核对次页。[^1]\n\n[^1]: 资料 D002。'}</SafeMarkdown>
      </>,
    );
    const references = screen.getAllByRole('link', { name: /^1$/ });
    expect(new Set(references.map((link) => link.id)).size).toBe(2);
    for (const [index, forward] of references.entries()) {
      const note = document.getElementById(forward.getAttribute('href')!.slice(1));
      const back = container.querySelectorAll('.footnotes a')[index];
      expect(note?.textContent).toContain(`资料 D00${index + 1}。`);
      expect(back?.getAttribute('href')).toBe(`#${forward.id}`);
      expect(back?.getAttribute('target')).toBeNull();
    }
  });
  test('保留普通Markdown和代码，原始HTML不成为页面元素', () => {
    const { container } = render(
      <SafeMarkdown>
        {
          '# 检查结果\n\n**需要核对**\n\n<script>alert(1)</script>\n\n<img src="/pixel" onerror="alert(1)">\n\n`<script>示例</script>`'
        }
      </SafeMarkdown>,
    );
    expect(screen.getByRole('heading', { name: '检查结果' }).tagName).toBe('H1');
    expect(container.querySelector('strong')?.textContent).toBe('需要核对');
    expect(container.querySelector('code')?.textContent).toBe('<script>示例</script>');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
  });

  test('禁止外部图片、本站图片和原始HTML中的资源', () => {
    const { container } = render(
      <SafeMarkdown>
        {
          '![外部](https://example.com/collect?document=secret)\n\n![本地](/private/file.png)\n\n<iframe src="https://example.com"></iframe>\n\n<link rel="stylesheet" href="https://example.com/style.css">'
        }
      </SafeMarkdown>,
    );
    expect(
      container.querySelector('img, iframe, link, video, audio, source, object, embed'),
    ).toBeNull();
    expect(container.innerHTML).not.toContain('https://example.com');
  });

  test('危险协议、相对路径和协议相对外链不会成为可点击链接', () => {
    const source = [
      'javascript:alert',
      'jav&#x61;script:alert',
      'data:text/html,evil',
      'file:///secret',
      '//example.com',
      '/api/private',
      '../private',
      'mailto:test@example.com',
      'https://user:password@example.com',
    ]
      .map((url, index) => `[链接${index}](${url})`)
      .join('\n\n');
    const { container } = render(<SafeMarkdown>{source}</SafeMarkdown>);
    expect(container.querySelector('a')).toBeNull();
  });

  test('外链明确提示外部网站且隔离新窗口，内部锚点保留', () => {
    render(
      <SafeMarkdown>
        {'[官方来源](https://example.com/source)\n\n[本页依据](#evidence)'}
      </SafeMarkdown>,
    );
    const external = screen.getByRole('link', { name: '官方来源（外部网站）' });
    expect(external.getAttribute('href')).toBe('https://example.com/source');
    expect(external.getAttribute('target')).toBe('_blank');
    expect(external.getAttribute('rel')).toBe('noopener noreferrer');
    expect(external.getAttribute('title')).toBe('点击后打开外部网站');
    const local = screen.getByRole('link', { name: '本页依据' });
    expect(local.getAttribute('href')).toBe('#evidence');
    expect(local.getAttribute('target')).toBeNull();
  });
});
