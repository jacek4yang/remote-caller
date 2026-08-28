const $ = (selector) => document.querySelector(selector);

const els = {
  loginView: $('#login-view'), dashboard: $('#dashboard-view'), call: $('#call'),
  loginForm: $('#login-form'), loginButton: $('#login-button'), loginError: $('#login-error'),
  username: $('#username'), password: $('#password'), accountName: $('#account-name'), welcomeName: $('#welcome-name'),
  logout: $('#logout-button'), joinForm: $('#join-form'), joinButton: $('#join-button'),
  dashboardError: $('#dashboard-error'), joinHint: $('#join-hint'), room: $('#room-id'),
  createRoom: $('#create-room-button'), invitePanel: $('#invite-panel'), inviteRoomCode: $('#created-room-code'),
  copyRoom: $('#copy-room-button'), shareInvite: $('#share-invite-button'), enterCreatedRoom: $('#enter-created-room-button'),
  roomLabel: $('#room-label'), network: $('#network-badge'), share: $('#share-button'),
  localVideo: $('#local-video'), remoteVideo: $('#remote-video'), localAvatar: $('#local-avatar'),
  remotePlaceholder: $('#remote-placeholder'), remoteTitle: $('#remote-title'), remoteSubtitle: $('#remote-subtitle'),
  peerName: $('#peer-name'), mic: $('#mic-button'), camera: $('#camera-button'),
  switchCamera: $('#switch-camera-button'), pip: $('#pip-button'), hangup: $('#hangup-button'), toast: $('#toast'),
};

const state = {
  token: '', clientId: '', room: '', mode: 'video', localStream: null, pc: null, socket: null,
  displayName: '', role: '', expiresAt: 0, sessionTimer: null, draftRoom: '',
  iceServers: [], cameraFacing: 'user', active: false, reconnectAttempts: 0, reconnectTimer: null,
  socketGeneration: 0, signalChain: Promise.resolve(), pendingIceCandidates: [],
  makingOffer: false, ignoreOffer: false, polite: false, peerPresent: false,
  iceRestartTimer: null, iceRestartAttempts: 0,
  wakeLock: null,
  adaptationTimer: null, qualityTier: 0, badSamples: 0, goodSamples: 0, previousStats: null,
  networkEwma: null,
};

// Quality-first ladder: always retain HD spatial resolution and reduce temporal
// detail/bitrate before resolution. WebRTC's encoder performs inter-frame prediction.
const QUALITY_TIERS = [
  { name: '1080P 60FPS 极清', maxBitrate: 8_000_000, maxFramerate: 60, scale: 1, width: 1920, height: 1080 },
  { name: '1080P 45FPS 超清', maxBitrate: 5_500_000, maxFramerate: 45, scale: 1, width: 1920, height: 1080 },
  { name: '1080P 30FPS 高清', maxBitrate: 3_500_000, maxFramerate: 30, scale: 1, width: 1920, height: 1080 },
  { name: '720P 30FPS 弱网保护', maxBitrate: 1_800_000, maxFramerate: 30, scale: 1.5, width: 1280, height: 720 },
];
const MAX_PENDING_ICE_CANDIDATES = 256;
const MAX_TIMEOUT = 2_147_483_647;

function makeRoom() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function sanitizeRoom(value) {
  return value.trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}

const params = new URLSearchParams(location.search);
const invitedRoom = sanitizeRoom(params.get('room') || '');
els.room.value = invitedRoom;
els.username.value = localStorage.getItem('remote-caller-username') || '';
if (invitedRoom) els.joinHint.textContent = '邀请链接中的房间号已填好，登录后可直接加入。';

els.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  els.loginError.textContent = '';
  els.loginButton.disabled = true;
  els.loginButton.textContent = '正在登录…';
  const username = els.username.value.trim();
  const password = els.password.value;
  try {
    const session = await request('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    const config = await request('/api/config', { headers: { Authorization: `Bearer ${session.token}` } });
    localStorage.setItem('remote-caller-username', username);
    state.token = session.token;
    state.clientId = session.clientId;
    state.displayName = session.displayName || username;
    state.role = session.role || '';
    state.expiresAt = session.expiresAt || 0;
    state.iceServers = config.iceServers;
    els.password.value = '';
    scheduleSessionExpiry();
    showDashboard();
  } catch (error) {
    clearSession();
    els.loginError.textContent = humanError(error);
  } finally {
    els.loginButton.disabled = false;
    els.loginButton.textContent = '登录';
  }
});

