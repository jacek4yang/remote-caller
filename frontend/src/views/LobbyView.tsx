import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Camera,
  CameraOff,
  CircleAlert,
  LoaderCircle,
  Mic,
  MicOff,
  Phone,
  RefreshCw,
  Video,
  Volume2,
} from 'lucide-react';
import { Button } from '../components/ui/Button';
import { SelectField, Switch } from '../components/ui/controls';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/messages';
import { useLocalMedia } from '../hooks/useLocalMedia';
import { initialOf } from '../lib/format';
import type { MediaErrorKind } from '../lib/media';
import type { CallMode } from '../call/CallSession';

export interface LobbyStartOptions {
  room: string;
  mode: CallMode;
  stream: MediaStream;
  cameraDeviceId: string;
  audioDeviceId: string;
}

interface LobbyViewProps {
  flavor: 'create' | 'join';
  /** Pre-filled room id (join flavor). Empty for create. */
  room: string;
  defaultMode: CallMode;
  localName: string;
  onCancel: () => void;
  onStart: (options: LobbyStartOptions) => void;
}

const ERROR_KEY: Record<MediaErrorKind, MessageKey> = {
  denied: 'lobby.mediaError.denied',
  notfound: 'lobby.mediaError.notfound',
  inuse: 'lobby.mediaError.inuse',
  unsupported: 'lobby.mediaError.unsupported',
  insecure: 'lobby.mediaError.insecure',
  generic: 'lobby.mediaError.generic',
};

