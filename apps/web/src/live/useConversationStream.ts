import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, subscribeSessionExpired } from './api.js';
import {
  conversationEventNames,
  initialConversationState,
  parseConversationEvent,
  reduceConversationEvent,
  type ConversationStreamState,
} from './events.js';

export type StreamConnection = 'connecting' | 'open' | 'reconnecting' | 'closed' | 'error';
export function useConversationStream(conversationId: string | null, enabled = true) {
  const [revision, setRevision] = useState(0);
  const [value, setValue] = useState<{
    state: ConversationStreamState;
    connection: StreamConnection;
    error: string | null;
  }>({ state: initialConversationState(null), connection: 'closed', error: null });
  const epoch = useRef(0);
  const reconnect = useCallback(() => setRevision((current) => current + 1), []);
  useEffect(() => {
    const generation = ++epoch.current;
    let state = initialConversationState(conversationId);
    let source: EventSource | undefined;
    let checking = false;
    let closed = false;
    const active = () => !closed && epoch.current === generation;
    const update = (connection: StreamConnection, error: string | null = null) => {
      if (active()) setValue({ state, connection, error });
    };
    const unsubscribe = subscribeSessionExpired(() => {
      source?.close();
      state = initialConversationState(conversationId);
      update('closed', '登录已失效，请重新登录。');
      closed = true;
    });
    if (!enabled || !conversationId) update('closed');
    else {
      update('connecting');
      source = new EventSource(
        `/api/conversations/${encodeURIComponent(conversationId)}/events?afterSeq=0`,
      );
      source.onopen = () => update('open');
      for (const name of conversationEventNames)
        source.addEventListener(name, ((message: MessageEvent<string>) => {
          if (!active()) return;
          try {
            state = reduceConversationEvent(
              state,
              parseConversationEvent(message.data, name, message.lastEventId),
            );
            update('open');
          } catch {
            source?.close();
            update('error', '对话记录格式或顺序未能确认，请重新连接以完整读取。');
            closed = true;
          }
        }) as EventListener);
      source.onerror = () => {
        if (!active()) return;
        update(
          source?.readyState === 2 ? 'error' : 'reconnecting',
          source?.readyState === 2
            ? '连接已关闭，请重新连接以完整读取对话。'
            : '连接暂时中断，正在从最后一条记录恢复。',
        );
        if (checking) return;
        checking = true;
        void api
          .me()
          .catch((error: unknown) => {
            if (active() && error instanceof ApiError && error.status === 401) {
              source?.close();
              state = initialConversationState(conversationId);
              update('closed', '登录已失效，请重新登录。');
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
  }, [conversationId, enabled, revision]);
  const visible =
    enabled && value.state.conversationId === conversationId
      ? value
      : {
          state: initialConversationState(conversationId),
          connection: enabled && conversationId ? ('connecting' as const) : ('closed' as const),
          error: null,
        };
  return { ...visible, reconnect };
}
