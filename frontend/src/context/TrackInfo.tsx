import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { TrackInfoDialog } from "../components/TrackInfoDialog";

interface TrackInfoCtxValue {
  /** Opens the read-only track-info dialog for the given track id. */
  open: (trackId: string) => void;
}

const TrackInfoContext = createContext<TrackInfoCtxValue | null>(null);

/**
 * TrackInfoProvider owns the single app-wide "Song info" dialog. Any
 * component can pop it open via `useTrackInfo().open(id)` — the dialog
 * itself lives here so the context menu, keyboard shortcuts, and future
 * entrypoints don't each need to manage their own copy.
 */
export function TrackInfoProvider({ children }: { children: ReactNode }) {
  const [id, setId] = useState<string | null>(null);
  const open = useCallback((trackId: string) => setId(trackId), []);
  const close = useCallback(() => setId(null), []);
  const value = useMemo<TrackInfoCtxValue>(() => ({ open }), [open]);
  return (
    <TrackInfoContext.Provider value={value}>
      {children}
      <TrackInfoDialog open={id !== null} trackId={id} onClose={close} />
    </TrackInfoContext.Provider>
  );
}

/**
 * Read the app-wide TrackInfo context. Returns null when called outside a
 * TrackInfoProvider — callers that need a guarantee should throw; those
 * that want graceful fallback (e.g. the context-menu hook's default onInfo)
 * can treat null as "no dialog available".
 */
export function useTrackInfo(): TrackInfoCtxValue | null {
  return useContext(TrackInfoContext);
}
