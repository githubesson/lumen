/**
 * Async KV interface injected into the shared core wherever persistence is
 * needed. Web implements this on top of `localStorage`; mobile wraps
 * `@react-native-async-storage/async-storage`. Async so both platforms share
 * one contract — small UX cost on web is a non-issue since callers treat the
 * initial read as best-effort and fall back to defaults.
 */
export interface Storage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/**
 * Wrap a sync KV (e.g. `window.localStorage`) in the async interface.
 * Used by the web client. Never throws — storage errors (quota, private
 * mode) are swallowed because player volume / theme persistence are
 * non-critical.
 */
export function asyncifySyncStorage(sync: {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}): Storage {
  return {
    async getItem(key) {
      try {
        return sync.getItem(key);
      } catch {
        return null;
      }
    },
    async setItem(key, value) {
      try {
        sync.setItem(key, value);
      } catch {
        /* ignored */
      }
    },
    async removeItem(key) {
      try {
        sync.removeItem(key);
      } catch {
        /* ignored */
      }
    },
  };
}
