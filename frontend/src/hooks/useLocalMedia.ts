import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cameraConstraints,
  kindOfMediaError,
  listDevices,
  microphoneConstraints,
  saveDevicePreference,
  type DeviceKind,
  type MediaErrorKind,
} from '../lib/media';

export interface UseLocalMediaOptions {
  /** Whether the initial acquisition should request the camera. */
  initialVideo: boolean;
  cameraDeviceId?: string;
  audioDeviceId?: string;
}

export interface LocalMediaController {
  stream: MediaStream | null;
  busy: boolean;
  /** Audio acquisition failed — calling is not possible until resolved. */
  fatalError: MediaErrorKind | null;
  /** Camera failed but audio is fine; the call can proceed without video. */
  cameraError: MediaErrorKind | null;
  audioOn: boolean;
  videoOn: boolean;
  devices: DeviceKind;
  cameraDeviceId: string;
  micDeviceId: string;
  retry: () => Promise<void>;
  setAudioOn: (on: boolean) => Promise<void>;
  setVideoOn: (on: boolean) => Promise<void>;
  flipCamera: () => Promise<void>;
  setCameraDevice: (deviceId: string) => Promise<void>;
  setMicDevice: (deviceId: string) => Promise<void>;
  /** Hands the stream to the call engine; the hook stops managing it. */
  detach: () => MediaStream | null;
}

const EMPTY: DeviceKind = { videoinput: [], audioinput: [], audiooutput: [] };

/**
 * Manages the pre-call local stream.
 *
 * Acquisition is staged and degrades gracefully: audio is mandatory, and when
 * the camera prompt is denied (or no camera exists) the preview continues with
 * audio only instead of blocking the call.
 */
