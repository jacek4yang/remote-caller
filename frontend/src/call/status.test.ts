import { describe, expect, it } from 'vitest';
import { deriveCallStatus } from './status';
import { initialCallSnapshot, type CallSnapshot } from './CallSession';

function snapshot(patch: Partial<CallSnapshot>): CallSnapshot {
  return { ...initialCallSnapshot(), active: true, ...patch };
}

describe('deriveCallStatus', () => {
  it('returns null when the session is inactive', () => {
    expect(deriveCallStatus(initialCallSnapshot())).toBeNull();
  });

  it('shows connecting while the socket opens before a peer joins', () => {
    expect(deriveCallStatus(snapshot({ wsPhase: 'opening' }))).toEqual({
      kind: 'connecting',
      labelKey: 'call.connecting',
    });
  });

  it('shows waiting once signaling is open without a peer', () => {
    expect(deriveCallStatus(snapshot({ wsPhase: 'open' }))).toEqual({
      kind: 'waiting',
      labelKey: 'call.waitingShort',
    });
  });

  it('shows reconnecting when the socket drops while waiting', () => {
    expect(deriveCallStatus(snapshot({ wsPhase: 'reconnecting' }))).toMatchObject({ kind: 'reconnecting' });
  });

  it('shows negotiating while the peer connection is being established', () => {
    expect(deriveCallStatus(snapshot({ peerPresent: true, wsPhase: 'open', pcPhase: 'connecting' })))
      .toEqual({ kind: 'negotiating', labelKey: 'call.negotiating' });
  });

  it('reports connected when media is up even if the socket flaps', () => {
    expect(deriveCallStatus(snapshot({ peerPresent: true, wsPhase: 'reconnecting', pcPhase: 'connected' })))
      .toEqual({ kind: 'connected', labelKey: 'call.connected' });
  });

  it('reports reconnecting media when the peer connection drops', () => {
    expect(deriveCallStatus(snapshot({ peerPresent: true, wsPhase: 'open', pcPhase: 'reconnecting' })))
      .toEqual({ kind: 'reconnecting', labelKey: 'call.reconnectingMedia' });
  });

  it('prioritizes the offline state', () => {
    expect(deriveCallStatus(snapshot({ offline: true, peerPresent: true, pcPhase: 'connected' })))
      .toEqual({ kind: 'offline', labelKey: 'call.offline' });
  });
});
