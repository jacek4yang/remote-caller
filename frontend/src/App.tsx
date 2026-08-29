import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { CallMode } from './call/CallSession';
import { CallView } from './components/CallView';
import { DashboardView } from './components/DashboardView';
import { LoginView } from './components/LoginView';
import { useCallSession } from './hooks/useCallSession';
import { authenticate, humanError, type ClientConfig, type LoginResponse } from './lib/api';
import {
  copyText,
  invitedRoomFromLocation,
  makeRoom,
  replaceRoomUrl,
  sanitizeRoom,
  shareRoom,
  validateRoom,
} from './lib/rooms';

const MAX_TIMEOUT = 2_147_483_647;
const USERNAME_STORAGE_KEY = 'remote-caller-username';

type AuthSession = LoginResponse & ClientConfig;

function savedUsername(): string {
  try {
    return localStorage.getItem(USERNAME_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export default function App() {
  const initialInvite = useRef(invitedRoomFromLocation()).current;
  const [username, setUsername] = useState(savedUsername);
  const [password, setPassword] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [session, setSession] = useState<AuthSession | null>(null);
  const [joinRoom, setJoinRoom] = useState(initialInvite);
  const [draftRoom, setDraftRoom] = useState('');
  const [mode, setMode] = useState<CallMode>('video');
  const [roomBusy, setRoomBusy] = useState(false);
  const [dashboardError, setDashboardError] = useState('');
  const [toast, setToast] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2600);
  }, []);

  const call = useCallSession({
    onToast: showToast,
    onAuthExpired: room => {
      setJoinRoom(room);
      replaceRoomUrl(room);
      setSession(null);
      setLoginError('登录已过期，请重新登录');
    },
    onRoomFull: room => {
      setJoinRoom(room);
      replaceRoomUrl(room);
      setDashboardError('房间已满（当前版本支持两人通话）');
    },
  });

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  useEffect(() => {
    const syncInvite = () => {
      const room = invitedRoomFromLocation();
      if (room) setJoinRoom(room);
    };
    window.addEventListener('popstate', syncInvite);
    return () => window.removeEventListener('popstate', syncInvite);
  }, []);

  useEffect(() => {
    if (!session?.expiresAt) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      const remaining = session.expiresAt * 1000 - Date.now();
      if (remaining <= 0) {
        const room = call.getRoom() || invitedRoomFromLocation();
        call.stop();
        setSession(null);
        setLoginError('登录已过期，请重新登录');
        if (room) {
          setJoinRoom(room);
          replaceRoomUrl(room);
        }
        return;
      }
      timer = setTimeout(schedule, Math.min(remaining, MAX_TIMEOUT));
    };
    schedule();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [session, call.getRoom, call.stop]);

  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoginError('');
    setLoginBusy(true);
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
      setDashboardError('');
    } catch (error) {
      setSession(null);
      setLoginError(humanError(error));
    } finally {
      setLoginBusy(false);
    }
  };

  const startCall = async (roomValue: string) => {
    setDashboardError('');
    setRoomBusy(true);
    try {
      if (!session) throw new Error('请先登录');
      const room = validateRoom(roomValue);
      await call.start({
        room,
        mode,
        token: session.token,
        clientId: session.clientId,
        iceServers: session.iceServers,
      });
      setJoinRoom(room);
      replaceRoomUrl(room);
    } catch (error) {
      setDashboardError(humanError(error));
    } finally {
      setRoomBusy(false);
    }
  };

  const createRoom = () => {
    const room = makeRoom();
    setDraftRoom(room);
    setJoinRoom(room);
    setDashboardError('');
    replaceRoomUrl(room);
  };

  const copyDraftRoom = async () => {
    try {
      await copyText(validateRoom(draftRoom));
      showToast('房间号已复制');
    } catch {
      showToast('复制失败，请手动复制');
    }
  };

  const shareCurrentRoom = async (room: string) => {
    try {
      const result = await shareRoom(room);
      if (result === 'copied') showToast('邀请链接已复制');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      showToast('分享失败，请复制房间号');
    }
  };

  const hangup = () => {
    const room = call.getRoom();
    call.stop();
    setJoinRoom(room);
    setDashboardError('');
    replaceRoomUrl(room);
  };

  const logout = (message = '') => {
    const room = call.getRoom() || sanitizeRoom(joinRoom || draftRoom);
    call.stop();
    setSession(null);
    setPassword('');
    setLoginError(message);
    setDashboardError('');
    if (room) {
      setJoinRoom(room);
      replaceRoomUrl(room);
    } else {
      replaceRoomUrl('');
    }
  };

  let view;
  if (call.snapshot.active && session) {
    view = (
      <CallView
        snapshot={call.snapshot}
        displayName={session.displayName}
        onShare={() => void shareCurrentRoom(call.snapshot.room)}
        onToggleMicrophone={() => void call.toggleMicrophone()}
        onToggleCamera={() => void call.toggleCamera()}
        onSwitchCamera={() => void call.switchCamera()}
        onHangup={hangup}
        onPlaybackBlocked={() => showToast('轻触页面以播放对方声音')}
      />
    );
  } else if (session) {
    view = (
      <DashboardView
        displayName={session.displayName}
        invitedRoom={initialInvite}
        draftRoom={draftRoom}
        joinRoom={joinRoom}
        mode={mode}
        busy={roomBusy}
        error={dashboardError}
        onModeChange={setMode}
        onJoinRoomChange={value => setJoinRoom(sanitizeRoom(value))}
        onCreateRoom={createRoom}
        onCopyRoom={() => void copyDraftRoom()}
        onShareRoom={() => void shareCurrentRoom(draftRoom)}
        onEnterDraftRoom={() => void startCall(draftRoom)}
        onJoin={event => {
          event.preventDefault();
          void startCall(joinRoom);
        }}
        onLogout={() => logout()}
      />
    );
  } else {
    view = (
      <LoginView
        username={username}
        password={password}
        busy={loginBusy}
        error={loginError}
        onUsernameChange={setUsername}
        onPasswordChange={setPassword}
        onSubmit={event => void handleLogin(event)}
      />
    );
  }

  return (
    <main className="app-shell">
      {view}
      <div className={'toast' + (toast ? ' show' : '')} role="status" aria-live="polite">{toast}</div>
    </main>
  );
}
