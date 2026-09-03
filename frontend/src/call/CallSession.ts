import { ApiError, request } from '../lib/api';
import {
  callMediaConstraints,
  cameraConstraints,
  kindOfMediaError,
  listDevices,
  microphoneConstraints,
} from '../lib/media';
import type { MessageKey } from '../i18n/messages';
import { QUALITY_TIERS, classifyNetwork, ewma } from './quality';

const MAX_PENDING_ICE_CANDIDATES = 256;

export type CallMode = 'video' | 'audio';
export type WsPhase = 'idle' | 'opening' | 'open' | 'reconnecting';
export type PcPhase = 'none' | 'connecting' | 'connected' | 'reconnecting';
export type Quality = 'excellent' | 'good' | 'unstable' | 'poor';

export interface SessionCredentials {
  token: string;
  clientId: string;
  iceServers: RTCIceServer[];
}

export interface StartCallOptions extends SessionCredentials {
  room: string;
  mode: CallMode;
  /** A stream already acquired by the pre-call lobby. The session takes ownership. */
  stream?: MediaStream;
  cameraDeviceId?: string;
  audioDeviceId?: string;
}

export interface CallNotice {
  id: number;
  key: MessageKey;
  params?: Record<string, string | number>;
}

export interface CallSnapshot {
  active: boolean;
  room: string;
  mode: CallMode;
  wsPhase: WsPhase;
  pcPhase: PcPhase;
  offline: boolean;
  peerPresent: boolean;
  peerName: string;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  localMuted: boolean;
  localVideoEnabled: boolean;
  remoteMuted: boolean;
  remoteVideoOff: boolean;
  quality: Quality | null;
  /** Epoch ms of the first connected moment in the current room session. */
  connectedAt: number | null;
  notice: CallNotice | null;
}

export interface CallDiagnostics {
  wsPhase: WsPhase;
  pcState: RTCPeerConnectionState | 'none';
  quality: Quality | null;
  route: 'direct' | 'relay' | 'unknown';
  codec: string;
  resolution: { width: number; height: number } | null;
  frameRate: number | null;
  outboundBitrate: number | null;
  inboundBitrate: number | null;
  rtt: number | null;
  loss: number | null;
  jitter: number | null;
}

interface CallCallbacks {
  onChange: (snapshot: CallSnapshot) => void;
  onToast: (key: MessageKey, params?: Record<string, string | number>) => void;
  onAuthExpired: (room: string) => void;
  onRoomFull: (room: string) => void;
}

interface WsTicketResponse {
  ticket: string;
  expiresAt: number;
}

interface SignalMessage {
  type: string;
  from?: string;
  displayName?: string;
  payload?: RTCSessionDescriptionInit | RTCIceCandidateInit | { audio?: boolean; video?: boolean };
}

interface PreviousStats {
  packetsSent: number;
  packetsLost: number;
  bytesSent: number;
  bytesReceived: number;
  timestamp: number;
}

interface NetworkEwma {
  loss: number;
  rtt: number;
  available: number;
}

type ExtendedEncoding = RTCRtpEncodingParameters & { scalabilityMode?: string };
type ExtendedCodec = RTCRtpCodec & { scalabilityModes?: string[] };
type ExtendedStats = RTCStats & {
  type: string;
  kind?: string;
  isRemote?: boolean;
  packetsSent?: number;
  packetsLost?: number;
  timestamp: number;
  roundTripTime?: number;
  currentRoundTripTime?: number;
  jitter?: number;
  state?: string;
  nominated?: boolean;
  selected?: boolean;
  availableOutgoingBitrate?: number;
  qualityLimitationReason?: string;
  framesPerSecond?: number;
  frameWidth?: number;
  frameHeight?: number;
  bytesSent?: number;
  bytesReceived?: number;
  codecId?: string;
  candidateType?: string;
  localCandidateType?: string;
  remoteCandidateType?: string;
  mediaType?: string;
  mimeType?: string;
  clockRate?: number;
};

export function initialCallSnapshot(): CallSnapshot {
  return {
    active: false,
    room: '',
    mode: 'video',
    wsPhase: 'idle',
    pcPhase: 'none',
    offline: false,
    peerPresent: false,
    peerName: '',
    localStream: null,
    remoteStream: null,
    localMuted: false,
    localVideoEnabled: false,
    remoteMuted: false,
    remoteVideoOff: false,
    quality: null,
    connectedAt: null,
    notice: null,
  };
}

const QUALITY_LABELS: readonly Quality[] = ['excellent', 'good', 'unstable', 'poor'];

function qualityFromTier(tier: number): Quality {
  return QUALITY_LABELS[Math.max(0, Math.min(tier, QUALITY_LABELS.length - 1))] ?? 'poor';
}

export class CallSession {
  private readonly callbacks: CallCallbacks;
  private snapshot = initialCallSnapshot();
  private token = '';
  private clientId = '';
  private room = '';
  private mode: CallMode = 'video';
  private iceServers: RTCIceServer[] = [];
  private cameraFacing: 'user' | 'environment' = 'user';
  private cameraDeviceId = '';
  private audioDeviceId = '';
  private localStream: MediaStream | null = null;
  private pc: RTCPeerConnection | null = null;
  private socket: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private socketGeneration = 0;
  private signalChain: Promise<void> = Promise.resolve();
  private pendingIceCandidates: RTCIceCandidateInit[] = [];
  private makingOffer = false;
  private ignoreOffer = false;
  private polite = false;
  private peerPresent = false;
  private iceRestartTimer: ReturnType<typeof setTimeout> | null = null;
  private iceRestartAttempts = 0;
  private wakeLock: WakeLockSentinel | null = null;
  private adaptationTimer: ReturnType<typeof setInterval> | null = null;
  private qualityTier = 0;
  private badSamples = 0;
  private goodSamples = 0;
  private previousStats: PreviousStats | null = null;
  private networkEwma: NetworkEwma | null = null;
  private lastDiagnostics: CallDiagnostics | null = null;
  private lifecycleGeneration = 0;
  private noticeSequence = 0;
  constructor(callbacks: CallCallbacks) {
    this.callbacks = callbacks;
  }

