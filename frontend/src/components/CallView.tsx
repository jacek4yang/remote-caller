import { useCallback, useEffect, useRef } from 'react';
import type { CallSnapshot } from '../call/CallSession';
import { Brand } from './Brand';

interface CallViewProps {
  snapshot: CallSnapshot;
  displayName: string;
  onShare: () => void;
  onToggleMicrophone: () => void;
  onToggleCamera: () => void;
  onSwitchCamera: () => void;
  onHangup: () => void;
  onPlaybackBlocked: () => void;
}

function attachStream(video: HTMLVideoElement | null, stream: MediaStream | null): void {
  if (!video || video.srcObject === stream) return;
  video.srcObject = stream;
  if (stream) void video.play().catch(() => undefined);
}

export function CallView({
  snapshot,
  displayName,
  onShare,
  onToggleMicrophone,
  onToggleCamera,
  onSwitchCamera,
  onHangup,
  onPlaybackBlocked,
}: CallViewProps) {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => attachStream(localVideoRef.current, snapshot.localStream), [snapshot.localStream]);
  useEffect(() => {
    const video = remoteVideoRef.current;
    attachStream(video, snapshot.remoteStream);
    if (video && snapshot.remoteStream) {
      void video.play().catch(onPlaybackBlocked);
    }
  }, [snapshot.remoteStream, onPlaybackBlocked]);

  const resumePlayback = useCallback(() => {
    const video = remoteVideoRef.current;
    if (video?.srcObject && video.paused) void video.play().catch(() => undefined);
  }, []);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') resumePlayback();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pointerdown', resumePlayback, { passive: true });
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pointerdown', resumePlayback);
    };
  }, [resumePlayback]);

  const pictureInPictureAvailable = Boolean(
    document.pictureInPictureEnabled
    && snapshot.remoteStream
    && remoteVideoRef.current?.requestPictureInPicture,
  );
  const togglePictureInPicture = async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await remoteVideoRef.current?.requestPictureInPicture();
    } catch {
      onPlaybackBlocked();
    }
  };
  const showRemotePlaceholder = !snapshot.remoteStream || snapshot.remoteVideoOff;

  return (
    <section className="call" aria-label="通话界面">
      <header className="call-header">
        <div>
          <Brand compact />
          <p className="room-label">房间 {snapshot.room}</p>
        </div>
        <div className="header-actions">
          <span className={'status-badge' + (snapshot.waiting ? ' waiting' : '')}>{snapshot.status}</span>
          <button className="share-button" type="button" onClick={onShare}>分享链接</button>
        </div>
      </header>

      <div className="stage">
        <div className="remote-panel">
          <video
            ref={remoteVideoRef}
            className={snapshot.remoteVideoOff ? 'video-off' : ''}
            autoPlay
            playsInline
          />
          {showRemotePlaceholder && (
            <div className="placeholder">
              <div className="pulse-avatar">{snapshot.peerPresent ? snapshot.peerName.slice(0, 1) : '…'}</div>
              <h2>{snapshot.remoteVideoOff ? snapshot.peerName + '已关闭摄像头' : snapshot.remoteTitle}</h2>
              <p>{snapshot.remoteVideoOff ? '语音仍然保持连接' : snapshot.remoteSubtitle}</p>
            </div>
          )}
          {snapshot.peerName && <div className="name-tag">{snapshot.peerName}</div>}
        </div>
        <div className="local-panel">
          <video ref={localVideoRef} autoPlay muted playsInline hidden={!snapshot.localVideoEnabled} />
          {!snapshot.localVideoEnabled && <div className="local-avatar">{displayName.slice(0, 1) || '我'}</div>}
          <span className="local-label">你</span>
        </div>
      </div>

      <div className="controls" role="toolbar" aria-label="通话控制">
        <button
          className="control-button"
          type="button"
          aria-pressed={snapshot.localMuted}
          onClick={onToggleMicrophone}
        >
          <span className="control-icon" aria-hidden="true">{snapshot.localMuted ? '♪' : '♩'}</span>
          <span>{snapshot.localMuted ? '取消静音' : '静音'}</span>
        </button>
        <button
          className="control-button"
          type="button"
          aria-pressed={!snapshot.localVideoEnabled}
          onClick={onToggleCamera}
        >
          <span className="control-icon" aria-hidden="true">▣</span>
          <span>{snapshot.localVideoEnabled ? '关摄像头' : '开摄像头'}</span>
        </button>
        <button
          className="control-button mobile-only"
          type="button"
          onClick={onSwitchCamera}
          disabled={!snapshot.localVideoEnabled}
        >
          <span className="control-icon" aria-hidden="true">↻</span><span>翻转</span>
        </button>
        {pictureInPictureAvailable && (
          <button className="control-button" type="button" onClick={() => void togglePictureInPicture()}>
            <span className="control-icon" aria-hidden="true">▱</span><span>画中画</span>
          </button>
        )}
        <button className="control-button danger" type="button" onClick={onHangup}>
          <span className="control-icon" aria-hidden="true">×</span><span>挂断</span>
        </button>
      </div>
    </section>
  );
}
