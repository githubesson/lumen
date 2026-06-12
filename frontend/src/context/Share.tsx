import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ShareDialog } from "../components/ShareDialog";

interface ShareCtxValue {
  /** Open the share dialog for the given track id. */
  open: (trackId: string) => void;
}

const ShareContext = createContext<ShareCtxValue | null>(null);

/**
 * ShareProvider owns the single app-wide "Share track" dialog (pick a 30s
 * window → copy Discord-embeddable link). Mirrors TrackInfoProvider so
 * the context menu, command palette, etc. can pop it open without each
 * surface owning its own copy.
 */
export function ShareProvider({ children }: { children: ReactNode }) {
  const [id, setId] = useState<string | null>(null);
  const open = useCallback((trackId: string) => setId(trackId), []);
  const close = useCallback(() => setId(null), []);
  const value = useMemo<ShareCtxValue>(() => ({ open }), [open]);
  return (
    <ShareContext.Provider value={value}>
      {children}
      <ShareDialog open={id !== null} trackId={id} onClose={close} />
    </ShareContext.Provider>
  );
}

/**
 * Read the Share context. Returns null outside a ShareProvider — the
 * context-menu hook treats that as "share action unavailable" so the
 * menu entry silently disappears if the provider isn't mounted.
 */
export function useShare(): ShareCtxValue | null {
  return useContext(ShareContext);
}
