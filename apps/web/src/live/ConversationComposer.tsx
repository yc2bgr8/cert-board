// Adapted from Orca's NativeChatComposerToolbar and NativeChatComposerPrimaryButton.
// Source: https://github.com/stablyai/orca/tree/bc8085021b0a7e046925901a2f857361dd929686/src/renderer/src/components/native-chat/composer/controls
// Copyright (c) 2026 Lovecast Inc. MIT. See third_party/orca/LICENSE. Modified for cert-board.
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type FormEvent,
  type KeyboardEvent,
  type SetStateAction,
} from 'react';
import type { PermissionMode } from '@cert-board/shared';
import { ReferencePicker } from './ReferencePicker.js';
import { ShellIcon } from './ShellIcon.js';

const modes = {
  read_only: { label: '只读', description: '可以读取和分析资料，不能执行业务改动。' },
  ask: { label: '请求批准', description: '需要批准的动作先交给本对话发起人确认。' },
  full: { label: '完全允许', description: '允许执行可撤销的动作；对外动作仍需批准。' },
} satisfies Record<PermissionMode, { label: string; description: string }>;

const maxLength = 8000;
const referenceLine = /^资料引用：(.+)（文档编号 [\da-f-]{36}，第 [1-9]\d* 版）$/u;
const mentionAtEnd = /(?:^|\s)@$/u;

function splitDraft(text: string) {
  const lines = text.split('\n');
  const references = [];
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index] ?? '';
    const match = referenceLine.exec(line);
    if (!match) break;
    references.unshift({ line, label: match[1] ?? line });
    lines.pop();
  }
  return { body: lines.join('\n'), references };
}

function joinDraft(body: string, references: string[]) {
  return references.length ? [body, ...references].filter(Boolean).join('\n') : body;
}

function ComposerButton({
  variant = 'ghost',
  className = '',
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'ghost' | 'soft' | 'primary' }) {
  return (
    <button
      type={type}
      data-slot="button"
      data-variant={variant}
      className={`live-composer-button ${className}`}
      {...props}
    />
  );
}

type Props = {
  conversationId: string;
  projectId: string | null;
  text: string;
  setText(update: SetStateAction<string>): void;
  mode: PermissionMode;
  mayWrite: boolean;
  blocked: boolean;
  status: '发送' | '回复' | '插话';
  stopBusy: boolean;
  onSubmit(event: FormEvent): void;
  onMode(mode: PermissionMode): void;
  onStop?: (() => void) | undefined;
};

