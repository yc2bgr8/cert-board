import { useEffect, useRef, useState } from 'react';
import { memberNotificationSnapshotSchema } from '@cert-board/shared';
import { api, ApiError, subscribeSessionExpired } from './api.js';
import type { StreamConnection } from './useConversationStream.js';

export type MemberNotificationSnapshot = ReturnType<typeof memberNotificationSnapshotSchema.parse>;
export function useMemberNotifications(enabled = true) {
  const [value, setValue] = useState<{
    snapshot: MemberNotificationSnapshot | null;
    connection: StreamConnection;
    error: string | null;
  }>({ snapshot: null, connection: 'closed', error: null });
  const epoch = useRef(0);
  useEffect(() => {
    const generation = ++epoch.current;
    let source: EventSource | undefined,
      closed = false,
      checking = false;
    const active = () => !closed && epoch.current === generation;
    const unsubscribe = subscribeSessionExpired(() => {
      source?.close();
      if (active())
        setValue({ snapshot: null, connection: 'closed', error: '登录已失效，请重新登录。' });
      closed = true;
    });
    setValue({ snapshot: null, connection: enabled ? 'connecting' : 'closed', error: null });
    if (enabled) {
      source = new EventSource('/api/me/stream');
      source.onopen = () => {
        if (active()) setValue((current) => ({ ...current, connection: 'open', error: null }));
      };
      source.addEventListener('pending_snapshot', ((message: MessageEvent<string>) => {
        if (!active()) return;
        try {
          const snapshot = memberNotificationSnapshotSchema.parse(JSON.parse(message.data));
          if (message.lastEventId) throw new Error('snapshot_cursor');
          setValue({ snapshot, connection: 'open', error: null });
        } catch {
          source?.close();
          setValue({
            snapshot: null,
            connection: 'error',
            error: '待处理通知格式不完整，请重新打开页面。',
          });
          closed = true;
        }
      }) as EventListener);
      source.onerror = () => {
        if (!active()) return;
        setValue((current) => ({
          ...current,
          connection: source?.readyState === 2 ? 'error' : 'reconnecting',
          error:
            source?.readyState === 2
              ? '通知连接已关闭，请重新打开页面。'
              : '通知连接暂时中断，正在重连。',
        }));
        if (checking) return;
        checking = true;
        void api
          .me()
          .catch((error: unknown) => {
            if (active() && error instanceof ApiError && error.status === 401) {
              source?.close();
              setValue({ snapshot: null, connection: 'closed', error: '登录已失效，请重新登录。' });
              closed = true;
            }
          })
          .finally(() => {
            checking = false;
          });
      };
    }
    return () => {
      closed = true;
      source?.close();
      unsubscribe();
    };
  }, [enabled]);
  return enabled ? value : { snapshot: null, connection: 'closed' as const, error: null };
}
