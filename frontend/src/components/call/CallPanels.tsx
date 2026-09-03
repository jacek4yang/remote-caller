import { Globe, Monitor, Moon, Sun } from 'lucide-react';
import type { CallDiagnostics, CallSnapshot } from '../../call/CallSession';
import { useI18n } from '../../i18n/I18nProvider';
import { LOCALES, type Locale } from '../../i18n/messages';
import type { MessageKey } from '../../i18n/messages';
import { useTheme, type ThemeMode } from '../../theme/ThemeProvider';
import { formatBitrate, formatPercent, formatResolution, formatSeconds } from '../../lib/format';
import { supportsSetSinkId } from '../../lib/media';
import { SelectField } from '../ui/controls';

const THEME_ICON: Record<ThemeMode, typeof Sun> = { light: Sun, dark: Moon, system: Monitor };
const THEME_KEY: Record<ThemeMode, 'theme.light' | 'theme.dark' | 'theme.system'> = {
  light: 'theme.light',
  dark: 'theme.dark',
  system: 'theme.system',
};
const LOCALE_LABEL: Record<Locale, string> = { 'en-US': 'English', 'zh-CN': '简体中文' };

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="diag-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function stateLabel(state: string): MessageKey {
  switch (state) {
    case 'connected': return 'diag.state.connected';
    case 'connecting': return 'diag.state.connecting';
    case 'disconnected': return 'diag.state.disconnected';
    case 'failed': return 'diag.state.failed';
    case 'closed': return 'diag.state.closed';
    case 'reconnecting': return 'diag.state.reconnecting';
    default: return 'diag.unknown';
  }
}

/** Advanced connection details behind the info button. */
export function DiagnosticsPanel({ diagnostics, snapshot }: { diagnostics: CallDiagnostics | null; snapshot: CallSnapshot }) {
  const { t } = useI18n();
  const mediaState = snapshot.pcPhase === 'none'
    ? t('diag.state.none')
    : t(stateLabel(snapshot.pcPhase));
  const wsState = snapshot.wsPhase === 'idle'
    ? t('diag.state.none')
    : t(stateLabel(snapshot.wsPhase === 'reconnecting' ? 'reconnecting' : snapshot.wsPhase === 'open' ? 'connected' : 'connecting'));

  return (
    <div>
      <dl className="diag-grid">
        <Row label={t('diag.connectionState')}>{mediaState}</Row>
        <Row label={t('diag.signaling')}>{wsState}</Row>
        <Row label={t('diag.route')}>
          {!diagnostics
            ? t('diag.unknown')
            : diagnostics.route === 'direct' ? t('diag.route.direct') : diagnostics.route === 'relay' ? t('diag.route.relay') : t('diag.unknown')}
        </Row>
        <Row label={t('diag.codec')}>{diagnostics?.codec || t('diag.unknown')}</Row>
        <Row label={t('diag.resolution')}>
          {diagnostics?.resolution ? formatResolution(diagnostics.resolution.width, diagnostics.resolution.height) : t('diag.unknown')}
        </Row>
        <Row label={t('diag.framerate')}>
          {diagnostics?.frameRate ? diagnostics.frameRate.toFixed(0) + ' fps' : t('diag.unknown')}
        </Row>
        <Row label={t('diag.bitrate')}>
          {diagnostics?.outboundBitrate ? formatBitrate(diagnostics.outboundBitrate) : t('diag.unknown')}
        </Row>
        <Row label={t('diag.rtt')}>{formatSeconds(diagnostics?.rtt)}</Row>
        <Row label={t('diag.loss')}>{formatPercent(diagnostics?.loss)}</Row>
        <Row label={t('diag.jitter')}>{formatSeconds(diagnostics?.jitter)}</Row>
      </dl>
      <p className="hint-text diag-note">{t('diag.p2pNote')}</p>
    </div>
  );
}

interface DevicesPanelProps {
  videoDevices: MediaDeviceInfo[];
  audioDevices: MediaDeviceInfo[];
  outputDevices: MediaDeviceInfo[];
  cameraOn: boolean;
  cameraDeviceId: string;
  micDeviceId: string;
  sinkId: string;
  onVideoDevice: (deviceId: string) => void;
  onAudioDevice: (deviceId: string) => void;
  onOutputDevice: (deviceId: string) => void;
}

/** Devices + appearance preferences inside the call settings modal. */
export function CallSettingsPanel({
  videoDevices,
  audioDevices,
  outputDevices,
  cameraOn,
  cameraDeviceId,
  micDeviceId,
  sinkId,
  onVideoDevice,
  onAudioDevice,
  onOutputDevice,
}: DevicesPanelProps) {
  const { t, locale, setLocale } = useI18n();
  const { mode, setMode } = useTheme();
  return (
    <div className="settings-stack">
      <div className="mode-seg settings-seg" role="group" aria-label={t('theme.label')}>
        {(['light', 'dark', 'system'] as ThemeMode[]).map(item => {
          const Icon = THEME_ICON[item];
          return (
            <button key={item} type="button" aria-pressed={mode === item} onClick={() => setMode(item)}>
              <Icon size={15} aria-hidden="true" />
              <span>{t(THEME_KEY[item])}</span>
            </button>
          );
        })}
      </div>
      <div className="mode-seg settings-seg" role="group" aria-label={t('lang.label')}>
        {LOCALES.map(item => (
          <button key={item} type="button" aria-pressed={locale === item} onClick={() => setLocale(item)}>
            <Globe size={15} aria-hidden="true" />
            <span>{LOCALE_LABEL[item]}</span>
          </button>
        ))}
      </div>

      <div className="device-list settings-devices">
        {videoDevices.length > 0 ? (
          <SelectField label={t('settings.camera')} value={cameraDeviceId} onChange={onVideoDevice} disabled={!cameraOn}>
            <option value="">{t('lobby.defaultDevice')}</option>
            {videoDevices.map(device => (
              <option key={device.deviceId} value={device.deviceId}>{device.label || t('lobby.deviceUnavailable')}</option>
            ))}
          </SelectField>
        ) : null}
        {audioDevices.length > 0 ? (
          <SelectField label={t('settings.mic')} value={micDeviceId} onChange={onAudioDevice}>
            <option value="">{t('lobby.defaultDevice')}</option>
            {audioDevices.map(device => (
              <option key={device.deviceId} value={device.deviceId}>{device.label || t('lobby.deviceUnavailable')}</option>
            ))}
          </SelectField>
        ) : null}
        {supportsSetSinkId() && outputDevices.length > 0 ? (
          <SelectField label={t('settings.speaker')} value={sinkId} onChange={onOutputDevice}>
            <option value="">{t('call.speakerDefault')}</option>
            {outputDevices.map(device => (
              <option key={device.deviceId} value={device.deviceId}>{device.label || t('lobby.deviceUnavailable')}</option>
            ))}
          </SelectField>
        ) : null}
      </div>
    </div>
  );
}