export function ConversationComposer({
  conversationId,
  projectId,
  text,
  setText,
  mode,
  mayWrite,
  blocked,
  status,
  stopBusy,
  onSubmit,
  onMode,
  onStop,
}: Props) {
  const form = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const activePopup = useRef<HTMLDivElement>(null);
  const [popup, setPopup] = useState<'references' | 'permissions' | null>(null);
  const [notice, setNotice] = useState<string>();
  const { body, references } = splitDraft(text);
  const referenceLines = references.map(({ line }) => line);
  const available = popup === 'permissions' ? mayWrite : mayWrite && !blocked && !!projectId;
  const visiblePopup = available ? popup : null;
  const reserved = referenceLines.length ? referenceLines.join('\n').length + 1 : 0;

  useLayoutEffect(() => {
    const node = input.current;
    if (!node) return;
    const measure = () => {
      node.style.height = '0px';
      node.style.height = `${Math.min(node.scrollHeight, 160)}px`;
    };
    measure();
    const container = form.current;
    if (typeof ResizeObserver === 'undefined' || !container) return;
    let width = container.clientWidth;
    const resize = new ResizeObserver(() => {
      if (width === container.clientWidth) return;
      width = container.clientWidth;
      measure();
    });
    resize.observe(container);
    return () => resize.disconnect();
  }, [body]);

  useLayoutEffect(() => {
    if (visiblePopup) activePopup.current?.querySelector<HTMLElement>('input, button')?.focus();
  }, [visiblePopup]);

  useEffect(() => {
    if (!visiblePopup) return;
    const outside = (event: PointerEvent) => {
      if (!form.current?.contains(event.target as Node)) setPopup(null);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [visiblePopup]);

  function closePopup() {
    setPopup(null);
    input.current?.focus();
  }

  function editBody(value: string, fromKeyboard: boolean) {
    const next = joinDraft(value, referenceLines);
    if (next.length > maxLength) {
      setNotice('消息和资料引用合计不得超过 8000 字。');
      return;
    }
    setText(next);
    setNotice(undefined);
    if (fromKeyboard && projectId && mayWrite && !blocked && mentionAtEnd.test(value))
      setPopup('references');
  }

  function addReference(line: string) {
    if (!mayWrite || blocked) return;
    const next = joinDraft(
      body.replace(/(^|\s)@$/u, '$1').trimEnd(),
      referenceLines.includes(line) ? referenceLines : [...referenceLines, line],
    );
    if (next.length > maxLength) {
      setNotice('消息和资料引用合计不得超过 8000 字。');
      return;
    }
    setText(next);
    setNotice(undefined);
    closePopup();
  }

  function keyboard(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing &&
      event.keyCode !== 229
    ) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <form
      ref={form}
      className="live-composer"
      onSubmit={(event) => {
        setPopup(null);
        onSubmit(event);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && visiblePopup) {
          event.preventDefault();
          event.stopPropagation();
          closePopup();
        }
      }}
    >
      {references.length > 0 && (
        <div className="live-composer-references" aria-label="已选资料">
          {references.map(({ line, label }, index) => (
            <span className="live-composer-reference" title={line} key={`${line}-${index}`}>
              <ShellIcon name="file" />
              <span>{label}</span>
              <ComposerButton
                type="button"
                aria-label={`移除 ${label}`}
                disabled={blocked}
                onClick={() => {
                  setText(
                    joinDraft(
                      body,
                      referenceLines.filter((_, i) => i !== index),
                    ),
                  );
                  setNotice(undefined);
                }}
              >
                <ShellIcon name="close" />
              </ComposerButton>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={input}
        aria-label="消息"
        rows={1}
        maxLength={Math.max(0, maxLength - reserved)}
        value={body}
        placeholder={
          blocked
            ? '请先处理批准请求'
            : status === '回复'
              ? '回复 Agent 的提问…'
              : projectId
                ? '输入消息，或用 @ 引用项目资料'
                : '输入消息…'
        }
        onChange={(event) =>
          editBody(event.target.value, !(event.nativeEvent as InputEvent).isComposing)
        }
        onKeyDown={keyboard}
        disabled={blocked}
      />
      <div className="live-composer-controls">
        <div className="live-permission">
          {projectId && (
            <ComposerButton
              variant="soft"
              className="live-composer-round"
              aria-label="添加资料引用"
              aria-haspopup="dialog"
              aria-expanded={visiblePopup === 'references'}
              title="引用项目资料"
              disabled={!mayWrite || blocked}
              onClick={() => {
                setPopup(visiblePopup === 'references' ? null : 'references');
                setNotice(undefined);
              }}
            >
              <ShellIcon name="plus" />
            </ComposerButton>
          )}
          <ComposerButton
            className="live-composer-mode"
            aria-label="权限模式"
            aria-haspopup="dialog"
            aria-expanded={visiblePopup === 'permissions'}
            title={modes[mode].description}
            disabled={!mayWrite}
            onClick={() => setPopup(visiblePopup === 'permissions' ? null : 'permissions')}
          >
            <ShellIcon name="shield" />
            <span>{modes[mode].label}</span>
            <ShellIcon name="chevronDown" />
          </ComposerButton>
        </div>
        <div className="live-composer-actions">
          <span className="live-composer-hint">Shift + Enter 换行</span>
          {onStop && (
            <ComposerButton
              variant="soft"
              className="live-composer-round"
              aria-label="停止"
              title="停止"
              disabled={stopBusy}
              onClick={onStop}
            >
              <ShellIcon name="stop" />
            </ComposerButton>
          )}
          <ComposerButton
            variant="primary"
            className="live-composer-round"
            type="submit"
            aria-label={status}
            title={status}
            disabled={!mayWrite || !text.trim() || blocked}
            onMouseDown={(event) => {
              if (event.button === 0) {
                event.preventDefault();
                input.current?.focus();
              }
            }}
          >
            <ShellIcon name="arrowUp" />
          </ComposerButton>
        </div>
      </div>
      {visiblePopup === 'references' && projectId && (
        <div ref={activePopup} className="live-composer-popup">
          <ReferencePicker
            projectId={projectId}
            conversationId={conversationId}
            onSelect={addReference}
            onClose={closePopup}
          />
        </div>
      )}
      {visiblePopup === 'permissions' && (
        <div
          ref={activePopup}
          className="live-composer-popup live-mode-popup"
          role="dialog"
          aria-label="切换权限模式"
        >
          {(Object.keys(modes) as PermissionMode[]).map((key) => (
            <button
              type="button"
              className="live-composer-option"
              key={key}
              aria-pressed={mode === key}
              onClick={() => {
                closePopup();
                if (key !== mode) onMode(key);
              }}
            >
              <span>
                <strong>{modes[key].label}</strong>
                <small>{modes[key].description}</small>
              </span>
              {mode === key && <ShellIcon name="check" />}
            </button>
          ))}
        </div>
      )}
      {notice && (
        <p className="live-command-error" role="alert">
          {notice}
        </p>
      )}
    </form>
  );
}
