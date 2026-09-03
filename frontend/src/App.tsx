import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { CircleAlert } from 'lucide-react';
import type { CallMode } from './call/CallSession';
import { MediaSetupError } from './call/CallSession';
import { CallView } from './components/call/CallView';
import type { CallHandlers } from './components/call/types';
import { Modal } from './components/ui/Modal';
import { useCallSession } from './hooks/useCallSession';
import { ApiError, authenticate, type ClientConfig, type LoginResponse } from './lib/api';
import {
  clearRoomUrl,
  copyText,
  invitedRoomFromLocation,
  replaceRoomUrl,
  resolveStartRoom,
  roomUrl,
  sanitizeRoom,
  validateRoom,
  type RoomError,
} from './lib/rooms';
import { useI18n } from './i18n/I18nProvider';
import type { MessageKey } from './i18n/messages';
import { HomeView } from './views/HomeView';
import { LoginView } from './views/LoginView';
import { LobbyView, type LobbyStartOptions } from './views/LobbyView';

const USERNAME_STORAGE_KEY = 'remote-caller-username';
const LAST_MODE_KEY = 'rc:lastMode';
const MAX_TIMEOUT = 2_147_483_647;

type AuthSession = LoginResponse & ClientConfig;

interface LobbyState {
  flavor: 'create' | 'join';
  room: string;
  defaultMode: CallMode;
}

