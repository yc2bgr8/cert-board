/// <reference types="vite/client" />
import { useRef, useState, type RefObject } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { PublicUser } from '@cert-board/shared';
import { errorMessage } from './api.js';
import { ShellIcon } from './ShellIcon.js';
import type { StreamConnection } from './useConversationStream.js';
import './pages.css';

const managementSections = [
  '预算与用量',
  '告警',
  '模型配置',
  '技能与 Agent 定义',
  '用户与权限',
  '目标与运行',
];

export function Settings({
  open,
  onOpenChange,
  user,
  logout,
  returnFocus,
  maintenance,
  onMaintenanceChange,
  notificationConnection,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  user: PublicUser;
  logout(): Promise<void>;
  returnFocus: RefObject<HTMLElement | null>;
  maintenance: boolean;
  onMaintenanceChange(value: boolean): void;
  notificationConnection: StreamConnection;
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
  const showMaintenance = user.isManagement && maintenance;
  const notificationStatus = {
    open: '已连接',
    connecting: '正在连接',
    reconnecting: '正在重连',
    closed: '暂未连接',
    error: '连接异常',
  }[notificationConnection];
  return (
    <Dialog.Root modal={false} open={open} onOpenChange={onOpenChange}>
      <Dialog.Content
        className="live-dialog live-settings-dock"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (returnFocus.current?.isConnected) returnFocus.current.focus();
          else document.querySelector<HTMLButtonElement>('.live-project-header button')?.focus();
        }}
      >
        <Dialog.Title className="sr-only">{showMaintenance ? '维护' : '设置'}</Dialog.Title>
        <Dialog.Description className="sr-only">
          {showMaintenance ? '管理权限和运维功能。' : '个人账号、通知与产品信息。'}
        </Dialog.Description>
        <div className="live-workspace-page">
          <div className="live-page-toolbar">
            {showMaintenance ? (
              <button
                type="button"
                className="live-text-button"
                onClick={() => onMaintenanceChange(false)}
              >
                返回设置
              </button>
            ) : (
              <span />
            )}
            <Dialog.Close className="live-icon-button" aria-label="关闭设置">
              <ShellIcon name="close" />
            </Dialog.Close>
          </div>
          {showMaintenance ? (
            <Maintenance user={user} />
          ) : (
            <div className="live-settings-columns">
              <nav className="live-page-card live-settings-nav" aria-label="设置分类">
                <a href="#account-current">个人与通知</a>
                {user.isManagement && (
                  <button type="button" onClick={() => onMaintenanceChange(true)}>
                    维护页
                  </button>
                )}
                <a href="#about-cert-board">关于</a>
              </nav>
              <div className="live-page-side">
                <section id="account-current" className="live-page-card">
                  <header className="live-page-card-head">
                    <h2>个人与通知</h2>
                  </header>
                  <dl className="live-settings-facts">
                    <div>
                      <dt>姓名</dt>
                      <dd>{user.displayName}</dd>
                    </div>
                    <div>
                      <dt>用户名</dt>
                      <dd>
                        <code>{user.username}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>站内通知</dt>
                      <dd>
                        <span className="live-notice-chip">{notificationStatus}</span>
                      </dd>
                    </div>
                    <div>
                      <dt>显示时间</dt>
                      <dd>北京时间</dd>
                    </div>
                    <div>
                      <dt>企业微信</dt>
                      <dd>尚未接入</dd>
                    </div>
                    <div>
                      <dt>日摘要</dt>
                      <dd>尚未接入</dd>
                    </div>
                  </dl>
                  {error && (
                    <p className="live-page-message live-error" role="alert">
                      {error}
                    </p>
                  )}
                  <button
                    className="live-secondary live-settings-signout"
                    type="button"
                    aria-label="退出登录"
                    disabled={busy}
                    onClick={() => void signOut()}
                  >
                    {busy ? '正在退出…' : '退出登录'}
                  </button>
                </section>
                <section id="about-cert-board" className="live-page-card">
                  <header className="live-page-card-head">
                    <h2>关于</h2>
                  </header>
                  <p className="live-page-message">cert-board · 器械认证工作台</p>
                  {import.meta.env.DEV && (
                    <p className="live-development-note live-page-message">
                      开发环境，连接本地服务。
                    </p>
                  )}
                </section>
              </div>
            </div>
          )}
        </div>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function Maintenance({ user }: { user: PublicUser }) {
  return (
    <div className="live-maintenance-grid">
      {managementSections.map((title) => (
        <section key={title} className="live-page-card">
          <header className="live-page-card-head">
            <h2>{title}</h2>
          </header>
          {title === '用户与权限' && (
            <p className="live-page-message">{user.displayName} · 管理权限已启用</p>
          )}
          <p className="live-page-message live-muted">
            {title === '用户与权限' ? '账号管理尚未接入。' : '尚未接入'}
          </p>
        </section>
      ))}
    </div>
  );
}
