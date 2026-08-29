import { ApiError, request } from '../lib/api';
import { QUALITY_TIERS, classifyNetwork, ewma } from './quality';

const MAX_PENDING_ICE_CANDIDATES = 256;

export type CallMode = 'video' | 'audio';

export interface SessionCredentials {
  token: string;
  clientId: string;
  iceServers: RTCIceServer[];
}

export interface StartCallOptions extends SessionCredentials {
  room: string;
  mode: CallMode;
}

export interface CallSnapshot {
  active: boolean;
  room: string;
  status: string;
  waiting: boolean;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  localMuted: boolean;
  localVideoEnabled: boolean;
  remoteVideoOff: boolean;
  peerName: string;
  peerPresent: boolean;
  remoteTitle: string;
  remoteSubtitle: string;
}

interface CallCallbacks {
  onChange: (snapshot: CallSnapshot) => void;
  onToast: (message: string) => void;
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
  state?: string;
  nominated?: boolean;
  selected?: boolean;
  availableOutgoingBitrate?: number;
  qualityLimitationReason?: string;
  framesPerSecond?: number;
};

export function initialCallSnapshot(): CallSnapshot {
  return {
    active: false,
    room: '',
    status: '等待对方',
    waiting: true,
    localStream: null,
    remoteStream: null,
    localMuted: false,
    localVideoEnabled: false,
    remoteVideoOff: false,
    peerName: '',
    peerPresent: false,
    remoteTitle: '等待对方加入',
    remoteSubtitle: '把房间链接发给想通话的人',
  };
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
  private localStream: MediaStream | null = null;
  private pc: RTCPeerConnection | null = null;
  private socket: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
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
  private lifecycleGeneration = 0;

  constructor(callbacks: CallCallbacks) {
    this.callbacks = callbacks;
  }

  getSnapshot(): CallSnapshot {
    return this.snapshot;
  }

  getRoom(): string {
    return this.room;
  }

  async start(options: StartCallOptions): Promise<void> {
    this.stop();
    const generation = this.lifecycleGeneration;
    this.token = options.token;
    this.clientId = options.clientId;
    this.iceServers = options.iceServers;
    this.room = options.room;
    this.mode = options.mode;
    await this.acquireMedia(options.mode === 'video');
    if (generation !== this.lifecycleGeneration) {
      this.stopMedia();
      return;
    }
    this.patch({
      active: true,
      room: this.room,
      status: '正在连接',
      waiting: true,
      localStream: this.localStream,
      localMuted: false,
      localVideoEnabled: options.mode === 'video',
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
    this.snapshot = { ...initialCallSnapshot(), room: this.room };
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
    let track = this.localStream?.getVideoTracks()[0];
    if (!this.localStream) return;
    if (!track) {
      try {
        const extra = await navigator.mediaDevices.getUserMedia({ video: this.videoConstraints() });
        track = extra.getVideoTracks()[0];
        if (!track) throw new Error('camera did not provide a video track');
        this.localStream.addTrack(track);
        if (this.pc) this.pc.addTrack(track, this.localStream);
      } catch {
        this.callbacks.onToast('无法开启摄像头，请检查浏览器权限');
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
    this.cameraFacing = this.cameraFacing === 'user' ? 'environment' : 'user';
    let newTrack: MediaStreamTrack | undefined;
    try {
      const replacementStream = await navigator.mediaDevices.getUserMedia({ video: this.videoConstraints() });
      [newTrack] = replacementStream.getVideoTracks();
      if (!newTrack) throw new Error('replacement camera did not provide a video track');
      const sender = this.pc?.getSenders().find(item => item.track?.kind === 'video');
      await sender?.replaceTrack(newTrack);
      this.localStream.removeTrack(oldTrack);
      oldTrack.stop();
      this.localStream.addTrack(newTrack);
      this.patch({ localStream: this.localStream, localVideoEnabled: true });
    } catch {
      newTrack?.stop();
      this.cameraFacing = this.cameraFacing === 'user' ? 'environment' : 'user';
      this.callbacks.onToast('无法切换摄像头');
    }
  }

  handleVisible(): void {
    if (!this.snapshot.active) return;
    void this.requestWakeLock();
    if (!this.socket || this.socket.readyState === WebSocket.CLOSED) void this.connectSocket();
  }

  handleOnline(): void {
    if (!this.snapshot.active) return;
    void this.connectSocket();
    this.scheduleIceRestart(500);
  }

  handleOffline(): void {
    if (this.snapshot.active) this.setStatus('网络已断开', true);
  }

  private patch(patch: Partial<CallSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.callbacks.onChange(this.snapshot);
  }

  private clearTimer(name: 'reconnectTimer' | 'iceRestartTimer'): void {
    const timer = this[name];
    if (timer) clearTimeout(timer);
    this[name] = null;
  }

  private async acquireMedia(withVideo: boolean): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('当前浏览器不支持音视频通话，请使用新版 Safari、Chrome 或 Edge');
    }
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: { ideal: 48_000 },
          sampleSize: { ideal: 16 },
          channelCount: { ideal: 1 },
        },
        video: withVideo ? this.videoConstraints() : false,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotAllowedError') {
        throw new Error('需要允许摄像头和麦克风权限才能通话');
      }
      if (error instanceof DOMException && error.name === 'NotFoundError') {
        throw new Error('没有找到可用的摄像头或麦克风');
      }
      throw error;
    }
    this.localStream.getAudioTracks().forEach(track => { track.contentHint = 'speech'; });
    this.localStream.getVideoTracks().forEach(track => { track.contentHint = 'detail'; });
  }

  private videoConstraints(): MediaTrackConstraints & { resizeMode: string } {
    return {
      facingMode: { ideal: this.cameraFacing },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 60, max: 60 },
      resizeMode: 'crop-and-scale',
    };
  }

  private async connectSocket(): Promise<void> {
    if (!this.snapshot.active) return;
    if (this.socket && (
      this.socket.readyState === WebSocket.CONNECTING
      || this.socket.readyState === WebSocket.OPEN
    )) return;
    const generation = ++this.socketGeneration;
    this.setStatus('正在连接', true);

    try {
      // The browser WebSocket API cannot set Authorization. Exchange the in-memory
      // JWT for a short-lived, single-use ticket so the JWT never enters a URL.
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
        this.setStatus(this.peerPresent ? '建立连接' : '等待对方', true);
        if (this.peerPresent && ['failed', 'disconnected'].includes(this.pc?.connectionState || '')) {
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
            console.error('signal handling failed', error);
            this.callbacks.onToast('连接协商失败，正在恢复');
          });
      });
      socket.addEventListener('close', () => {
        if (socket !== this.socket) return;
        this.socket = null;
        if (this.snapshot.active) this.scheduleSocketReconnect();
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
      this.scheduleSocketReconnect();
    }
  }

  private scheduleSocketReconnect(): void {
    if (!this.snapshot.active) return;
    this.setStatus('信令重连中', true);
    const base = Math.min(1000 * 2 ** this.reconnectAttempts++, 10_000);
    const delay = Math.round(base * (.8 + Math.random() * .4));
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
    } else if (message.type === 'answer' && this.pc) {
      if (this.pc.signalingState !== 'have-local-offer') return;
      await this.pc.setRemoteDescription(message.payload as RTCSessionDescriptionInit);
      await this.flushPendingIceCandidates(this.pc);
      this.ignoreOffer = false;
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
      this.resetPeer('对方已离开', '链接仍然有效，等待对方重新加入');
    } else if (message.type === 'media-state') {
      const media = message.payload as { video?: boolean };
      this.patch({ remoteVideoOff: media.video === false && Boolean(this.snapshot.remoteStream) });
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
    this.localStream.getTracks().forEach(track => pc.addTrack(track, this.localStream as MediaStream));
    await configureVideoCodecs(pc);
    await configureAudioSender(pc);
    await this.applyQualityTier(0, pc, false);
    pc.addEventListener('icecandidate', event => {
      if (event.candidate) this.sendSignal('ice-candidate', event.candidate);
    });
    pc.addEventListener('track', event => {
      const stream = event.streams[0] || new MediaStream([event.track]);
      this.patch({ remoteStream: stream, remoteVideoOff: false });
    });
    pc.addEventListener('negotiationneeded', () => {
      if (this.snapshot.active && this.peerPresent) void this.sendOffer(false);
    });
    pc.addEventListener('connectionstatechange', () => {
      if (pc !== this.pc) return;
      const labels: Partial<Record<RTCPeerConnectionState, [string, boolean]>> = {
        connected: ['通话中', false],
        connecting: ['建立连接', true],
        disconnected: ['连接中断', true],
        failed: ['连接失败', true],
      };
      const next = labels[pc.connectionState];
      if (next) this.setStatus(...next);
      if (pc.connectionState === 'connected') {
        this.iceRestartAttempts = 0;
        this.clearTimer('iceRestartTimer');
        this.startNetworkMonitor();
      } else if (pc.connectionState === 'disconnected') {
        this.scheduleIceRestart(3000);
      } else if (pc.connectionState === 'failed') {
        this.scheduleIceRestart(0);
      }
    });
    return pc;
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
        this.pc?.close();
        this.pc = null;
        this.pendingIceCandidates = [];
        this.iceRestartAttempts = 0;
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
    else this.callbacks.onToast('协商数据异常过大，正在重建连接');
  }

  private showPeer(name?: string): void {
    this.peerPresent = true;
    const peerName = name || '对方';
    this.patch({
      peerPresent: true,
      peerName,
      remoteTitle: peerName + '正在加入',
      remoteSubtitle: '正在建立安全的媒体连接',
      status: '建立连接',
      waiting: true,
    });
  }

  private resetPeer(
    title = '等待对方加入',
    subtitle = '把房间链接发给想通话的人',
  ): void {
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
      remoteVideoOff: false,
      remoteTitle: title,
      remoteSubtitle: subtitle,
      status: '等待对方',
      waiting: true,
    });
  }

  private sendMediaState(): void {
    this.sendSignal('media-state', {
      audio: this.localStream?.getAudioTracks().some(track => track.enabled) || false,
      video: this.localStream?.getVideoTracks().some(track => track.enabled) || false,
    });
  }

  private setStatus(status: string, waiting = false): void {
    this.patch({ status, waiting });
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
  }

  private async sampleNetwork(): Promise<void> {
    const pc = this.pc;
    if (!pc || pc.connectionState !== 'connected') return;
    try {
      const report = await pc.getStats();
      let outbound: ExtendedStats | undefined;
      let remoteInbound: ExtendedStats | undefined;
      let candidatePair: ExtendedStats | undefined;
      report.forEach(item => {
        const stat = item as ExtendedStats;
        if (stat.type === 'outbound-rtp' && stat.kind === 'video' && !stat.isRemote) outbound = stat;
        if (stat.type === 'remote-inbound-rtp' && stat.kind === 'video') remoteInbound = stat;
        if (stat.type === 'candidate-pair' && stat.state === 'succeeded' && (stat.nominated || stat.selected)) candidatePair = stat;
      });
      if (!outbound) return;

      const snapshot = {
        packetsSent: outbound.packetsSent || 0,
        packetsLost: Math.max(0, remoteInbound?.packetsLost || 0),
        timestamp: outbound.timestamp,
      };
      if (!this.previousStats) {
        this.previousStats = snapshot;
        return;
      }

      const sent = Math.max(0, snapshot.packetsSent - this.previousStats.packetsSent);
      const lost = Math.max(0, snapshot.packetsLost - this.previousStats.packetsLost);
      const loss = lost / Math.max(1, sent + lost);
      const rtt = remoteInbound?.roundTripTime ?? candidatePair?.currentRoundTripTime ?? 0;
      const available = candidatePair?.availableOutgoingBitrate ?? Number.POSITIVE_INFINITY;
      this.previousStats = snapshot;

      const alpha = this.networkEwma && available >= this.networkEwma.available ? .15 : .55;
      this.networkEwma = {
        loss: ewma(this.networkEwma?.loss ?? null, loss, alpha),
        rtt: ewma(this.networkEwma?.rtt ?? null, rtt, alpha),
        available: ewma(this.networkEwma?.available ?? null, available, alpha),
      };
      const cpuLimited = outbound.qualityLimitationReason === 'cpu'
        || Boolean(outbound.framesPerSecond && outbound.framesPerSecond < QUALITY_TIERS[this.qualityTier].maxFramerate * .7);
      const desiredTier = Math.max(
        classifyNetwork(this.networkEwma.loss, this.networkEwma.rtt, this.networkEwma.available),
        cpuLimited ? Math.min(2, this.qualityTier + 1) : 0,
      );
      await this.considerTierChange(desiredTier);
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
    notify = true,
  ): Promise<void> {
    const tier = QUALITY_TIERS[tierIndex];
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
    const changed = this.qualityTier !== tierIndex;
    this.qualityTier = tierIndex;
    if (changed && notify) this.callbacks.onToast(tier.name + ' · 质量优先自适应');
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
