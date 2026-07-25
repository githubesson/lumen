import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Shell, onAppearanceChange } from '../native/shell';

export type ColorScheme = 'light' | 'dark';
export type ThemeMode = 'light' | 'dark' | 'system';

/**
 * Palette shared with the iOS client (mobile/theme/theme.tsx) so both clients
 * read as the same product. Values mirror the iOS HIG neutrals; macOS-specific
 * surfaces (sidebar, dock) sit on NSVisualEffectView materials instead of these
 * flat colors, and use `overlay*` for controls drawn on top of them.
 */
export interface ThemePalette {
  bg: string;
  bgElev1: string;
  bgElev2: string;
  fg: string;
  fgSubtle: string;
  fgMuted: string;
  separator: string;
  accent: string;
  /** Foreground (text/icon/spinner) on top of `accent`. */
  onAccent: string;
  /** Destructive / error (systemRed, per scheme). */
  danger: string;
  /** Success / positive (systemGreen, per scheme). */
  success: string;
  /**
   * Translucent overlays for controls floating on an immersive surface (the
   * Now Playing scrubber, volume bar, dock). White-based in dark, ink-based in
   * light, so they stay visible over vibrancy materials in both schemes.
   */
  overlayStrong: string;
  overlayMuted: string;
  overlayGrabber: string;
  /** Row/control hover tint — desktop-only addition to the shared palette. */
  hover: string;
  /** Selected sidebar row / active control fill. */
  selected: string;
}

export interface ThemeTokens {
  scheme: ColorScheme;
  color: ThemePalette;
  radius: { sm: number; md: number; lg: number };
  space: { xs: number; sm: number; md: number; lg: number; xl: number };
  row: { height: number };
}

const LIGHT: ThemePalette = {
  bg: '#FFFFFF',
  bgElev1: '#F7F7F8',
  bgElev2: '#ECECEE',
  fg: '#0A0A0A',
  fgSubtle: '#3C3C43',
  fgMuted: '#8E8E93',
  separator: '#D1D1D6',
  accent: '#0A84FF',
  onAccent: '#FFFFFF',
  danger: '#FF3B30',
  success: '#34C759',
  overlayStrong: 'rgba(0,0,0,0.55)',
  overlayMuted: 'rgba(0,0,0,0.12)',
  overlayGrabber: 'rgba(0,0,0,0.28)',
  hover: 'rgba(0,0,0,0.06)',
  selected: 'rgba(0,0,0,0.10)',
};

const DARK: ThemePalette = {
  bg: '#000000',
  bgElev1: '#1C1C1E',
  bgElev2: '#2C2C2E',
  fg: '#FFFFFF',
  fgSubtle: '#EBEBF5',
  fgMuted: '#8E8E93',
  separator: '#38383A',
  accent: '#0A84FF',
  onAccent: '#FFFFFF',
  danger: '#FF453A',
  success: '#30D158',
  overlayStrong: 'rgba(255,255,255,0.85)',
  overlayMuted: 'rgba(255,255,255,0.18)',
  overlayGrabber: 'rgba(255,255,255,0.45)',
  hover: 'rgba(255,255,255,0.08)',
  selected: 'rgba(255,255,255,0.14)',
};

function buildTokens(scheme: ColorScheme): ThemeTokens {
  return {
    scheme,
    color: scheme === 'dark' ? DARK : LIGHT,
    radius: { sm: 6, md: 10, lg: 16 },
    space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 },
    row: { height: 56 },
  };
}

/**
 * Push the resolved scheme down to AppKit so NSVisualEffectView materials and
 * native menus follow an explicit override rather than the system appearance.
 * react-native-macos does not guarantee `setColorScheme`, so this is optional:
 * when it is missing the JS tokens still switch, only the native materials
 * stay on the system appearance.
 */
function applyNativeAppearance(mode: ThemeMode) {
  // AppKit chrome — toolbar, sidebar, menus, native controls — follows
  // NSApp.appearance, not React state. Without this the window's own
  // furniture stays on the system appearance while the app's content
  // follows the user's choice.
  Shell.setAppearance(mode);
}

interface ThemeContextValue {
  tokens: ThemeTokens;
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
}

const Ctx = createContext<ThemeContextValue | null>(null);
const MODE_KEY = 'mlib-theme-mode';

/**
 * Whether the running native shell reports the window's appearance.
 *
 * Read once, at module scope: a JS bundle is reloaded far more often than the
 * app is rebuilt, so a session can easily end up running new JS against an
 * older binary. There, subscribing to an event that binary does not declare
 * logs a redbox, so the capability is checked rather than assumed.
 */
const NATIVE_APPEARANCE =
  Shell.initialScheme === 'dark' || Shell.initialScheme === 'light';

/**
 * The system appearance, reported by AppKit rather than by React Native.
 *
 * `useColorScheme()` is unreliable on this platform: `RCTAppearance` resolves
 * the scheme once, early enough that the app has not settled on the system
 * appearance yet, and then answers "light" for the rest of the process — which
 * put the whole React-drawn pane in the light palette under a dark AppKit
 * sidebar. `LMShellModule` reports the real appearance and every change to it.
 * Its answer is preferred, and RN's own is the fallback for an older binary.
 */
function useSystemScheme(): ColorScheme {
  const fallback = useColorScheme() === 'dark' ? 'dark' : 'light';
  const [scheme, setScheme] = useState<ColorScheme | null>(() =>
    NATIVE_APPEARANCE ? (Shell.initialScheme as ColorScheme) : null,
  );

  useEffect(() => {
    if (!NATIVE_APPEARANCE) return;
    const subscription = onAppearanceChange(setScheme);
    return () => subscription.remove();
  }, []);

  return scheme ?? fallback;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const system = useSystemScheme();
  // Do not mount children containing native vibrancy views until the persisted
  // override is known: mounting once with the system scheme and correcting a
  // frame later leaves AppKit-owned materials in the initial appearance.
  const [mode, setModeState] = useState<ThemeMode | null>(null);

  useEffect(() => {
    let cancelled = false;
    void AsyncStorage.getItem(MODE_KEY)
      .then(v => {
        if (cancelled) return;
        const restored: ThemeMode =
          v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
        applyNativeAppearance(restored);
        setModeState(restored);
      })
      .catch(() => {
        if (cancelled) return;
        applyNativeAppearance('system');
        setModeState('system');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setMode = useCallback((m: ThemeMode) => {
    applyNativeAppearance(m);
    setModeState(m);
    void AsyncStorage.setItem(MODE_KEY, m);
  }, []);

  const resolvedMode = mode ?? 'system';
  const scheme: ColorScheme = resolvedMode === 'system' ? system : resolvedMode;
  const tokens = useMemo(() => buildTokens(scheme), [scheme]);

  const value = useMemo<ThemeContextValue>(
    () => ({ tokens, mode: resolvedMode, setMode }),
    [tokens, resolvedMode, setMode],
  );

  if (mode === null) return null;

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeTokens {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useTheme requires ThemeProvider');
  return ctx.tokens;
}

export function useThemeMode(): {
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
} {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useThemeMode requires ThemeProvider');
  return { mode: ctx.mode, setMode: ctx.setMode };
}
