import { useState, type FormEvent } from 'react';
import { ArrowRight, ChevronRight, CircleAlert, Phone, ShieldCheck, Video } from 'lucide-react';
import { Brand } from '../components/Brand';
import { ShellControls } from '../components/ShellControls';
import { Button } from '../components/ui/Button';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/messages';

interface HomeViewProps {
  displayName: string;
  busy: boolean;
  error: MessageKey | null;
  joinRoom: string;
  onJoinRoomChange: (value: string) => void;
  onStartVideo: () => void;
  onStartVoice: () => void;
  onJoin: () => void;
  onSignOut: () => void;
}

export function HomeView({
  displayName,
  busy,
  error,
  joinRoom,
  onJoinRoomChange,
  onStartVideo,
  onStartVoice,
  onJoin,
  onSignOut,
}: HomeViewProps) {
  const { t } = useI18n();
  const [joinError, setJoinError] = useState(false);

  const handleJoin = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (joinRoom.trim().length < 6) {
      setJoinError(true);
      return;
    }
    setJoinError(false);
    onJoin();
  };

  return (
    <div className="view home-shell">
      <header className="topbar">
        <Brand />
        <ShellControls displayName={displayName} onSignOut={onSignOut} />
      </header>

      <main className="home-main">
        <div className="home-heading">
          <p className="home-kicker">{t('home.greeting', { name: displayName })}</p>
          <h1>{t('home.hello')}</h1>
          <p>{t('home.intro')}</p>
        </div>

        <div className="home-call-actions">
          <button type="button" className="call-action" data-kind="video" onClick={onStartVideo} disabled={busy}>
            <span className="action-glyph" aria-hidden="true"><Video size={24} /></span>
            <span className="action-copy">
              <strong>{t('home.startVideo')}</strong>
              <span>{t('home.startVideoHint')}</span>
            </span>
            <ArrowRight className="action-arrow" size={20} aria-hidden="true" />
          </button>
          <button type="button" className="call-action" data-kind="audio" onClick={onStartVoice} disabled={busy}>
            <span className="action-glyph" aria-hidden="true"><Phone size={22} /></span>
            <span className="action-copy">
              <strong>{t('home.startVoice')}</strong>
              <span>{t('home.startVoiceHint')}</span>
            </span>
            <ArrowRight className="action-arrow" size={20} aria-hidden="true" />
          </button>
        </div>

        <div className="home-divider" role="presentation"><span>{t('home.or')}</span></div>

        <div className="card join-card">
          <h2>{t('home.joinTitle')}</h2>
          <p>{t('home.joinHint')}</p>
          <form className="join-form" onSubmit={handleJoin} aria-busy={busy} noValidate>
            <div className="input-wrap">
              <input
                id="room-id"
                className="input join-code"
                name="room"
                minLength={6}
                maxLength={64}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="go"
                aria-label={t('home.joinPlaceholder')}
                placeholder={t('home.joinPlaceholder')}
                value={joinRoom}
                onChange={event => {
                  onJoinRoomChange(event.target.value);
                  if (joinError) setJoinError(false);
                }}
                disabled={busy}
                aria-invalid={joinError || error ? true : undefined}
              />
            </div>
            <Button type="submit" variant="primary" busy={busy} disabled={busy}>
              {busy ? t('home.joining') : <><span>{t('home.join')}</span><ChevronRight size={16} aria-hidden="true" /></>}
            </Button>
          </form>
          <p className="error-text home-error" role="alert" aria-live="polite">
            {joinError ? <CircleAlert size={15} aria-hidden="true" /> : null}
            <span>
              {joinError ? t('home.joinInvalid') : error ? t(error) : ''}
            </span>
          </p>
        </div>

        <p className="home-foot">
          <ShieldCheck size={13} strokeWidth={2.2} aria-hidden="true" style={{ verticalAlign: -2, marginRight: 5 }} />
          {t('home.footnote')}
        </p>
      </main>
    </div>
  );
}
