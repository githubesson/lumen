/**
 * Last-known results for pages the user moves between, so a revisit paints
 * what it showed last time and refreshes behind it instead of flashing a
 * loading state. Module-level on purpose: pages unmount on navigation. Holds
 * one account's data, so the Shell clears it when the session changes.
 */
const cache = new Map<string, unknown>();

export function readCache<T>(key: string | undefined): T | undefined {
  return key === undefined ? undefined : (cache.get(key) as T | undefined);
}

export function writeCache(key: string | undefined, value: unknown) {
  if (key !== undefined) cache.set(key, value);
}

export function clearResourceCache() {
  cache.clear();
}
