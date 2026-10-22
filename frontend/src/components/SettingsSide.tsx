import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState } from "react";

/**
 * The Settings dialog's side column. A section that shows something beside
 * its rows (the Discord card preview) claims it while mounted and portals its
 * content in; the heading's toggle then opens it, widening the dialog.
 */
export interface SettingsSide {
  /** Where to portal; null when the window has no room for the column. */
  target: HTMLElement | null;
  /** Offers the column; the returned function gives it back. */
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
 * The dialog's end: the column's element (give `setTarget` as its ref), its
 * claims and whether it's shown.
 * `toggle` is there while a section holds a claim and `roomy` says the window
 * has room; `open` while it's also been toggled on. It starts shut, and stays
 * as it was left for the rest of the session. A shut column keeps its content
 * (hidden), so closing slides the content away with it.
 */
export function useSettingsSideColumn(roomy: boolean) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const [claims, setClaims] = useState(0);
  const [shown, setShown] = useState(false);
  const claim = useCallback(() => {
    setClaims((n) => n + 1);
    return () => setClaims((n) => n - 1);
  }, []);
  const toggle = useCallback(() => setShown((s) => !s), []);
  const side = useMemo<SettingsSide>(() => ({ target: roomy ? target : null, claim }), [roomy, target, claim]);
  const offered = roomy && claims > 0;
  return { side, open: offered && shown, toggle: offered ? toggle : undefined, setTarget };
}
