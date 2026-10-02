import { useEffect, useState } from "react";

/**
 * Subscribes to the app coming back to the foreground (a tab shown again, an
 * app made active) and returns the unsubscribe. Pass a stable function.
 */
export type ResumeSubscriber = (onResume: () => void) => () => void;

/**
 * The local date, updated when it changes, so a screen showing a rolling
 * period ("this month", "last 30 days") recomputes its range rather than
 * keep acting on yesterday's dates.
 *
 * A timer fires just after midnight, but timers stall while a laptop sleeps
 * or a phone app is suspended, so the date is also checked on every resume.
 */
export function useLocalDay(subscribeResume?: ResumeSubscriber): string {
  const [day, setDay] = useState(() => new Date().toDateString());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => setDay(new Date().toDateString());
    const arm = () => {
      const now = new Date();
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      timer = setTimeout(() => {
        check();
        arm();
      }, midnight.getTime() - now.getTime() + 1000);
    };
    arm();
    const unsubscribe = subscribeResume?.(check);
    return () => {
      clearTimeout(timer);
      unsubscribe?.();
    };
  }, [subscribeResume]);
  return day;
}
