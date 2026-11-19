// 图形取自 docs/变更单/界面设计稿/logo/cert-board-glyph.svg。
export function Logo({ compact = false, large = false }: { compact?: boolean; large?: boolean }) {
  return (
    <span className={large ? 'live-brand live-brand-large' : 'live-brand'}>
      <span className="live-brand-mark" aria-hidden="true">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M15.89 6.18A7.6 7.6 0 1 0 15.89 17.82" strokeWidth="1.9" />
          <path d="M7.9 12.9L10.9 15.9L20.4 6.4" strokeWidth="2.1" />
        </svg>
      </span>
      {!compact && (
        <span>
          <span className="live-wordmark">
            cert<span>-</span>board
          </span>
          <small>器械认证工作台</small>
        </span>
      )}
    </span>
  );
}
