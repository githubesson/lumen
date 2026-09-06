import { AuthProvider as SharedAuthProvider, type Storage } from "@music-library/core";
import { electron } from "../lib/platform";
import type { ReactNode } from "react";
export { useAuth, type AuthState } from "@music-library/core";

// Unlike preference storage, failures must propagate: offline logout needs a
// durable marker when the browser cannot revoke its HttpOnly cookie.
const intentStorage: Storage = {
  async getItem(key) {
    const desktop = electron();
    return desktop ? (await desktop.getSignOutIntent() ? "1" : null) : localStorage.getItem(key);
  },
  async setItem(key, value) {
    const desktop = electron();
    if (desktop) await desktop.setSignOutIntent(value === "1");
    else localStorage.setItem(key, value);
  },
  async removeItem(key) {
    const desktop = electron();
    if (desktop) await desktop.setSignOutIntent(false);
    else localStorage.removeItem(key);
  },
};
export function AuthProvider({ children }: { children: ReactNode }) {
  return <SharedAuthProvider intentStorage={intentStorage}>{children}</SharedAuthProvider>;
}
