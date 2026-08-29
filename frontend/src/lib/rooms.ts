export function makeRoom(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function sanitizeRoom(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}

export function validateRoom(value: string): string {
  const room = sanitizeRoom(value);
  if (room.length < 6) throw new Error('房间号至少需要 6 个字符');
  return room;
}

export function invitedRoomFromLocation(search = location.search): string {
  return sanitizeRoom(new URLSearchParams(search).get('room') || '');
}

export function roomUrl(room: string): string {
  const url = new URL(location.pathname, location.origin);
  url.searchParams.set('room', sanitizeRoom(room));
  return url.href;
}

export function replaceRoomUrl(room: string): void {
  const clean = sanitizeRoom(room);
  history.replaceState({}, '', clean ? roomUrl(clean) : location.pathname);
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

export async function shareRoom(room: string): Promise<'shared' | 'copied'> {
  const clean = validateRoom(room);
  const url = roomUrl(clean);
  if (navigator.share) {
    await navigator.share({ title: '加入我的通话', text: '房间号：' + clean, url });
    return 'shared';
  }
  await copyText(url);
  return 'copied';
}
