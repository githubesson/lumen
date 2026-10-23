import AsyncStorage from "@react-native-async-storage/async-storage";
import { AccessibilityInfo, Dimensions } from "react-native";

/**
 * The cue for a gesture nobody can see: once per install, the first song
 * list the user settles on peeks its first row open right, then left, by
 * itself. Rows offer themselves as they mount; 900 ms after the last of a
 * burst, the topmost on screen peeks if at least three are, nothing is being
 * touched, and the list isn't moving. Skipped under Reduce Motion (and not
 * recorded, so it still comes once motion is back on).
 */

const PEEK_SHOWN_KEY = "swipe-actions.peek-shown.v1"; // AsyncStorage; "1"
const SETTLE_MS = 900;
/** A second look this long after the first, to tell a still list from a moving one. */
const STILL_CHECK_MS = 120;
const MIN_ROWS = 3;

export interface PeekCandidate {
  /** The row's frame in the window, or null when it isn't laid out. */
  measure: (done: (frame: { y: number; height: number } | null) => void) => void;
  peek: () => void;
}

let status: "unknown" | "loading" | "armed" | "done" = "unknown";
// Rows offered since the last attempt: the list that just appeared, not
// rows on screens it covered.
let batch = new Set<PeekCandidate>();
let timer: ReturnType<typeof setTimeout> | null = null;
let touches = 0;
let lastTouchAt = 0;
// A touch whose row unmounted never reports its end; don't wait on it forever.
const TOUCH_STALE_MS = 5000;

/** A row's swipe gesture began (true) or finished (false). */
export function notePeekTouch(down: boolean) {
  touches = Math.max(0, touches + (down ? 1 : -1));
  if (down) lastTouchAt = Date.now();
}

function touching() {
  return touches > 0 && Date.now() - lastTouchAt < TOUCH_STALE_MS;
}

/** Offers a row for the peek. Returns the withdrawal, for unmount. */
export function offerPeek(candidate: PeekCandidate): () => void {
  if (status === "done") return withdrawNothing;
  batch.add(candidate);
  if (status === "unknown") {
    status = "loading";
    void load();
  } else if (status === "armed") {
    schedule();
  }
  return () => {
    batch.delete(candidate);
  };
}

function withdrawNothing() {}

async function load() {
  let skip = true;
  try {
    const [shown, reduceMotion] = await Promise.all([
      AsyncStorage.getItem(PEEK_SHOWN_KEY),
      AccessibilityInfo.isReduceMotionEnabled(),
    ]);
    skip = shown === "1" || reduceMotion;
  } catch {
    // An unreadable flag: better no cue than one on every launch.
  }
  if (skip) {
    finish(false);
    return;
  }
  status = "armed";
  schedule();
}

function schedule() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void attempt(), SETTLE_MS);
}

function finish(record: boolean) {
  status = "done";
  batch = new Set();
  if (timer) clearTimeout(timer);
  timer = null;
  if (record) void AsyncStorage.setItem(PEEK_SHOWN_KEY, "1").catch(() => {});
}

type Measured = { candidate: PeekCandidate; y: number };

function measureVisible(candidates: PeekCandidate[]): Promise<Measured[]> {
  const windowHeight = Dimensions.get("window").height;
  return Promise.all(
    candidates.map(
      (candidate) =>
        new Promise<Measured | null>((resolve) => {
          candidate.measure((frame) => {
            const visible =
              !!frame &&
              frame.height > 0 &&
              frame.y >= 0 &&
              frame.y + frame.height <= windowHeight;
            resolve(visible ? { candidate, y: frame.y } : null);
          });
        }),
    ),
  ).then((frames) =>
    frames.filter((frame): frame is Measured => frame !== null).sort((a, b) => a.y - b.y),
  );
}

async function attempt() {
  timer = null;
  if (status !== "armed") return;
  const candidates = [...batch];
  const visible = await measureVisible(candidates);
  // A short list: wait for the next one.
  if (visible.length < MIN_ROWS) {
    for (const candidate of candidates) batch.delete(candidate);
    return;
  }
  const first = visible[0];
  await new Promise((resolve) => setTimeout(resolve, STILL_CHECK_MS));
  const again = await measureVisible([first.candidate]);
  const still = again.length === 1 && Math.abs(again[0].y - first.y) < 1;
  if (status !== "armed") return;
  if (touching() || !still || !batch.has(first.candidate)) {
    // Busy or moving: try again once it settles.
    schedule();
    return;
  }
  finish(true);
  first.candidate.peek();
}
