import { useRef, useState, type FormEvent, type RefObject } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { ProjectRecord } from '@cert-board/shared';
import { api, createRequestKey, errorMessage } from './api.js';
import { ShellIcon } from './ShellIcon.js';

type Market = '' | ProjectRecord['market'];
const blank = { name: '', market: '' as Market, pathway: '' };

export function NewProject({
  open,
  onOpenChange,
  onCreated,
  returnFocus,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onCreated(project: ProjectRecord): void;
  returnFocus: RefObject<HTMLElement | null>;
}) {
  const [draft, setDraft] = useState(blank);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const sending = useRef(false);
  const completed = useRef(false);
  const intent = useRef<{ fingerprint: string; requestKey: string } | null>(null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending.current || !draft.market) return;
    const fields = { name: draft.name.trim(), market: draft.market, pathway: draft.pathway.trim() };
    if (!fields.name) {
      setError('请填写项目名称。');
      input.current?.focus();
      return;
    }
    const fingerprint = JSON.stringify(fields);
    if (intent.current?.fingerprint !== fingerprint)
      intent.current = { fingerprint, requestKey: createRequestKey() };
    sending.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.createRegistrationProject({
        ...fields,
        requestKey: intent.current.requestKey,
      });
      completed.current = true;
      setDraft(blank);
      intent.current = null;
      onCreated(result.project);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  return (
    <Dialog.Root
      modal={false}
      open={open}
      onOpenChange={(next) => {
        if (!sending.current) onOpenChange(next);
      }}
    >
      <Dialog.Content
        className="live-dialog live-new-project-dialog"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          completed.current = false;
          input.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (completed.current)
            document.querySelector<HTMLElement>('[data-project-start]')?.focus();
          else if (returnFocus.current?.isConnected) returnFocus.current.focus();
        }}
      >
        <header className="live-new-project-heading">
          <div>
            <Dialog.Title>新建注册项目</Dialog.Title>
            <Dialog.Description>建立独立工作区，并添加一个立项目标。</Dialog.Description>
          </div>
          <Dialog.Close aria-label="关闭新建项目" className="live-icon-button" disabled={busy}>
            <ShellIcon name="close" />
          </Dialog.Close>
        </header>
        <form onSubmit={(event) => void save(event)}>
          <fieldset disabled={busy}>
            <label>
              项目名称
              <input
                ref={input}
                value={draft.name}
                required
                maxLength={255}
                placeholder="例如：新器械北美注册"
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </label>
            <label>
              目标市场
              <select
                value={draft.market}
                required
                onChange={(event) => setDraft({ ...draft, market: event.target.value as Market })}
              >
                <option value="">请选择</option>
                <option value="US">美国</option>
                <option value="CA">加拿大</option>
                <option value="US_CA">美国与加拿大</option>
              </select>
            </label>
            <label>
              <span>
                申报路径 <small>选填</small>
              </span>
              <input
                value={draft.pathway}
                maxLength={120}
                placeholder="留空则记为待研判"
                onChange={(event) => setDraft({ ...draft, pathway: event.target.value })}
              />
            </label>
          </fieldset>
          {error && (
            <p className="live-error" role="alert">
              {error}
            </p>
          )}
          <footer className="live-new-project-actions">
            <Dialog.Close className="live-secondary" disabled={busy}>
              取消
            </Dialog.Close>
            <button type="submit" className="live-primary" disabled={busy}>
              {busy ? '正在建立工作区…' : '创建并打开项目'}
            </button>
          </footer>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}