els.createRoom.addEventListener('click', () => showInvitation(makeRoom()));
els.enterCreatedRoom.addEventListener('click', () => void startCall(state.draftRoom));
els.copyRoom.addEventListener('click', () => void copyText(state.draftRoom, '房间号已复制'));
els.shareInvite.addEventListener('click', () => void shareRoom(state.draftRoom));
els.logout.addEventListener('click', () => logout());

els.joinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void startCall(els.room.value);
});

function showDashboard(message = '') {
  els.loginView.hidden = true;
  els.call.hidden = true;
  els.dashboard.hidden = false;
  els.accountName.textContent = state.displayName;
  els.welcomeName.textContent = state.displayName;
  els.dashboardError.textContent = message;
  if (invitedRoom && !els.room.value) els.room.value = invitedRoom;
}

function showInvitation(room) {
  state.draftRoom = sanitizeRoom(room);
  els.inviteRoomCode.textContent = state.draftRoom;
  els.invitePanel.hidden = false;
  history.replaceState({}, '', roomUrl(state.draftRoom));
  els.invitePanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function selectedMode() {
  return document.querySelector('input[name="mode"]:checked')?.value || 'video';
}

async function startCall(roomValue) {
  const room = sanitizeRoom(roomValue);
  els.dashboardError.textContent = '';
  setRoomActionsBusy(true);
  try {
    if (!state.token) throw new Error('请先登录');
    if (room.length < 6) throw new Error('房间号至少需要 6 个字符');
    state.room = room;
    state.mode = selectedMode();
    await acquireMedia(state.mode === 'video');
    enterCall();
    void connectSocket();
  } catch (error) {
    stopMedia();
    els.dashboardError.textContent = humanError(error);
  } finally {
    setRoomActionsBusy(false);
  }
}

function setRoomActionsBusy(busy) {
  els.createRoom.disabled = busy;
  els.joinButton.disabled = busy;
  els.enterCreatedRoom.disabled = busy;
  els.joinButton.textContent = busy ? '正在准备…' : '加入房间';
  els.enterCreatedRoom.textContent = busy ? '正在准备…' : '进入这个房间';
}

function roomUrl(room) {
  const url = new URL(location.pathname, location.origin);
  url.searchParams.set('room', room);
  return url.href;
}

async function shareRoom(room) {
  const url = roomUrl(room);
  const shareData = { title: '加入我的通话', text: `房间号：${room}`, url };
  try {
    if (navigator.share) await navigator.share(shareData);
    else await copyText(url, '邀请链接已复制');
  } catch (error) {
    if (error.name !== 'AbortError') showToast('分享失败，请复制房间号');
  }
}

async function copyText(value, successMessage) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
    } else {
      const field = document.createElement('textarea');
      field.value = value;
      field.setAttribute('readonly', '');
      field.style.position = 'fixed';
      field.style.opacity = '0';
      document.body.append(field);
      field.select();
      if (!document.execCommand('copy')) throw new Error('copy command failed');
      field.remove();
    }
    showToast(successMessage);
  } catch {
    showToast('复制失败，请手动复制');
  }
}

function scheduleSessionExpiry() {
  clearTimeout(state.sessionTimer);
  if (!state.expiresAt) return;
  const delay = Math.min(Math.max(0, state.expiresAt * 1000 - Date.now()), MAX_TIMEOUT);
  state.sessionTimer = setTimeout(() => {
    if (Date.now() < state.expiresAt * 1000) scheduleSessionExpiry();
    else logout('登录已过期，请重新登录');
  }, delay);
}

function clearSession() {
  clearTimeout(state.sessionTimer);
  state.sessionTimer = null;
  state.token = '';
  state.clientId = '';
  state.displayName = '';
  state.role = '';
  state.expiresAt = 0;
  state.iceServers = [];
}

function logout(message = '') {
  const room = state.active ? state.room : sanitizeRoom(els.room.value || state.draftRoom);
  stopCall();
  clearSession();
  els.dashboard.hidden = true;
  els.call.hidden = true;
  els.loginView.hidden = false;
  els.loginError.textContent = message;
  if (room) {
    els.room.value = room;
    history.replaceState({}, '', roomUrl(room));
  } else {
    history.replaceState({}, '', location.pathname);
  }
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error === 'unauthorized' ? '认证失败或登录已过期'
      : data.error === 'room_full' ? '房间已满（当前版本支持两人通话）'
      : data.error === 'rate_limited' ? '请求过于频繁，请稍后再试'
      : data.error === 'capacity_reached' ? '服务正在保护资源，请稍后重试'
      : data.message || `服务请求失败 (${response.status})`;
    const error = new Error(message);
    error.code = data.error || `http_${response.status}`;
    throw error;
  }
  return data;
}

