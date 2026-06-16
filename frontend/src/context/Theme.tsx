import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  getTweaks,
  isElectron,
  saveTweaks,
  setTitleBarTheme,
} from "../lib/platform";

export type Theme = "light" | "dark";
export type Density = "airy" | "balanced" | "dense";
export type Layout = "compact" | "sidebar" | "wide";

export interface Tweaks {
  theme: Theme;
  depth: number;
  radius: number;
  density: Density;
  layout: Layout;
  /** Ambient accent glow — the album-cover-driven color wash on the app
   *  background, detail headers, mini-player, etc. Turn off for a flat look. */
  glow: boolean;
}

const STORAGE_KEY = "lumen.tweaks";

const DEFAULTS: Tweaks = {
  theme: "dark",
  depth: 2,
  radius: 10,
  density: "balanced",
  layout: "sidebar",
  glow: true,
};

function readInitial(): Tweaks {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      return { ...DEFAULTS, theme: prefersDark ? "dark" : "light" };
    }
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch {
    return DEFAULTS;
  }
}

interface ThemeState extends Tweaks {
  toggle: () => void;
  setTheme: (t: Theme) => void;
  setDepth: (d: number) => void;
  setRadius: (r: number) => void;
  setDensity: (d: Density) => void;
  setLayout: (l: Layout) => void;
  setGlow: (g: boolean) => void;
  setAccent: (l: number, c: number, h: number) => void;
  resetAccent: () => void;
}

const Ctx = createContext<ThemeState | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [tweaks, setTweaks] = useState<Tweaks>(() => readInitial());
  const electronLoadedRef = useRef(false);

  useEffect(() => {
    const el = document.documentElement;
    el.setAttribute("data-theme", tweaks.theme);
    el.setAttribute("data-depth", String(tweaks.depth));
    el.setAttribute("data-radius", String(tweaks.radius));
    el.setAttribute("data-density", tweaks.density);
    el.setAttribute("data-layout", tweaks.layout);
    el.setAttribute("data-glow", tweaks.glow ? "on" : "off");
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tweaks));
    if (isElectron && electronLoadedRef.current) {
      void saveTweaks({ tweaks });
    }
  }, [tweaks]);

  // In Electron the local proxy port changes every launch, so localStorage
  // from the previous run is on a different origin. Load the canonical copy
  // from config.json once at startup and merge it on top of defaults.
  useEffect(() => {
    if (!isElectron) return;
    let cancelled = false;
    getTweaks()
      .then(({ tweaks: electronTweaks }) => {
        if (cancelled) return;
        electronLoadedRef.current = true;
        setTweaks((prev) => ({ ...prev, ...electronTweaks }));
      })
      .catch(() => {
        electronLoadedRef.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isElectron) return;
    const isDark = tweaks.theme === "dark";
    void setTitleBarTheme({
      color: isDark ? "#1a1a1e" : "#ffffff",
      symbolColor: isDark ? "#f2f2f2" : "#1a1a1e",
    });
  }, [tweaks.theme]);

  const setTheme = useCallback((t: Theme) => setTweaks((v) => ({ ...v, theme: t })), []);
  const toggle = useCallback(
    () =>
      setTweaks((v) => ({
        ...v,
        theme: v.theme === "dark" ? "light" : "dark",
      })),
    [],
  );
  const setDepth = useCallback((d: number) => setTweaks((v) => ({ ...v, depth: d })), []);
  const setRadius = useCallback(
    (r: number) => setTweaks((v) => ({ ...v, radius: r })),
    [],
  );
  const setDensity = useCallback(
    (d: Density) => setTweaks((v) => ({ ...v, density: d })),
    [],
  );
  const setLayout = useCallback(
    (l: Layout) => setTweaks((v) => ({ ...v, layout: l })),
    [],
  );
  const setGlow = useCallback(
    (g: boolean) => setTweaks((v) => ({ ...v, glow: g })),
    [],
  );

  const setAccent = useCallback((l: number, c: number, h: number) => {
    const root = document.documentElement;
    root.style.setProperty("--accent", `oklch(${l} ${c} ${h})`);
    root.style.setProperty(
      "--accent-soft",
      `oklch(${l} ${c} ${h} / 0.14)`,
    );
    root.style.setProperty("--ring", `oklch(${l} ${c} ${h} / 0.55)`);
  }, []);

  const resetAccent = useCallback(() => {
    const root = document.documentElement;
    root.style.removeProperty("--accent");
    root.style.removeProperty("--accent-soft");
    root.style.removeProperty("--ring");
  }, []);

  const value = useMemo<ThemeState>(
    () => ({
      ...tweaks,
      toggle,
      setTheme,
      setDepth,
      setRadius,
      setDensity,
      setLayout,
      setGlow,
      setAccent,
      resetAccent,
    }),
    [
      tweaks,
      toggle,
      setTheme,
      setDepth,
      setRadius,
      setDensity,
      setLayout,
      setGlow,
      setAccent,
      resetAccent,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTheme requires ThemeProvider");
  return v;
}
