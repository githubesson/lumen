import { useEffect, useState } from "react";

/**
 * Returns `value` after it has stayed unchanged for `delayMs`. Used to debounce
 * search input before firing queries.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timeout = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timeout);
  }, [delayMs, value]);

  return debounced;
}
