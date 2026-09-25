import { createContext, useContext } from "react";
import type { SectionId } from "../SettingsDialog";

/** Opens the settings dialog, optionally on one section. Provided by Shell. */
export const OpenSettingsContext = createContext<(section?: SectionId) => void>(() => {});

export function useOpenSettings() {
  return useContext(OpenSettingsContext);
}
