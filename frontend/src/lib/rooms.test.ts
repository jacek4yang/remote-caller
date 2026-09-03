import { describe, expect, it, vi } from 'vitest';
import { RoomError, makeRoom, sanitizeRoom, validateRoom } from './rooms';

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
});
