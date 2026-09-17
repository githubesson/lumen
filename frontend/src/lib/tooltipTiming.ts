/** Shared timing state for both tooltip systems (the global `title=` layer in
 *  TitleTooltips and the rich <Tooltip> component). Once any tooltip has been
 *  open, neighbouring ones open instantly for a short window: the delay exists
 *  to prevent accidental activation, and the user has already paid it. */
export const OPEN_DELAY = 500;
export const SKIP_DELAY_WINDOW = 300;

let lastClosedAt = 0;

export function markTooltipClosed() {
  lastClosedAt = Date.now();
}

export function resetTooltipSkip() {
  lastClosedAt = 0;
}

/** True when a tooltip should open with no delay and no entrance animation. */
export function shouldSkipDelay() {
  return Date.now() - lastClosedAt < SKIP_DELAY_WINDOW;
}
