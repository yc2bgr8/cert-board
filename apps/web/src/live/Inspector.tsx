import { useEffect, useRef, type ReactNode } from 'react';
import { ShellIcon } from './ShellIcon.js';

export interface InspectorEntry {
  key: number;
  label: string;
  content: ReactNode;
  wide?: boolean;
  flush?: boolean;
}
export function Inspector({
  entries,
  onBack,
  onClose,
}: {
  entries: InspectorEntry[];
  onBack(): void;
  onClose(): void;
}) {
  const close = useRef<HTMLButtonElement>(null);
  const current = entries.at(-1);
  useEffect(() => {
    if (current) close.current?.focus();
  }, [current?.key]);
  if (!current) return null;
  return (
    <aside className={`live-inspector${current.wide ? ' is-wide' : ''}`} aria-label={current.label}>
      <header className="live-inspector-navigation">
        <div className="live-inspector-heading">
          {entries.length > 1 && (
            <button className="live-text-button" type="button" onClick={onBack}>
              返回{entries.at(-2)!.label}
            </button>
          )}
          <strong>{current.label}</strong>
        </div>
        <button
          ref={close}
          className="live-icon-button"
          type="button"
          aria-label="关闭右栏"
          onClick={onClose}
        >
          <ShellIcon name="close" />
        </button>
      </header>
      {entries.map((entry, index) => (
        <div
          className={`live-inspector-page${entry.flush ? ' is-flush' : ''}`}
          key={entry.key}
          hidden={index !== entries.length - 1}
        >
          {entry.content}
        </div>
      ))}
    </aside>
  );
}
