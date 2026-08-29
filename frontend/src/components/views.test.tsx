import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DashboardView } from './DashboardView';
import { LoginView } from './LoginView';

describe('authentication and room views', () => {
  it('keeps room actions out of the login screen', () => {
    const html = renderToStaticMarkup(
      <LoginView
        username="caller-one"
        password=""
        busy={false}
        error=""
        onUsernameChange={vi.fn()}
        onPasswordChange={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(html).toContain('id="username"');
    expect(html).toContain('id="password"');
    expect(html).not.toContain('id="room-id"');
    expect(html).not.toContain('生成房间号');
  });

  it('shows create and join actions only in the signed-in dashboard', () => {
    const html = renderToStaticMarkup(
      <DashboardView
        displayName="Caller One"
        invitedRoom="invite-123"
        draftRoom=""
        joinRoom="invite-123"
        mode="video"
        busy={false}
        error=""
        onModeChange={vi.fn()}
        onJoinRoomChange={vi.fn()}
        onCreateRoom={vi.fn()}
        onCopyRoom={vi.fn()}
        onShareRoom={vi.fn()}
        onEnterDraftRoom={vi.fn()}
        onJoin={vi.fn()}
        onLogout={vi.fn()}
      />,
    );

    expect(html).toContain('通话工作台');
    expect(html).toContain('生成房间号');
    expect(html).toContain('id="room-id"');
    expect(html).toContain('value="invite-123"');
    expect(html).not.toContain('id="password"');
  });
});
