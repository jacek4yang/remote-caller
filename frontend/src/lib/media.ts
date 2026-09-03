/* Media capability helpers. Everything is feature-detected so older Safari,
   iOS, and Firefox degrade gracefully instead of crashing. */

export type MediaErrorKind =
  | 'denied'
  | 'notfound'
  | 'inuse'
  | 'unsupported'
  | 'insecure'
  | 'generic';

export interface VideoMode {
  facingMode?: 'user' | 'environment';
  deviceId?: string;
}

export interface AudioCaptureOptions {
  deviceId?: string;
}

export interface DeviceKind {
  videoinput: MediaDeviceInfo[];
  audioinput: MediaDeviceInfo[];
  audiooutput: MediaDeviceInfo[];
}

export const emptyDevices: DeviceKind = { videoinput: [], audioinput: [], audiooutput: [] };

export function supportsGetUserMedia(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);
}

export function supportsSetSinkId(): boolean {
  return typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
}

export function isSecureContext(): boolean {
  return typeof window === 'undefined'
    || window.isSecureContext
    || location.hostname === 'localhost'
    || location.hostname === '127.0.0.1';
}

export function kindOfMediaError(error: unknown): MediaErrorKind {
  if (error instanceof DOMException) {
    switch (error.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return 'denied';
      case 'NotFoundError':
      case 'OverconstrainedError':
        return 'notfound';
      case 'NotReadableError':
      case 'TrackStartError':
        return 'inuse';
      case 'AbortError':
        return 'generic';
      default:
        break;
    }
  }
  return 'generic';
}

export function microphoneConstraints(deviceId?: string): MediaTrackConstraints {
  return {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    sampleRate: { ideal: 48_000 },
    sampleSize: { ideal: 16 },
    channelCount: { ideal: 1 },
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  };
}

// `resizeMode` is a Chromium-supported camera constraint that the TS DOM lib
// does not model yet; keep it typed separately instead of weakening everything.
export type CameraTrackConstraints = MediaTrackConstraints & { resizeMode?: 'crop-and-scale' | 'none' };

export function cameraConstraints(mode: VideoMode, highQuality = true): CameraTrackConstraints {
  const base: CameraTrackConstraints = {
    ...(mode.deviceId ? { deviceId: { exact: mode.deviceId } } : {}),
    ...(mode.facingMode ? { facingMode: { ideal: mode.facingMode } } : {}),
  };
  if (!highQuality) return base;
  return {
    ...base,
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 60, max: 60 },
    resizeMode: 'crop-and-scale',
  };
}

export async function listDevices(): Promise<DeviceKind> {
  const kinds = emptyDevices;
  if (!navigator.mediaDevices?.enumerateDevices) return kinds;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    for (const device of devices) {
      if (device.kind === 'videoinput' || device.kind === 'audioinput' || device.kind === 'audiooutput') {
        kinds[device.kind].push(device);
      }
    }
  } catch {
    // Enumeration is optional; return what we have.
  }
  return kinds;
}

export function humanDeviceLabel(device: MediaDeviceInfo | undefined, fallback: string): string {
  if (!device) return fallback;
  const label = device.label.trim();
  if (label) return label;
  return fallback;
}

export function lastDevicePreference(
  kind: 'videoinput' | 'audioinput' | 'audiooutput',
): string {
  try {
    return localStorage.getItem('rc:device:' + kind) || '';
  } catch {
    return '';
  }
}

export function saveDevicePreference(kind: 'videoinput' | 'audioinput' | 'audiooutput', deviceId: string): void {
  if (!deviceId) return;
  try {
    localStorage.setItem('rc:device:' + kind, deviceId);
  } catch {
    // Ignore storage failures.
  }
}

export interface PermissionSnapshot {
  camera: PermissionState | 'unsupported';
  microphone: PermissionState | 'unsupported';
}

export async function queryPermissions(): Promise<PermissionSnapshot> {
  const result: PermissionSnapshot = { camera: 'unsupported', microphone: 'unsupported' };
  if (!navigator.permissions?.query) return result;
  const lookup = async (name: PermissionName): Promise<PermissionState | 'unsupported'> => {
    try {
      return (await navigator.permissions.query({ name })).state;
    } catch {
      return 'unsupported';
    }
  };
  // Type gymnastics: some engines accept only specific permission names.
  const camera = await lookup('camera' as PermissionName);
  const microphone = await lookup('microphone' as PermissionName);
  if (camera !== 'unsupported') result.camera = camera;
  if (microphone !== 'unsupported') result.microphone = microphone;
  return result;
}

/** Convenience: build the complete getUserMedia constraints for a call mode. */
export function callMediaConstraints(mode: 'video' | 'audio', video: VideoMode, audioDeviceId?: string): MediaStreamConstraints {
  return {
    audio: microphoneConstraints(audioDeviceId),
    video: mode === 'video' ? cameraConstraints(video) : false,
  };
}
