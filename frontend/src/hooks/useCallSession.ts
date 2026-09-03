import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CallSession,
  initialCallSnapshot,
  type CallDiagnostics,
  type CallSnapshot,
  type StartCallOptions,
} from '../call/CallSession';
import type { MessageKey } from '../i18n/messages';

interface UseCallSessionOptions {
  onToast: (key: MessageKey, params?: Record<string, string | number>) => void;
  onAuthExpired: (room: string) => void;
  onRoomFull: (room: string) => void;
}

export interface CallSessionApi {
  snapshot: CallSnapshot;
  start: (options: StartCallOptions) => Promise<void>;
  stop: () => void;
  toggleMicrophone: () => Promise<void>;
  toggleCamera: () => Promise<void>;
  switchCamera: () => Promise<void>;
  switchVideoInput: (deviceId: string) => Promise<void>;
  switchAudioInput: (deviceId: string) => Promise<void>;
  getDiagnostics: () => CallDiagnostics | null;
  getRoom: () => string;
}

export function useCallSession(options: UseCallSessionOptions): CallSessionApi {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [snapshot, setSnapshot] = useState<CallSnapshot>(() => initialCallSnapshot());
  const controllerRef = useRef<CallSession | null>(null);

  if (!controllerRef.current) {
    controllerRef.current = new CallSession({
      onChange: next => setSnapshot(next),
      onToast: (key, params) => optionsRef.current.onToast(key, params),
      onAuthExpired: room => optionsRef.current.onAuthExpired(room),
      onRoomFull: room => optionsRef.current.onRoomFull(room),
    });
  }

  useEffect(() => {
    const controller = controllerRef.current as CallSession;
    const onPageHide = () => controller.stop();
    const onPageshow = (event: PageTransitionEvent) => {
      // Mobile Safari may put a running call into the back/forward cache.
      // Everything was released on pagehide; return to a coherent state and
      // let the user rejoin with one tap instead of showing a zombie call.
      if (event.persisted && controller.getSnapshot().active) {
        controller.stop();
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') controller.handleVisible();
    };
    const onOnline = () => controller.handleOnline();
    const onOffline = () => controller.handleOffline();

    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageshow);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageshow);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisibility);
      controller.dispose();
    };
  }, []);

  const start = useCallback((startOptions: StartCallOptions) => (
    (controllerRef.current as CallSession).start(startOptions)
  ), []);
  const stop = useCallback(() => (controllerRef.current as CallSession).stop(), []);
  const toggleMicrophone = useCallback(() => (
    (controllerRef.current as CallSession).toggleMicrophone()
  ), []);
  const toggleCamera = useCallback(() => (
    (controllerRef.current as CallSession).toggleCamera()
  ), []);
  const switchCamera = useCallback(() => (
    (controllerRef.current as CallSession).switchCamera()
  ), []);
  const switchVideoInput = useCallback((deviceId: string) => (
    (controllerRef.current as CallSession).switchVideoInput(deviceId)
  ), []);
  const switchAudioInput = useCallback((deviceId: string) => (
    (controllerRef.current as CallSession).switchAudioInput(deviceId)
  ), []);
  const getDiagnostics = useCallback(() => (
    (controllerRef.current as CallSession).getDiagnostics()
  ), []);
  const getRoom = useCallback(() => (controllerRef.current as CallSession).getRoom(), []);

  return {
    snapshot,
    start,
    stop,
    toggleMicrophone,
    toggleCamera,
    switchCamera,
    switchVideoInput,
    switchAudioInput,
    getDiagnostics,
    getRoom,
  };
}
