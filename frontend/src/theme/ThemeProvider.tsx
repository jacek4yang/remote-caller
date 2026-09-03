import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'rc:theme';
const MEDIA = '(prefers-color-scheme: light)';

interface ThemeContextValue {
  mode: ThemeMode;
  resolved: 'light' | 'dark';
  setMode: (mode: ThemeMode) => void;
  cycleMode: () => ThemeMode;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    // localStorage unavailable.
  }
  // First visit: respect the operating-system preference.
  return 'system';
}

function systemTheme(): 'light' | 'dark' {
  return window.matchMedia(MEDIA).matches ? 'light' : 'dark';
}

function apply(resolved: 'light' | 'dark'): void {
  const root = document.documentElement;
  root.dataset.theme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'dark' ? '#070a12' : '#f4f6f9');
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(readStoredMode);
  const [system, setSystem] = useState<'light' | 'dark'>(() =>
    typeof window === 'undefined' ? 'dark' : systemTheme(),
  );

  const resolved: 'light' | 'dark' = mode === 'system' ? system : mode;

  useEffect(() => {
    apply(resolved);
  }, [resolved]);

  useEffect(() => {
    if (mode !== 'system') return;
    const query = window.matchMedia(MEDIA);
    const onChange = (event: MediaQueryListEvent) => setSystem(event.matches ? 'light' : 'dark');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [mode]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Ignore storage failures.
    }
  }, []);

  const cycleMode = useCallback((): ThemeMode => {
    const order: ThemeMode[] = ['light', 'dark', 'system'];
    const index = order.indexOf(mode);
    const next = order[(index + 1) % order.length];
    setMode(next);
    return next;
  }, [mode, setMode]);

  const value = useMemo(
    () => ({ mode, resolved, setMode, cycleMode }),
    [mode, resolved, setMode, cycleMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside <ThemeProvider>');
  return context;
}
