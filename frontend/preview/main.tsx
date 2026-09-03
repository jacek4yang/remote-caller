/* Design-preview storyboard (development only, never built into the app).
   Renders every user-facing screen and call state with mock props so the UI
   can be reviewed without the Rust signaling server. */
import { StrictMode, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Phone, Sun } from 'lucide-react';
import { initialCallSnapshot, type CallSnapshot } from '../src/call/CallSession';
import { CallView } from '../src/components/call/CallView';
import type { CallHandlers } from '../src/components/call/types';
import { I18nProvider, useI18n } from '../src/i18n/I18nProvider';
import type { Locale } from '../src/i18n/messages';
import { ThemeProvider, useTheme } from '../src/theme/ThemeProvider';
import { HomeView } from '../src/views/HomeView';
import { LoginView } from '../src/views/LoginView';
import '../src/styles/tokens.css';
import '../src/styles/base.css';
import '../src/styles/components.css';
import '../src/styles/views.css';
import '../src/styles/call.css';
import './styles.css';

function snap(patch: Partial<CallSnapshot>): CallSnapshot {
  return {
    ...initialCallSnapshot(),
    active: true,
    room: 'willow-42',
    mode: 'video',
    wsPhase: 'open',
    ...patch,
  };
}

function noop(): void {}

function makeHandlers(): CallHandlers {
  return {
    onToggleMicrophone: noop,
    onToggleCamera: noop,
    onSwitchCamera: noop,
    onSwitchVideoInput: noop,
    onSwitchAudioInput: noop,
    onLeave: noop,
    onCopyInvite: () => window.alert('copy invite'),
    onNativeShare: () => window.alert('share invite'),
    onToast: message => window.alert(message),
    getDiagnostics: () => ({
      wsPhase: 'open',
      pcState: 'connected',
      quality: 'good',
      route: 'relay',
      codec: 'VP9',
      resolution: { width: 1280, height: 720 },
      frameRate: 30,
      outboundBitrate: 980_000,
      inboundBitrate: 1_120_000,
      rtt: 38,
      loss: 0.4,
      jitter: 6,
    }),
  };
}

function Frame({ label, children, tint }: { label: string; children: ReactNode; tint?: 'danger' | 'warning' | 'success' }) {
  return (
    <section className="pf-card" style={{ borderColor: tint ? `var(--${tint})` : 'transparent' }}>
      <h2 className="pf-label" style={tint ? { color: `var(--${tint})` } : undefined}>{label}</h2>
      <div className="pf-stage">{children}</div>
    </section>
  );
}

function CallGallery() {
  return (
    <div className="pf-grid">
      <Frame label="waiting · creator">
        <CallView
          snapshot={snap({ peerPresent: false, peerName: '', wsPhase: 'open', quality: null })}
          displayName="Alice"
          isCreator
          shareSupported
          handlers={makeHandlers()}
        />
      </Frame>
      <Frame label="connecting">
        <CallView
          snapshot={snap({ wsPhase: 'opening', peerPresent: false, quality: null })}
          displayName="Alice"
          isCreator={false}
          shareSupported={false}
          handlers={makeHandlers()}
        />
      </Frame>
      <Frame label="negotiating">
        <CallView
          snapshot={snap({ wsPhase: 'open', peerPresent: true, peerName: 'Bob', pcPhase: 'connecting', quality: null })}
          displayName="Alice"
          isCreator={false}
          shareSupported={false}
          handlers={makeHandlers()}
        />
      </Frame>
      <Frame label="connected · voice only" tint="success">
        <CallView
          snapshot={snap({
            wsPhase: 'open', peerPresent: true, peerName: 'Bob', pcPhase: 'connected',
            mode: 'audio', remoteVideoOff: true, remoteMuted: false, quality: 'excellent',
            connectedAt: Date.now() - 42_000, localVideoEnabled: false,
          })}
          displayName="Alice"
          isCreator={false}
          shareSupported={false}
          handlers={makeHandlers()}
        />
      </Frame>
      <Frame label="connected · remote muted" tint="success">
        <CallView
          snapshot={snap({
            wsPhase: 'open', peerPresent: true, peerName: 'Bob', pcPhase: 'connected',
            remoteMuted: true, quality: 'good', connectedAt: Date.now() - 60_000,
          })}
          displayName="Alice"
          isCreator={false}
          shareSupported={false}
          handlers={makeHandlers()}
        />
      </Frame>
      <Frame label="reconnecting" tint="warning">
        <CallView
          snapshot={snap({
            wsPhase: 'open', peerPresent: true, peerName: 'Bob', pcPhase: 'reconnecting',
            quality: 'unstable', connectedAt: Date.now() - 60_000,
          })}
          displayName="Alice"
          isCreator={false}
          shareSupported={false}
          handlers={makeHandlers()}
        />
      </Frame>
      <Frame label="offline" tint="danger">
        <CallView
          snapshot={snap({ wsPhase: 'open', peerPresent: true, peerName: 'Bob', pcPhase: 'connected', offline: true, quality: 'poor' })}
          displayName="Alice"
          isCreator={false}
          shareSupported={false}
          handlers={makeHandlers()}
        />
      </Frame>
    </div>
  );
}

function Toolbar() {
  const { locale, setLocale } = useI18n();
  const { mode, resolved, setMode } = useTheme();
  const isActive = (candidate: 'dark' | 'light' | 'system') =>
    candidate === 'system' ? mode === 'system' : resolved === candidate;
  return (
    <header className="pf-toolbar">
      <strong>Remote Caller · UI review</strong>
      <div className="pf-toolbar-group">
        {(['en-US', 'zh-CN'] as Locale[]).map(code => (
          <button key={code} type="button" onClick={() => setLocale(code)} data-active={locale === code || undefined}>
            {code}
          </button>
        ))}
      </div>
      <div className="pf-toolbar-group">
        {(['dark', 'light', 'system'] as const).map(candidate => (
          <button key={candidate} type="button" onClick={() => setMode(candidate)} data-active={isActive(candidate) || undefined}>
            {candidate}
          </button>
        ))}
      </div>
      <span className="pf-hint">scenes use mock data — click controls to explore</span>
    </header>
  );
}

function Preview() {
  const [username] = useState('Alice');
  const [password] = useState('');
  const { locale } = useI18n();
  void locale;
  return (
    <div className="pf-wrap">
      <Toolbar />
      <Frame label="Login">
        <div style={{ background: 'var(--bg)' }}>
          <LoginView
            username={username}
            password={password}
            busy={false}
            error={null}
            sessionExpired={false}
            hasPendingInvite
            onUsernameChange={noop}
            onPasswordChange={noop}
            onSubmit={event => event.preventDefault()}
          />
        </div>
      </Frame>
      <Frame label="Home">
        <div style={{ background: 'var(--bg)' }}>
          <HomeView
            displayName="Alice"
            busy={false}
            error={null}
            joinRoom=""
            onJoinRoomChange={noop}
            onStartVideo={() => window.alert('start video')}
            onStartVoice={() => window.alert('start voice')}
            onJoin={() => window.alert('join')}
            onSignOut={() => window.alert('sign out')}
          />
        </div>
      </Frame>
      <h2 className="pf-section" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Phone size={18} /> Call states — note: a real local preview mirror is not available; cameras need a peer.
      </h2>
      <CallGallery />
      <p className="pf-foot">
        <Sun size={13} /> Preview only — switch theme above; pick zh-CN to audit translations.
      </p>
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <ThemeProvider>
      <I18nProvider>
        <Preview />
      </I18nProvider>
    </ThemeProvider>
  </StrictMode>,
);