  getSnapshot(): CallSnapshot {
    return this.snapshot;
  }

  getRoom(): string {
    return this.room;
  }

  getDiagnostics(): CallDiagnostics | null {
    return this.lastDiagnostics;
  }

  async start(options: StartCallOptions): Promise<void> {
    this.stop();
    const generation = this.lifecycleGeneration;
    this.token = options.token;
    this.clientId = options.clientId;
    this.iceServers = options.iceServers;
    this.room = options.room;
    this.mode = options.mode;
    this.cameraDeviceId = options.cameraDeviceId || '';
    this.audioDeviceId = options.audioDeviceId || '';
    this.cameraFacing = 'user';

    if (options.stream) {
      this.localStream = options.stream;
      this.tuneLocalTracks();
    } else {
      try {
        await this.acquireMedia(this.mode === 'video');
      } catch (error) {
        if (generation !== this.lifecycleGeneration) return;
        const key = this.mediaErrorKey(error);
        throw new MediaSetupError(key);
      }
    }
    if (generation !== this.lifecycleGeneration) {
      this.stopMedia();
      return;
    }

    const muted = !this.localStream?.getAudioTracks().some(track => track.enabled);
    const videoEnabled = Boolean(this.localStream?.getVideoTracks().some(track => track.enabled));
    this.patch({
      active: true,
      room: this.room,
      mode: this.mode,
      wsPhase: 'opening',
      pcPhase: 'none',
      localStream: this.localStream,
      localMuted: muted,
      localVideoEnabled: videoEnabled,
      peerPresent: false,
      quality: null,
      connectedAt: null,
    });
    void this.requestWakeLock();
    void this.connectSocket();
  }

  stop(): void {
    this.lifecycleGeneration += 1;
    const oldSocket = this.socket;
    this.socket = null;
    this.socketGeneration += 1;
    this.clearTimer('reconnectTimer');
    this.clearTimer('iceRestartTimer');
    this.clearNoticeTimer();
    oldSocket?.close();
    this.pc?.close();
    this.pc = null;
    this.stopMedia();
    this.signalChain = Promise.resolve();
    this.pendingIceCandidates = [];
    this.token = '';
    this.clientId = '';
    this.iceServers = [];
    this.reconnectAttempts = 0;
    this.peerPresent = false;
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.iceRestartAttempts = 0;
    void this.wakeLock?.release().catch(() => undefined);
    this.wakeLock = null;
    this.stopNetworkMonitor();
    this.snapshot = { ...initialCallSnapshot(), room: this.room, mode: this.mode, active: false };
    this.callbacks.onChange(this.snapshot);
  }

  dispose(): void {
    this.stop();
  }

  async toggleMicrophone(): Promise<void> {
    const track = this.localStream?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    this.patch({ localMuted: !track.enabled });
    this.sendMediaState();
  }

  async toggleCamera(): Promise<void> {
    if (!this.localStream) return;
    let track = this.localStream.getVideoTracks()[0];
    if (!track) {
      // Camera was fully released (e.g. voice-only start): acquire it now.
      let extra: MediaStream | null = null;
      try {
        extra = await navigator.mediaDevices.getUserMedia({
          video: this.videoConstraints(),
        });
        const acquired = extra.getVideoTracks()[0];
        if (!acquired) throw new Error('no video track');
        // The session may have ended while the permission prompt was up.
        if (!this.localStream || !this.snapshot.active) throw new Error('session ended');
        this.localStream.addTrack(acquired);
        if (this.pc && this.pc.connectionState !== 'closed') {
          this.pc.addTrack(acquired, this.localStream);
        }
        this.watchTrackEnded(acquired);
        extra = null; // adopted — do not stop on a later throw
        track = acquired;
      } catch {
        extra?.getTracks().forEach(item => item.stop());
        if (this.snapshot.active) this.callbacks.onToast('call.toast.cameraFailed');
        return;
      }
    } else {
      track.enabled = !track.enabled;
    }
    this.patch({
      localStream: this.localStream,
      localVideoEnabled: Boolean(track.enabled),
    });
    this.sendMediaState();
  }

