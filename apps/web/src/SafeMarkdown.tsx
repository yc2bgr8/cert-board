import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import { useId } from 'react';
import rehypeRaw from 'rehype-raw';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import type { Element, Root } from 'hast';
import './workbench-markdown.css';

function removeEmbeddedStyles() {
  function clean(parent: Root | Element) {
    for (let index = parent.children.length - 1; index >= 0; index--) {
      const node = parent.children[index];
      if (node?.type !== 'element') continue;
      const rel = node.properties.rel;
      if (
        node.tagName === 'style' ||
        (node.tagName === 'link' &&
          (Array.isArray(rel) ? rel : String(rel ?? '').split(/\s+/)).some(
            (value) => String(value).toLowerCase() === 'stylesheet',
          ))
      ) {
        parent.children.splice(index, 1);
      } else clean(node);
    }
  }
  return (tree: Root) => clean(tree);
}

function safeLink(value: string | undefined): string | undefined {
  if (
    !value ||
    value.includes('\\') ||
    [...value].some((character) => character.charCodeAt(0) <= 32)
  ) {
    return undefined;
  }
  if (value.startsWith('#')) return value;
  if (!/^https?:\/\//i.test(value)) return undefined;
  try {
    const target = new URL(value);
    if (!target.hostname || target.username || target.password) return undefined;
    return target.href;
  } catch {
    return undefined;
  }
}

function imageSource(value: string) {
  if (/^data:image\/(?:png|jpeg|gif|webp|avif|svg\+xml);/i.test(value) || value.startsWith('blob:'))
    return value;
  if (value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')) return value;
  const target = safeLink(value);
  return target?.startsWith('https:') ? target : '';
}

export function SafeMarkdown({
  children,
  workbench = false,
}: {
  children: string;
  workbench?: boolean;
}) {
  const footnotePrefix = `note-${useId()}-`;
  const plugins = workbench
    ? {
        remarkPlugins: [remarkGfm],
        remarkRehypeOptions: { clobberPrefix: footnotePrefix },
        rehypePlugins: [rehypeRaw, removeEmbeddedStyles, rehypeHighlight],
      }
    : {
        skipHtml: true,
        allowedElements: [
          'p',
          'br',
          'strong',
          'em',
          'del',
          'code',
          'pre',
          'blockquote',
          'ul',
          'ol',
          'li',
          'hr',
          'a',
          'h1',
          'h2',
          'h3',
          'h4',
          'h5',
          'h6',
          'table',
          'thead',
          'tbody',
          'tr',
          'th',
          'td',
        ],
      };
  return (
    <div className={workbench ? 'markdown-content workbench-markdown' : 'markdown-content'}>
      <ReactMarkdown
        {...plugins}
        urlTransform={(url, key, node) => {
          if (node.tagName === 'a' && key === 'href') return safeLink(url) ?? '';
          if (workbench && node.tagName === 'img' && key === 'src') return imageSource(url);
          return workbench ? defaultUrlTransform(url) : '';
        }}
        components={{
          // 正文不能把文档元数据或可执行脚本提升到工作台的 head。
          base: () => null,
          meta: () => null,
          title: () => null,
          link: () => null,
          script: () => null,
          input({ node: _node, type, value, defaultValue, ...input }) {
            // 浏览器只允许用户为文件选择器赋值。
            if (type?.toLowerCase() === 'file') return <input {...input} type="file" disabled />;
            return <input {...input} type={type} defaultValue={defaultValue ?? value} />;
          },
          img({ node: _node, src, alt, ...image }) {
            return workbench && src ? (
              <img
                {...image}
                src={src}
                alt={alt ?? ''}
                loading="lazy"
                decoding="async"
                referrerPolicy="no-referrer"
              />
            ) : null;
          },
          a({
            href,
            id,
            children: label,
            'aria-describedby': describedBy,
            'aria-label': labelText,
          }) {
            const target = safeLink(href);
            if (!target) return <span>{label}</span>;
            if (target.startsWith('#'))
              return (
                <a href={target} id={id} aria-describedby={describedBy} aria-label={labelText}>
                  {label}
                </a>
              );
            return (
              <a href={target} target="_blank" rel="noopener noreferrer" title="点击后打开外部网站">
                {label}
                <span className="external-link-notice">（外部网站）</span>
              </a>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
