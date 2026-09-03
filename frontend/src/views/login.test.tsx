// @vitest-environment jsdom
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '../i18n/I18nProvider';
import { LoginView } from './LoginView';

function LoginHarness({
  initialUsername = '',
  initialPassword = '',
  busy = false,
  error = null,
  sessionExpired = false,
  hasPendingInvite = false,
  onSubmit = vi.fn((event: { preventDefault(): void }) => event.preventDefault()),
}: Partial<Parameters<typeof LoginView>[0]> & { initialUsername?: string; initialPassword?: string } = {}) {
  const [username, setUsername] = useState(initialUsername);
  const [password, setPassword] = useState(initialPassword);
  return (
    <I18nProvider initialLocale="en-US">
      <LoginView
        username={username}
        password={password}
        busy={busy}
        error={error}
        sessionExpired={sessionExpired}
        hasPendingInvite={hasPendingInvite}
        onUsernameChange={setUsername}
        onPasswordChange={setPassword}
        onSubmit={onSubmit}
      />
    </I18nProvider>
  );
}

describe('LoginView', () => {
  it('keeps password fields private and offers a reveal toggle', async () => {
    const user = userEvent.setup();
    render(<LoginHarness />);
    const password = screen.getByLabelText('Password') as HTMLInputElement;
    expect(password).toHaveAttribute('type', 'password');
    expect(password).toHaveAttribute('autoComplete', 'current-password');
    expect(screen.getByLabelText('Username')).toHaveAttribute('autoComplete', 'username');

    await user.type(password, 's3cret');
    expect(password).toHaveValue('s3cret');

    await user.click(screen.getByRole('button', { name: 'Show password' }));
    expect(password).toHaveAttribute('type', 'text');
    await user.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(password).toHaveAttribute('type', 'password');
  });

  it('submits with Enter when valid and disables fields while busy', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((event: { preventDefault(): void }) => event.preventDefault());
    const { rerender } = render(
      <LoginHarness initialUsername="alice" initialPassword="s3cret" onSubmit={onSubmit} />,
    );
    await user.type(screen.getByLabelText('Password'), '{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);

    rerender(<LoginHarness initialUsername="alice" initialPassword="s3cret" busy onSubmit={onSubmit} />);
    expect(screen.getByLabelText('Username')).toBeDisabled();
    expect(screen.getByLabelText('Password')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled();
  });

  it('announces a localized error without layout-breaking markup', () => {
    render(<LoginHarness error="login.error.rateLimited" />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Too many attempts');
  });

  it('explains the session-expired state', () => {
    render(<LoginHarness sessionExpired hasPendingInvite />);
    expect(screen.getByRole('heading', { name: 'Your session expired' })).toBeInTheDocument();
    expect(screen.getAllByRole('alert').some(node => node.textContent?.includes('Sign in again to continue'))).toBe(true);
  });

  it('renders Chinese copy when the provider locale is zh-CN', () => {
    render(
      <I18nProvider initialLocale="zh-CN">
        <LoginView
          username="" password="" busy={false} error={null}
          sessionExpired={false} hasPendingInvite={false}
          onUsernameChange={vi.fn()} onPasswordChange={vi.fn()} onSubmit={vi.fn()}
        />
      </I18nProvider>,
    );
    expect(screen.getByRole('button', { name: '登录' })).toBeInTheDocument();
    expect(screen.getByLabelText('账号')).toBeInTheDocument();
  });
});