export function LobbyView({ flavor, room, defaultMode, localName, onCancel, onStart }: LobbyViewProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<CallMode>(defaultMode);
  const [startBusy, setStartBusy] = useState(false);
  const media = useLocalMedia({
    initialVideo: defaultMode === 'video',
    cameraDeviceId: undefined,
    audioDeviceId: undefined,
  });
  const { stream } = media;

  const startRef = useRef<() => void>(() => undefined);
  startRef.current = () => {
    if (!stream || startBusy) return;
    const detached = media.detach();
    if (!detached) return;
    setStartBusy(true);
    onStart({
      room,
      mode,
      stream: detached,
      cameraDeviceId: media.cameraDeviceId,
      audioDeviceId: media.micDeviceId,
    });
  };

  const pickMode = useCallback((next: CallMode) => {
    if (next === mode) return;
    setMode(next);
    if (next === 'audio') void media.setVideoOn(false);
    else if (!media.cameraError) void media.setVideoOn(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, media]);

  const showVideoArt = mode === 'video' && media.videoOn && Boolean(stream?.getVideoTracks().length);
  const fatalKey = media.fatalError ? ERROR_KEY[media.fatalError] : null;
  const cameraIssueKey = media.cameraError && !fatalKey ? ERROR_KEY[media.cameraError] : null;

  const toggleAudio = useCallback(() => void media.setAudioOn(!media.audioOn), [media]);
  const toggleVideo = useCallback(() => void media.setVideoOn(!media.videoOn), [media]);
  const cameraDisabled = media.fatalError !== null || media.busy;

  return (
    <div className="view lobby-shell">
      <div className="topbar">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={startBusy}>
          <ArrowLeft size={16} aria-hidden="true" />
          {t('lobby.back')}
        </Button>
        {flavor === 'join' && room ? (
          <span className="badge lobby-room-chip" data-tone="accent">
            <span className="visually-hidden">{t('call.roomCode')}: </span>
            {room}
          </span>
        ) : null}
      </div>

      <div className="lobby-layout">
        {/* ---------- Preview stage ---------- */}
        <div className="preview-stage" aria-label={t(mode === 'video' ? 'lobby.camera' : 'lobby.voicePreview')}>
          <video
            className="preview-video"
            data-muted={showVideoArt ? undefined : 'true'}
            autoPlay
            muted
            playsInline
            ref={node => {
              if (node && node.srcObject !== stream) node.srcObject = stream;
            }}
          />
          <div className="preview-fallback" data-hidden={showVideoArt ? 'true' : undefined}>
            {mode === 'audio' || !media.videoOn ? (
              <div className="voice-art" aria-hidden="true">
                <span className="ring" />
                <span className="ring" />
                <span className="ring" />
                <span className="core">{mode === 'audio' ? <Phone size={30} /> : <CameraOff size={28} />}</span>
              </div>
            ) : (
              <div className="voice-art" aria-hidden="true">
                <span className="core" style={{ background: 'var(--accent-soft)', color: 'var(--text-1)', fontSize: '2rem', fontWeight: 800 }}>
                  {initialOf(localName)}
                </span>
              </div>
            )}
            <p className="hint-text" style={{ marginTop: 12, maxWidth: 280, textAlign: 'center' }}>
              {mode === 'audio' ? t('lobby.voicePreview') : t('lobby.cameraPreviewOff')}
            </p>
          </div>
          {media.busy ? (
            <span className="preview-hint"><LoaderCircle className="spinner" size={14} aria-hidden="true" />{t('common.loading')}</span>
          ) : null}
          {showVideoArt && media.audioOn === false ? (
            <span className="preview-hint"><MicOff size={14} aria-hidden="true" />{t('lobby.micOff')}</span>
          ) : null}
        </div>

        {/* ---------- Control panel ---------- */}
        <div className="card lobby-panel">
          <div className="lobby-panel-title">
            <h1>{t(flavor === 'create' ? 'lobby.createTitle' : 'lobby.joinTitle')}</h1>
            <p>{t(flavor === 'create' ? 'lobby.createHint' : 'lobby.joinHint')}</p>
          </div>

          <div className="mode-seg" role="group" aria-label={t('lobby.callType')}>
            <button
              type="button"
              aria-pressed={mode === 'video'}
              onClick={() => pickMode('video')}
              disabled={media.busy}
            >
              <Video size={16} aria-hidden="true" />
              {t('lobby.mode.video')}
            </button>
            <button
              type="button"
              aria-pressed={mode === 'audio'}
              onClick={() => pickMode('audio')}
              disabled={media.busy}
            >
              <Phone size={15} aria-hidden="true" />
              {t('lobby.mode.audio')}
            </button>
          </div>

          {mode === 'video' ? (
            <div className="toggle-line">
              <span className="toggle-copy">
                {media.videoOn ? <Camera size={17} aria-hidden="true" /> : <CameraOff size={17} aria-hidden="true" />}
                {t(media.videoOn ? 'lobby.cameraOn' : 'lobby.cameraOff')}
              </span>
              <Switch
                label={t(media.videoOn ? 'lobby.cameraOff' : 'lobby.cameraOn')}
                checked={media.videoOn}
                disabled={cameraDisabled}
                onChange={toggleVideo}
              />
            </div>
          ) : null}

          <div className="toggle-line">
            <span className="toggle-copy">
              {media.audioOn ? <Mic size={17} aria-hidden="true" /> : <MicOff size={17} aria-hidden="true" />}
              {t(media.audioOn ? 'lobby.micOn' : 'lobby.micOff')}
            </span>
            <Switch
              label={t(media.audioOn ? 'lobby.micOff' : 'lobby.micOn')}
              checked={media.audioOn}
              disabled={cameraDisabled}
              onChange={toggleAudio}
            />
          </div>

          <div className="device-list">
            {media.devices.videoinput.length > 1 ? (
              <SelectField
                label={t('lobby.videoDevice')}
                value={media.cameraDeviceId}
                disabled={media.fatalError !== null}
                onChange={value => void media.setCameraDevice(value)}
              >
                <option value="">{t('lobby.defaultDevice')}</option>
                {media.devices.videoinput.map(device => (
                  <option key={device.deviceId} value={device.deviceId}>{device.label || t('lobby.deviceUnavailable')}</option>
                ))}
              </SelectField>
            ) : null}
            {media.devices.audioinput.length > 1 ? (
              <SelectField
                label={t('lobby.audioDevice')}
                value={media.micDeviceId}
                disabled={media.fatalError !== null}
                onChange={value => void media.setMicDevice(value)}
              >
                <option value="">{t('lobby.defaultDevice')}</option>
                {media.devices.audioinput.map(device => (
                  <option key={device.deviceId} value={device.deviceId}>{device.label || t('lobby.deviceUnavailable')}</option>
                ))}
              </SelectField>
            ) : null}
            {mode === 'video' && media.devices.videoinput.length <= 1 && media.videoOn ? (
              <div className="lobby-row">
                <div className="lobby-row-head">
                  <span className="row-label"><Camera size={15} aria-hidden="true" />{t('lobby.videoDevice')}</span>
                  <Button variant="ghost" size="sm" onClick={() => void media.flipCamera()} disabled={media.busy}>
                    <RefreshCw size={14} aria-hidden="true" />
                    {t('call.switchCamera')}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>

          {fatalKey ? (
            <div className="lobby-error" role="alert">
              <p style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <CircleAlert size={16} style={{ flex: 'none', marginTop: 2 }} aria-hidden="true" />
                <span>{t(fatalKey)}</span>
              </p>
              <Button variant="secondary" size="sm" style={{ marginTop: 12 }} onClick={() => void media.retry()}>
                <RefreshCw size={14} aria-hidden="true" />
                {t('lobby.retryMedia')}
              </Button>
            </div>
          ) : null}

          {cameraIssueKey && mode === 'video' ? (
            <div className="lobby-error" role="status">
              <p style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <CircleAlert size={16} style={{ flex: 'none', marginTop: 2 }} aria-hidden="true" />
                <span>{t(cameraIssueKey)}</span>
              </p>
              <Button variant="secondary" size="sm" style={{ marginTop: 12 }} onClick={() => void media.retry()}>
                <RefreshCw size={14} aria-hidden="true" />
                {t('common.retry')}
              </Button>
            </div>
          ) : null}

          <div className="lobby-cta">
            <Button
              variant="primary"
              size="lg"
              block
              busy={media.busy || startBusy}
              disabled={!stream || media.fatalError !== null}
              onClick={() => startRef.current()}
            >
              {flavor === 'create' ? t('lobby.start') : t('lobby.joinNow')}
            </Button>
            <p className="lobby-cta-note">
              {flavor === 'create' ? t('lobby.connectingNote') : t('lobby.joiningRoomNote')}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
