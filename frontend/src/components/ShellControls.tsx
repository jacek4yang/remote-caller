import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Globe, LogOut, Monitor, Moon, Sun } from 'lucide-react';
import { Avatar } from './ui/Avatar';
import { IconButton } from './ui/IconButton';
import { useI18n } from '../i18n/I18nProvider';
import { LOCALES, type Locale } from '../i18n/messages';
import { useTheme, type ThemeMode } from '../theme/ThemeProvider';

const THEME_ICON: Record<ThemeMode, typeof Sun> = { light: Sun, dark: Moon, system: Monitor };
const THEME_KEY: Record<ThemeMode, 'theme.light' | 'theme.dark' | 'theme.system'> = {
  light: 'theme.light',
  dark: 'theme.dark',
  system: 'theme.system',
};
const LOCALE_LABEL: Record<Locale, string> = { 'en-US': 'English', 'zh-CN': '简体中文' };

interface ShellControlsProps {
  displayName: string;
  onSignOut: () => void;
}

function useDismiss(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);
  return ref;
}

/** Theme + language + account controls shared by signed-in screens. */
export function ShellControls({ displayName, onSignOut }: ShellControlsProps) {
  const { t, locale, setLocale } = useI18n();
  const { mode, setMode } = useTheme();
  const [menu, setMenu] = useState<'none' | 'theme' | 'lang' | 'account'>('none');
  const containerRef = useDismiss(menu !== 'none', () => setMenu('none'));
  const ThemeIcon = THEME_ICON[mode];

  const toggle = (name: 'theme' | 'lang' | 'account') => {
    setMenu(current => (current === name ? 'none' : name));
  };

  return (
    <div className="topbar-actions" ref={containerRef}>
      <IconButton label={t(THEME_KEY[mode])} onClick={() => toggle('theme')}>
        <ThemeIcon size={17} />
      </IconButton>
      {menu === 'theme' ? (
        <div className="popover" role="menu" aria-label={t('theme.label')}>
          {(['light', 'dark', 'system'] as ThemeMode[]).map(item => {
            const Icon = THEME_ICON[item];
            return (
              <button
                key={item}
                type="button"
                className="menu-item"
                role="menuitemradio"
                aria-checked={mode === item}
                onClick={() => { setMode(item); setMenu('none'); }}
              >
                <Icon size={16} aria-hidden="true" />
                <span className="menu-label">{t(THEME_KEY[item])}</span>
                {mode === item ? <Check size={15} aria-hidden="true" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}

      <IconButton label={t('lang.label')} onClick={() => toggle('lang')}>
        <Globe size={17} />
      </IconButton>
      {menu === 'lang' ? (
        <div className="popover" role="menu" aria-label={t('lang.label')}>
          {LOCALES.map(item => (
            <button
              key={item}
              type="button"
              className="menu-item"
              role="menuitemradio"
              aria-checked={locale === item}
              onClick={() => { setLocale(item); setMenu('none'); }}
            >
              <span className="menu-label">{LOCALE_LABEL[item]}</span>
              {locale === item ? <Check size={15} aria-hidden="true" /> : null}
            </button>
          ))}
        </div>
      ) : null}

      <div className="topbar-user">
        <button
          type="button"
          className="account-chip"
          aria-haspopup="menu"
          aria-expanded={menu === 'account'}
          aria-label={t('home.account', { name: displayName })}
          onClick={() => toggle('account')}
        >
          <Avatar name={displayName} size="sm" />
          <span className="user-name">{displayName}</span>
          <ChevronDown size={14} className="account-chevron" aria-hidden="true" />
        </button>
        {menu === 'account' ? (
          <div className="popover" role="menu" aria-label={t('home.account', { name: displayName })}>
            <div className="menu-item account-header" aria-hidden="true">
              <Avatar name={displayName} size="sm" />
              <span className="menu-label menu-strong">{displayName}</span>
            </div>
            <button
              type="button"
              className="menu-item"
              data-danger="true"
              role="menuitem"
              onClick={() => { onSignOut(); setMenu('none'); }}
            >
              <LogOut size={16} aria-hidden="true" />
              <span className="menu-label">{t('home.signOut')}</span>
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