function savedUsername(): string {
  try {
    return localStorage.getItem(USERNAME_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function savedMode(): CallMode {
  try {
    return localStorage.getItem(LAST_MODE_KEY) === 'audio' ? 'audio' : 'video';
  } catch {
    return 'video';
  }
}

function rememberMode(mode: CallMode): void {
  try {
    localStorage.setItem(LAST_MODE_KEY, mode);
  } catch {
    // Ignore storage failures.
  }
}

function loginErrorKey(error: unknown): MessageKey {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'unauthorized': return 'login.error.invalid';
      case 'rate_limited': return 'login.error.rateLimited';
      case 'capacity_reached': return 'login.error.busy';
      default: return error.code.startsWith('http_') && Number(error.code.slice(5)) >= 500
        ? 'login.error.busy'
        : 'login.error.generic';
    }
  }
  if (error instanceof TypeError) return 'login.error.network';
  return 'login.error.generic';
}

export default function App() {
  const { t } = useI18n();
  const initialInvite = useRef(invitedRoomFromLocation()).current;

  const [username, setUsername] = useState(savedUsername);
  const [password, setPassword] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState<MessageKey | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [joinRoom, setJoinRoom] = useState(initialInvite);
  const [lobby, setLobby] = useState<LobbyState | null>(null);
  const [isCreator, setIsCreator] = useState(false);
  const [homeError, setHomeError] = useState<MessageKey | null>(null);
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  const [dialog, setDialog] = useState<{ title: MessageKey; body: MessageKey } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastId = useRef(0);

  const showToastText = useCallback((message: string) => {
    const id = ++toastId.current;
    setToast({ id, text: message });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }, []);

  const showToastKey = useCallback((key: MessageKey, params?: Record<string, string | number>) => {
    showToastText(t(key, params));
  }, [t, showToastText]);

  const expireSession = useCallback((message: MessageKey) => {
    const room = invitedRoomFromLocation();
    setSession(null);
    setSessionExpired(true);
    setLoginError(message);
    if (room) setJoinRoom(room);
  }, []);

  const call = useCallSession({
    onToast: showToastKey,
    onAuthExpired: room => {
      replaceRoomUrl(room);
      expireSession('login.expired.title');
    },
    onRoomFull: room => {
      setLobby(null);
      replaceRoomUrl(room);
      setDialog({ title: 'call.roomFull.title', body: 'call.roomFull.body' });
    },
  });

  const hangup = useCallback(() => {
    call.stop();
    setLobby(null);
    setIsCreator(false);
    setHomeError(null);
  }, [call]);

  // When a *joined* call ends because the other person left, return home with a
  // notice; the room creator instead stays in the waiting room to re-invite.
  const callWatch = useRef({ wasPeer: false, wasConnected: false, peerName: '' });
  const exitAfterPeerLeft = useRef(false);
  useEffect(() => {
    const watch = callWatch.current;
    const current = call.snapshot;
    if (!current.active) {
      watch.wasPeer = false;
      watch.wasConnected = false;
      watch.peerName = '';
      exitAfterPeerLeft.current = false;
      return;
    }
    const justLostConnectedPeer = watch.wasPeer && watch.wasConnected
      && !current.peerPresent && !exitAfterPeerLeft.current;
    if (justLostConnectedPeer && !isCreator) {
      exitAfterPeerLeft.current = true;
      showToastText(t('call.peerLeft', { name: watch.peerName || t('call.peer') }));
      hangup();
      return;
    }
    watch.wasPeer = current.peerPresent;
    watch.wasConnected = current.pcPhase === 'connected';
    if (current.peerName) watch.peerName = current.peerName;
  }, [call.snapshot, call, isCreator, hangup, showToastText, t]);

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  // Watch for in-page back/forward navigation changing the room parameter.
  useEffect(() => {
    const syncInvite = () => {
      const room = invitedRoomFromLocation();
      if (room) setJoinRoom(room);
    };
    window.addEventListener('popstate', syncInvite);
    return () => window.removeEventListener('popstate', syncInvite);
  }, []);

  // Automatic session-expiry sign-out.
  useEffect(() => {
    if (!session?.expiresAt) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      const remaining = session.expiresAt * 1000 - Date.now();
      if (remaining <= 0) {
        call.stop();
        expireSession('login.expired.title');
        return;
      }
      timer = setTimeout(schedule, Math.min(remaining, MAX_TIMEOUT));
    };
    schedule();
    return () => {
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.expiresAt]);

  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoginBusy(true);
    setLoginError(null);
    try {
      const cleanUsername = username.trim();
      const nextSession = await authenticate(cleanUsername, password);
      try {
        localStorage.setItem(USERNAME_STORAGE_KEY, cleanUsername);
      } catch {
        // Private browsing may make localStorage unavailable; login still works.
      }
      setSession({ ...nextSession, displayName: nextSession.displayName || cleanUsername });
      setPassword('');
      setSessionExpired(false);
      setHomeError(null);
      const pending = invitedRoomFromLocation();
      if (pending) {
        setIsCreator(false);
        setJoinRoom(pending);
        setLobby({ flavor: 'join', room: pending, defaultMode: savedMode() });
      } else {
        setJoinRoom('');
      }
    } catch (error) {
      setLoginError(loginErrorKey(error));
    } finally {
      setLoginBusy(false);
    }
  };

  const goToLobby = useCallback((flavor: 'create' | 'join', room: string, mode: CallMode) => {
    setHomeError(null);
    setLobby({ flavor, room, defaultMode: mode });
  }, []);

  const startLobbyCall = useCallback(async (options: LobbyStartOptions) => {
    const nextSession = session;
    if (!nextSession) return;
    try {
      // A creator's room is minted at start time; a joiner validates the code
      // they were given. Never trust an empty create-room through validateRoom.
      const flavor = lobby?.flavor ?? 'join';
      const room = resolveStartRoom(flavor, options.room);
      rememberMode(options.mode);
      replaceRoomUrl(room);
      setIsCreator(flavor === 'create');
      await call.start({
        room,
        mode: options.mode,
        token: nextSession.token,
        clientId: nextSession.clientId,
        iceServers: nextSession.iceServers,
        stream: options.stream,
        cameraDeviceId: options.cameraDeviceId,
        audioDeviceId: options.audioDeviceId,
      });
      setLobby(null);
    } catch (error) {
      if (error instanceof MediaSetupError) {
        showToastKey(error.key);
        return;
      }
      if (error instanceof ApiError) {
        if (error.code === 'unauthorized') {
          expireSession('login.expired.title');
          return;
        }
        if (error.code === 'room_full') {
          setDialog({ title: 'call.roomFull.title', body: 'call.roomFull.body' });
          return;
        }
      }
      showToastText(t('common.error'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, lobby?.flavor, call.start, t, showToastText]);

  const openCreateLobby = useCallback((mode: CallMode) => {
    goToLobby('create', '', mode);
  }, [goToLobby]);

  const openJoinLobby = useCallback(() => {
    let room = '';
    try {
      room = validateRoom(joinRoom || invitedRoomFromLocation());
    } catch (error) {
      setHomeError((error as RoomError).code === 'too-short' ? 'home.joinInvalid' : 'home.joinInvalid');
      return;
    }
    replaceRoomUrl(room);
    goToLobby('join', room, savedMode());
  }, [joinRoom, goToLobby]);

  const shareCurrentRoom = useCallback(async (room: string) => {
    try {
      const clean = validateRoom(room);
      const url = roomUrl(clean);
      if (navigator.share) {
        try {
          await navigator.share({
            title: t('app.name'),
            text: t('share.inviteText', { code: clean }),
            url,
          });
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') return;
          await copyText(url);
          showToastText(t('call.inviteCopied'));
        }
      } else {
        await copyText(url);
        showToastText(t('call.inviteCopied'));
      }
    } catch {
      showToastText(t('call.shareFailed'));
    }
  }, [t, showToastText]);

  const signOut = useCallback(() => {
    call.stop();
    setLobby(null);
    setSession(null);
    setPassword('');
    setLoginError(null);
    setSessionExpired(false);
    setHomeError(null);
    clearRoomUrl();
  }, [call]);

  const handlers: CallHandlers = {
    onToggleMicrophone: () => void call.toggleMicrophone(),
    onToggleCamera: () => void call.toggleCamera(),
    onSwitchCamera: () => void call.switchCamera(),
    onSwitchVideoInput: deviceId => void call.switchVideoInput(deviceId),
    onSwitchAudioInput: deviceId => void call.switchAudioInput(deviceId),
    onLeave: hangup,
    onCopyInvite: () => void shareCurrentRoom(call.getRoom() || joinRoom),
    onNativeShare: () => void shareCurrentRoom(call.getRoom() || joinRoom),
    onToast: showToastText,
    getDiagnostics: () => call.getDiagnostics(),
  };

  const shareSupported = typeof navigator !== 'undefined' && Boolean(navigator.share);

  let view: React.ReactNode;
  if (!session) {
    view = (
      <LoginView
        username={username}
        password={password}
        busy={loginBusy}
        error={loginError}
        sessionExpired={sessionExpired}
        hasPendingInvite={Boolean(joinRoom)}
        onUsernameChange={setUsername}
        onPasswordChange={setPassword}
        onSubmit={event => void handleLogin(event)}
      />
    );
  } else if (call.snapshot.active) {
    view = (
      <CallView
        snapshot={call.snapshot}
        displayName={session.displayName}
        isCreator={isCreator}
        shareSupported={shareSupported}
        handlers={handlers}
      />
    );
  } else if (lobby) {
    view = (
      <LobbyView
        key={lobby.room + lobby.flavor + lobby.defaultMode}
        flavor={lobby.flavor}
        room={lobby.room}
        defaultMode={lobby.defaultMode}
        localName={session.displayName}
        onCancel={() => {
          setLobby(null);
          setHomeError(null);
        }}
        onStart={options => void startLobbyCall(options)}
      />
    );
  } else {
    view = (
      <HomeView
        displayName={session.displayName}
        busy={false}
        error={homeError}
        joinRoom={joinRoom}
        onJoinRoomChange={value => setJoinRoom(sanitizeRoom(value))}
        onStartVideo={() => openCreateLobby('video')}
        onStartVoice={() => openCreateLobby('audio')}
        onJoin={openJoinLobby}
        onSignOut={signOut}
      />
    );
  }

  return (
    <>
      {view}
      <div className="toast-region" aria-live="polite">
        {toast ? (
          <div className="toast" key={toast.id} role="status">
            {toast.text}
          </div>
        ) : null}
      </div>
      <Modal open={dialog !== null} title={dialog ? t(dialog.title) : ''} onClose={() => setDialog(null)}>
        <p className="hint-text" style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <CircleAlert size={17} style={{ flex: 'none', marginTop: 2 }} aria-hidden="true" />
          <span>{dialog ? t(dialog.body) : ''}</span>
        </p>
      </Modal>
    </>
  );
}
