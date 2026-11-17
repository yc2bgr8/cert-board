import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const css = `
:root{color-scheme:light;--ink:#223548;--muted:#5b6b7b;--line:#d9dde2;--soft:#eef1f4;--blue:#0057d2}
*{box-sizing:border-box}body{margin:0;color:var(--ink);background:#f5f6f7;font:15px/1.7 "Segoe UI","Microsoft YaHei",sans-serif}
.layout{display:grid;grid-template-columns:270px minmax(0,1fr);max-width:1400px;margin:auto}
nav{position:sticky;top:0;height:100vh;overflow:auto;padding:24px 16px;border-right:1px solid var(--line);background:white;font-size:13px}
nav a{display:block;padding:3px 6px;text-decoration:none}nav .level-3{padding-left:20px}
main{min-width:0;padding:32px 48px 80px;background:white}h1{font-size:28px}h2{margin-top:40px;border-bottom:2px solid var(--soft)}
h3{margin-top:28px}h4{padding:6px 10px;background:#ebf8ff;border-left:3px solid var(--blue)}
p{margin:8px 0}a{color:var(--blue)}table{border-collapse:collapse;width:100%;font-size:13px;margin:12px 0}
th,td{border:1px solid var(--line);padding:6px 9px;vertical-align:top;text-align:left}th{background:#f5f6f7}
code{font-family:Consolas,"Microsoft YaHei",monospace;font-size:13px;background:var(--soft);padding:1px 4px;border-radius:3px}
pre{overflow:auto;background:#f5f6f7;border:1px solid var(--line);padding:12px;border-radius:6px}pre code{padding:0;background:none}
blockquote{margin:12px 0;padding:8px 14px;border-left:3px solid #8396a8;background:#fafbfc}
img{max-width:100%;height:auto}.blocked,.footer{color:var(--muted);font-size:13px}.footer{margin-top:48px;border-top:1px solid var(--line);padding-top:10px}
@media(max-width:800px){.layout{display:block}nav{position:static;height:auto;max-height:220px}main{padding:24px}}
@media print{body{background:white;font-size:11pt}.layout{display:block}nav{display:none}main{padding:0}h2,h3{break-after:avoid}table,blockquote{break-inside:avoid}}
`;

export function escapeHtml(value) {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
}