async function acquireMedia(withVideo) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器不支持音视频通话，请使用新版 Safari、Chrome 或 Edge');
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true, noiseSuppression: true, autoGainControl: true,
        sampleRate: { ideal: 48_000 }, sampleSize: { ideal: 16 }, channelCount: { ideal: 1 },
      },
      video: withVideo ? videoConstraints() : false,
    });
  } catch (error) {
    if (error.name === 'NotAllowedError') throw new Error('需要允许摄像头和麦克风权限才能通话');
    if (error.name === 'NotFoundError') throw new Error('没有找到可用的摄像头或麦克风');
    throw error;
  }
  state.localStream.getAudioTracks().forEach(track => { track.contentHint = 'speech'; });
  state.localStream.getVideoTracks().forEach(track => { track.contentHint = 'detail'; });
  els.localVideo.srcObject = state.localStream;
  updateLocalPreview();
  setPressed(els.mic, false, '静音');
  setPressed(els.camera, !withVideo, withVideo ? '摄像头' : '开启视频');
}

function videoConstraints() {
  return {
    facingMode: { ideal: state.cameraFacing },
    width: { ideal: 1920 }, height: { ideal: 1080 },
    frameRate: { ideal: 60, max: 60 }, resizeMode: 'crop-and-scale',
  };
}

function enterCall() {
  state.active = true;
  history.replaceState({}, '', roomUrl(state.room));
  els.roomLabel.textContent = `房间 ${state.room}`;
  els.dashboard.hidden = true;
  els.call.hidden = false;
  requestWakeLock();
}

