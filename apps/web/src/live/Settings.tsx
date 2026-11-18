/// <reference types="vite/client" />
import { useRef, useState, type RefObject } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { PublicUser } from '@cert-board/shared';
import { errorMessage } from './api.js';
import { ShellIcon } from './ShellIcon.js';

export function Settings({
  open,
  onOpenChange,
  user,
  logout,
  returnFocus,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  user: PublicUser;
  logout(): Promise<void>;
  returnFocus: RefObject<HTMLElement | null>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  async function signOut() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await logout();
      onOpenChange(false);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <Dialog.Root modal={false} open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Content
          className="live-dialog"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocus.current?.focus();
          }}
        >
          <div className="live-dialog-heading">
            <Dialog.Title>设置</Dialog.Title>
            <Dialog.Close className="live-icon-button" aria-label="关闭设置">
              <ShellIcon name="close" />
            </Dialog.Close>
          </div>
          <Dialog.Description className="live-muted">当前账号与显示设置。</Dialog.Description>
          <dl className="live-settings-list">
            <dt>姓名</dt>
            <dd>{user.displayName}</dd>
            <dt>用户名</dt>
            <dd>{user.username}</dd>
            <dt>显示时间</dt>
            <dd>北京时间</dd>
            {user.isManagement && (
              <>
                <dt>系统维护权限</dt>
                <dd>已启用</dd>
              </>
            )}
          </dl>
          {error && (
            <p className="live-error" role="alert">
              {error}
            </p>
          )}
          <button
            className="live-secondary"
            type="button"
            aria-label="退出登录"
            disabled={busy}
            onClick={() => void signOut()}
          >
            {busy ? '正在退出…' : '退出登录'}
          </button>
          {import.meta.env.DEV && (
            <p className="live-development-note">
              开发环境。操作连接当前本地服务，结果请核对后使用。
            </p>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