  async switchCamera(): Promise<void> {
    const oldTrack = this.localStream?.getVideoTracks()[0];
    if (!oldTrack || !this.localStream) return;

    const next = await this.pickNextVideoDevice();
    if (!next) {
      if (this.snapshot.active) this.callbacks.onToast('call.toast.switchFailed');
      return;
    }
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: next.constraints });
      const replacement = stream.getVideoTracks()[0];
      if (!replacement) throw new Error('no video track');
      // The session may have ended while the camera was starting.
      if (!this.localStream || !this.snapshot.active) throw new Error('session ended');
      await this.replaceVideoTrack(replacement);
      stream = null; // adopted
      this.cameraFacing = next.facing ?? this.cameraFacing;
      this.cameraDeviceId = next.deviceId ?? '';
    } catch (error) {
      // Keep the previous camera running and release the orphan, if any.
      stream?.getTracks().forEach(track => track.stop());
      if (this.snapshot.active) this.callbacks.onToast('call.toast.switchFailed');
      console.warn('camera switch failed', error);
    }
  }

  async switchVideoInput(deviceId: string): Promise<void> {
    const oldTrack = this.localStream?.getVideoTracks()[0];
    if (!oldTrack || !this.localStream) return;
    if (!deviceId || deviceId === this.cameraDeviceId) return;
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: cameraConstraints({ deviceId }),
      });
      const replacement = stream.getVideoTracks()[0];
      if (!replacement) throw new Error('no video track');
      // The session may have ended while the camera was starting.
      if (!this.localStream || !this.snapshot.active) throw new Error('session ended');
      await this.replaceVideoTrack(replacement);
      stream = null; // adopted
      this.cameraDeviceId = deviceId;
      this.cameraFacing = 'user';
    } catch (error) {
      // Keep the previous camera running and release the orphan, if any.
      stream?.getTracks().forEach(track => track.stop());
      if (this.snapshot.active) this.callbacks.onToast('call.toast.cameraFailed');
      console.warn('video input switch failed', error);
    }
  }

  async switchAudioInput(deviceId: string): Promise<void> {
    if (!this.localStream || deviceId === this.audioDeviceId) return;
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: microphoneConstraints(deviceId),
      });
      const replacement = stream.getAudioTracks()[0];
      if (!replacement) throw new Error('no audio track');
      // The session may have ended while the mic was starting.
      if (!this.localStream || !this.snapshot.active) throw new Error('session ended');
      const target = this.localStream;
      const previousEnabled = target.getAudioTracks().some(track => track.enabled);
      const sender = this.pc?.getSenders().find(item => item.track?.kind === 'audio');
      await sender?.replaceTrack(replacement);
      target.getAudioTracks().forEach(track => {
        target.removeTrack(track);
        track.stop();
      });
      replacement.enabled = previousEnabled;
      target.addTrack(replacement);
      stream = null; // adopted
      this.audioDeviceId = deviceId;
      this.tuneLocalTracks();
      this.patch({ localStream: target, localMuted: !previousEnabled });
      this.sendMediaState();
    } catch (error) {
      // Keep the previous microphone running and release the orphan, if any.
      stream?.getTracks().forEach(track => track.stop());
      if (this.snapshot.active) this.callbacks.onToast('call.toast.micFailed');
      console.warn('audio input switch failed', error);
    }
  }

  handleVisible(): void {
    if (!this.snapshot.active) return;
    void this.requestWakeLock();
    if (!this.socket || this.socket.readyState === WebSocket.CLOSED) void this.connectSocket();
  }

  handleOnline(): void {
    if (!this.snapshot.active) return;
    this.patch({ offline: false });
    void this.connectSocket();
    this.scheduleIceRestart(500);
  }

  handleOffline(): void {
    if (this.snapshot.active) this.patch({ offline: true });
  }

  private patch(patch: Partial<CallSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.callbacks.onChange(this.snapshot);
  }

  private flash(key: MessageKey, params?: Record<string, string | number>): void {
    this.clearNoticeTimer();
    const notice: CallNotice = { id: ++this.noticeSequence, key, params };
    this.patch({ notice });
    this.noticeTimer = setTimeout(() => {
      if (this.snapshot.notice?.id === notice.id) this.patch({ notice: null });
    }, 3600);
  }

  private clearNoticeTimer(): void {
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = null;
  }

  private clearTimer(name: 'reconnectTimer' | 'iceRestartTimer'): void {
    const timer = this[name];
    if (timer) clearTimeout(timer);
    this[name] = null;
  }

  private mediaErrorKey(error: unknown): MessageKey {
    const kind = kindOfMediaError(error);
    switch (kind) {
      case 'denied': return 'lobby.mediaError.denied';
      case 'notfound': return 'lobby.mediaError.notfound';
      case 'inuse': return 'lobby.mediaError.inuse';
      default: return 'lobby.mediaError.generic';
    }
  }

  private videoConstraints(): MediaTrackConstraints {
    if (this.cameraDeviceId) return cameraConstraints({ deviceId: this.cameraDeviceId });
    return cameraConstraints({ facingMode: this.cameraFacing });
  }

  private async acquireMedia(withVideo: boolean): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('unsupported');
    }
    this.localStream = await navigator.mediaDevices.getUserMedia(
      callMediaConstraints(
        withVideo ? 'video' : 'audio',
        this.cameraDeviceId ? { deviceId: this.cameraDeviceId } : { facingMode: this.cameraFacing },
        this.audioDeviceId || undefined,
      ),
    );
    this.tuneLocalTracks();
  }

  private tuneLocalTracks(): void {
    const stream = this.localStream;
    if (!stream) return;
    stream.getAudioTracks().forEach(track => { track.contentHint = 'speech'; });
    stream.getVideoTracks().forEach(track => {
      track.contentHint = 'detail';
      this.watchTrackEnded(track);
    });
  }

  private watchTrackEnded(track: MediaStreamTrack): void {
    const onEnded = () => {
      // A device was unplugged or the OS revoked it. Reflect reality calmly.
      this.patch({
        localMuted: !this.localStream?.getAudioTracks().some(item => item.enabled && item.readyState === 'live'),
        localVideoEnabled: Boolean(this.localStream?.getVideoTracks().some(item => item.enabled && item.readyState === 'live')),
      });
    };
    track.addEventListener('ended', onEnded, { once: true });
  }

  private async pickNextVideoDevice(): Promise<
    | { constraints: MediaTrackConstraints; facing?: 'user' | 'environment'; deviceId?: string }
    | null
  > {
    const kinds = await listDevices();
    const cameras = kinds.videoinput;
    const current = this.cameraDeviceId;
    if (cameras.length > 1 && current) {
      const index = cameras.findIndex(item => item.deviceId === current);
      const next = cameras[(index + 1) % cameras.length];
      return { constraints: cameraConstraints({ deviceId: next.deviceId }), deviceId: next.deviceId };
    }
    if (cameras.length > 1 && !current) {
      return { constraints: cameraConstraints({ deviceId: cameras[0].deviceId }), deviceId: cameras[0].deviceId };
    }
    // Single camera: browsers that model facing mode still accept an ideal
    // facing constraint; the same physical camera is returned.
    const nextFacing = this.cameraFacing === 'user' ? 'environment' : 'user';
    return { constraints: cameraConstraints({ facingMode: nextFacing }), facing: nextFacing };
  }

  private async replaceVideoTrack(replacement: MediaStreamTrack): Promise<void> {
    const stream = this.localStream;
    const oldTrack = stream?.getVideoTracks()[0];
    if (!oldTrack || !stream) {
      // The session may have ended while the replacement camera was starting.
      replacement.stop();
      throw new Error('no local video to replace');
    }
    // Re-point the sender first so the far side keeps a live video track; the
    // peer may be absent (no sender yet) — the local stream swap below still
    // applies and ensurePeerConnection will pick up the replacement later.
    const sender = this.pc?.getSenders().find(item => item.track?.kind === 'video');
    await sender?.replaceTrack(replacement);
    stream.removeTrack(oldTrack);
    oldTrack.stop();
    stream.addTrack(replacement);
    replacement.contentHint = 'detail';
    this.watchTrackEnded(replacement);
    this.patch({ localStream: stream, localVideoEnabled: true });
    this.sendMediaState();
  }

  private async connectSocket(): Promise<void> {
    if (!this.snapshot.active) return;
    if (this.socket && (
      this.socket.readyState === WebSocket.CONNECTING
      || this.socket.readyState === WebSocket.OPEN
    )) return;
    const generation = ++this.socketGeneration;
    this.patch({ wsPhase: this.snapshot.peerPresent ? 'reconnecting' : 'opening' });

    try {
      const issued = await request<WsTicketResponse>('/api/ws-ticket', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + this.token },
        body: JSON.stringify({ room: this.room }),
      });
      if (!this.snapshot.active || generation !== this.socketGeneration) return;

      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(protocol + '//' + location.host + '/ws?ticket=' + encodeURIComponent(issued.ticket));
      this.socket = socket;

      socket.addEventListener('open', () => {
        if (socket !== this.socket) return;
        this.reconnectAttempts = 0;
        this.patch({ wsPhase: 'open', offline: false });
        this.sendMediaState();
        if (this.peerPresent && this.pc?.connectionState !== 'connected') {
          this.scheduleIceRestart(250);
        }
      });
      socket.addEventListener('message', ({ data }) => {
        this.signalChain = this.signalChain
          .then(async () => {
            if (socket !== this.socket || generation !== this.socketGeneration || typeof data !== 'string' || data.length > 70_000) return;
            const message = JSON.parse(data) as SignalMessage;
            if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
              throw new Error('invalid signaling envelope');
            }
            await this.onSignal(message);
          })
          .catch(error => {
            console.warn('signal handling failed', error);
            // A malformed or unserializable exchange cannot be trusted to stay in
            // sync; forcing a socket cycle re-establishes a clean ordered stream.
            if (socket === this.socket && this.snapshot.active) {
              socket.close();
              this.socket = null;
              this.scheduleSocketReconnect();
            }
          });
      });
      socket.addEventListener('close', () => {
        if (socket !== this.socket) return;
        this.socket = null;
        if (this.snapshot.active) {
          this.patch({ wsPhase: 'reconnecting' });
          this.scheduleSocketReconnect();
        }
      });
    } catch (error) {
      if (!this.snapshot.active || generation !== this.socketGeneration) return;
      if (error instanceof ApiError && error.code === 'unauthorized') {
        const room = this.room;
        this.stop();
        this.callbacks.onAuthExpired(room);
        return;
      }
      if (error instanceof ApiError && error.code === 'room_full') {
        const room = this.room;
        this.stop();
        this.callbacks.onRoomFull(room);
        return;
      }
      console.warn('signaling connection failed', error);
      this.patch({ wsPhase: 'reconnecting' });
      this.scheduleSocketReconnect();
    }
  }

  private scheduleSocketReconnect(): void {
    if (!this.snapshot.active) return;
    const base = Math.min(1000 * 2 ** this.reconnectAttempts++, 10_000);
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    this.clearTimer('reconnectTimer');
    this.reconnectTimer = setTimeout(() => void this.connectSocket(), delay);
  }

  private async onSignal(message: SignalMessage): Promise<void> {
    if (message.type === 'ready') return;
    if (message.from) this.polite = this.clientId.localeCompare(message.from) > 0;

    if (message.type === 'peer-joined') {
      this.showPeer(message.displayName);
      await this.ensurePeerConnection();
      if (!await this.sendOffer(false)) this.scheduleIceRestart(500);
    } else if (message.type === 'offer') {
      this.showPeer(message.displayName);
      const pc = await this.ensurePeerConnection();
      const offerCollision = this.makingOffer || pc.signalingState !== 'stable';
      this.ignoreOffer = !this.polite && offerCollision;
      if (this.ignoreOffer) return;
      if (offerCollision) {
        try { await pc.setLocalDescription({ type: 'rollback' }); } catch { /* implicit rollback fallback */ }
      }
      await pc.setRemoteDescription(message.payload as RTCSessionDescriptionInit);
      await this.flushPendingIceCandidates(pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(tuneOpus(answer));
      this.sendSignal('answer', pc.localDescription);
      this.ignoreOffer = false;
      this.patch({ pcPhase: 'connecting' });
    } else if (message.type === 'answer' && this.pc) {
      if (this.pc.signalingState !== 'have-local-offer') return;
      await this.pc.setRemoteDescription(message.payload as RTCSessionDescriptionInit);
      await this.flushPendingIceCandidates(this.pc);
      this.ignoreOffer = false;
      this.patch({ pcPhase: 'connecting' });
    } else if (message.type === 'ice-candidate' && message.payload) {
      if (this.ignoreOffer) return;
      const pc = await this.ensurePeerConnection();
      const candidate = message.payload as RTCIceCandidateInit;
      if (!pc.remoteDescription) {
        if (this.pendingIceCandidates.length >= MAX_PENDING_ICE_CANDIDATES) {
          throw new Error('too many queued ICE candidates');
        }
        this.pendingIceCandidates.push(candidate);
      } else if (candidateMatchesRemoteDescription(pc, candidate)) {
        await pc.addIceCandidate(candidate);
      }
    } else if (message.type === 'peer-left') {
      const leftName = this.snapshot.peerName;
      this.resetPeer();
      if (leftName) this.flash('call.peerLeft', { name: leftName });
    } else if (message.type === 'media-state') {
      const media = message.payload as { audio?: boolean; video?: boolean } | undefined;
      if (!media) return;
      // The server relays each member's media-state only to the other member
      // (src/signal.rs: event.from != claims.sub), so every message we receive
      // here describes the remote peer.
      this.patch({
        remoteMuted: media.audio === false,
        remoteVideoOff: media.video === false,
      });
    }
  }

  private async flushPendingIceCandidates(pc: RTCPeerConnection): Promise<void> {
    const candidates = this.pendingIceCandidates.splice(0);
    for (const candidate of candidates) {
      if (!candidateMatchesRemoteDescription(pc, candidate)) continue;
      try {
        await pc.addIceCandidate(candidate);
      } catch (error) {
        console.warn('ICE candidate rejected', error);
      }
    }
  }

  private async ensurePeerConnection(): Promise<RTCPeerConnection> {
    if (this.pc && this.pc.connectionState !== 'closed') return this.pc;
    if (!this.localStream) throw new Error('local media is unavailable');
    const pc = new RTCPeerConnection({ iceServers: this.iceServers, iceCandidatePoolSize: 4 });
    this.pc = pc;
    this.pendingIceCandidates = [];
    this.ignoreOffer = false;
    this.patch({ pcPhase: 'connecting' });
    this.localStream.getTracks().forEach(track => pc.addTrack(track, this.localStream as MediaStream));
    await configureVideoCodecs(pc);
    await configureAudioSender(pc);
    await this.applyQualityTier(0, pc);
    pc.addEventListener('icecandidate', event => {
      if (event.candidate) this.sendSignal('ice-candidate', event.candidate);
    });
    pc.addEventListener('track', event => this.onRemoteTrack(event));
    pc.addEventListener('negotiationneeded', () => {
      if (this.snapshot.active && this.peerPresent) void this.sendOffer(false);
    });
    pc.addEventListener('connectionstatechange', () => {
      if (pc !== this.pc) return;
      this.onConnectionStateChange(pc);
    });
    return pc;
  }

  private onRemoteTrack(event: RTCTrackEvent): void {
    const incoming = event.streams[0] ?? new MediaStream([event.track]);
    const previous = this.snapshot.remoteStream;
    if (!previous) {
      this.patch({ remoteStream: incoming, remoteVideoOff: false });
      return;
    }
    // Merge instead of replacing: a later track event (e.g. the peer turns
    // their camera on mid-call) must not drop the audio track already playing.
    if (incoming.id === previous.id) {
      if (!previous.getTracks().some(track => track.id === event.track.id)) {
        previous.addTrack(event.track);
        this.patch({ remoteStream: previous });
      }
      return;
    }
    // New stream id: fold any previously playing tracks into the incoming
    // stream so audio is never dropped when the peer adds video mid-call.
    // `merged` becomes the only referenced remote stream, so relocating the
    // tracks here is safe even where a track can belong to one stream only.
    const merged = incoming;
    for (const track of previous.getTracks()) {
      if (!merged.getTracks().some(item => item.id === track.id)) {
        merged.addTrack(track);
      }
    }
    this.patch({ remoteStream: merged, remoteVideoOff: false });
  }

  private onConnectionStateChange(pc: RTCPeerConnection): void {
    switch (pc.connectionState) {
      case 'connected':
        this.iceRestartAttempts = 0;
        this.clearTimer('iceRestartTimer');
        this.patch({ pcPhase: 'connected', connectedAt: this.snapshot.connectedAt ?? Date.now() });
        this.startNetworkMonitor();
        this.sendMediaState();
        break;
      case 'connecting':
        this.patch({ pcPhase: 'connecting' });
        break;
      case 'disconnected':
        this.patch({ pcPhase: 'reconnecting' });
        this.scheduleIceRestart(3000);
        break;
      case 'failed':
        this.patch({ pcPhase: 'reconnecting' });
        this.scheduleIceRestart(0);
        break;
      default:
        break;
    }
  }

  private async sendOffer(iceRestart = false): Promise<boolean> {
    const pc = await this.ensurePeerConnection();
    if (this.makingOffer || pc.signalingState !== 'stable' || this.socket?.readyState !== WebSocket.OPEN) return false;
    this.makingOffer = true;
    try {
      const offer = await pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
      if (pc.signalingState !== 'stable') return false;
      await pc.setLocalDescription(tuneOpus(offer));
      this.sendSignal('offer', pc.localDescription);
      return true;
    } finally {
      this.makingOffer = false;
    }
  }

  private scheduleIceRestart(delay: number): void {
    if (!this.snapshot.active || !this.peerPresent) return;
    this.clearTimer('iceRestartTimer');
    this.iceRestartTimer = setTimeout(async () => {
      if (!this.snapshot.active || !this.peerPresent) return;
      if (this.pc?.connectionState === 'connected') return;
      if (this.socket?.readyState !== WebSocket.OPEN) {
        this.scheduleIceRestart(1500);
        return;
      }
      if (this.iceRestartAttempts >= 3) {
        // The peer connection is beyond repair; rebuild it fresh so the next
        // offer gathers new ICE candidates instead of retrying dead ones.
        this.pc?.close();
        this.pc = null;
        this.pendingIceCandidates = [];
        this.iceRestartAttempts = 0;
        this.patch({ pcPhase: 'connecting' });
      }
      this.iceRestartAttempts += 1;
      const sent = await this.sendOffer(true).catch(error => {
        console.warn('ICE restart failed', error);
        return false;
      });
      if (!sent) {
        this.scheduleIceRestart(1000);
      } else {
        this.scheduleIceRestart(Math.min(3000 * 2 ** (this.iceRestartAttempts - 1), 12_000));
      }
    }, delay);
  }

  private sendSignal(type: string, payload: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const message = JSON.stringify({ type, payload });
    if (message.length <= 65_536) this.socket.send(message);
    else if (this.snapshot.active) this.callbacks.onToast('call.toast.signalTooLarge');
  }

  private showPeer(name?: string): void {
    this.peerPresent = true;
    const peerName = name || this.snapshot.peerName || '';
    this.patch({
      peerPresent: true,
      peerName,
      wsPhase: this.snapshot.wsPhase,
      // The caller of this handler proceeds to create/negotiate the peer
      // connection; keep the existing phase until that work updates it.
    });
  }

  private resetPeer(): void {
    this.peerPresent = false;
    this.clearTimer('iceRestartTimer');
    this.iceRestartAttempts = 0;
    this.stopNetworkMonitor();
    this.pc?.close();
    this.pc = null;
    this.patch({
      peerPresent: false,
      peerName: '',
      remoteStream: null,
      remoteMuted: false,
      remoteVideoOff: false,
      pcPhase: 'none',
      quality: null,
      connectedAt: null,
    });
  }

  private sendMediaState(): void {
    if (!this.snapshot.active) return;
    this.sendSignal('media-state', {
      audio: this.localStream?.getAudioTracks().some(track => track.enabled) || false,
      video: this.localStream?.getVideoTracks().some(track => track.enabled) || false,
    });
  }

  private startNetworkMonitor(): void {
    if (this.adaptationTimer) return;
    this.previousStats = null;
    void this.sampleNetwork();
    this.adaptationTimer = setInterval(() => void this.sampleNetwork(), 2000);
  }

  private stopNetworkMonitor(): void {
    if (this.adaptationTimer) clearInterval(this.adaptationTimer);
    this.adaptationTimer = null;
    this.previousStats = null;
    this.badSamples = 0;
    this.goodSamples = 0;
    this.qualityTier = 0;
    this.networkEwma = null;
    if (this.snapshot.quality !== null) this.patch({ quality: null });
  }

  private async sampleNetwork(): Promise<void> {
    const pc = this.pc;
    if (!pc || pc.connectionState !== 'connected') return;
    try {
      const report = await pc.getStats();
      const stats = collectStats(report);
      const outbound = stats.outboundVideo;
      if (!outbound) return;

      const now = outbound.timestamp;
      const previous = this.previousStats;
      this.previousStats = {
        packetsSent: outbound.packetsSent || 0,
        packetsLost: stats.remoteInbound?.packetsLost || 0,
        bytesSent: outbound.bytesSent || 0,
        bytesReceived: stats.inboundVideo?.bytesReceived || 0,
        timestamp: now,
      };
      if (!previous || now <= previous.timestamp) return;

      const sent = Math.max(0, (outbound.packetsSent || 0) - previous.packetsSent);
      const lost = Math.max(0, (stats.remoteInbound?.packetsLost || 0) - previous.packetsLost);
      const loss = sent + lost > 0 ? lost / (sent + lost) : 0;
      const rtt = stats.remoteInbound?.roundTripTime ?? stats.candidatePair?.currentRoundTripTime ?? 0;
      const available = stats.candidatePair?.availableOutgoingBitrate ?? Number.POSITIVE_INFINITY;
      const intervalSeconds = (now - previous.timestamp) / 1000;
      const outboundBitrate = intervalSeconds > 0
        ? Math.max(0, ((outbound.bytesSent || 0) - previous.bytesSent) * 8 / intervalSeconds)
        : null;
      const inboundBitrate = intervalSeconds > 0
        ? Math.max(0, ((stats.inboundVideo?.bytesReceived || 0) - previous.bytesReceived) * 8 / intervalSeconds)
        : null;

      const alpha = this.networkEwma && available >= this.networkEwma.available ? 0.15 : 0.55;
      this.networkEwma = {
        loss: ewma(this.networkEwma?.loss ?? null, loss, alpha),
        rtt: ewma(this.networkEwma?.rtt ?? null, rtt, alpha),
        available: ewma(this.networkEwma?.available ?? null, available, alpha),
      };

      const cpuLimited = outbound.qualityLimitationReason === 'cpu'
        || Boolean(outbound.framesPerSecond && outbound.framesPerSecond < QUALITY_TIERS[this.qualityTier].maxFramerate * 0.7);
      const desiredTier = Math.max(
        classifyNetwork(this.networkEwma.loss, this.networkEwma.rtt, this.networkEwma.available),
        cpuLimited ? Math.min(2, this.qualityTier + 1) : 0,
      );
      const quality = qualityFromTier(classifyNetwork(this.networkEwma.loss, this.networkEwma.rtt, this.networkEwma.available));
      if (quality !== this.snapshot.quality) this.patch({ quality });
      await this.considerTierChange(desiredTier);

      this.lastDiagnostics = {
        wsPhase: this.snapshot.wsPhase,
        pcState: pc.connectionState,
        quality: this.snapshot.quality,
        route: stats.route,
        codec: stats.videoCodec,
        resolution: outbound.frameWidth && outbound.frameHeight
          ? { width: outbound.frameWidth, height: outbound.frameHeight }
          : null,
        frameRate: outbound.framesPerSecond ?? null,
        outboundBitrate,
        inboundBitrate,
        rtt: this.networkEwma.rtt,
        loss: this.networkEwma.loss,
        jitter: stats.remoteInbound?.jitter ?? null,
      };
    } catch (error) {
      console.debug('network sampling unavailable', error);
    }
  }

  private async considerTierChange(desiredTier: number): Promise<void> {
    if (desiredTier > this.qualityTier) {
      this.badSamples += 1;
      this.goodSamples = 0;
      if (this.badSamples >= 2) {
        await this.applyQualityTier(Math.min(this.qualityTier + 1, desiredTier));
        this.badSamples = 0;
      }
    } else if (desiredTier < this.qualityTier) {
      this.goodSamples += 1;
      this.badSamples = 0;
      if (this.goodSamples >= 8) {
        await this.applyQualityTier(this.qualityTier - 1);
        this.goodSamples = 0;
      }
    } else {
      this.badSamples = 0;
      this.goodSamples = 0;
    }
  }

  private async applyQualityTier(
    tierIndex: number,
    pc = this.pc,
  ): Promise<void> {
    const tier = QUALITY_TIERS[tierIndex];
    if (!tier) return;
    const sender = pc?.getSenders().find(item => item.track?.kind === 'video');
    if (!sender) return;
    const parameters = sender.getParameters();
    parameters.degradationPreference = 'maintain-resolution';
    let parametersApplied = false;
    if (parameters.encodings?.length) {
      const encoding = parameters.encodings[0] as ExtendedEncoding;
      encoding.maxBitrate = tier.maxBitrate;
      encoding.maxFramerate = tier.maxFramerate;
      encoding.scaleResolutionDownBy = tier.scale;
      encoding.scalabilityMode = 'L1T3';
      try {
        await sender.setParameters(parameters);
        parametersApplied = true;
      } catch (error) {
        delete encoding.scalabilityMode;
        try {
          await sender.setParameters(parameters);
          parametersApplied = true;
        } catch (fallbackError) {
          console.debug('sender tuning unsupported', error, fallbackError);
        }
      }
    }
    if (!parametersApplied) {
      try {
        await sender.track?.applyConstraints({
          width: { ideal: tier.width },
          height: { ideal: tier.height },
          frameRate: { ideal: tier.maxFramerate, max: tier.maxFramerate },
        });
      } catch (error) {
        console.debug('track constraints unsupported', error);
      }
    }
    this.qualityTier = tierIndex;
  }

  private async requestWakeLock(): Promise<void> {
    if (!this.snapshot.active || !('wakeLock' in navigator)) return;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
    } catch {
      // The OS may deny a wake lock in low-power mode.
    }
  }

  private stopMedia(): void {
    this.localStream?.getTracks().forEach(track => track.stop());
    this.localStream = null;
  }
}

