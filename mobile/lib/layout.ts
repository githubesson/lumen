/**
 * Shortest window side from which the app switches to its tablet layout
 * (side dock, wide Now Playing). Shared so the dock and Now Playing can't
 * disagree about which layout is showing.
 */
export const TABLET_BREAKPOINT = 600;

export function isTabletLayout(width: number, height: number): boolean {
  return Math.min(width, height) >= TABLET_BREAKPOINT;
}
