import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState } from "react";

/**
 * The Settings dialog's side column. A section that shows something beside
 * its rows (the Discord card preview) claims it while mounted, which widens
 * the dialog to open it, and portals its content in.
 */
export interface SettingsSide {
  /** Where to portal; null when the window has no room for the column. */
  target: HTMLElement | null;
  /** Opens the column; the returned function gives it back. */
  claim: () => () => void;
}

export const SettingsSideContext = createContext<SettingsSide | null>(null);

/**
 * Claims the side column while mounted; null where content belongs inline.
 * Claimed before paint, so a dialog opening on the section opens wide
 * rather than widening as it fades in.
 */
export function useSettingsSide(): HTMLElement | null {
  const side = useContext(SettingsSideContext);
  const claim = side?.claim;
  useLayoutEffect(() => claim?.(), [claim]);
  return side?.target ?? null;
}

/**
 * The dialog's end: the column's element (give `setTarget` as its ref) and
 * its claims.
 * `open` while a section holds a claim and `roomy` says the window has room.
 */
export function useSettingsSideColumn(roomy: boolean) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const [claims, setClaims] = useState(0);
  const claim = useCallback(() => {
    setClaims((n) => n + 1);
    return () => setClaims((n) => n - 1);
  }, []);
  const side = useMemo<SettingsSide>(() => ({ target: roomy ? target : null, claim }), [roomy, target, claim]);
  return { side, open: roomy && claims > 0, setTarget };
}
