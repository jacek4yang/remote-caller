import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Info, Link2, PictureInPicture2 } from 'lucide-react';
import type { CallSnapshot, Quality } from '../../call/CallSession';
import { deriveCallStatus } from '../../call/status';
import { useI18n } from '../../i18n/I18nProvider';
import type { MessageKey } from '../../i18n/messages';
import { formatDuration } from '../../lib/format';
import { listDevices, saveDevicePreference, type DeviceKind } from '../../lib/media';
import { safePlay } from '../../lib/play';
import { Modal } from '../ui/Modal';
import { IconButton } from '../ui/IconButton';
import { RemoteStage } from './RemoteStage';
import { LocalPip } from './LocalPip';
import { ControlsDock } from './ControlsDock';
import { InviteCard } from './InviteCard';
import { CallSettingsPanel, DiagnosticsPanel } from './CallPanels';
import type { CallHandlers } from './types';

const QUALITY_KEY: Record<Quality, MessageKey> = {
  excellent: 'call.quality.excellent',
  good: 'call.quality.good',
  unstable: 'call.quality.unstable',
  poor: 'call.quality.poor',
};

interface CallViewProps {
  snapshot: CallSnapshot;
  displayName: string;
  isCreator: boolean;
  shareSupported: boolean;
  handlers: CallHandlers;
}

const IDLE_HIDE_AFTER_MS = 4200;
const EMPTY_DEVICES: DeviceKind = { videoinput: [], audioinput: [], audiooutput: [] };

