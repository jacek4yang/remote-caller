import type { CallDiagnostics, CallSnapshot } from '../../call/CallSession';

/** Callbacks the call screen can invoke; implemented by App via the session. */
export interface CallHandlers {
  onToggleMicrophone: () => void;
  onToggleCamera: () => void;
  onSwitchCamera: () => void;
  onSwitchVideoInput: (deviceId: string) => void;
  onSwitchAudioInput: (deviceId: string) => void;
  onLeave: () => void;
  onCopyInvite: () => void;
  onNativeShare: () => void;
  onToast: (message: string) => void;
  getDiagnostics: () => CallDiagnostics | null;
}

export type { CallSnapshot };
