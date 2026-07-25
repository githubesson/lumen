import { useCallback, useState } from 'react';

/**
 * Pointer-hover state for a view. Desktop UI leans on hover the way touch UI
 * leans on press: rows reveal their controls, buttons brighten, and nothing is
 * discoverable without it.
 *
 * Returns props to spread onto a `View`/`Pressable` plus the current state.
 */
export function useHover() {
  const [hovered, setHovered] = useState(false);
  const onMouseEnter = useCallback(() => setHovered(true), []);
  const onMouseLeave = useCallback(() => setHovered(false), []);
  return {
    hovered,
    hoverProps: { onMouseEnter, onMouseLeave },
  };
}
