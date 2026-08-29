import { describe, expect, it } from 'vitest';
import { candidateMatchesRemoteDescription, tuneOpus } from './CallSession';

describe('call negotiation helpers', () => {
  it('rejects stale ICE candidates from a previous remote description', () => {
    const peer = {
      remoteDescription: {
        type: 'offer',
        sdp: 'v=0\r\na=ice-ufrag:current-generation\r\n',
      } as RTCSessionDescription,
    };

    expect(candidateMatchesRemoteDescription(peer, { usernameFragment: 'current-generation' })).toBe(true);
    expect(candidateMatchesRemoteDescription(peer, { usernameFragment: 'stale-generation' })).toBe(false);
  });

  it('adds required Opus quality parameters without removing existing ones', () => {
    const result = tuneOpus({
      type: 'offer',
      sdp: 'v=0\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 foo=bar;minptime=3\r\n',
    });

    expect(result.sdp).toContain('foo=bar');
    expect(result.sdp).toContain('minptime=10');
    expect(result.sdp).toContain('useinbandfec=1');
    expect(result.sdp).toContain('maxaveragebitrate=96000');
  });
});