export class MediaSetupError extends Error {
  readonly key: MessageKey;

  constructor(key: MessageKey) {
    super(key);
    this.name = 'MediaSetupError';
    this.key = key;
  }
}

/* ---------- Pure helpers (unit tested) ---------- */

export function candidateMatchesRemoteDescription(
  pc: Pick<RTCPeerConnection, 'remoteDescription'>,
  candidate: RTCIceCandidateInit,
): boolean {
  const remoteUfrags = new Set(Array.from(
    pc.remoteDescription?.sdp?.matchAll(/^a=ice-ufrag:(.+)$/gmi) || [],
    match => match[1].trim(),
  ));
  return !candidate.usernameFragment || !remoteUfrags.size || remoteUfrags.has(candidate.usernameFragment);
}

export function tuneOpus(description: RTCSessionDescriptionInit): RTCSessionDescriptionInit {
  if (!description.sdp) return description;
  const opus = description.sdp.match(/^a=rtpmap:(\d+) opus\/48000\/2\r?$/mi);
  if (!opus) return description;
  const payload = opus[1];
  const fmtpPattern = new RegExp('^a=fmtp:' + payload + ' (.*)$', 'mi');
  const required: Record<string, string> = {
    minptime: '10',
    useinbandfec: '1',
    usedtx: '0',
    stereo: '0',
    'sprop-stereo': '0',
    maxplaybackrate: '48000',
    'sprop-maxcapturerate': '48000',
    maxaveragebitrate: '96000',
    cbr: '0',
  };
  let sdp = description.sdp;
  const existing = sdp.match(fmtpPattern);
  if (existing) {
    const parameters = new Map(existing[1].split(';').map(item => item.trim().split('=') as [string, string]));
    Object.entries(required).forEach(([key, value]) => parameters.set(key, value));
    sdp = sdp.replace(
      fmtpPattern,
      'a=fmtp:' + payload + ' ' + Array.from(parameters, item => item.join('=')).join(';'),
    );
  } else {
    const attributes = Object.entries(required).map(item => item.join('=')).join(';');
    sdp = sdp.replace(opus[0], opus[0] + '\r\na=fmtp:' + payload + ' ' + attributes);
  }
  return { type: description.type, sdp };
}

