/* Pure mapping from engine snapshot flags to a single user-facing call
   status. Kept free of React so it can be unit tested cheaply. */

import type { MessageKey } from '../i18n/messages';
import type { CallSnapshot } from './CallSession';

export type CallStatusKind =
  | 'connecting'
  | 'waiting'
  | 'negotiating'
  | 'connected'
  | 'reconnecting'
  | 'offline';

export interface CallStatus {
  kind: CallStatusKind;
  labelKey: MessageKey;
}

export function deriveCallStatus(snapshot: Pick<
  CallSnapshot,
  'active' | 'offline' | 'peerPresent' | 'wsPhase' | 'pcPhase'
>): CallStatus | null {
  if (!snapshot.active) return null;

  if (snapshot.offline) {
    return { kind: 'offline', labelKey: 'call.offline' };
  }

  if (!snapshot.peerPresent) {
    switch (snapshot.wsPhase) {
      case 'opening':
        return { kind: 'connecting', labelKey: 'call.connecting' };
      case 'reconnecting':
      case 'idle':
        return { kind: 'reconnecting', labelKey: 'call.reconnecting' };
      default:
        return { kind: 'waiting', labelKey: 'call.waitingShort' };
    }
  }

  switch (snapshot.pcPhase) {
    case 'connected':
      return { kind: 'connected', labelKey: 'call.connected' };
    case 'reconnecting':
      return { kind: 'reconnecting', labelKey: 'call.reconnectingMedia' };
    case 'connecting':
    case 'none':
    default:
      return snapshot.wsPhase === 'reconnecting' || snapshot.wsPhase === 'opening'
        ? { kind: 'reconnecting', labelKey: 'call.reconnecting' }
        : { kind: 'negotiating', labelKey: 'call.negotiating' };
  }
}
