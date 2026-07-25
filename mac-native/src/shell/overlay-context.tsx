import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

interface OverlayValue {
  nowPlayingOpen: boolean;
  openNowPlaying: () => void;
  closeNowPlaying: () => void;
  toggleNowPlaying: () => void;
  /** Right-hand pane of the expanded player. */
  paneMode: 'lyrics' | 'queue';
  toggleLyrics: () => void;
  toggleQueue: () => void;
}

const Ctx = createContext<OverlayValue | null>(null);

/** Whether the Now Playing panel is showing. Shared so the dock, the Escape
 *  key and the Window menu all drive the same panel. */
export function OverlayProvider({ children }: { children: ReactNode }) {
  const [nowPlayingOpen, setOpen] = useState(false);
  const [paneMode, setPaneMode] = useState<'lyrics' | 'queue'>('lyrics');

  const openNowPlaying = useCallback(() => setOpen(true), []);
  const closeNowPlaying = useCallback(() => setOpen(false), []);
  const toggleNowPlaying = useCallback(() => setOpen(v => !v), []);

  // From the compact bar these open the expanded player on the chosen pane;
  // once it is open they switch panes.
  const toggleLyrics = useCallback(() => {
    setPaneMode('lyrics');
    setOpen(true);
  }, []);
  const toggleQueue = useCallback(() => {
    setPaneMode('queue');
    setOpen(true);
  }, []);

  const value = useMemo(
    () => ({
      nowPlayingOpen,
      openNowPlaying,
      closeNowPlaying,
      toggleNowPlaying,
      paneMode,
      toggleLyrics,
      toggleQueue,
    }),
    [
      nowPlayingOpen,
      openNowPlaying,
      closeNowPlaying,
      toggleNowPlaying,
      paneMode,
      toggleLyrics,
      toggleQueue,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useOverlay(): OverlayValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useOverlay requires OverlayProvider');
  return ctx;
}
