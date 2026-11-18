import { useRef, useState, type FormEvent } from 'react';
import { errorMessage } from './api.js';

export function Login({
  login,
  error,
}: {
  login(username: string, password: string): Promise<void>;
  error: string | null;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const inFlight = useRef(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    if (!username.trim() || password.length < 16) {
      setLocalError('请填写用户名和至少16个字符的密码。');
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setLocalError(null);
    try {
      await login(username.trim(), password);
    } catch (failure) {
      setLocalError(errorMessage(failure));
    } finally {
      setPassword('');
      setBusy(false);
      inFlight.current = false;
    }
  }
  return (
    <main className="live-login">
      <form className="live-login-form" method="post" onSubmit={(event) => void submit(event)}>
        <h1>器械认证</h1>
        <p className="live-muted">登录后进入项目，查看资料、交代工作和审核结果。</p>
        <label htmlFor="live-username">用户名</label>
        <input
          id="live-username"
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          value={username}
          onChange={(event) => {
            setUsername(event.target.value);
            setLocalError(null);
          }}
          maxLength={80}
          required
          autoFocus
          disabled={busy}
        />
        <label htmlFor="live-password">密码</label>
        <input
          id="live-password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            setLocalError(null);
          }}
          minLength={16}
          maxLength={256}
          required
          disabled={busy}
        />
        {(localError || error) && (
          <p className="live-error" role="alert">
            {localError ?? error}
          </p>
        )}
        <button
          className="live-primary"
          type="submit"
          aria-label="登录"
          aria-busy={busy}
          disabled={busy}
        >
          {busy ? '正在登录…' : '登录'}
        </button>
      </form>
    </main>
  );
}
