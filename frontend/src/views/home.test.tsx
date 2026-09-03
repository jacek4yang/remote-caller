// @vitest-environment jsdom
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '../i18n/I18nProvider';
import { ThemeProvider } from '../theme/ThemeProvider';
import { HomeView } from './HomeView';

function HomeHarness({
  displayName = 'Alice',
  initialRoom = '',
  onStartVideo = vi.fn(),
  onStartVoice = vi.fn(),
  onJoin = vi.fn(),
  onSignOut = vi.fn(),
}: Partial<Parameters<typeof HomeView>[0]> & { initialRoom?: string } = {}) {
  const [joinRoom, setJoinRoom] = useState(initialRoom);
  return (
    <ThemeProvider>
      <I18nProvider initialLocale="en-US">
        <HomeView
          displayName={displayName}
          busy={false}
          error={null}
          joinRoom={joinRoom}
          onJoinRoomChange={setJoinRoom}
          onStartVideo={onStartVideo}
          onStartVoice={onStartVoice}
          onJoin={onJoin}
          onSignOut={onSignOut}
        />
      </I18nProvider>
    </ThemeProvider>
  );
}

describe('HomeView', () => {
  it('offers video and voice call starts and routes to join on submit', async () => {
    const user = userEvent.setup();
    const onStartVideo = vi.fn();
    const onStartVoice = vi.fn();
    const onJoin = vi.fn();
    render(
      <HomeHarness initialRoom="room-123" onStartVideo={onStartVideo} onStartVoice={onStartVoice} onJoin={onJoin} />,
    );

    await user.click(screen.getByRole('button', { name: /video call/i }));
    expect(onStartVideo).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: /voice call/i }));
    expect(onStartVoice).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Join' }));
    expect(onJoin).toHaveBeenCalledTimes(1);
  });

  it('rejects short invite codes without calling join', async () => {
    const user = userEvent.setup();
    const onJoin = vi.fn();
    render(<HomeHarness onJoin={onJoin} />);

    const input = screen.getByLabelText('Invite code');
    await user.type(input, 'tiny');
    await user.click(screen.getByRole('button', { name: 'Join' }));
    expect(onJoin).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('at least 6 characters');
  });

  it('clears the code hint as the user types', async () => {
    const user = userEvent.setup();
    const onJoin = vi.fn();
    render(<HomeHarness onJoin={onJoin} />);

    const input = screen.getByLabelText('Invite code');
    await user.type(input, 'ab');
    await user.click(screen.getByRole('button', { name: 'Join' }));
    expect(screen.getByRole('alert').textContent).toContain('at least 6 characters');

    await user.type(input, 'cdef12');
    expect(screen.getByRole('alert').textContent).not.toContain('at least 6 characters');
  });

  it('signs out from the account menu', async () => {
    const user = userEvent.setup();
    const onSignOut = vi.fn();
    render(<HomeHarness displayName="Alice" onSignOut={onSignOut} />);
    await user.click(screen.getByRole('button', { name: /Signed in as Alice/i }));
    await user.click(screen.getByRole('menuitem', { name: /sign out/i }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
});