async function configureAudioSender(pc: RTCPeerConnection): Promise<void> {
  const sender = pc.getSenders().find(item => item.track?.kind === 'audio');
  if (!sender) return;
  const parameters = sender.getParameters();
  if (!parameters.encodings?.length) return;
  parameters.encodings[0].maxBitrate = 96_000;
  try {
    await sender.setParameters(parameters);
  } catch (error) {
    console.debug('audio tuning unsupported', error);
  }
}

async function configureVideoCodecs(pc: RTCPeerConnection): Promise<void> {
  const transceiver = pc.getTransceivers().find(item => item.sender.track?.kind === 'video');
  const codecs = globalThis.RTCRtpReceiver?.getCapabilities?.('video')?.codecs as ExtendedCodec[] | undefined;
  if (!transceiver?.setCodecPreferences || !codecs?.length) return;

  const isAppleMobile = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const isLowPowerMobile = /Android/i.test(navigator.userAgent) && (navigator.hardwareConcurrency || 4) < 8;
  const preferred = (isAppleMobile || isLowPowerMobile)
    ? ['video/H264', 'video/VP8', 'video/VP9', 'video/AV1']
    : ['video/AV1', 'video/VP9', 'video/H264', 'video/VP8'];
  const primary = codecs.filter(codec => !/\/(rtx|red|ulpfec|flexfec)/i.test(codec.mimeType));
  const repair = codecs.filter(codec => /\/(rtx|red|ulpfec|flexfec)/i.test(codec.mimeType));
  const scored = await Promise.all(primary.map(async codec => ({
    codec,
    score: await scoreCodec(codec, preferred),
  })));
  scored.sort((left, right) => right.score - left.score);
  try {
    transceiver.setCodecPreferences([...scored.map(item => item.codec), ...repair]);
  } catch (error) {
    console.debug('codec preference unsupported', error);
  }
}

