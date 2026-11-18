import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AuthResponse } from '@cert-board/shared';
import {
  api,
  ApiError,
  errorMessage,
  setSessionCredentials,
  subscribeSessionExpired,
} from './api.js';

export type SessionState = {
  status: 'loading' | 'authenticated' | 'anonymous' | 'error';
  session: AuthResponse | null;
  error: string | null;
  login(username: string, password: string): Promise<void>;
  logout(): Promise<void>;
  refresh(): Promise<void>;
};
const SessionContext = createContext<SessionState | null>(null);
export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState<Pick<SessionState, 'status' | 'session' | 'error'>>({
    status: 'loading',
    session: null,
    error: null,
  });
  const operation = useRef(0);
  const clearQueries = useCallback(() => {
    void queryClient.cancelQueries();
    queryClient.clear();
  }, [queryClient]);
  const refresh = useCallback(async () => {
    const sequence = ++operation.current;
    try {
      const session = await api.me();
      if (sequence !== operation.current) return;
      setSessionCredentials(session);
      setValue({ status: 'authenticated', session, error: null });
    } catch (error) {
      if (sequence !== operation.current) return;
      setSessionCredentials(null);
      clearQueries();
      setValue({
        status: error instanceof ApiError && error.status === 401 ? 'anonymous' : 'error',
        session: null,
        error: error instanceof ApiError && error.status === 401 ? null : errorMessage(error),
      });
    }
  }, [clearQueries]);
  useEffect(() => {
    const unsubscribe = subscribeSessionExpired(() => {
      operation.current++;
      clearQueries();
      setValue({ status: 'anonymous', session: null, error: '登录已失效，请重新登录。' });
    });
    void refresh();
    return () => {
      operation.current++;
      unsubscribe();
      setSessionCredentials(null);
    };
  }, [refresh, clearQueries]);
  const login = useCallback(
    async (username: string, password: string) => {
      const sequence = ++operation.current;
      try {
        const session = await api.login(username, password);
        if (sequence !== operation.current) return;
        clearQueries();
        setSessionCredentials(session);
        setValue({ status: 'authenticated', session, error: null });
      } catch (error) {
        if (sequence === operation.current)
          setValue({ status: 'anonymous', session: null, error: errorMessage(error) });
        throw error;
      }
    },
    [clearQueries],
  );
  const logout = useCallback(async () => {
    await api.logout();
    operation.current++;
    setSessionCredentials(null);
    clearQueries();
    setValue({ status: 'anonymous', session: null, error: null });
  }, [clearQueries]);
  return createElement(
    SessionContext.Provider,
    { value: { ...value, login, logout, refresh } },
    children,
  );
}
export function useSession(): SessionState {
  const session = useContext(SessionContext);
  if (!session) throw new Error('登录状态组件尚未初始化。');
  return session;
}
