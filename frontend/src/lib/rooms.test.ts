import { describe, expect, it, vi } from 'vitest';
import { RoomError, makeRoom, resolveStartRoom, sanitizeRoom, validateRoom } from './rooms';

describe('room helpers', () => {
  it('generates a high-entropy URL-safe room code', () => {
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => bytes.fill(0xab) });
    expect(makeRoom()).toBe('abababababababab');
    vi.unstubAllGlobals();
  });

  it('sanitizes and bounds invitation input', () => {
    expect(sanitizeRoom(' team room!_123 ')).toBe('teamroom_123');
    expect(sanitizeRoom('a'.repeat(80))).toHaveLength(64);
  });

  it('rejects undersized rooms with a typed, translatable error', () => {
    expect(() => validateRoom('tiny')).toThrow(RoomError);
    expect(() => validateRoom('tiny')).toThrowError(expect.objectContaining({ code: 'too-short' }));
    expect(validateRoom('team-123')).toBe('team-123');
  });

  it('mints a fresh room for a creator even when no code was entered', () => {
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => bytes.fill(0x42) });
    expect(resolveStartRoom('create', '')).toBe('4242424242424242');
    vi.unstubAllGlobals();
  });

  it('still validates the code for a joiner', () => {
    expect(resolveStartRoom('join', 'room-123')).toBe('room-123');
    expect(() => resolveStartRoom('join', '')).toThrow(RoomError);
    expect(() => resolveStartRoom('join', 'tiny')).toThrow(RoomError);
  });
});
