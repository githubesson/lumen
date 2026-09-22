import { useCallback, useState } from "react";

/**
 * An editable form draft kept as one object. `setField` updates a single
 * field; `resetDraft` replaces the whole draft, e.g. to snapshot an entity
 * when its edit dialog opens. Both are referentially stable.
 */
export function useFormDraft<T extends object>(initial: T) {
  const [draft, resetDraft] = useState<T>(initial);
  const setField = useCallback(<K extends keyof T>(key: K, value: T[K]) => {
    resetDraft((current) => ({ ...current, [key]: value }));
  }, []);
  return { draft, setField, resetDraft };
}
