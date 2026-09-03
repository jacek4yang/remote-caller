import { Mic, MicOff, PhoneOff, Settings2, SwitchCamera, Video, VideoOff } from 'lucide-react';
import type { CallSnapshot } from '../../call/CallSession';
import { useI18n } from '../../i18n/I18nProvider';

interface ControlsDockProps {
  snapshot: CallSnapshot;
  hidden: boolean;
  canFlip: boolean;
  onToggleMicrophone: () => void;
  onToggleCamera: () => void;
  onSwitchCamera: () => void;
  onOpenSettings: () => void;
  onLeave: () => void;
}

function ControlButton({
  label,
  pressed,
  danger,
  onClick,
  children,
  disabled,
}: {
  label: string;
  pressed?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="call-ctl"
      data-pressed={pressed ? 'true' : 'false'}
      data-danger={danger ? 'true' : undefined}
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      disabled={disabled}
      title={label}
    >
      {children}
    </button>
  );
}

/** Bottom (or right-edge) cluster of circular call controls. */
export function ControlsDock({
  snapshot,
  hidden,
  canFlip,
  onToggleMicrophone,
  onToggleCamera,
  onSwitchCamera,
  onOpenSettings,
  onLeave,
}: ControlsDockProps) {
  const { t } = useI18n();
  const cameraOn = snapshot.localVideoEnabled;
  const micOn = !snapshot.localMuted;

  return (
    <div className="controls-dock" data-hidden={hidden ? 'true' : undefined} role="toolbar" aria-label={t('call.controlsLabel')}>
      <ControlButton
        label={micOn ? t('call.mute') : t('call.unmute')}
        pressed={!micOn}
        onClick={onToggleMicrophone}
      >
        {micOn ? <Mic size={24} /> : <MicOff size={24} />}
      </ControlButton>

      <ControlButton
        label={cameraOn ? t('call.turnCameraOff') : t('call.turnCameraOn')}
        pressed={!cameraOn}
        onClick={onToggleCamera}
      >
        {cameraOn ? <Video size={25} /> : <VideoOff size={25} />}
      </ControlButton>

      {canFlip && cameraOn ? (
        <ControlButton label={t('call.switchCamera')} onClick={onSwitchCamera}>
          <SwitchCamera size={24} />
        </ControlButton>
      ) : null}

      <ControlButton label={t('call.settings')} onClick={onOpenSettings}>
        <Settings2 size={22} />
      </ControlButton>

      <ControlButton label={t('call.endCall')} danger onClick={onLeave}>
        <PhoneOff size={24} />
      </ControlButton>
    </div>
  );
}
