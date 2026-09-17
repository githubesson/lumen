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

import type { Theme, Density, Layout, Tweaks } from "../contracts/desktop";
export type { Theme, Density, Layout, Tweaks } from "../contracts/desktop";

const STORAGE_KEY = "lumen.tweaks";

const DEFAULTS: Tweaks = {
  theme: "dark",
  radius: 10,
  density: "balanced",
  layout: "sidebar",
};

// Older builds persisted depth/glow tweaks; keep only the fields this build
// still understands so retired keys are not written back.
function knownTweaks(raw: Partial<Tweaks> | null | undefined): Partial<Tweaks> {
  if (!raw || typeof raw !== "object") return {};
  const out: Partial<Tweaks> = {};
  if (raw.theme !== undefined) out.theme = raw.theme;
  if (raw.radius !== undefined) out.radius = raw.radius;
  if (raw.density !== undefined) out.density = raw.density;
  if (raw.layout !== undefined) out.layout = raw.layout;
  return out;
}

function readInitial(): Tweaks {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      return { ...DEFAULTS, theme: prefersDark ? "dark" : "light" };
    }
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...knownTweaks(parsed) };
  } catch {
    return DEFAULTS;
  }
}

interface ThemeState extends Tweaks {
  toggle: () => void;
  setTheme: (t: Theme) => void;
  setRadius: (r: number) => void;
  setDensity: (d: Density) => void;
  setLayout: (l: Layout) => void;
}

const Ctx = createContext<ThemeState | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [tweaks, setTweaks] = useState<Tweaks>(() => readInitial());
  const electronLoadedRef = useRef(false);

  useEffect(() => {
    const el = document.documentElement;
    el.setAttribute("data-theme", tweaks.theme);
    el.setAttribute("data-radius", String(tweaks.radius));
    el.setAttribute("data-density", tweaks.density);
    el.setAttribute("data-layout", tweaks.layout);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tweaks));
    if (isElectron() && electronLoadedRef.current) {
      void saveTweaks({ tweaks });
    }
  }, [tweaks]);

  // In Electron the local proxy port changes every launch, so localStorage
  // from the previous run is on a different origin. Load the canonical copy
  // from config.json once at startup and merge it on top of defaults.
  useEffect(() => {
    if (!isElectron()) return;
    let cancelled = false;
    getTweaks()
      .then(({ tweaks: electronTweaks }) => {
        if (cancelled) return;
        electronLoadedRef.current = true;
        setTweaks((prev) => ({ ...prev, ...knownTweaks(electronTweaks) }));
      })
      .catch(() => {
        electronLoadedRef.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isElectron()) return;
    const isDark = tweaks.theme === "dark";
    void setTitleBarTheme({
      // shadcn neutral --sidebar in each theme.
      color: isDark ? "#171717" : "#fafafa",
      symbolColor: isDark ? "#fafafa" : "#0a0a0a",
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

  const value = useMemo<ThemeState>(
    () => ({
      ...tweaks,
      toggle,
      setTheme,
      setRadius,
      setDensity,
      setLayout,
    }),
    [
      tweaks,
      toggle,
      setTheme,
      setRadius,
      setDensity,
      setLayout,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTheme requires ThemeProvider");
  return v;
}