export function CallView({ snapshot, displayName, isCreator, shareSupported, handlers }: CallViewProps) {
  const { t } = useI18n();
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [uiHidden, setUiHidden] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [inviteOpen, setInviteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [deviceList, setDeviceList] = useState<DeviceKind>(EMPTY_DEVICES);
  const [sinkId, setSinkId] = useState('');

  const status = deriveCallStatus(snapshot);
  const connected = status?.kind === 'connected';
  const waiting = status?.kind === 'waiting';

  // Re-open the invite card at the start of each wait cycle (unless dismissed).
  useEffect(() => {
    setInviteOpen(false);
    if (waiting && isCreator && !snapshot.peerPresent) setInviteOpen(true);
  }, [waiting, isCreator, snapshot.peerPresent, snapshot.wsPhase]);

  // Duration ticking while connected.
  useEffect(() => {
    if (!snapshot.connectedAt) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [snapshot.connectedAt]);

  // ---- Auto-hiding chrome (connected only, never while overlays are open) ----
  const scheduleHide = useCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      if (connected && !settingsOpen && !diagnosticsOpen) setUiHidden(true);
    }, IDLE_HIDE_AFTER_MS);
  }, [connected, settingsOpen, diagnosticsOpen]);

  const poke = useCallback(() => {
    setUiHidden(false);
    scheduleHide();
  }, [scheduleHide]);

  useEffect(() => {
    if (connected) {
      poke();
    } else {
      setUiHidden(false);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    }
  }, [connected, poke]);

  useEffect(() => () => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
  }, []);

  // ---- Speaker output (setSinkId) ----
  const changeOutput = useCallback(async (deviceId: string) => {
    setSinkId(deviceId);
    saveDevicePreference('audiooutput', deviceId);
    const video = remoteVideoRef.current;
    if (video && 'setSinkId' in video) {
      try {
        await (video as HTMLVideoElement & { setSinkId: (id: string) => Promise<void> }).setSinkId(deviceId);
      } catch {
        handlers.onToast(t('call.toast.speakerFailed'));
      }
    }
  }, [handlers, t]);

  useEffect(() => {
    const video = remoteVideoRef.current;
    const saved = localStorage.getItem('rc:device:audiooutput') || '';
    setSinkId(saved);
    if (video && saved && video.sinkId !== saved) void changeOutput(saved);
  }, [changeOutput, snapshot.remoteStream]);

  // ---- Device list for the settings panel ----
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const kinds = await listDevices();
      if (!cancelled) setDeviceList(kinds);
    };
    void refresh();
    navigator.mediaDevices?.addEventListener?.('devicechange', refresh);
    return () => {
      cancelled = true;
      navigator.mediaDevices?.removeEventListener?.('devicechange', refresh);
    };
  }, []);

  // ---- Autoplay recovery ----
  const resumeRemote = useCallback(() => {
    const video = remoteVideoRef.current;
    if (video?.srcObject && video.paused) safePlay(video);
  }, []);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') resumeRemote();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [resumeRemote]);

  const videoDeviceCount = deviceList.videoinput.length;
  const canFlip = snapshot.localVideoEnabled
    && (videoDeviceCount > 1 || /iPhone|iPad|iPod|Android/i.test(navigator.userAgent));

  const pipSupported = Boolean(
    document.pictureInPictureEnabled
    && snapshot.remoteStream
    && typeof HTMLVideoElement.prototype.requestPictureInPicture === 'function',
  );
  const togglePip = async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await remoteVideoRef.current?.requestPictureInPicture();
    } catch {
      handlers.onToast(t('call.toast.pipUnsupported'));
    }
  };

  const duration = snapshot.connectedAt ? formatDuration((now - snapshot.connectedAt) / 1000) : null;
  const qualityTone = snapshot.quality === 'poor' ? 'danger'
    : snapshot.quality === 'unstable' ? 'warning'
      : 'success';
  const localAudioOn = !snapshot.localMuted;
  const localVideoOn = snapshot.localVideoEnabled;

  return (
    <div
      className="call-shell"
      onPointerDown={poke}
      onPointerMove={poke}
      onFocusCapture={poke}
    >
      <RemoteStage
        snapshot={snapshot}
        onVideoElement={node => { remoteVideoRef.current = node; }}
      >
        {inviteOpen && waiting && isCreator && !snapshot.peerPresent ? (
          <InviteCard
            room={snapshot.room}
            shareSupported={shareSupported}
            onCopy={handlers.onCopyInvite}
            onNativeShare={handlers.onNativeShare}
            onDismiss={() => setInviteOpen(false)}
          />
        ) : null}
      </RemoteStage>

      {snapshot.active ? (
        <LocalPip
          snapshot={snapshot}
          displayName={displayName}
          label={t('call.you')}
          onFlip={handlers.onSwitchCamera}
        />
      ) : null}

      {/* ---------- Top chrome ---------- */}
      <div className="call-top" data-hidden={uiHidden ? 'true' : undefined}>
        <div className="call-top-left">
          <button
            type="button"
            className="glass-chip"
            onClick={() => {
              if (isCreator && !snapshot.peerPresent) setInviteOpen(value => !value);
              else handlers.onCopyInvite();
            }}
          >
            {isCreator && !snapshot.peerPresent ? (
              <>
                <Link2 size={15} aria-hidden="true" />
                {t('call.inviteTitle')}
              </>
            ) : (
              <>
                <Copy size={14} aria-hidden="true" />
                <code>{snapshot.room}</code>
              </>
            )}
          </button>
        </div>

        <div className="call-top-center">
          {connected ? (
            <span className="call-status-line" data-tone="connected">
              {t('call.connected')}
              {duration ? <span className="call-duration">{duration}</span> : null}
            </span>
          ) : null}
        </div>

        <div className="call-top-right">
          {snapshot.quality ? (
            <span className="quality-chip" data-tone={qualityTone} role="status" aria-label={t(QUALITY_KEY[snapshot.quality])}>
              <span className="dot" aria-hidden="true" />
              {t(QUALITY_KEY[snapshot.quality])}
            </span>
          ) : null}
          {pipSupported ? (
            <IconButton label={t('call.pictureInPicture')} onClick={() => void togglePip()} className="glass-icon">
              <PictureInPicture2 size={17} />
            </IconButton>
          ) : null}
          <IconButton label={t('call.diagnostics')} onClick={() => setDiagnosticsOpen(true)} className="glass-icon">
            <Info size={17} />
          </IconButton>
        </div>
      </div>

      {snapshot.notice ? (
        <div className="call-notice" role="status" key={snapshot.notice.id}>
          {t(snapshot.notice.key, snapshot.notice.params)}
        </div>
      ) : null}

      {uiHidden && connected ? (
        <button
          type="button"
          className="tap-hint"
          onPointerDown={event => event.stopPropagation()}
          onClick={poke}
        >
          {t('call.tapToShowControls')}
        </button>
      ) : null}

      <ControlsDock
        snapshot={snapshot}
        hidden={uiHidden}
        canFlip={canFlip}
        onToggleMicrophone={() => { poke(); handlers.onToggleMicrophone(); }}
        onToggleCamera={() => { poke(); handlers.onToggleCamera(); }}
        onSwitchCamera={() => handlers.onSwitchCamera()}
        onOpenSettings={() => { setUiHidden(false); setSettingsOpen(true); }}
        onLeave={handlers.onLeave}
      />

      {/* ---------- Modals ---------- */}
      <Modal open={settingsOpen} title={t('call.settings')} onClose={() => setSettingsOpen(false)}>
        <CallSettingsPanel
          videoDevices={deviceList.videoinput}
          audioDevices={deviceList.audioinput}
          outputDevices={deviceList.audiooutput}
          cameraOn={snapshot.localStream?.getVideoTracks().some(track => track.readyState === 'live') || false}
          cameraDeviceId={snapshot.localStream?.getVideoTracks()[0]?.getSettings().deviceId ?? ''}
          micDeviceId={snapshot.localStream?.getAudioTracks()[0]?.getSettings().deviceId ?? ''}
          sinkId={sinkId}
          onVideoDevice={deviceId => handlers.onSwitchVideoInput(deviceId)}
          onAudioDevice={deviceId => handlers.onSwitchAudioInput(deviceId)}
          onOutputDevice={deviceId => void changeOutput(deviceId)}
        />
      </Modal>
      <Modal open={diagnosticsOpen} title={t('call.diagnostics')} onClose={() => setDiagnosticsOpen(false)}>
        <DiagnosticsPanel diagnostics={handlers.getDiagnostics()} snapshot={snapshot} />
      </Modal>

      <div className="visually-hidden" aria-live="polite">
        {!localAudioOn ? t('call.micMuted') + '. ' : ''}
        {!localVideoOn ? t('call.cameraOff') + '. ' : ''}
      </div>
    </div>
  );
}
