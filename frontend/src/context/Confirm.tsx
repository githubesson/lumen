import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ConfirmDialog,
  type ConfirmOptions,
  type ConfirmRequest,
} from "../components/ConfirmDialog";

export type { ConfirmArt, ConfirmOptions, ConfirmSubject } from "../components/ConfirmDialog";

/** Ask before a destructive action; resolves true if they go ahead. */
export type Confirm = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<Confirm | null>(null);

interface Request extends ConfirmRequest {
  resolve: (confirmed: boolean) => void;
}

/**
 * Owns the single app-wide confirm dialog, in place of the browser's
 * window.confirm box, which doesn't match the app and blocks the page.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<Request | null>(null);
  const [open, setOpen] = useState(false);
  const pending = useRef<Request | null>(null);
  const nextId = useRef(0);

  const settle = useCallback((id: number, confirmed: boolean) => {
    // A replaced question was already answered no.
    if (pending.current?.id !== id) return;
    pending.current.resolve(confirmed);
    pending.current = null;
    setOpen(false);
  }, []);

  const confirm = useCallback<Confirm>(
    (options) =>
      new Promise<boolean>((resolve) => {
        // A newer question replaces one still open, which counts as a no.
        pending.current?.resolve(false);
        const next = { id: ++nextId.current, options, resolve };
        pending.current = next;
        setRequest(next);
        setOpen(true);
      }),
    [],
  );

  // Nothing is left to answer it once the app goes.
  useEffect(() => () => pending.current?.resolve(false), []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <ConfirmDialog open={open} request={request} onSettle={settle} />
    </ConfirmContext.Provider>
  );
}

/** The app-wide confirm dialog; needs a ConfirmProvider above it. */
export function useConfirm(): Confirm {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error("useConfirm needs a ConfirmProvider");
  return confirm;
}
