import { useEffect, useState } from "react";

/**
 * Returns `value` after it has stayed unchanged for `delayMs`. Used to debounce
 * search input before firing queries.
 *
 * The two copies this replaces differed only in calling `window.setTimeout`
 * rather than the global — which is also why this belongs in core: the bare
 * global is the portable spelling, and React Native has no `window.setTimeout`
 * on every platform.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timeout = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timeout);
  }, [value, delayMs]);

  return debounced;
}
