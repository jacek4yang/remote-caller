import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { detectLocale, messages, type Locale, type MessageKey } from './messages';

const STORAGE_KEY = 'rc:locale';

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children, initialLocale }: { children: ReactNode; initialLocale?: Locale }) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    if (initialLocale) return initialLocale;
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'en-US' || stored === 'zh-CN') return stored;
    } catch {
      // localStorage unavailable; fall through to detection.
    }
    return detectLocale();
  });

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Ignore storage failures (private mode).
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale === 'zh-CN' ? 'zh-CN' : 'en';
    const meta = document.querySelector('meta[name="description"]');
    if (meta && meta.getAttribute('content')?.startsWith('Remote Caller')) {
      meta.setAttribute(
        'content',
        locale === 'zh-CN'
          ? '安全、清晰、点对点的私密音视频通话'
          : 'Secure, clear, peer-to-peer private audio and video calls',
      );
    }
  }, [locale]);

  const t = useCallback(
    (key: MessageKey, params?: Record<string, string | number>) => {
      let template: string = messages[locale][key];
      if (template === undefined) template = messages['en-US'][key] ?? key;
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (match, name: string) =>
        params[name] === undefined ? match : String(params[name]),
      );
    },
    [locale],
  );

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error('useI18n must be used inside <I18nProvider>');
  return context;
}
