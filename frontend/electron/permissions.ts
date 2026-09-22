import { session } from "electron";
import type { LocalProxy } from "./local-proxy";

// Grant `media` so `navigator.mediaDevices.enumerateDevices()` returns
// labelled `audiooutput` entries. Chromium hides labels until microphone
// permission is granted; without this the device picker shows blanks.
// Chromium's `media` permission covers the *microphone*, so it is granted
// only to our own loopback origin — not to whatever content happens to be
// loaded in the default session.
export function installMediaPermissionHandlers(localProxy: LocalProxy): void {
  const mediaAllowedFor = (origin: string | undefined): boolean => {
    if (!origin) return false;
    try {
      const u = new URL(origin);
      return (
        u.protocol === "http:" &&
        (u.hostname === "127.0.0.1" || u.hostname === "localhost") &&
        u.port === String(localProxy.port)
      );
    } catch {
      return false;
    }
  };
  session.defaultSession.setPermissionRequestHandler(
    (wc, permission, callback) => {
      callback(
        permission === "media" && mediaAllowedFor(wc?.getURL?.()),
      );
    },
  );
  session.defaultSession.setPermissionCheckHandler(
    (_wc, permission, requestingOrigin) =>
      permission === "media" && mediaAllowedFor(requestingOrigin),
  );
}
