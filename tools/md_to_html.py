"""把需求文档等 Markdown 转成单文件 HTML（离线可用，带目录，可打印）。

用法：python md_to_html.py <输入.md> [输出.html]
支持本工作区文档用到的语法：#–####标题、段落、**粗体**、`代码`、[链接](地址)、![图](路径)、
无序列表（可嵌套）、有序列表、表格、引用块、代码块。
"""
import html
import re
import sys
from pathlib import Path

CSS = """
:root { --ink:#223548; --ink2:#354a5f; --muted:#5b6b7b; --line:#d9dde2; --soft:#eef1f4; --primary:#0057d2; --band:#ebf8ff; }
* { box-sizing: border-box; }
body { margin: 0; font-family: "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif; color: var(--ink); background: #f5f6f7; line-height: 1.7; font-size: 15px; }
.layout { display: grid; grid-template-columns: 280px minmax(0, 1fr); max-width: 1400px; margin: 0 auto; }
nav { position: sticky; top: 0; height: 100vh; overflow: auto; padding: 24px 16px; border-right: 1px solid var(--line); background: #fff; font-size: 13px; }
nav .title { font-weight: 600; margin-bottom: 12px; color: var(--ink); }
nav a { display: block; color: var(--ink2); text-decoration: none; padding: 3px 6px; border-radius: 4px; }
nav a:hover { background: var(--band); color: var(--primary); }
nav a.l3 { padding-left: 20px; color: var(--muted); }
main { padding: 32px 48px 80px; background: #fff; min-width: 0; }
h1 { font-size: 28px; margin: 0 0 16px; }
h2 { font-size: 21px; margin: 40px 0 12px; padding-bottom: 6px; border-bottom: 2px solid var(--soft); }
h3 { font-size: 17px; margin: 28px 0 10px; }
h4 { font-size: 15.5px; margin: 22px 0 8px; padding: 6px 10px; background: var(--band); border-left: 3px solid var(--primary); border-radius: 4px; }
p { margin: 8px 0; }
p.meta { margin: 2px 0; color: var(--muted); font-size: 13.5px; }
ul, ol { margin: 6px 0 10px; padding-left: 24px; }
li { margin: 3px 0; }
table { border-collapse: collapse; width: 100%; margin: 10px 0 16px; font-size: 13.5px; }
th, td { border: 1px solid var(--line); padding: 6px 9px; vertical-align: top; text-align: left; }
th { background: #f5f6f7; font-weight: 600; }
tr:nth-child(even) td { background: #fafbfc; }
code { font-family: Consolas, "Microsoft YaHei", monospace; font-size: 13px; background: var(--soft); padding: 1px 5px; border-radius: 4px; }
pre { background: #f5f6f7; border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; overflow: auto; }
pre code { background: none; padding: 0; }
blockquote { margin: 10px 0; padding: 8px 14px; border-left: 3px solid #8396a8; background: #fafbfc; color: var(--ink2); }
blockquote p { margin: 4px 0; }
a { color: var(--primary); }
img { max-width: 100%; border: 1px solid var(--line); border-radius: 4px; }
.footer { margin-top: 48px; color: var(--muted); font-size: 12px; border-top: 1px solid var(--line); padding-top: 8px; }
@media print {
  body { background: #fff; font-size: 11pt; }
  .layout { display: block; }
  nav { display: none; }
  main { padding: 0; }
  h2 { page-break-after: avoid; }
  h4, table, blockquote { page-break-inside: avoid; }
}
"""


def inline(text):
    """转义后处理行内语法。"""
    codes = []

    def keep_code(m):
        codes.append(html.escape(m.group(1)))
        return f'\x00{len(codes) - 1}\x00'

    text = re.sub(r'`([^`]+)`', keep_code, text)
    text = html.escape(text, quote=False)
    text = re.sub(r'!\[([^\]]*)\]\(([^)]+)\)', r'<img alt="\1" src="\2">', text)
    text = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'<a href="\2">\1</a>', text)
    text = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', text)
    return re.sub(r'\x00(\d+)\x00', lambda m: f'<code>{codes[int(m.group(1))]}</code>', text)


def slug(text, used):
    base = re.sub(r'[^\w\u4e00-\u9fff]+', '-', text).strip('-').lower() or 'section'
    s, n = base, 2
    while s in used:
        s, n = f'{base}-{n}', n + 1
    used.add(s)
    return s