async function connectSocket() {
  if (!state.active) return;
  if (state.socket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(state.socket.readyState)) return;
  const generation = ++state.socketGeneration;
  setStatus('正在连接', true);

  try {
    // Browser WebSocket APIs cannot set an Authorization header. Exchange the
    // in-memory JWT for a 30-second, single-use ticket so the JWT never enters
    // a URL, proxy log, browser history, or monitoring system.
    const issued = await request('/api/ws-ticket', {
      method: 'POST',
      headers: { Authorization: `Bearer ${state.token}` },
      body: JSON.stringify({ room: state.room }),
    });
    if (!state.active || generation !== state.socketGeneration) return;

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}/ws?ticket=${encodeURIComponent(issued.ticket)}`);
    state.socket = socket;

    socket.addEventListener('open', () => {
      if (socket !== state.socket) return;
      state.reconnectAttempts = 0;
      setStatus(state.peerPresent ? '建立连接' : '等待对方', true);
      if (state.peerPresent && ['failed', 'disconnected'].includes(state.pc?.connectionState)) scheduleIceRestart(250);
    });
    socket.addEventListener('message', ({ data }) => {
      // Serialize SDP and ICE operations. WebSocket message callbacks themselves
      // are not awaited by the browser and otherwise race setRemoteDescription.
      state.signalChain = state.signalChain
        .then(() => {
          if (socket !== state.socket || generation !== state.socketGeneration || typeof data !== 'string' || data.length > 70_000) return;
          const message = JSON.parse(data);
          if (!message || typeof message !== 'object' || typeof message.type !== 'string') throw new Error('invalid signaling envelope');
          return onSignal(message);
        })
        .catch(error => {
          console.error('signal handling failed', error);
          showToast('连接协商失败，正在恢复');
        });
    });
    socket.addEventListener('close', () => {
      if (socket !== state.socket) return;
      state.socket = null;
      if (!state.active) return;
      scheduleSocketReconnect();
    });
  } catch (error) {
    if (!state.active || generation !== state.socketGeneration) return;
    if (error.code === 'unauthorized') {
      logout('登录已过期，请重新登录');
      return;
    }
    if (error.code === 'room_full') {
      returnToDashboard('房间已满（当前版本支持两人通话）');
      return;
    }
    console.warn('signaling connection failed', error);
    scheduleSocketReconnect();
  }
}

function scheduleSocketReconnect() {
  if (!state.active) return;
  setStatus('信令重连中', true);
  const base = Math.min(1000 * 2 ** state.reconnectAttempts++, 10000);
  const delay = Math.round(base * (.8 + Math.random() * .4));
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = setTimeout(() => void connectSocket(), delay);
}

async function onSignal(message) {
  if (message.type === 'ready') return;
  if (message.from) state.polite = state.clientId.localeCompare(message.from) > 0;

  if (message.type === 'peer-joined') {
    showPeer(message.displayName);
    await ensurePeerConnection();
    if (!await sendOffer(false)) scheduleIceRestart(500);
  } else if (message.type === 'offer') {
    showPeer(message.displayName);
    const pc = await ensurePeerConnection();
    const offerCollision = state.makingOffer || pc.signalingState !== 'stable';
    state.ignoreOffer = !state.polite && offerCollision;
    if (state.ignoreOffer) return;

    // The polite peer rolls back a simultaneous local offer. Modern browsers
    // also support implicit rollback in setRemoteDescription; explicit rollback
    // keeps behavior deterministic where available.
    if (offerCollision) {
      try { await pc.setLocalDescription({ type: 'rollback' }); } catch { /* implicit rollback fallback */ }
    }
    await pc.setRemoteDescription(message.payload);
    await flushPendingIceCandidates(pc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(tuneOpus(answer));
    sendSignal('answer', pc.localDescription);
    state.ignoreOffer = false;
  } else if (message.type === 'answer' && state.pc) {
    if (state.pc.signalingState !== 'have-local-offer') return;
    await state.pc.setRemoteDescription(message.payload);
    await flushPendingIceCandidates(state.pc);
    state.ignoreOffer = false;
  } else if (message.type === 'ice-candidate' && message.payload) {
    if (state.ignoreOffer) return;
    const pc = await ensurePeerConnection();
    if (!pc.remoteDescription) {
      if (state.pendingIceCandidates.length >= MAX_PENDING_ICE_CANDIDATES) {
        throw new Error('too many queued ICE candidates');
      }
      state.pendingIceCandidates.push(message.payload);
    } else if (candidateMatchesRemoteDescription(pc, message.payload)) {
      await pc.addIceCandidate(message.payload);
    }
  } else if (message.type === 'peer-left') {
    resetPeer('对方已离开', '链接仍然有效，等待对方重新加入');
  } else if (message.type === 'media-state') {
    if (message.payload?.video === false && els.remoteVideo.srcObject) els.remoteVideo.classList.add('video-off');
    else els.remoteVideo.classList.remove('video-off');
  }
}

async function flushPendingIceCandidates(pc) {
  const candidates = state.pendingIceCandidates.splice(0);
  for (const candidate of candidates) {
    if (!candidateMatchesRemoteDescription(pc, candidate)) continue;
    try { await pc.addIceCandidate(candidate); } catch (error) { console.warn('ICE candidate rejected', error); }
  }
}

function candidateMatchesRemoteDescription(pc, candidate) {
  const remoteUfrags = new Set(Array.from(
    pc.remoteDescription?.sdp?.matchAll(/^a=ice-ufrag:(.+)$/gmi) || [],
    match => match[1].trim(),
  ));
  return !candidate.usernameFragment || !remoteUfrags.size || remoteUfrags.has(candidate.usernameFragment);
}

async function ensurePeerConnection() {
  if (state.pc && state.pc.connectionState !== 'closed') return state.pc;
  const pc = new RTCPeerConnection({ iceServers: state.iceServers, iceCandidatePoolSize: 4 });
  state.pc = pc;
  state.pendingIceCandidates = [];
  state.ignoreOffer = false;
  state.localStream.getTracks().forEach(track => pc.addTrack(track, state.localStream));
  await configureVideoCodecs(pc);
  await configureAudioSender(pc);
  await applyQualityTier(0, pc, false);
  pc.addEventListener('icecandidate', event => { if (event.candidate) sendSignal('ice-candidate', event.candidate); });
  pc.addEventListener('track', event => {
    els.remoteVideo.srcObject = event.streams[0];
    els.remotePlaceholder.hidden = true;
    els.remoteVideo.play().catch(() => showToast('轻触页面以播放对方声音'));
  });
  pc.addEventListener('negotiationneeded', () => {
    if (state.active && state.peerPresent) void sendOffer(false);
  });
  pc.addEventListener('connectionstatechange', () => {
    if (pc !== state.pc) return;
    const labels = { connected: ['通话中', false], connecting: ['建立连接', true], disconnected: ['连接中断', true], failed: ['连接失败', true] };
    const next = labels[pc.connectionState];
    if (next) setStatus(...next);
    if (pc.connectionState === 'connected') {
      state.iceRestartAttempts = 0;
      clearTimeout(state.iceRestartTimer);
      startNetworkMonitor();
    } else if (pc.connectionState === 'disconnected') {
      scheduleIceRestart(3000);
    } else if (pc.connectionState === 'failed') {
      scheduleIceRestart(0);
    }
  });
  return pc;
}

async function sendOffer(iceRestart = false) {
  const pc = await ensurePeerConnection();
  if (state.makingOffer || pc.signalingState !== 'stable' || state.socket?.readyState !== WebSocket.OPEN) return false;
  state.makingOffer = true;
  try {
    const offer = await pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
    if (pc.signalingState !== 'stable') return false;
    await pc.setLocalDescription(tuneOpus(offer));
    sendSignal('offer', pc.localDescription);
    return true;
  } finally {
    state.makingOffer = false;
  }
}

function scheduleIceRestart(delay) {
  if (!state.active || !state.peerPresent) return;
  clearTimeout(state.iceRestartTimer);
  state.iceRestartTimer = setTimeout(async () => {
    if (!state.active || !state.peerPresent) return;
    if (state.pc?.connectionState === 'connected') return;
    if (state.socket?.readyState !== WebSocket.OPEN) {
      scheduleIceRestart(1500);
      return;
    }
    if (state.iceRestartAttempts >= 3) {
      state.pc?.close();
      state.pc = null;
      state.pendingIceCandidates = [];
      state.iceRestartAttempts = 0;
    }
    state.iceRestartAttempts += 1;
    const sent = await sendOffer(true).catch(error => {
      console.warn('ICE restart failed', error);
      return false;
    });
    if (!sent) {
      scheduleIceRestart(1000);
    } else {
      // An ICE-restart offer needs a bounded watchdog; connectionState does
      // not necessarily emit a second failure event after a failed restart.
      scheduleIceRestart(Math.min(3000 * 2 ** (state.iceRestartAttempts - 1), 12000));
    }
  }, delay);
}

function tuneOpus(description) {
  if (!description.sdp) return description;
  const opus = description.sdp.match(/^a=rtpmap:(\d+) opus\/48000\/2\r?$/mi);
  if (!opus) return description;
  const payload = opus[1];
  const fmtpPattern = new RegExp(`^a=fmtp:${payload} (.*)$`, 'mi');
  const required = {
    minptime: '10', useinbandfec: '1', usedtx: '0', stereo: '0', 'sprop-stereo': '0',
    maxplaybackrate: '48000', 'sprop-maxcapturerate': '48000', maxaveragebitrate: '96000', cbr: '0',
  };
  let sdp = description.sdp;
  const existing = sdp.match(fmtpPattern);
  if (existing) {
    const parameters = new Map(existing[1].split(';').map(item => item.trim().split('=')));
    Object.entries(required).forEach(([key, value]) => parameters.set(key, value));
    sdp = sdp.replace(fmtpPattern, `a=fmtp:${payload} ${Array.from(parameters, item => item.join('=')).join(';')}`);
  } else {
    sdp = sdp.replace(opus[0], `${opus[0]}\r\na=fmtp:${payload} ${Object.entries(required).map(item => item.join('=')).join(';')}`);
  }
  return { type: description.type, sdp };
}

async function configureVideoCodecs(pc) {
  const transceiver = pc.getTransceivers().find(item => item.sender.track?.kind === 'video');
  const codecs = globalThis.RTCRtpReceiver?.getCapabilities?.('video')?.codecs;
  if (!transceiver?.setCodecPreferences || !codecs?.length) return;

  const isAppleMobile = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const isLowPowerMobile = /Android/i.test(navigator.userAgent) && (navigator.hardwareConcurrency || 4) < 8;
  const preferred = (isAppleMobile || isLowPowerMobile)
    ? ['video/H264', 'video/VP8', 'video/VP9', 'video/AV1']
    : ['video/AV1', 'video/VP9', 'video/H264', 'video/VP8'];
  const primary = codecs.filter(codec => !/\/(rtx|red|ulpfec|flexfec)/i.test(codec.mimeType));
  const repair = codecs.filter(codec => /\/(rtx|red|ulpfec|flexfec)/i.test(codec.mimeType));
  const scored = await Promise.all(primary.map(async codec => ({ codec, score: await scoreCodec(codec, preferred) })));
  scored.sort((left, right) => right.score - left.score);
  const orderedPrimary = scored.map(item => item.codec);
  try { transceiver.setCodecPreferences([...orderedPrimary, ...repair]); } catch (error) { console.debug('codec preference unsupported', error); }
}

async function scoreCodec(codec, preferred) {
  const normalized = codec.mimeType.toUpperCase().replace('VIDEO/', 'video/');
  const preference = preferred.indexOf(normalized);
  let score = preference === -1 ? 0 : (preferred.length - preference) * 10;
  if (!navigator.mediaCapabilities?.encodingInfo) return score;
  try {
    const contentType = codec.sdpFmtpLine ? `${codec.mimeType};${codec.sdpFmtpLine}` : codec.mimeType;
    const scalabilityMode = codec.scalabilityModes?.includes('L1T3') ? 'L1T3' : undefined;
    const info = await navigator.mediaCapabilities.encodingInfo({
      type: 'webrtc',
      video: { contentType, width: 1920, height: 1080, bitrate: 8_000_000, framerate: 60, scalabilityMode },
    });
    if (!info.supported) return -1000;
    if (info.smooth) score += 100;
    if (info.powerEfficient) score += 200;
  } catch { /* Capability probing is optional; retain the compatibility ranking. */ }
  return score;
}

function sendSignal(type, payload) {
  if (state.socket?.readyState !== WebSocket.OPEN) return;
  const message = JSON.stringify({ type, payload });
  if (message.length <= 65_536) state.socket.send(message);
  else showToast('协商数据异常过大，正在重建连接');
}

function showPeer(name) {
  state.peerPresent = true;
  els.peerName.textContent = name || '对方';
  els.peerName.hidden = false;
  els.remoteTitle.textContent = `${name || '对方'}正在加入`;
  els.remoteSubtitle.textContent = '正在建立安全的媒体连接';
  setStatus('建立连接', true);
}

function resetPeer(title = '等待对方加入', subtitle = '把房间链接发给想通话的人') {
  state.peerPresent = false;
  clearTimeout(state.iceRestartTimer);
  state.iceRestartAttempts = 0;
  stopNetworkMonitor();
  state.pc?.close();
  state.pc = null;
  els.remoteVideo.srcObject = null;
  els.remotePlaceholder.hidden = false;
  els.remoteTitle.textContent = title;
  els.remoteSubtitle.textContent = subtitle;
  els.peerName.hidden = true;
  setStatus('等待对方', true);
}

els.mic.addEventListener('click', () => {
  const track = state.localStream?.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  setPressed(els.mic, !track.enabled, track.enabled ? '静音' : '取消静音');
  sendMediaState();
});

els.camera.addEventListener('click', async () => {
  let track = state.localStream?.getVideoTracks()[0];
  if (!track) {
    try {
      const extra = await navigator.mediaDevices.getUserMedia({ video: videoConstraints() });
      track = extra.getVideoTracks()[0];
      state.localStream.addTrack(track);
      if (state.pc) state.pc.addTrack(track, state.localStream);
      els.localVideo.srcObject = state.localStream;
    } catch { showToast('无法开启摄像头，请检查浏览器权限'); return; }
  } else {
    track.enabled = !track.enabled;
  }
  setPressed(els.camera, !track.enabled, track.enabled ? '摄像头' : '开启视频');
  updateLocalPreview();
  sendMediaState();
});

els.switchCamera.addEventListener('click', async () => {
  const oldTrack = state.localStream?.getVideoTracks()[0];
  if (!oldTrack) return;
  state.cameraFacing = state.cameraFacing === 'user' ? 'environment' : 'user';
  let newTrack;
  try {
    const replacementStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints() });
    [newTrack] = replacementStream.getVideoTracks();
    if (!newTrack) throw new Error('replacement camera did not provide a video track');
    const sender = state.pc?.getSenders().find(item => item.track?.kind === 'video');
    await sender?.replaceTrack(newTrack);
    state.localStream.removeTrack(oldTrack);
    oldTrack.stop();
    state.localStream.addTrack(newTrack);
    els.localVideo.srcObject = state.localStream;
  } catch {
    newTrack?.stop();
    state.cameraFacing = state.cameraFacing === 'user' ? 'environment' : 'user';
    showToast('无法切换摄像头');
  }
});

els.share.addEventListener('click', () => void shareRoom(state.room));

if (document.pictureInPictureEnabled && els.remoteVideo.requestPictureInPicture) {
  els.pip.hidden = false;
  els.pip.addEventListener('click', async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (els.remoteVideo.srcObject) await els.remoteVideo.requestPictureInPicture();
      else showToast('对方加入后才能开启画中画');
    } catch { showToast('当前系统暂时无法开启画中画'); }
  });
}

els.hangup.addEventListener('click', hangup);
window.addEventListener('pagehide', stopCall);

function hangup() {
  const room = state.room;
  stopCall();
  showDashboard();
  showInvitation(room);
}

function returnToDashboard(message) {
  const room = state.room;
  stopCall();
  els.room.value = room;
  history.replaceState({}, '', roomUrl(room));
  showDashboard(message);
}

function stopCall() {
  state.active = false;
  clearTimeout(state.reconnectTimer);
  clearTimeout(state.iceRestartTimer);
  state.socketGeneration += 1;
  state.socket?.close();
  state.pc?.close();
  stopMedia();
  state.pc = null;
  state.socket = null;
  state.signalChain = Promise.resolve();
  state.pendingIceCandidates = [];
  state.wakeLock?.release().catch(() => {});
  state.wakeLock = null;
  stopNetworkMonitor();
  resetPeer();
  setPressed(els.mic, false, '静音');
  setPressed(els.camera, false, '摄像头');
  els.remoteVideo.classList.remove('video-off');
}

async function configureAudioSender(pc) {
  const sender = pc.getSenders().find(item => item.track?.kind === 'audio');
  if (!sender) return;
  const parameters = sender.getParameters();
  if (!parameters.encodings?.length) return;
  // 96 kbit/s VBR mono Opus preserves full-band 48 kHz speech with ample headroom.
  parameters.encodings[0].maxBitrate = 96_000;
  try { await sender.setParameters(parameters); } catch (error) { console.debug('audio tuning unsupported', error); }
}

function startNetworkMonitor() {
  if (state.adaptationTimer) return;
  state.previousStats = null;
  sampleNetwork();
  state.adaptationTimer = setInterval(sampleNetwork, 2000);
}

function stopNetworkMonitor() {
  clearInterval(state.adaptationTimer);
  state.adaptationTimer = null;
  state.previousStats = null;
  state.badSamples = 0;
  state.goodSamples = 0;
  state.qualityTier = 0;
  state.networkEwma = null;
}

async function sampleNetwork() {
  const pc = state.pc;
  if (!pc || pc.connectionState !== 'connected') return;
  try {
    const report = await pc.getStats();
    let outbound;
    let remoteInbound;
    let candidatePair;
    report.forEach(item => {
      if (item.type === 'outbound-rtp' && item.kind === 'video' && !item.isRemote) outbound = item;
      if (item.type === 'remote-inbound-rtp' && item.kind === 'video') remoteInbound = item;
      if (item.type === 'candidate-pair' && item.state === 'succeeded' && (item.nominated || item.selected)) candidatePair = item;
    });
    if (!outbound) return;

    const snapshot = {
      packetsSent: outbound.packetsSent || 0,
      packetsLost: Math.max(0, remoteInbound?.packetsLost || 0),
      timestamp: outbound.timestamp,
    };
    if (!state.previousStats) { state.previousStats = snapshot; return; }

    const sent = Math.max(0, snapshot.packetsSent - state.previousStats.packetsSent);
    const lost = Math.max(0, snapshot.packetsLost - state.previousStats.packetsLost);
    const loss = lost / Math.max(1, sent + lost);
    const rtt = remoteInbound?.roundTripTime ?? candidatePair?.currentRoundTripTime ?? 0;
    const available = candidatePair?.availableOutgoingBitrate ?? Number.POSITIVE_INFINITY;
    state.previousStats = snapshot;

    const alpha = state.networkEwma && available >= state.networkEwma.available ? .15 : .55;
    state.networkEwma = {
      loss: ewma(state.networkEwma?.loss, loss, alpha),
      rtt: ewma(state.networkEwma?.rtt, rtt, alpha),
      available: ewma(state.networkEwma?.available, available, alpha),
    };
    const cpuLimited = outbound.qualityLimitationReason === 'cpu'
      || (outbound.framesPerSecond && outbound.framesPerSecond < QUALITY_TIERS[state.qualityTier].maxFramerate * .7);
    const desiredTier = Math.max(classifyNetwork(
      state.networkEwma.loss, state.networkEwma.rtt, state.networkEwma.available,
    ), cpuLimited ? Math.min(2, state.qualityTier + 1) : 0);
    await considerTierChange(desiredTier);
  } catch (error) {
    console.debug('network sampling unavailable', error);
  }
}

function ewma(previous, current, alpha) {
  if (!Number.isFinite(current)) return previous ?? current;
  return previous == null || !Number.isFinite(previous) ? current : previous + alpha * (current - previous);
}

function classifyNetwork(loss, rtt, available) {
  if (loss >= .12 || rtt >= .8 || available < 2_200_000) return 3;
  if (loss >= .07 || rtt >= .5 || available < 4_000_000) return 2;
  if (loss >= .03 || rtt >= .3 || available < 6_500_000) return 1;
  return 0;
}

async function considerTierChange(desiredTier) {
  if (desiredTier > state.qualityTier) {
    state.badSamples += 1;
    state.goodSamples = 0;
    // Degrade after two bad samples (about four seconds), one tier at a time.
    if (state.badSamples >= 2) {
      await applyQualityTier(Math.min(state.qualityTier + 1, desiredTier));
      state.badSamples = 0;
    }
  } else if (desiredTier < state.qualityTier) {
    state.goodSamples += 1;
    state.badSamples = 0;
    // Require sustained recovery to avoid visibly oscillating quality.
    if (state.goodSamples >= 8) {
      await applyQualityTier(state.qualityTier - 1);
      state.goodSamples = 0;
    }
  } else {
    state.badSamples = 0;
    state.goodSamples = 0;
  }
}

async function applyQualityTier(tierIndex, pc = state.pc, notify = true) {
  const tier = QUALITY_TIERS[tierIndex];
  const sender = pc?.getSenders().find(item => item.track?.kind === 'video');
  if (!sender) return;
  const parameters = sender.getParameters();
  parameters.degradationPreference = 'maintain-resolution';
  let parametersApplied = false;
  if (parameters.encodings?.length) {
    parameters.encodings[0].maxBitrate = tier.maxBitrate;
    parameters.encodings[0].maxFramerate = tier.maxFramerate;
    parameters.encodings[0].scaleResolutionDownBy = tier.scale;
    parameters.encodings[0].scalabilityMode = 'L1T3';
    try {
      await sender.setParameters(parameters);
      parametersApplied = true;
    } catch (error) {
      // H.264/older Safari may reject explicit temporal SVC. Retry without it.
      delete parameters.encodings[0].scalabilityMode;
      try {
        await sender.setParameters(parameters);
        parametersApplied = true;
      } catch (fallbackError) { console.debug('sender tuning unsupported', error, fallbackError); }
    }
  }
  if (!parametersApplied) {
    // Safari-friendly fallback when encoding parameters are unavailable.
    try {
      await sender.track?.applyConstraints({
        width: { ideal: tier.width }, height: { ideal: tier.height }, frameRate: { ideal: tier.maxFramerate, max: tier.maxFramerate },
      });
    } catch (error) { console.debug('track constraints unsupported', error); }
  }
  const changed = state.qualityTier !== tierIndex;
  state.qualityTier = tierIndex;
  if (changed && notify) showToast(`${tier.name} · 质量优先自适应`);
}

async function requestWakeLock() {
  if (!state.active || !('wakeLock' in navigator)) return;
  try { state.wakeLock = await navigator.wakeLock.request('screen'); } catch { /* OS may deny in low power mode. */ }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.active) {
    requestWakeLock();
    els.localVideo.play().catch(() => {});
    els.remoteVideo.play().catch(() => showToast('轻触页面恢复对方声音'));
    if (!state.socket || state.socket.readyState === WebSocket.CLOSED) void connectSocket();
  }
});

window.addEventListener('online', () => {
  if (!state.active) return;
  void connectSocket();
  scheduleIceRestart(500);
});
window.addEventListener('offline', () => {
  if (state.active) setStatus('网络已断开', true);
});
document.addEventListener('pointerdown', () => {
  if (state.active && els.remoteVideo.srcObject) els.remoteVideo.play().catch(() => {});
}, { passive: true });

function stopMedia() {
  state.localStream?.getTracks().forEach(track => track.stop());
  state.localStream = null;
  els.localVideo.srcObject = null;
}

function updateLocalPreview() {
  const videoEnabled = state.localStream?.getVideoTracks().some(track => track.enabled);
  els.localVideo.hidden = !videoEnabled;
  els.localAvatar.hidden = Boolean(videoEnabled);
}

function sendMediaState() {
  sendSignal('media-state', {
    audio: state.localStream?.getAudioTracks().some(track => track.enabled) || false,
    video: state.localStream?.getVideoTracks().some(track => track.enabled) || false,
  });
}

function setPressed(button, pressed, text) {
  button.setAttribute('aria-pressed', String(pressed));
  button.lastElementChild.textContent = text;
}

function setStatus(text, waiting = false) {
  els.network.textContent = text;
  els.network.classList.toggle('waiting', waiting);
}

let toastTimer;
function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2600);
}

function humanError(error) {
  console.error(error);
  if (!window.isSecureContext && location.hostname !== 'localhost') return '浏览器要求通过 HTTPS 才能使用摄像头和麦克风';
  return error.message || '出现了意外错误，请稍后重试';
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
