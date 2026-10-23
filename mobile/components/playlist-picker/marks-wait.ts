import { useEffect, useState } from "react";

/**
 * How long the picker has been waiting for the "Added" marks: "quiet" at
 * first (the usual quick answer shows nothing), "busy" once the wait is
 * worth showing, "given-up" once a hung request (a captive portal can hold
 * one for a minute) must stop holding the rows: a possible duplicate beats
 * a sheet that ignores every tap.
 */
export type MarksWait = "quiet" | "busy" | "given-up";

export const MARKS_BUSY_AFTER_MS = 600;
export const MARKS_GIVE_UP_AFTER_MS = 5000;

const ORDER: readonly MarksWait[] = ["quiet", "busy", "given-up"];

/**
 * Calls `onPhase` as the wait passes each step. Returns the cleanup that
 * stops it.
 */
export function watchMarksWait(onPhase: (phase: MarksWait) => void): () => void {
  const busy = setTimeout(() => onPhase("busy"), MARKS_BUSY_AFTER_MS);
  const givenUp = setTimeout(() => onPhase("given-up"), MARKS_GIVE_UP_AFTER_MS);
  return () => {
    clearTimeout(busy);
    clearTimeout(givenUp);
  };
}

/**
 * The wait for the marks while `pending`. The rows wait once: a request
 * that pauses (offline, when the rows let go) and resumes comes back
 * "given-up", so flapping connectivity can't hold them again and again.
 */
export function useMarksWait(pending: boolean): MarksWait {
  const [phase, setPhase] = useState<MarksWait>("quiet");
  useEffect(() => {
    if (!pending) return;
    const stop = watchMarksWait((next) =>
      setPhase((current) =>
        ORDER.indexOf(next) > ORDER.indexOf(current) ? next : current,
      ),
    );
    return () => {
      stop();
      // The wait paused or ended. Restarting the clock on resume would make
      // the 5 s cap a 5 s cap per pause.
      setPhase("given-up");
    };
  }, [pending]);
  return pending ? phase : "quiet";
}
