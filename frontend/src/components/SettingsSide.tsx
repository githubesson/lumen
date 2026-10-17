import { createContext, useContext, useEffect } from "react";

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

/** Claims the side column while mounted; null where content belongs inline. */
export function useSettingsSide(): HTMLElement | null {
  const side = useContext(SettingsSideContext);
  const claim = side?.claim;
  useEffect(() => claim?.(), [claim]);
  return side?.target ?? null;
}
