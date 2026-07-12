import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

interface LyricsPanelContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

const LyricsPanelContext = createContext<LyricsPanelContextValue | null>(null);

export function LyricsPanelProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  const toggle = useCallback(() => {
    setOpen((value) => !value);
  }, []);

  useEffect(() => {
    document.documentElement.toggleAttribute("data-lyrics-panel", open);
    return () => {
      document.documentElement.removeAttribute("data-lyrics-panel");
    };
  }, [open]);

  const value = useMemo(
    () => ({ open, setOpen, toggle }),
    [open, toggle],
  );

  return (
    <LyricsPanelContext.Provider value={value}>
      {children}
    </LyricsPanelContext.Provider>
  );
}

export function useLyricsPanel() {
  const ctx = useContext(LyricsPanelContext);
  if (!ctx) {
    throw new Error("useLyricsPanel must be used within LyricsPanelProvider");
  }
  return ctx;
}
