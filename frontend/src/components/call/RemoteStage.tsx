import { useEffect, useRef, useState, type ReactNode } from 'react';
import { LoaderCircle, MicOff, Phone, VideoOff } from 'lucide-react';
import type { CallSnapshot } from '../../call/CallSession';
import { deriveCallStatus } from '../../call/status';
import { useI18n } from '../../i18n/I18nProvider';
import { initialOf } from '../../lib/format';
import { safePlay } from '../../lib/play';

interface RemoteStageProps {
  snapshot: CallSnapshot;
  /** Lets the parent reach the remote <video> element (PiP, sink id). */
  onVideoElement?: (node: HTMLVideoElement | null) => void;
  children?: ReactNode;
}

function attachStream(
  video: HTMLVideoElement | null,
  stream: MediaStream | null,
  onReady: (ready: boolean) => void,
): void {
  if (!video) return;
  if (video.srcObject !== stream) {
    video.srcObject = stream;
    if (stream) {
      safePlay(video);
      const mark = () => onReady(video.readyState >= 2);
      video.addEventListener('loadeddata', mark, { once: true });
    } else {
      onReady(false);
    }
  }
}

/** The dominant remote content area: video, calm placeholders, status art. */
export function RemoteStage({ snapshot, onVideoElement, children }: RemoteStageProps) {
  const { t } = useI18n();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoReady, setVideoReady] = useState(false);
  const status = deriveCallStatus(snapshot);

  const stream = snapshot.remoteStream;
  const remoteVideoTracks = stream?.getVideoTracks().filter(track => track.readyState === 'live') ?? [];
  const hasRemoteVideo = remoteVideoTracks.length > 0;
  const showVideo = Boolean(stream) && hasRemoteVideo && !snapshot.remoteVideoOff;

  useEffect(() => {
    attachStream(videoRef.current, stream, setVideoReady);
    const video = videoRef.current;
    if (video && stream && video.paused) {
      safePlay(video);
    }
  }, [stream]);

  useEffect(() => {
    const video = videoRef.current;
    if (showVideo && video?.paused) {
      safePlay(video);
    }
  }, [showVideo]);

  const waiting = status?.kind === 'waiting';
  const connecting = status?.kind === 'connecting';
  const negotiating = status?.kind === 'negotiating';
  const reconnecting = status?.kind === 'reconnecting';
  const offline = status?.kind === 'offline';
  const connected = status?.kind === 'connected';
  const noMedia = !showVideo;

  return (
    <div className="remote-stage">
      <video
        ref={node => {
          videoRef.current = node;
          onVideoElement?.(node);
        }}
        className="remote-video"
        data-hidden={noMedia || !videoReady ? 'true' : undefined}
        autoPlay
        playsInline
        aria-hidden={noMedia ? 'true' : undefined}
      />

      {noMedia && !waiting ? (
        <div className="remote-avatar-stage" data-tone={snapshot.remoteVideoOff ? 'off' : undefined}>
          <span className="remote-avatar">
            {snapshot.peerPresent ? initialOf(snapshot.peerName) : <Phone size={30} aria-hidden="true" />}
          </span>
          {snapshot.peerName ? <p className="remote-state-title">{snapshot.peerName}</p> : null}
          {snapshot.remoteVideoOff ? (
            <p className="remote-state-sub">
              <VideoOff size={14} aria-hidden="true" />
              {t('call.cameraOff')} · {t('call.audioOnly')}
            </p>
          ) : snapshot.mode === 'audio' ? (
            <p className="remote-state-sub">
              <Phone size={14} aria-hidden="true" />
              {t('call.audioOnly')}
            </p>
          ) : null}
          {snapshot.peerPresent && snapshot.remoteMuted ? (
            <p className="remote-state-sub">
              <MicOff size={14} aria-hidden="true" />
              {t('call.micMuted')}
            </p>
          ) : null}
        </div>
      ) : null}

      {waiting ? (
        <div className="waiting-stage">
          <span className="waiting-orbit" aria-hidden="true">
            <span className="waiting-core"><Phone size={34} /></span>
          </span>
          <h2 className="waiting-title">{t('call.waiting.title')}</h2>
          <p className="waiting-subtitle">{t('call.waiting.subtitle')}</p>
        </div>
      ) : null}

      {connecting ? (
        <div className="waiting-stage">
          <span className="connecting-pill">
            <LoaderCircle className="spinner" size={16} aria-hidden="true" />
            {t(status.labelKey)}
          </span>
        </div>
      ) : null}

      {negotiating ? (
        <div className="waiting-stage">
          <span className="remote-avatar">
            {snapshot.peerName ? initialOf(snapshot.peerName) : <Phone size={30} aria-hidden="true" />}
          </span>
          <p className="remote-state-title">{snapshot.peerName || ''}</p>
          <p className="connecting-pill">
            <LoaderCircle className="spinner" size={15} aria-hidden="true" />
            {t(status.labelKey)}
          </p>
        </div>
      ) : null}

      {reconnecting || offline ? (
        <div className="reconnect-banner" role="status">
          <LoaderCircle className="spinner" size={15} aria-hidden="true" />
          {t(status.labelKey)}
        </div>
      ) : null}

      {snapshot.peerPresent && snapshot.peerName && showVideo ? (
        <div className="remote-nameplate">
          <span className="remote-name">{snapshot.peerName}</span>
          {snapshot.remoteMuted ? (
            <span className="remote-state-chip">
              <MicOff size={12} aria-hidden="true" />
              {t('call.micMuted')}
            </span>
          ) : null}
          {connected ? <span className="remote-live-dot" aria-hidden="true" /> : null}
        </div>
      ) : null}

      {children}
    </div>
  );
}