export function useLocalMedia(options: UseLocalMediaOptions): LocalMediaController {
  const optsRef = useRef(options);
  optsRef.current = options;

  const [stream, setStream] = useState<MediaStream | null>(null);
  const [busy, setBusy] = useState(true);
  const [fatalError, setFatalError] = useState<MediaErrorKind | null>(null);
  const [cameraError, setCameraError] = useState<MediaErrorKind | null>(null);
  const [audioOn, setAudioOnState] = useState(true);
  const [videoOn, setVideoOnState] = useState(options.initialVideo);
  const [devices, setDevices] = useState<DeviceKind>(EMPTY);
  const [cameraDeviceId, setCameraDeviceId] = useState(options.cameraDeviceId || '');
  const [micDeviceId, setMicDeviceId] = useState(options.audioDeviceId || '');

  const streamRef = useRef<MediaStream | null>(null);
  const generationRef = useRef(0);
  const releasedRef = useRef(false);
  const handedOffRef = useRef(false);
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  const audioOnRef = useRef(true);
  const videoOnRef = useRef(options.initialVideo);
  const mountedRef = useRef(true);

  const replaceStream = useCallback((next: MediaStream | null) => {
    streamRef.current = next;
    setStream(next);
  }, []);

  const setAudioFlags = useCallback((on: boolean) => {
    audioOnRef.current = on;
    setAudioOnState(on);
  }, []);

  const setVideoFlags = useCallback((on: boolean) => {
    videoOnRef.current = on;
    setVideoOnState(on);
  }, []);

  const refreshDevices = useCallback(async () => {
    const kinds = await listDevices();
    if (mountedRef.current) setDevices(kinds);
  }, []);

  /** Serializes device operations so rapid toggles cannot interleave. */
  const runExclusive = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
    const result = queueRef.current.then(operation, operation);
    queueRef.current = result.then(() => undefined, () => undefined);
    return result;
  }, []);

  const applyTrackState = useCallback(() => {
    const current = streamRef.current;
    if (!current) return;
    setAudioFlags(current.getAudioTracks().some(track => track.enabled && track.readyState === 'live'));
    setVideoFlags(current.getVideoTracks().some(track => track.enabled && track.readyState === 'live'));
  }, [setAudioFlags, setVideoFlags]);

  const captureActualDeviceIds = useCallback((acquired: MediaStream) => {
    const mic = acquired.getAudioTracks()[0]?.getSettings().deviceId;
    const cam = acquired.getVideoTracks()[0]?.getSettings().deviceId;
    if (mic) {
      setMicDeviceId(mic);
      saveDevicePreference('audioinput', mic);
    }
    if (cam) {
      setCameraDeviceId(cam);
      saveDevicePreference('videoinput', cam);
    }
  }, []);

  /** Removes + stops every local track of `kind`, optionally adding `next`. */
  const clearKind = useCallback((kind: 'audio' | 'video', next?: MediaStreamTrack) => {
    const current = streamRef.current;
    if (!current) return;
    const previousTracks = current.getTracks().filter(track => track.kind === kind);
    previousTracks.forEach(track => {
      current.removeTrack(track);
      track.stop();
    });
    if (next) current.addTrack(next);
  }, []);

  const boot = useCallback(async () => {
    const generation = ++generationRef.current;
    const opts = optsRef.current;
    if (releasedRef.current || handedOffRef.current) return;
    setBusy(true);

    let lastErrorKind: MediaErrorKind = 'generic';
    let acquired: MediaStream | null = null;

    if (opts.initialVideo) {
      try {
        acquired = await navigator.mediaDevices.getUserMedia({
          audio: microphoneConstraints(opts.audioDeviceId || undefined),
          video: cameraConstraints(opts.cameraDeviceId ? { deviceId: opts.cameraDeviceId } : { facingMode: 'user' }),
        });
      } catch (error) {
        lastErrorKind = kindOfMediaError(error);
        try {
          acquired = await navigator.mediaDevices.getUserMedia({
            audio: microphoneConstraints(opts.audioDeviceId || undefined),
            video: false,
          });
        } catch (audioError) {
          lastErrorKind = kindOfMediaError(audioError);
          acquired = null;
        }
      }
    } else {
      try {
        acquired = await navigator.mediaDevices.getUserMedia({
          audio: microphoneConstraints(opts.audioDeviceId || undefined),
          video: false,
        });
      } catch (error) {
        lastErrorKind = kindOfMediaError(error);
      }
    }

    if (generation !== generationRef.current || releasedRef.current || handedOffRef.current) {
      acquired?.getTracks().forEach(track => track.stop());
      return;
    }
    if (!acquired) {
      if (mountedRef.current) {
        setFatalError(lastErrorKind);
        setBusy(false);
      }
      return;
    }

    streamRef.current?.getTracks().forEach(track => track.stop());
    replaceStream(acquired);
    setFatalError(null);
    captureActualDeviceIds(acquired);
    applyTrackState();
    const videoLive = acquired.getVideoTracks().some(track => track.readyState === 'live');
    if (opts.initialVideo && !videoLive && lastErrorKind !== 'generic') {
      setCameraError(lastErrorKind);
    }
    setVideoFlags(videoLive);
    if (mountedRef.current) setBusy(false);
    await refreshDevices();
  }, [applyTrackState, captureActualDeviceIds, refreshDevices, replaceStream, setVideoFlags]);

  useEffect(() => {
    mountedRef.current = true;
    releasedRef.current = false;
    handedOffRef.current = false;
    void runExclusive(boot);
    const onDeviceChange = () => void refreshDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange);
    return () => {
      mountedRef.current = false;
      releasedRef.current = true;
      generationRef.current += 1;
      navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange);
      if (!handedOffRef.current) {
        streamRef.current?.getTracks().forEach(track => track.stop());
        streamRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const acquireCamera = useCallback(async (deviceId: string): Promise<boolean> => {
    const generation = generationRef.current;
    try {
      const camera = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: cameraConstraints(deviceId ? { deviceId } : { facingMode: 'user' }),
      });
      const target = streamRef.current;
      if (generation !== generationRef.current || releasedRef.current || handedOffRef.current || !target) {
        camera.getTracks().forEach(track => track.stop());
        return false;
      }
      const track = camera.getVideoTracks()[0];
      if (track) {
        clearKind('video', track);
        setCameraError(null);
        setVideoFlags(true);
        const used = track.getSettings().deviceId || deviceId;
        if (used) {
          setCameraDeviceId(used);
          saveDevicePreference('videoinput', used);
        }
      } else {
        camera.getTracks().forEach(item => item.stop());
      }
      camera.getTracks().forEach(item => { if (item.kind !== 'video') item.stop(); });
      void refreshDevices();
      return true;
    } catch (error) {
      setCameraError(kindOfMediaError(error));
      return false;
    }
  }, [clearKind, refreshDevices, setVideoFlags]);

  const retry = useCallback(async () => {
    if (fatalError !== null) {
      // Retry with the user's latest intent, not the initial boot mode.
      optsRef.current = { ...optsRef.current, initialVideo: videoOnRef.current };
      await runExclusive(boot);
      return;
    }
    // Camera-only retry after a graceful degradation.
    await runExclusive(() => acquireCamera(cameraDeviceId));
  }, [acquireCamera, boot, cameraDeviceId, fatalError, runExclusive]);

  const setAudioOn = useCallback(async (on: boolean) => {
    setAudioFlags(on);
    for (const track of streamRef.current?.getAudioTracks() ?? []) track.enabled = on;
  }, [setAudioFlags]);

  const setVideoOn = useCallback(async (on: boolean) => {
    if (on === videoOnRef.current) return;
    const current = streamRef.current;
    if (!current) return;
    if (!on) {
      // In the lobby "camera off" is a privacy statement: fully release the
      // camera instead of leaving it warm. (In-call toggles mute the track so
      // switching back is instant.)
      clearKind('video');
      setVideoFlags(false);
      return;
    }
    await runExclusive(() => acquireCamera(cameraDeviceId));
  }, [acquireCamera, cameraDeviceId, clearKind, runExclusive, setVideoFlags]);

  const setCameraDevice = useCallback(async (deviceId: string) => {
    if (!deviceId || deviceId === cameraDeviceId) return;
    if (streamRef.current && !videoOnRef.current) {
      // Camera is off: remember the preference without prompting again.
      setCameraDeviceId(deviceId);
      saveDevicePreference('videoinput', deviceId);
      return;
    }
    await runExclusive(() => acquireCamera(deviceId));
  }, [acquireCamera, cameraDeviceId, runExclusive]);

  const setMicDevice = useCallback(async (deviceId: string) => {
    const current = streamRef.current;
    if (!current || !deviceId || deviceId === micDeviceId) return;
    await runExclusive(async () => {
      const wasEnabled = current.getAudioTracks().some(track => track.enabled && track.readyState === 'live');
      try {
        const mic = await navigator.mediaDevices.getUserMedia({
          audio: microphoneConstraints(deviceId),
          video: false,
        });
        if (releasedRef.current || handedOffRef.current) {
          mic.getTracks().forEach(track => track.stop());
          return;
        }
        const track = mic.getAudioTracks()[0];
        if (track) {
          clearKind('audio', track);
          track.enabled = wasEnabled;
          setMicDeviceId(deviceId);
          saveDevicePreference('audioinput', deviceId);
          setAudioFlags(wasEnabled);
        }
        mic.getTracks().forEach(item => { if (item.kind !== 'audio') item.stop(); });
      } catch {
        // Keep the previous microphone running.
      }
    });
  }, [clearKind, micDeviceId, runExclusive, setAudioFlags]);

  const flipCamera = useCallback(async () => {
    const kinds = await listDevices();
    const cameras = kinds.videoinput;
    if (cameras.length > 1) {
      const index = cameras.findIndex(item => item.deviceId === cameraDeviceId);
      const next = cameras[(index + 1) % cameras.length];
      await runExclusive(() => acquireCamera(next.deviceId));
      return;
    }
    // One camera: try the opposite facing mode (mobile browsers).
    await runExclusive(async () => {
      const target = streamRef.current;
      if (!target || !target.getVideoTracks()[0]) return;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: cameraConstraints({ facingMode: 'environment' }),
        });
        if (releasedRef.current || handedOffRef.current) {
          stream.getTracks().forEach(track => track.stop());
          return;
        }
        const track = stream.getVideoTracks()[0];
        if (track) clearKind('video', track);
        stream.getTracks().forEach(item => { if (item.kind !== 'video') item.stop(); });
      } catch {
        // Facing mode unsupported on this device.
      }
    });
  }, [acquireCamera, cameraDeviceId, clearKind, runExclusive]);

  const detach = useCallback((): MediaStream | null => {
    handedOffRef.current = true;
    releasedRef.current = true;
    generationRef.current += 1;
    return streamRef.current;
  }, []);

  return {
    stream,
    busy,
    fatalError,
    cameraError,
    audioOn,
    videoOn,
    devices,
    cameraDeviceId,
    micDeviceId,
    retry,
    setAudioOn,
    setVideoOn,
    flipCamera,
    setCameraDevice,
    setMicDevice,
    detach,
  };
}
