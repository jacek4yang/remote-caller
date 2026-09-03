import { useState, type FormEvent } from 'react';
import { CircleAlert, Eye, EyeOff, KeyRound, Lock, Server, ShieldCheck, User } from 'lucide-react';
import { Brand } from '../components/Brand';
import { Button } from '../components/ui/Button';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/messages';

interface LoginViewProps {
  username: string;
  password: string;
  busy: boolean;
  /** Localized error key to announce; reserved space prevents layout shift. */
  error: MessageKey | null;
  /** True when the previous session expired while a call was pending. */
  sessionExpired: boolean;
  hasPendingInvite: boolean;
  onUsernameChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

const POINTS = [
  { icon: ShieldCheck, key: 'login.securePoint1' as const },
  { icon: Lock, key: 'login.securePoint2' as const },
  { icon: KeyRound, key: 'login.securePoint3' as const },
];

export function LoginView({
  username,
  password,
  busy,
  error,
  sessionExpired,
  hasPendingInvite,
  onUsernameChange,
  onPasswordChange,
  onSubmit,
}: LoginViewProps) {
  const { t } = useI18n();
  const [showPassword, setShowPassword] = useState(false);

  return (
    <div className="view login-shell">
      <div className="login-grid">
        <div className="login-intro">
          <Brand />
          <p className="home-kicker">{t('login.kicker')}</p>
          <h1 className="login-headline">{t('login.title')}</h1>
          <p className="login-copy">{t('login.intro')}</p>
          <ul className="login-points" role="list">
            {POINTS.map(point => {
              const Icon = point.icon;
              return (
                <li key={point.key} className="login-point">
                  <Icon size={17} strokeWidth={2.2} aria-hidden="true" />
                  <span>{t(point.key)}</span>
                </li>
              );
            })}
          </ul>
          <span className="badge login-status" data-tone="accent">
            <Server size={13} strokeWidth={2.2} aria-hidden="true" />
            {t('common.private')}
          </span>
        </div>

        <div className="login-panel-wrap">
          {sessionExpired || hasPendingInvite ? (
            <div
              className="error-banner"
              data-tone={sessionExpired ? 'danger' : 'accent'}
              role={sessionExpired ? 'alert' : 'status'}
            >
              {sessionExpired ? <CircleAlert size={17} aria-hidden="true" /> : null}
              <span>{t(sessionExpired ? 'login.expired.body' : 'login.roomPending')}</span>
            </div>
          ) : null}

          <form className="card login-panel" onSubmit={onSubmit} aria-busy={busy} noValidate>
            <div>
              <p className="home-kicker">{t('login.kicker')}</p>
              <h2 className="login-panel-title">{t(sessionExpired ? 'login.expired.title' : 'login.welcome')}</h2>
              {sessionExpired ? null : <p className="hint-text">{t('login.accountHint')}</p>}
            </div>

            <div className="form-stack">
              <div className="field">
                <label htmlFor="username" className="field-label">{t('login.username')}</label>
                <div className="input-wrap">
                  <span className="icon-left" aria-hidden="true"><User size={17} /></span>
                  <input
                    id="username"
                    className="input"
                    name="username"
                    maxLength={40}
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    placeholder={t('login.usernamePlaceholder')}
                    value={username}
                    onChange={event => onUsernameChange(event.target.value)}
                    disabled={busy}
                    required
                    autoFocus
                  />
                </div>
              </div>

              <div className="field">
                <label htmlFor="password" className="field-label">{t('login.password')}</label>
                <div className="input-wrap">
                  <span className="icon-left" aria-hidden="true"><Lock size={17} /></span>
                  <input
                    id="password"
                    className="input"
                    name="password"
                    type={showPassword ? 'text' : 'password'}
                    maxLength={256}
                    autoComplete="current-password"
                    placeholder={t('login.passwordPlaceholder')}
                    value={password}
                    onChange={event => onPasswordChange(event.target.value)}
                    disabled={busy}
                    required
                  />
                  <button
                    type="button"
                    className="suffix-btn"
                    aria-label={showPassword ? t('login.hidePassword') : t('login.showPassword')}
                    onClick={() => setShowPassword(value => !value)}
                    disabled={busy}
                  >
                    {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                  </button>
                </div>
              </div>

              <Button
                type="submit"
                variant="primary"
                size="lg"
                block
                busy={busy}
                disabled={!username.trim() || !password}
                className="login-submit"
              >
                {busy ? t('login.signingIn') : t('login.signIn')}
              </Button>

              {/* Reserved slot: the card never jumps when an error appears. */}
              <p className="error-text login-error-slot" role="alert" aria-live="polite">
                {error ? <CircleAlert size={15} aria-hidden="true" /> : null}
                <span>{error ? t(error) : ''}</span>
              </p>
            </div>
          </form>

          <p className="login-foot">
            <Lock size={12} strokeWidth={2.4} aria-hidden="true" />
            {t('login.secureNote')}
          </p>
        </div>
      </div>
    </div>
  );
}