async function scoreCodec(codec: ExtendedCodec, preferred: string[]): Promise<number> {
  const normalized = codec.mimeType.toUpperCase().replace('VIDEO/', 'video/');
  const preference = preferred.indexOf(normalized);
  let score = preference === -1 ? 0 : (preferred.length - preference) * 10;
  const capabilities = navigator.mediaCapabilities as MediaCapabilities & {
    encodingInfo?: (configuration: unknown) => Promise<MediaCapabilitiesEncodingInfo>;
  };
  if (!capabilities?.encodingInfo) return score;
  try {
    const contentType = codec.sdpFmtpLine ? codec.mimeType + ';' + codec.sdpFmtpLine : codec.mimeType;
    const scalabilityMode = codec.scalabilityModes?.includes('L1T3') ? 'L1T3' : undefined;
    const info = await capabilities.encodingInfo({
      type: 'webrtc',
      video: {
        contentType,
        width: 1920,
        height: 1080,
        bitrate: 8_000_000,
        framerate: 60,
        scalabilityMode,
      },
    });
    if (!info.supported) return -1000;
    if (info.smooth) score += 100;
    if (info.powerEfficient) score += 200;
  } catch {
    // Capability probing is optional; retain the compatibility ranking.
  }
  return score;
}

/* ---------- getStats summary (pure-ish, unit tested with fake reports) ---------- */