function safeUrl(value, image) {
  const url = value.trim().normalize('NFC');
  if (
    !url ||
    [...url].some((char) => char.codePointAt(0) <= 32 || char.codePointAt(0) === 127) ||
    url.includes('\\') ||
    url.startsWith('/')
  )
    return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    if (image || !/^https?:\/\//i.test(url)) return null;
    try {
      const parsed = new URL(url);
      if (!parsed.hostname || parsed.username || parsed.password) return null;
      return { url, external: true };
    } catch {
      return null;
    }
  }
  if (url.includes(':') || url.includes('&')) return null;
  return { url: image ? url : url.replace(/\.md(?=$|[?#])/i, '.html'), external: false };
}

export function renderInline(value) {
  const pattern =
    /`([^`\n]+)`|!\[([^\]\n]*)\]\(([^)\n]+)\)|\[([^\]\n]+)\]\(([^)\n]+)\)|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*/g;
  let result = '';
  let offset = 0;
  for (const match of value.matchAll(pattern)) {
    result += escapeHtml(value.slice(offset, match.index));
    if (match[1] !== undefined) {
      result += `<code>${escapeHtml(match[1])}</code>`;
    } else if (match[2] !== undefined) {
      const target = safeUrl(match[3], true);
      result += target
        ? `<img alt="${escapeHtml(match[2])}" src="${escapeHtml(target.url)}" loading="lazy">`
        : `<span class="blocked">[图片未加载：${escapeHtml(match[2])}]</span>`;
    } else if (match[4] !== undefined) {
      const target = safeUrl(match[5], false);
      result += target
        ? `<a href="${escapeHtml(target.url)}"${target.external ? ' target="_blank" rel="noopener noreferrer" title="点击后打开外部网站"' : ''}>${escapeHtml(match[4])}${target.external ? '（外部链接）' : ''}</a>`
        : escapeHtml(match[4]);
    } else if (match[6] !== undefined) {
      result += `<strong>${renderInline(match[6])}</strong>`;
    } else {
      result += `<em>${escapeHtml(match[7])}</em>`;
    }
    offset = match.index + match[0].length;
  }
  return result + escapeHtml(value.slice(offset));
}

function tableCells(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

function listMatch(line) {
  return /^( *)([-+*]|\d+\.) (.*)$/.exec(line);
}

function renderList(items) {
  let cursor = 0;
  function level(indent, ordered) {
    const tag = ordered ? 'ol' : 'ul';
    let html = `<${tag}>`;
    while (
      cursor < items.length &&
      items[cursor].indent === indent &&
      items[cursor].ordered === ordered
    ) {
      html += `<li>${renderInline(items[cursor].text)}`;
      cursor++;
      while (cursor < items.length && items[cursor].indent > indent) {
        html += level(items[cursor].indent, items[cursor].ordered);
      }
      html += '</li>';
    }
    return html + `</${tag}>`;
  }
  let result = '';
  while (cursor < items.length) result += level(items[cursor].indent, items[cursor].ordered);
  return result;
}

export function renderDocument(markdown) {
  const lines = markdown.replace(/^\uFEFF/, '').split(/\r?\n/);
  const output = [];
  const toc = [];
  const identifiers = new Set();
  let title = '文档';
  let foundTitle = false;
  let index = 0;
  const isBlock = (line) => /^(#{1,6} |\s*```|\||>|\s*(?:[-+*]|\d+\.) |---+$)/.test(line);
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index++;
      continue;
    }
    if (/^\s*```/.test(line)) {
      const content = [];
      index++;
      while (index < lines.length && !/^\s*```/.test(lines[index])) content.push(lines[index++]);
      index++;
      output.push(`<pre><code>${escapeHtml(content.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6}) (.+)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2].trim();
      const plain = text.replace(/[*`]/g, '');
      if (level === 1 && !foundTitle) {
        title = plain;
        foundTitle = true;
      }
      const base =
        plain
          .normalize('NFC')
          .toLowerCase()
          .replace(/[^\p{L}\p{N}_-]+/gu, '-')
          .replace(/^-|-$/g, '') || 'section';
      let identifier = base;
      let counter = 2;
      while (identifiers.has(identifier)) identifier = `${base}-${counter++}`;
      identifiers.add(identifier);
      if (level === 2 || level === 3)
        toc.push(
          `<a class="level-${level}" href="#${escapeHtml(identifier)}">${escapeHtml(plain)}</a>`,
        );
      output.push(`<h${level} id="${escapeHtml(identifier)}">${renderInline(text)}</h${level}>`);
      index++;
      continue;
    }
    if (line.startsWith('|')) {
      const rows = [];
      while (index < lines.length && lines[index].startsWith('|')) {
        const cells = tableCells(lines[index++]);
        if (!cells.every((cell) => /^:?-+:?$/.test(cell))) rows.push(cells);
      }
      if (rows.length)
        output.push(
          `<table><thead><tr>${rows[0].map((cell) => `<th>${renderInline(cell)}</th>`).join('')}</tr></thead><tbody>${rows
            .slice(1)
            .map(
              (cells) =>
                `<tr>${cells.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`,
            )
            .join('')}</tbody></table>`,
        );
      continue;
    }
    if (listMatch(line)) {
      const items = [];
      while (index < lines.length) {
        const match = listMatch(lines[index]);
        if (!match) break;
        items.push({ indent: match[1].length, ordered: /\d/.test(match[2]), text: match[3] });
        index++;
      }
      output.push(renderList(items));
      continue;
    }
    if (line.startsWith('>')) {
      const quote = [];
      while (index < lines.length && lines[index].startsWith('>'))
        quote.push(renderInline(lines[index++].replace(/^> ?/, '')));
      output.push(`<blockquote><p>${quote.join('<br>')}</p></blockquote>`);
      continue;
    }
    if (/^---+$/.test(line.trim())) {
      output.push('<hr>');
      index++;
      continue;
    }
    const paragraph = [line.trim()];
    index++;
    while (index < lines.length && lines[index].trim() && !isBlock(lines[index]))
      paragraph.push(lines[index++].trim());
    output.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
  }
  return `<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escapeHtml(title)}</title><style>${css}</style></head><body><div class="layout"><nav aria-label="目录"><strong>目录</strong>${toc.join('')}</nav><main>${output.join('\n')}<div class="footer">由 Markdown 源文件生成，修改请编辑同名 .md 文件后重新生成。</div></main></div></body></html>\n`;
}

export async function generateDocs(directory) {
  let count = 0;
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    const normalized = new Set();
    for (const entry of entries.sort((a, b) =>
      a.name.normalize('NFC').localeCompare(b.name.normalize('NFC')),
    )) {
      const name = entry.name.normalize('NFC');
      if (normalized.has(name)) throw new Error(`文件名规范化后重复：${current}`);
      normalized.add(name);
      const filename = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(filename);
      else if (entry.isFile() && /\.md$/i.test(name)) {
        const html = renderDocument(await readFile(filename, 'utf8'));
        await writeFile(filename.replace(/\.md$/i, '.html'), html, 'utf8');
        count++;
      }
    }
  }
  await walk(directory);
  return count;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = path.resolve(process.argv[2] ?? 'docs');
  const count = await generateDocs(directory);
  console.log(`已生成 ${count} 份离线 HTML 文档。`);
}
