import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CallSession,
  initialCallSnapshot,
  type CallSnapshot,
  type StartCallOptions,
} from '../call/CallSession';

interface UseCallSessionOptions {
  onToast: (message: string) => void;
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
      onToast: message => optionsRef.current.onToast(message),
      onAuthExpired: room => optionsRef.current.onAuthExpired(room),
      onRoomFull: room => optionsRef.current.onRoomFull(room),
    });
  }

  useEffect(() => {
    const controller = controllerRef.current as CallSession;
    const onPageHide = () => controller.stop();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') controller.handleVisible();
    };
    const onOnline = () => controller.handleOnline();
    const onOffline = () => controller.handleOffline();

    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
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
  const getRoom = useCallback(() => (controllerRef.current as CallSession).getRoom(), []);

  return {
    snapshot,
    start,
    stop,
    toggleMicrophone,
    toggleCamera,
    switchCamera,
    getRoom,
  };
}
