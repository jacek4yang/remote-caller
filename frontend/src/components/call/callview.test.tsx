// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { initialCallSnapshot, type CallSnapshot } from '../../call/CallSession';
import { I18nProvider } from '../../i18n/I18nProvider';
import { CallView } from './CallView';
import type { CallHandlers } from './types';

function active(patch: Partial<CallSnapshot>): CallSnapshot {
  return { ...initialCallSnapshot(), active: true, room: 'room-123456', ...patch };
}

function makeHandlers(): CallHandlers {
  return {
    onToggleMicrophone: vi.fn(),
    onToggleCamera: vi.fn(),
    onSwitchCamera: vi.fn(),
    onSwitchVideoInput: vi.fn(),
    onSwitchAudioInput: vi.fn(),
    onLeave: vi.fn(),
    onCopyInvite: vi.fn(),
    onNativeShare: vi.fn(),
    onToast: vi.fn(),
    getDiagnostics: vi.fn(() => null),
  };
}

function renderCall(snapshot: CallSnapshot, handlers: CallHandlers, overrides: { isCreator?: boolean; shareSupported?: boolean } = {}) {
  render(
    <I18nProvider initialLocale="en-US">
      <CallView
        snapshot={snapshot}
        displayName="Alice"
        isCreator={overrides.isCreator ?? false}
        shareSupported={overrides.shareSupported ?? false}
        handlers={handlers}
      />
    </I18nProvider>,
  );
  return { handlers };
}

describe('CallView', () => {
  it('shows the waiting state and offers the creator an invite', async () => {
    const user = userEvent.setup();
    const handlers = makeHandlers();
    renderCall(active({ wsPhase: 'open' }), handlers, { isCreator: true });

    expect(await screen.findByRole('heading', { name: 'Waiting for the other person' })).toBeInTheDocument();
    const card = screen.getByRole('region', { name: 'Invite to this call' });
    await user.click(within(card).getByRole('button', { name: /copy invite link/i }));
    expect(handlers.onCopyInvite).toHaveBeenCalledTimes(1);
  });

  it('hides the invite card from a joiner who is waiting', () => {
    renderCall(active({ wsPhase: 'open' }), makeHandlers(), { isCreator: false });
    expect(screen.queryByRole('region', { name: 'Invite to this call' })).not.toBeInTheDocument();
  });

  it('labels call controls from snapshot state and toggles fire handlers', async () => {
    const user = userEvent.setup();
    const handlers = makeHandlers();
    const snapshot = active({
      wsPhase: 'open',
      peerPresent: true,
      peerName: 'Bob',
      pcPhase: 'connected',
      localMuted: false,
      localVideoEnabled: true,
      connectedAt: Date.now() - 30_000,
    });
    renderCall(snapshot, handlers);

    expect(screen.getAllByText('Bob').length).toBeGreaterThan(0);
    expect(screen.getByText('Connected')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Mute microphone' }));
    expect(handlers.onToggleMicrophone).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Turn camera off' }));
    expect(handlers.onToggleCamera).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'End call' }));
    expect(handlers.onLeave).toHaveBeenCalledTimes(1);
  });

  it('renders reconnecting language without raw engineering strings', () => {
    renderCall(active({ peerPresent: true, wsPhase: 'open', pcPhase: 'reconnecting' }), makeHandlers());
    expect(screen.getAllByText('Connection unstable — restoring…').length).toBeGreaterThan(0);
    expect(screen.queryByText(/connectionState/i)).not.toBeInTheDocument();
  });

  it('reflects a muted remote participant when their video is not visible', () => {
    const snapshot = active({
      peerPresent: true,
      peerName: 'Bob',
      pcPhase: 'connected',
      wsPhase: 'open',
      remoteMuted: true,
    });
    // Without a remote stream the avatar stage is shown; the mute chip must exist.
    renderCall(snapshot, makeHandlers());
    expect(screen.getAllByText('Muted').length).toBeGreaterThan(0);
  });
});
