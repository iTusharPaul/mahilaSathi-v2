import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type ThemePreference = 'system' | 'light' | 'dark';

interface ThemeState {
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
}

/** Storage can be unavailable (private mode, blocked site data); the app must still work. */
const safeStorage = createJSONStorage(() => {
  try {
    const probe = '__ms_probe__';
    window.localStorage.setItem(probe, probe);
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    const memory = new Map<string, string>();
    return {
      getItem: (k: string) => memory.get(k) ?? null,
      setItem: (k: string, v: string) => void memory.set(k, v),
      removeItem: (k: string) => void memory.delete(k),
    };
  }
});

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      preference: 'system',
      setPreference: (preference) => set({ preference }),
    }),
    { name: 'ms-theme', storage: safeStorage },
  ),
);

const darkQuery = () => window.matchMedia('(prefers-color-scheme: dark)');

export function resolveTheme(preference: ThemePreference): 'light' | 'dark' {
  if (preference === 'system') return darkQuery().matches ? 'dark' : 'light';
  return preference;
}

/** Applies the resolved theme to <html> and keeps following the OS when preference is 'system'. */
export function bindThemeToDocument(): () => void {
  const apply = () => {
    document.documentElement.dataset.theme = resolveTheme(useThemeStore.getState().preference);
  };
  apply();
  const unsubscribe = useThemeStore.subscribe(apply);
  const mq = darkQuery();
  mq.addEventListener('change', apply);
  return () => {
    unsubscribe();
    mq.removeEventListener('change', apply);
  };
}
