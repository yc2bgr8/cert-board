import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateDocs, renderDocument, renderInline } from './docs-html.mjs';

describe('离线文档转换', () => {
  it('保留中文、目录、表格、代码与嵌套列表', () => {
    const html = renderDocument(
      '# 中文文档\n\n## 检查\n\n## 检查\n\n| 字段 | 含义 |\n| --- | --- |\n| K号 | `K123456` |\n\n- 父项\n  - 子项\n- 第二项\n\n```html\n<script>危险</script>\n```',
    );
    expect(html).toContain('<title>中文文档</title>');
    expect(html).toContain('href="#检查-2"');
    expect(html).toContain('<td><code>K123456</code></td>');
    expect(html).toContain('<li>父项<ul><li>子项</li></ul></li>');
    expect(html).toContain('&lt;script&gt;危险&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('原始 HTML、属性注入和危险链接不会成为可执行内容', () => {
    expect(renderInline('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;');
    for (const target of [
      'javascript:alert',
      'data:text/html,test',
      'file:///secret',
      '//evil.test/x',
      '\\evil.test/x',
      'jav&#x61;script:alert',
    ]) {
      expect(renderInline(`[链接](${target})`)).not.toContain('href=');
    }
    expect(renderInline('!["危险](local.png)')).toContain('alt="&quot;危险"');
  });

  it('只加载相对图片，外部链接必须由人点击并明确标识', () => {
    expect(renderInline('![远程](https://example.com/pixel.png)')).not.toContain('<img');
    expect(renderInline('![本地](架构图.svg)')).toContain('src="架构图.svg"');
    expect(renderInline('[章节](../技术方案/说明.md#检查)')).toContain(
      'href="../技术方案/说明.html#检查"',
    );
    const external = renderInline('[来源](https://example.com/page)');
    expect(external).toContain('rel="noopener noreferrer"');
    expect(external).toContain('（外部链接）');
    expect(renderDocument('# 文档')).toContain("default-src 'none'");
  });

  it('遍历子目录生成同名 HTML，重复运行输出一致', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cert-board-docs-'));
    try {
      await mkdir(path.join(directory, '子目录'));
      await writeFile(path.join(directory, '子目录', '说明.md'), '# 示例\n\n正文', 'utf8');
      await writeFile(path.join(directory, '略过.txt'), '# 不生成', 'utf8');
      expect(await generateDocs(directory)).toBe(1);
      const filename = path.join(directory, '子目录', '说明.html');
      const before = await readFile(filename, 'utf8');
      expect(await generateDocs(directory)).toBe(1);
      expect(await readFile(filename, 'utf8')).toBe(before);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
