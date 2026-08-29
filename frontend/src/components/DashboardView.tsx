import { useEffect, useRef, type FormEvent } from 'react';
import type { CallMode } from '../call/CallSession';
import { Brand } from './Brand';

interface DashboardViewProps {
  displayName: string;
  invitedRoom: string;
  draftRoom: string;
  joinRoom: string;
  mode: CallMode;
  busy: boolean;
  error: string;
  onModeChange: (mode: CallMode) => void;
  onJoinRoomChange: (room: string) => void;
  onCreateRoom: () => void;
  onCopyRoom: () => void;
  onShareRoom: () => void;
  onEnterDraftRoom: () => void;
  onJoin: (event: FormEvent<HTMLFormElement>) => void;
  onLogout: () => void;
}

export function DashboardView({
  displayName,
  invitedRoom,
  draftRoom,
  joinRoom,
  mode,
  busy,
  error,
  onModeChange,
  onJoinRoomChange,
  onCreateRoom,
  onCopyRoom,
  onShareRoom,
  onEnterDraftRoom,
  onJoin,
  onLogout,
}: DashboardViewProps) {
  const inviteRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (draftRoom) inviteRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [draftRoom]);

  return (
    <section className="dashboard" aria-labelledby="dashboard-title">
      <header className="dashboard-header">
        <Brand />
        <div className="account-area">
          <div className="account-copy">
            <span>当前账号</span>
            <strong>{displayName}</strong>
          </div>
          <button className="quiet-button" type="button" onClick={onLogout}>退出</button>
        </div>
      </header>

      <div className="dashboard-main">
        <div className="dashboard-copy">
          <p className="eyebrow">通话工作台</p>
          <h1 id="dashboard-title">{displayName}，准备好通话了吗？</h1>
          <p>新建一个房间发给对方，或者输入你收到的房间号直接加入。</p>
        </div>

        <fieldset className="surface mode-section" disabled={busy}>
          <legend>通话方式</legend>
          <div className="mode-picker">
            <label>
              <input
                type="radio"
                name="mode"
                value="video"
                checked={mode === 'video'}
                onChange={() => onModeChange('video')}
              />
              <span><b>视频</b><small>摄像头和麦克风</small></span>
            </label>
            <label>
              <input
                type="radio"
                name="mode"
                value="audio"
                checked={mode === 'audio'}
                onChange={() => onModeChange('audio')}
              />
              <span><b>语音</b><small>仅使用麦克风</small></span>
            </label>
          </div>
        </fieldset>

        <div className="action-grid">
          <article className="surface action-card create-card">
            <div className="action-icon" aria-hidden="true">＋</div>
            <div className="card-heading">
              <p className="section-kicker">发起通话</p>
              <h2>新建房间</h2>
              <p>生成一个私密房间号，先分享给对方，再进入等候。</p>
            </div>
            <button className="primary-button" type="button" onClick={onCreateRoom} disabled={busy}>
              {draftRoom ? '重新生成房间号' : '生成房间号'}
            </button>

            {draftRoom && (
              <div ref={inviteRef} className="invite-panel" aria-live="polite">
                <span className="invite-label">房间已准备好</span>
                <output className="room-code">{draftRoom}</output>
                <div className="button-row">
                  <button className="secondary-button" type="button" onClick={onCopyRoom}>复制房间号</button>
                  <button className="secondary-button" type="button" onClick={onShareRoom}>分享邀请</button>
                </div>
                <button className="primary-button" type="button" onClick={onEnterDraftRoom} disabled={busy}>
                  {busy ? '正在准备…' : '进入这个房间'}
                </button>
              </div>
            )}
          </article>

          <article className="surface action-card join-card">
            <div className="action-icon" aria-hidden="true">→</div>
            <div className="card-heading">
              <p className="section-kicker">已有邀请</p>
              <h2>加入房间</h2>
              <p>{invitedRoom ? '邀请链接中的房间号已填好，登录后可直接加入。' : '输入对方发来的房间号即可加入。'}</p>
            </div>
            <form onSubmit={onJoin}>
              <label htmlFor="room-id">房间号</label>
              <input
                id="room-id"
                name="room"
                minLength={6}
                maxLength={64}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="粘贴或输入房间号"
                value={joinRoom}
                onChange={event => onJoinRoomChange(event.target.value)}
                disabled={busy}
                required
              />
              <button className="primary-button" type="submit" disabled={busy}>
                {busy ? '正在准备…' : '加入房间'}
              </button>
            </form>
          </article>
        </div>
        <p className="form-error dashboard-error" role="alert">{error}</p>
        <p className="dashboard-note">房间最多两人；邀请链接不包含你的账号、密码或登录令牌。</p>
      </div>
    </section>
  );
}
