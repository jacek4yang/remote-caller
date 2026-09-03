export class RoomError extends Error {
  readonly code: 'too-short' | 'invalid';

  constructor(code: 'too-short' | 'invalid') {
    super(code);
    this.name = 'RoomError';
    this.code = code;
  }
}

export function makeRoom(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function sanitizeRoom(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}

/** Validates + normalizes a room id, throwing a typed error the UI can translate. */
export function validateRoom(value: string): string {
  const room = sanitizeRoom(value);
  if (room.length < 6) throw new RoomError('too-short');
  return room;
}

/** Returns a non-empty normalized room when present, else ''. */
export function invitedRoomFromLocation(search = location.search): string {
  const raw = sanitizeRoom(new URLSearchParams(search).get('room') || '');
  if (raw.length < 6) return '';
  return raw;
}

export function roomUrl(room: string, host = location.host, path = location.pathname): string {
  const url = new URL(path, location.protocol === 'https:' ? 'https://' + host : 'http://' + host);
  url.searchParams.set('room', sanitizeRoom(room));
  return url.href;
}

export function replaceRoomUrl(room: string): void {
  const clean = sanitizeRoom(room);
  history.replaceState({}, '', clean ? roomUrl(clean) : location.pathname);
}

export function clearRoomUrl(): void {
  history.replaceState({}, '', location.pathname);
}

export async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const field = document.createElement('textarea');
  field.value = value;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.append(field);
  try {
    field.select();
    if (!document.execCommand('copy')) throw new Error('copy command failed');
  } finally {
    field.remove();
  }
}

export interface SharePayload {
  title: string;
  text: string;
}

export async function shareRoom(room: string, payload: SharePayload): Promise<'shared' | 'copied'> {
  const clean = validateRoom(room);
  const url = roomUrl(clean);
  if (navigator.share) {
    await navigator.share({ title: payload.title, text: payload.text, url });
    return 'shared';
  }
  await copyText(url);
  return 'copied';
}
