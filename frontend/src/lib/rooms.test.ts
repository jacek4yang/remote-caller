import { describe, expect, it, vi } from 'vitest';
import { makeRoom, sanitizeRoom, validateRoom } from './rooms';

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

  it('rejects undersized rooms', () => {
    expect(() => validateRoom('tiny')).toThrow('房间号至少需要 6 个字符');
    expect(validateRoom('team-123')).toBe('team-123');
  });
});
