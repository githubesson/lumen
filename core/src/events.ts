type Listener = () => void;

class Emitter {
  private listeners = new Set<Listener>();
  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  emit(): void {
    for (const fn of this.listeners) fn();
  }
}

// Fires when the library contents may have changed (uploads, admin rescan).
// Library/Favorites/Recent pages subscribe to refresh themselves.
export const libraryChanged = new Emitter();