def convert(md):
    lines = md.splitlines()
    out, toc, used = [], [], set()
    title = '文档'
    i = 0

    def is_block_start(line):
        return bool(re.match(r'^(#{1,4} |\|| *- | *\d+\. |>|```)', line))

    while i < len(lines):
        line = lines[i]
        if not line.strip():
            i += 1
            continue
        if line.startswith('```'):
            buf = []
            i += 1
            while i < len(lines) and not lines[i].startswith('```'):
                buf.append(html.escape(lines[i]))
                i += 1
            out.append('<pre><code>' + '\n'.join(buf) + '</code></pre>')
            i += 1
            continue
        m = re.match(r'^(#{1,4}) (.+)$', line)
        if m:
            level, text = len(m.group(1)), m.group(2).strip()
            if level == 1:
                title = re.sub(r'\*\*', '', text)
                out.append(f'<h1>{inline(text)}</h1>')
            else:
                sid = slug(text, used)
                if level in (2, 3):
                    toc.append((level, sid, re.sub(r'\*\*', '', text)))
                out.append(f'<h{level} id="{sid}">{inline(text)}</h{level}>')
            i += 1
            continue
        if line.startswith('|'):
            rows = []
            while i < len(lines) and lines[i].startswith('|'):
                cells = [c.strip() for c in lines[i].strip().strip('|').split('|')]
                if not all(re.fullmatch(r':?-+:?', c) for c in cells):
                    rows.append(cells)
                i += 1
            head, body = rows[0], rows[1:]
            t = ['<table><thead><tr>' + ''.join(f'<th>{inline(c)}</th>' for c in head) + '</tr></thead><tbody>']
            t += ['<tr>' + ''.join(f'<td>{inline(c)}</td>' for c in r) + '</tr>' for r in body]
            out.append(''.join(t) + '</tbody></table>')
            continue
        if line.startswith('>'):
            buf, para = [], []
            while i < len(lines) and lines[i].startswith('>'):
                content = lines[i][1:].strip()
                if content:
                    para.append(inline(content))
                elif para:
                    buf.append('<p>' + '<br>'.join(para) + '</p>')
                    para = []
                i += 1
            if para:
                buf.append('<p>' + '<br>'.join(para) + '</p>')
            out.append('<blockquote>' + ''.join(buf) + '</blockquote>')
            continue
        if re.match(r'^ *- ', line):
            stack = []
            while i < len(lines) and re.match(r'^ *- ', lines[i]):
                indent = len(lines[i]) - len(lines[i].lstrip(' '))
                depth = indent // 2
                while len(stack) < depth + 1:
                    out.append('<ul>')
                    stack.append(depth)
                while len(stack) > depth + 1:
                    out.append('</ul>')
                    stack.pop()
                out.append(f'<li>{inline(lines[i].strip()[2:])}</li>')
                i += 1
            out.extend('</ul>' for _ in stack)
            continue
        if re.match(r'^\d+\. ', line):
            out.append('<ol>')
            while i < len(lines) and re.match(r'^\d+\. ', lines[i]):
                out.append(f'<li>{inline(re.sub(r"^\d+\. ", "", lines[i]))}</li>')
                i += 1
            out.append('</ol>')
            continue
        para = [line.strip()]
        i += 1
        while i < len(lines) and lines[i].strip() and not is_block_start(lines[i]):
            para.append(lines[i].strip())
            i += 1
        text = ' '.join(para)
        cls = ' class="meta"' if re.match(r'^(文档版本|编制日期|文档状态|适用对象|日期)：', text) else ''
        out.append(f'<p{cls}>{inline(text)}</p>')

    nav = ''.join(f'<a class="l{lv}" href="#{sid}">{html.escape(t)}</a>' for lv, sid, t in toc)
    return f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)}</title><style>{CSS}</style></head>
<body><div class="layout"><nav><div class="title">目录</div>{nav}</nav>
<main>{''.join(out)}<div class="footer">由 Markdown 源文件生成，修改请编辑同名 .md 文件后重新生成。</div></main></div></body></html>
"""


def main():
    src = Path(sys.argv[1])
    dst = Path(sys.argv[2]) if len(sys.argv) > 2 else src.with_suffix('.html')
    dst.write_text(convert(src.read_text(encoding='utf-8')), encoding='utf-8')
    print('HTML_CREATED', dst)


if __name__ == '__main__':
    main()
