import ReactMarkdown from 'react-markdown';

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

export function SafeMarkdown({ children }: { children: string }) {
  return (
    <div className="markdown-content">
      <ReactMarkdown
        skipHtml
        allowedElements={[
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
        ]}
        urlTransform={(url, key) => (key === 'href' ? (safeLink(url) ?? '') : '')}
        components={{
          a({ href, children: label }) {
            const target = safeLink(href);
            if (!target) return <span>{label}</span>;
            if (target.startsWith('#')) return <a href={target}>{label}</a>;
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