interface StatsSummary {
  outboundVideo?: ExtendedStats;
  inboundVideo?: ExtendedStats;
  remoteInbound?: ExtendedStats;
  candidatePair?: ExtendedStats;
  videoCodec: string;
  route: 'direct' | 'relay' | 'unknown';
}

export function collectStats(report: RTCStatsReport): StatsSummary {
  let outboundVideo: ExtendedStats | undefined;
  let inboundVideo: ExtendedStats | undefined;
  let remoteInbound: ExtendedStats | undefined;
  let candidatePair: ExtendedStats | undefined;
  let localCandidate: ExtendedStats | undefined;
  let remoteCandidate: ExtendedStats | undefined;
  const codecs = new Map<string, ExtendedStats>();

  report.forEach(item => {
    const stat = item as ExtendedStats;
    if (stat.type === 'outbound-rtp' && stat.kind === 'video' && !stat.isRemote) outboundVideo = stat;
    if (stat.type === 'inbound-rtp' && stat.kind === 'video' && !stat.isRemote) inboundVideo = stat;
    if (stat.type === 'remote-inbound-rtp' && stat.kind === 'video') remoteInbound = stat;
    if (stat.type === 'candidate-pair' && stat.state === 'succeeded' && (stat.nominated || stat.selected)) {
      candidatePair = stat;
    }
    if (stat.type === 'local-candidate') localCandidate = stat;
    if (stat.type === 'remote-candidate') remoteCandidate = stat;
    if (stat.type === 'codec') codecs.set(stat.id, stat);
  });

  let route: 'direct' | 'relay' | 'unknown' = 'unknown';
  if (candidatePair) {
    const remoteType = remoteCandidate?.candidateType || 'unknown';
    const localType = localCandidate?.candidateType || 'unknown';
    route = remoteType === 'relay' || localType === 'relay' ? 'relay' : 'direct';
  }

  let videoCodec = '';
  if (outboundVideo?.codecId) {
    const codec = codecs.get(outboundVideo.codecId);
    if (codec?.mimeType) videoCodec = codec.mimeType.replace('video/', '').toUpperCase();
  }

  return {
    outboundVideo,
    inboundVideo,
    remoteInbound,
    candidatePair,
    videoCodec,
    route,
  };
}
