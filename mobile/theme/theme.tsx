import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useColorScheme } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

export type ColorScheme = "light" | "dark";
export type ThemeMode = "light" | "dark" | "system";

/**
 * Small palette per the `building-native-ui` skill — inline/StyleSheet values
 * that mirror iOS HIG neutrals. Consumers prefer `PlatformColor` where a true
 * iOS system color is wanted; the palette here covers app-specific surfaces
 * (separators with custom opacity, accent color, row height) that need to be
 * consistent between themes.
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
  /** Destructive / error (iOS systemRed, per scheme). */
  danger: string;
  /** Success / positive (iOS systemGreen, per scheme). */
  success: string;
  /**
   * Translucent overlays for controls floating on an immersive surface
   * (the Now Playing scrubber, volume bar, sheet grabber). White-based in
   * dark, ink-based in light, so they stay visible in both schemes instead of
   * the old hardcoded white that vanished on a light background.
   */
  overlayStrong: string;
  overlayMuted: string;
  overlayGrabber: string;
}

export interface ThemeTokens {
  scheme: ColorScheme;
  color: ThemePalette;
  radius: { sm: number; md: number; lg: number };
  space: { xs: number; sm: number; md: number; lg: number; xl: number };
  row: { height: number };
}

const LIGHT: ThemePalette = {
  bg: "#FFFFFF",
  bgElev1: "#F7F7F8",
  bgElev2: "#ECECEE",
  fg: "#0A0A0A",
  fgSubtle: "#3C3C43",
  fgMuted: "#8E8E93",
  separator: "#D1D1D6",
  accent: "#0A84FF",
  onAccent: "#FFFFFF",
  danger: "#FF3B30",
  success: "#34C759",
  overlayStrong: "rgba(0,0,0,0.55)",
  overlayMuted: "rgba(0,0,0,0.12)",
  overlayGrabber: "rgba(0,0,0,0.28)",
};

const DARK: ThemePalette = {
  bg: "#000000",
  bgElev1: "#1C1C1E",
  bgElev2: "#2C2C2E",
  fg: "#FFFFFF",
  fgSubtle: "#EBEBF5",
  fgMuted: "#8E8E93",
  separator: "#38383A",
  accent: "#0A84FF",
  onAccent: "#FFFFFF",
  danger: "#FF453A",
  success: "#30D158",
  overlayStrong: "rgba(255,255,255,0.85)",
  overlayMuted: "rgba(255,255,255,0.18)",
  overlayGrabber: "rgba(255,255,255,0.45)",
};

function buildTokens(scheme: ColorScheme): ThemeTokens {
  return {
    scheme,
    color: scheme === "dark" ? DARK : LIGHT,
    radius: { sm: 6, md: 10, lg: 16 },
    space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 },
    row: { height: 56 },
  };
}

interface ThemeContextValue {
  tokens: ThemeTokens;
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
}

const Ctx = createContext<ThemeContextValue | null>(null);
const MODE_KEY = "mlib-theme-mode";

export function ThemeProvider({ children }: { children: ReactNode }) {
  // SDK 55 widened `useColorScheme`'s return to include "unspecified". For our
  // theme we treat that (and null) as light.
  const systemRaw = useColorScheme();
  const system: ColorScheme = systemRaw === "dark" ? "dark" : "light";
  const [mode, setModeState] = useState<ThemeMode>("system");

  // Restore persisted mode.
  useEffect(() => {
    let cancelled = false;
    void AsyncStorage.getItem(MODE_KEY).then((v) => {
      if (cancelled) return;
      if (v === "light" || v === "dark" || v === "system") setModeState(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m);
    void AsyncStorage.setItem(MODE_KEY, m);
  }, []);

  const scheme: ColorScheme = mode === "system" ? system : mode;
  const tokens = useMemo(() => buildTokens(scheme), [scheme]);

  const value = useMemo<ThemeContextValue>(
    () => ({ tokens, mode, setMode }),
    [tokens, mode, setMode],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeTokens {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTheme requires ThemeProvider");
  return ctx.tokens;
}

export function useThemeMode(): {
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
} {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useThemeMode requires ThemeProvider");
  return { mode: ctx.mode, setMode: ctx.setMode };
}
