import type { FormEvent } from 'react';
import { Brand } from './Brand';

interface LoginViewProps {
  username: string;
  password: string;
  busy: boolean;
  error: string;
  onUsernameChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

export function LoginView({
  username,
  password,
  busy,
  error,
  onUsernameChange,
  onPasswordChange,
  onSubmit,
}: LoginViewProps) {
  return (
    <section className="auth-view" aria-labelledby="login-title">
      <header><Brand /></header>
      <div className="auth-layout">
        <div className="hero-copy">
          <p className="eyebrow">安全的双人通话</p>
          <h1 id="login-title">先登录，再决定去哪个房间。</h1>
          <p className="intro">登录后，你可以留在自己的通话工作台，随时创建、分享或加入房间。</p>
        </div>
        <form className="surface auth-card" onSubmit={onSubmit} aria-busy={busy}>
          <div className="card-heading">
            <p className="section-kicker">账号登录</p>
            <h2>欢迎回来</h2>
            <p>使用服务器管理员为你配置的账号。</p>
          </div>
          <label htmlFor="username">账号</label>
          <input
            id="username"
            name="username"
            maxLength={40}
            autoComplete="username"
            placeholder="你的专属账号"
            value={username}
            onChange={event => onUsernameChange(event.target.value)}
            disabled={busy}
            required
          />
          <label htmlFor="password">密码</label>
          <input
            id="password"
            name="password"
            type="password"
            maxLength={256}
            autoComplete="current-password"
            placeholder="输入密码"
            value={password}
            onChange={event => onPasswordChange(event.target.value)}
            disabled={busy}
            required
          />
          <button className="primary-button" type="submit" disabled={busy}>
            {busy ? '正在登录…' : '登录'}
          </button>
          <p className="form-error" role="alert">{error}</p>
          <p className="secure-note"><span aria-hidden="true">●</span> 密码和登录令牌不会写入本地存储</p>
        </form>
      </div>
    </section>
  );
}
