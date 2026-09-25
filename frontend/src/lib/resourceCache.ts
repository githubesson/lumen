/**
 * Last-known results for pages the user moves between, so a revisit paints
 * what it showed last time and refreshes behind it instead of flashing a
 * loading state. Module-level on purpose: pages unmount on navigation. Holds
 * one account's data, so the Shell clears it when the session changes.
 */
const cache = new Map<string, unknown>();
let owner: string | null = null;

/**
 * Called while the signed-in shell renders, before any page under it reads
 * the cache: a different account starts from an empty one. It has to happen
 * during render -- an effect would run only after the new account's pages
 * had already seeded their state from the old account's entries.
 */
export function claimResourceCache(userId: string | null) {
  if (owner === userId) return;
  cache.clear();
  owner = userId;
}

export function readCache<T>(key: string | undefined): T | undefined {
  return key === undefined ? undefined : (cache.get(key) as T | undefined);
}

export function writeCache(key: string | undefined, value: unknown) {
  if (key !== undefined) cache.set(key, value);
}

/** For a resource that's gone (a 404): a revisit mustn't paint it again. */
export function dropCache(key: string | undefined) {
  if (key !== undefined) cache.delete(key);
}

export function clearResourceCache() {
  cache.clear();
}
