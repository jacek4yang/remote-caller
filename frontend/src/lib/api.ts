export interface LoginResponse {
  token: string;
  clientId: string;
  expiresAt: number;
  displayName: string;
  role: string;
}

export interface ClientConfig {
  iceServers: RTCIceServer[];
}

interface ErrorResponse {
  error?: string;
  message?: string;
}

export class ApiError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> | undefined),
    },
  });
  const data = await response.json().catch(() => ({})) as T & ErrorResponse;
  if (!response.ok) {
    const message = data.error === 'unauthorized' ? '认证失败或登录已过期'
      : data.error === 'room_full' ? '房间已满（当前版本支持两人通话）'
      : data.error === 'rate_limited' ? '请求过于频繁，请稍后再试'
      : data.error === 'capacity_reached' ? '服务正在保护资源，请稍后重试'
      : data.message || '服务请求失败 (' + response.status + ')';
    throw new ApiError(message, data.error || 'http_' + response.status);
  }
  return data;
}

export async function authenticate(username: string, password: string): Promise<LoginResponse & ClientConfig> {
  const session = await request<LoginResponse>('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  const config = await request<ClientConfig>('/api/config', {
    headers: { Authorization: 'Bearer ' + session.token },
  });
  return { ...session, ...config };
}

export function humanError(error: unknown): string {
  console.error(error);
  if (!window.isSecureContext && location.hostname !== 'localhost') {
    return '浏览器要求通过 HTTPS 才能使用摄像头和麦克风';
  }
  return error instanceof Error && error.message ? error.message : '出现了意外错误，请稍后重试';
}
