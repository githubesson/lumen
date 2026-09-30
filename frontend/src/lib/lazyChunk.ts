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
 * instead of letting it appear later. Returns a function that cancels it.
 */
export function openWhenLoaded(chunk: LazyChunk<unknown>, commit: () => void): () => void {
  if (chunk.loaded) {
    commit();
    return () => {};
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
    active = false;
    stopWatching();
  }
  window.addEventListener("pointerdown", cancel, true);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("blur", cancel);
  chunk.load().then(
    () => {
      stopWatching();
      if (active) commit();
    },
    stopWatching,
  );
  return cancel;
}
