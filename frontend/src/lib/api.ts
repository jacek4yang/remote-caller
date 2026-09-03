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

export type ErrorCode =
  | 'unauthorized'
  | 'room_full'
  | 'rate_limited'
  | 'capacity_reached'
  | (string & {});

interface ErrorResponse {
  error?: ErrorCode;
  message?: string;
}

export class ApiError extends Error {
  readonly code: ErrorCode;

  constructor(message: string, code: ErrorCode) {
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
    throw new ApiError(data.message || 'request failed (' + response.status + ')', data.error || ('http_' + response.status));
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
