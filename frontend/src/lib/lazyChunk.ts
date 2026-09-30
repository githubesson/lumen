/** A dynamically imported chunk, fetched once and remembered. */
export interface LazyChunk<T> {
  load(): Promise<T>;
  readonly loaded: boolean;
}

export function lazyChunk<T>(importer: () => Promise<T>): LazyChunk<T> {
  let pending: Promise<T> | null = null;
  let loaded = false;
  return {
    load() {
      pending ??= importer().then(
        (module) => {
          loaded = true;
          return module;
        },
        (error: unknown) => {
          // Let a later open try again (e.g. after the network is back).
          pending = null;
          throw error;
        },
      );
      return pending;
    },
    get loaded() {
      return loaded;
    },
  };
}

/**
 * Runs `commit` once `chunk` has loaded, straight away when it already has.
 * Until then the UI it opens has no dismiss handlers of its own, so an
 * Escape, a pointer press or the window losing focus cancels the request
 * instead of letting it appear later. Returns a function that cancels it and
 * reports whether an open was still pending.
 */
export function openWhenLoaded(chunk: LazyChunk<unknown>, commit: () => void): () => boolean {
  if (chunk.loaded) {
    commit();
    return () => false;
  }
  let active = true;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") cancel();
  };
  const stopWatching = () => {
    window.removeEventListener("pointerdown", cancel, true);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("blur", cancel);
  };
  function cancel() {
    const wasPending = active;
    active = false;
    stopWatching();
    return wasPending;
  }
  window.addEventListener("pointerdown", cancel, true);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("blur", cancel);
  chunk.load().then(
    () => {
      stopWatching();
      if (active) {
        active = false;
        commit();
      }
    },
    () => {
      active = false;
      stopWatching();
    },
  );
  return cancel;
}
