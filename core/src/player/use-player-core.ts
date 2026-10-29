import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api, streamUrl, type TrackListItem } from "../api";
import { ApiError, rawFetch } from "../api-transport";
import type { Storage } from "../storage";
import { isTidalTrack } from "../track";
import type { AudioAdapter } from "./audio-adapter";
import {
  VOLUME_STORAGE_KEY,
  canStartTrack,
  clampVolume,
  continuesAlbum,
  fisherYatesWithAnchor,
  nextRepeatMode,
  shouldReportPlay,
  withPlayNext,
  type PlaybackError,
  type PlaybackErrorDetails,
  type PlayerControls,
  type PlayerState,
  type RepeatMode,
  type TimeState,
} from "./player-core";

export interface UsePlayerCoreOptions {
  adapter: AudioAdapter;
  storage: Storage;
  interpolateProgress?: boolean;
  /**
   * Resolve a playable URI for a track id before falling back to the network
   * stream. Returns a local `file://` URI when the track is available offline,
   * or `undefined`/empty to stream. Read synchronously on every source swap,
   * so it must be cheap (e.g. an in-memory lookup).
   */
  resolveTrackUri?: (trackId: string) => string | null | undefined;
  /**
   * Gate consulted when starting a track or advancing through the queue: return false to skip a
   * track (e.g. not downloaded while offline). Read synchronously on user
   * action / track end, so it must be cheap. Absent → everything is playable.
   * Tracks flagged `unavailable` are skipped regardless.
   */
  isTrackPlayable?: (trackId: string) => boolean;
  /**
   * Smooth mix: fade each track into the next over this many seconds, when
   * the adapter can (`crossfadeToPrepared`). 0 or absent plays them back to
   * back. An album playing in order runs straight through either way.
   */
  crossfadeSeconds?: number;
}

export interface UsePlayerCoreReturn {
  state: PlayerState;
  controls: PlayerControls;
  time: TimeState;
}

const TIME_STATE_GRANULARITY_SEC = 0.25;
const NEXT_TRACK_PREPARE_RATIO = 0.7;
// Closer to the end than this, a crossfade isn't worth starting; the track
// ends and hands off as it would without one.
const MIN_CROSSFADE_SEC = 1;

function quantizeTime(seconds: number, duration: number): number {
  const clamped =
    Number.isFinite(duration) && duration > 0
      ? Math.min(Math.max(0, seconds), duration)
      : Math.max(0, seconds);
  return Math.round(clamped / TIME_STATE_GRANULARITY_SEC) * TIME_STATE_GRANULARITY_SEC;
}

/** First index in [from..to] (inclusive, step ±1) whose track can start
 *  (see `canStartTrack`); -1 when none can. */
function firstPlayableIndex(
  queue: TrackListItem[],
  from: number,
  to: number,
  isPlayable?: (trackId: string) => boolean,
): number {
  const step = from <= to ? 1 : -1;
  for (let i = from; step > 0 ? i <= to : i >= to; i += step) {
    const track = queue[i];
    if (!track) continue;
    if (canStartTrack(track, isPlayable)) return i;
  }
  return -1;
}

const PLAYBACK_ERROR_FALLBACK = "Couldn't play this track.";

/** What asking for a failed stream again found. */
interface StreamProbe {
  /** The server's reason it can't serve the stream, when it gave one. */
  reason: string | null;
  /** The answer, for the failure's details. */
  answer: string;
}

/**
 * Why a stream failed, in the server's words: request it once more. The
 * backend answers a TIDAL stream it can't serve with a 502 or 503 and a short
 * plain-text reason (and remembers TIDAL's refusal, so this doesn't ask TIDAL
 * again). Any other answer, such as a stream that works now, a network
 * failure, another error or a reverse proxy's HTML error page, gives no
 * reason; it is only described.
 */
async function probeStream(
  url: string,
  { firstByte, signal }: { firstByte: boolean; signal: AbortSignal },
): Promise<StreamProbe> {
  try {
    // A library file is served with ranges, so one byte answers as well as
    // the whole file. A TIDAL stream is asked exactly as the player asks it.
    const response = await rawFetch(url, {
      signal,
      ...(firstByte ? { headers: { Range: "bytes=0-0" } } : {}),
    });
    // Nothing to explain; don't download the stream.
    void response.body?.cancel().catch(() => {});
    const type = response.headers.get("content-type");
    return {
      reason: null,
      answer: detailLine(`HTTP ${response.status}${type ? ` · ${type}` : ""}`) ?? "",
    };
  } catch (error) {
    if (!(error instanceof ApiError)) {
      return { reason: null, answer: detailLine(`No answer: ${String(error)}`) ?? "No answer" };
    }
    const text = error.message;
    const readable =
      text.length <= 300 && !text.startsWith("<") && !text.includes("\n") ? text : "";
    return {
      reason:
        readable && (error.status === 502 || error.status === 503) ? detailLine(readable) : null,
      answer: detailLine(`HTTP ${error.status}${readable ? ` · ${readable}` : ""}`) ?? "",
    };
  }
}

/**
 * A failure's account fit for a bug report: on one line, capped, and without
 * addresses (hls.js quotes a failed key's URI, which may be signed, and a
 * proxy's error page may name its upstream).
 */
function detailLine(text: string | null | undefined): string | null {
  const plain = text
    ?.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "<address>")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return null;
  return plain.length > 300 ? `${plain.slice(0, 299)}…` : plain;
}

/**
 * A failed source as the details show it: a server address without its
 * origin, or a downloaded copy by its file name (its folder is the device's).
 */
function failedSource(uri: string): string {
  if (/^file:/i.test(uri)) return `Downloaded copy · ${uri.slice(uri.lastIndexOf("/") + 1)}`;
  if (!/^https?:\/\//i.test(uri)) return uri;
  try {
    const { pathname, search } = new URL(uri);
    return pathname + search;
  } catch {
    return uri;
  }
}

/**
 * Platform-agnostic player state machine. Drives an `AudioAdapter` (HTML audio
 * on web, `expo-audio` on mobile), owns queue / shuffle / repeat / volume
 * state, and reports completed plays back to the API. Playback position is
 * interpolated against the wall clock, but React state is quantized to 250ms
 * steps so consumers don't all rerender at 60fps. Screens that need perfectly
 * smooth motion can interpolate locally from the coarse time anchor.
 *
 * Platform-specific concerns (MediaSession API, lock-screen controls, keyboard
 * shortcuts) live in the platform wrappers that compose this hook.
 */
export function usePlayerCore({
  adapter,
  storage,
  interpolateProgress = true,
  resolveTrackUri,
  isTrackPlayable,
  crossfadeSeconds = 0,
}: UsePlayerCoreOptions): UsePlayerCoreReturn {
  const [current, setCurrent] = useState<TrackListItem | null>(null);
  // `queue` is the actual play order — when shuffle is on it's a Fisher-Yates
  // permutation of `sourceQueue`. `sourceQueue` remembers the original order
  // so we can restore it when shuffle toggles off.
  const [queue, setQueue] = useState<TrackListItem[]>([]);
  const [sourceQueue, setSourceQueue] = useState<TrackListItem[]>([]);
  const [index, setIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState<number>(0.8);
  const [volumeHydrated, setVolumeHydrated] = useState(false);
  const [muted, setMuted] = useState(false);
  const [shuffle, setShuffleState] = useState(false);
  const [repeat, setRepeatState] = useState<RepeatMode>("off");
  const [playbackError, setPlaybackError] = useState<PlaybackError | null>(null);
  // The current track's failure, set as soon as the adapter reports it (its
  // message may still be on the way): playing that track again retries it,
  // and a message only lands while this is still the same failure.
  const failureRef = useRef<{ trackId: string } | null>(null);
  // The server being asked why the current failure happened.
  const probeRef = useRef<AbortController | null>(null);
  const playbackReportedRef = useRef<string | null>(null);
  const lastFMScrobbledRef = useRef<string | null>(null);
  // Lazily seeded (see the track-change effect below) rather than
  // `useRef(Date.now())`: the initializer expression is evaluated on every
  // render, and calling an impure function during render is a purity violation
  // the React Compiler rejects.
  const trackStartedAtRef = useRef(0);
  const listenedSecondsRef = useRef(0);
  const listeningTickRef = useRef<number | null>(null);
  const loadedTrackIdRef = useRef<string | null>(null);
  // The source the adapter was last given, as loaded or activated. A failure
  // is about it, whatever the track would resolve to now (a download removed
  // while it plays still played from the file).
  const loadedUriRef = useRef<string | null>(null);
  const preparedNextRef = useRef<{ trackId: string; uri: string } | null>(null);
  const playbackAttemptRef = useRef(0);
  const handoffRef = useRef<{ track: TrackListItem; attempt: number } | null>(null);
  // Picks made by play(), jumpTo() and prev(), and changes to shuffle or
  // repeat, and the last one React has committed. Until they match, the
  // event handlers still see the old queue's next track, and a timeupdate
  // must not prepare it or crossfade into it. Each pick also bumps state, so
  // it always commits, and only its own commit (not an earlier,
  // higher-priority one) clears it.
  const picksRef = useRef(0);
  const committedPicksRef = useRef(0);
  const [picks, setPicks] = useState(0);
  const notePick = useCallback(() => {
    picksRef.current += 1;
    setPicks(picksRef.current);
  }, []);
  // The tracks Play Next has put after the current one, so the next pick
  // goes behind them. Anything that moves the position or reorders the queue
  // (play, advance, a jump, prev, shuffle) ends the run; the same track
  // coming round again, or played anew, starts a fresh one.
  const playNextRunRef = useRef<{ currentId: string; ids: Set<string> } | null>(null);
  // Anchor used to interpolate currentTime against the wall clock between the
  // adapter's (infrequent) timeupdate pings.
  const anchorRef = useRef<{ audioTime: number; wallTime: number }>({
    audioTime: 0,
    wallTime: 0,
  });

  // Restore persisted volume once on mount. Async so both localStorage-backed
  // and AsyncStorage-backed adapters work. Fail-silent: volume is cosmetic.
  useEffect(() => {
    let cancelled = false;
    void storage.getItem(VOLUME_STORAGE_KEY).then((v) => {
      if (cancelled) return;
      if (v != null) {
        const parsed = parseFloat(v);
        if (Number.isFinite(parsed)) setVolumeState(clampVolume(parsed));
      }
      setVolumeHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, [storage]);

  // Push volume / mute to the adapter immediately. Persistence waits for the
  // initial read so the default value cannot overwrite a saved volume while
  // asynchronous storage is still hydrating.
  useEffect(() => {
    adapter.setVolume(volume);
    adapter.setMuted(muted);
  }, [adapter, volume, muted]);

  // Debounced: a slider drag changes the volume on every pointer move.
  const pendingVolumeRef = useRef<number | null>(null);
  useEffect(() => {
    if (!volumeHydrated) return;
    pendingVolumeRef.current = volume;
    const timer = setTimeout(() => {
      pendingVolumeRef.current = null;
      void storage.setItem(VOLUME_STORAGE_KEY, String(volume)).catch(() => {});
    }, 200);
    return () => clearTimeout(timer);
  }, [storage, volume, volumeHydrated]);
  // Write a change still inside the debounce when the player unmounts or
  // the page is closed, so the next launch doesn't restore the old volume.
  useEffect(() => {
    const pending = pendingVolumeRef;
    const flush = () => {
      const value = pending.current;
      if (value === null) return;
      pending.current = null;
      void storage.setItem(VOLUME_STORAGE_KEY, String(value)).catch(() => {});
    };
    const target = globalThis as { addEventListener?: typeof addEventListener; removeEventListener?: typeof removeEventListener };
    target.addEventListener?.("pagehide", flush);
    return () => {
      target.removeEventListener?.("pagehide", flush);
      flush();
    };
  }, [storage]);

  // Zero the visible clock the moment a different track is chosen. Without
  // this the wall-clock interpolation keeps advancing from the previous
  // track's anchor, so the scrubber shows the old track's position against
  // the old duration until the new one's `loadedmetadata` lands — and then
  // snaps. `next()` has always reset these; jumps, prev and fresh plays get
  // the same treatment here. No-op when the track is already loaded (e.g.
  // re-clicking the playing track), where no `loadedmetadata` would follow
  // to restore the duration.
  const resetClockForTrackChange = useCallback((trackId: string) => {
    if (loadedTrackIdRef.current === trackId) return;
    setCurrentTime(0);
    setDuration(0);
    anchorRef.current = { audioTime: 0, wallTime: performance.now() };
  }, []);

  const resolvePlayableUri = useCallback(
    (trackId: string) => resolveTrackUri?.(trackId) || streamUrl(trackId),
    [resolveTrackUri],
  );

  const clearPreparedNext = useCallback(() => {
    preparedNextRef.current = null;
    adapter.clearPrepared?.();
  }, [adapter]);

  const startPlayback = useCallback(() => {
    const attempt = ++playbackAttemptRef.current;
    void adapter.play().catch(() => {
      // Replacing a source can reject its pending play promise. Only the
      // latest attempt is allowed to change the current playback state.
      if (attempt === playbackAttemptRef.current) setIsPlaying(false);
    });
  }, [adapter]);

  const clearPlaybackError = useCallback(() => {
    // A failure that's gone has nothing left to ask about.
    probeRef.current?.abort();
    probeRef.current = null;
    if (!failureRef.current) return;
    failureRef.current = null;
    setPlaybackError(null);
  }, []);

  // A failed source stays failed, so play() alone can't revive it. Load it
  // again as a fresh start does, and start it here the way next() does.
  // load() drops the adapter's prepared next track, so drop its marker too,
  // or it is never prepared again. The reload starts over, so it is a fresh
  // listen for play history and Last.fm, as a repeat-one restart is.
  const retryFailedTrack = useCallback(
    (track: TrackListItem) => {
      clearPlaybackError();
      clearPreparedNext();
      playbackReportedRef.current = null;
      lastFMScrobbledRef.current = null;
      trackStartedAtRef.current = Math.floor(Date.now() / 1000);
      listenedSecondsRef.current = 0;
      listeningTickRef.current = performance.now();
      setCurrentTime(0);
      setDuration(0);
      anchorRef.current = { audioTime: 0, wallTime: performance.now() };
      loadedTrackIdRef.current = track.id;
      loadedUriRef.current = resolvePlayableUri(track.id);
      adapter.load(loadedUriRef.current);
      startPlayback();
      handoffRef.current = { track, attempt: playbackAttemptRef.current };
      setIsPlaying(true);
    },
    [adapter, clearPlaybackError, clearPreparedNext, resolvePlayableUri, startPlayback],
  );

  // Start the selected track: the failed one is retried, and any other
  // drops the previous track's failure.
  const startTrack = useCallback(
    (track: TrackListItem) => {
      if (failureRef.current?.trackId === track.id) {
        retryFailedTrack(track);
        return;
      }
      clearPlaybackError();
      setIsPlaying(true);
    },
    [clearPlaybackError, retryFailedTrack],
  );

  // The queue as the latest selection left it, ahead of React's commit.
  // playNext and advance read it, so playNext keeps its identity while the
  // queue moves (every swipeable list row holds it), and whatever lands
  // before a commit (a second pick, a track ending) builds on the list as it
  // now is. Every control that changes the queue or the position writes it
  // along with its state.
  const queueStateRef = useRef({ current, queue, sourceQueue, index, shuffle });
  useEffect(() => {
    queueStateRef.current = { current, queue, sourceQueue, index, shuffle };
  }, [current, queue, sourceQueue, index, shuffle]);

  const play = useCallback<PlayerControls["play"]>(
    (track, q, options) => {
      if (!canStartTrack(track, isTrackPlayable)) return false;
      notePick();
      playNextRunRef.current = null;
      const base = q && q.length ? q : [track];
      // Set here, with the queue, rather than through setShuffle: that
      // reorders the queue this render has, not the one starting now.
      const shuffled = options?.shuffle ?? shuffle;
      if (shuffled !== shuffle) setShuffleState(shuffled);
      // Shuffled, the clicked track is pinned at position 0 and the rest
      // shuffled: every track plays exactly once before any wrap.
      const nextQueue = shuffled ? fisherYatesWithAnchor(base, track.id) : base;
      const nextIndex = shuffled ? 0 : Math.max(0, base.findIndex((t) => t.id === track.id));
      setSourceQueue(base);
      setQueue(nextQueue);
      setIndex(nextIndex);
      setCurrent(track);
      queueStateRef.current = {
        current: track,
        queue: nextQueue,
        sourceQueue: base,
        index: nextIndex,
        shuffle: shuffled,
      };
      startTrack(track);
      resetClockForTrackChange(track.id);
      playbackReportedRef.current = null;
    },
    [isTrackPlayable, notePick, resetClockForTrackChange, shuffle, startTrack],
  );

  const playRef = useRef(play);
  useEffect(() => {
    playRef.current = play;
  }, [play]);

  const playNext = useCallback<PlayerControls["playNext"]>(
    (tracks) => {
      const state = queueStateRef.current;
      const { current: playing } = state;
      const seen = new Set<string>();
      const picked = tracks.filter((track) => {
        if (seen.has(track.id) || track.id === playing?.id) return false;
        seen.add(track.id);
        return canStartTrack(track, isTrackPlayable);
      });
      if (!picked.length) return false;
      if (!playing || !state.queue.length) {
        if (playRef.current(picked[0], picked) === false) return false;
        // Picks play in the order they were made, shuffle or not: play()
        // would have shuffled the rest.
        if (queueStateRef.current.shuffle) {
          setQueue(picked);
          setIndex(0);
          queueStateRef.current = { ...queueStateRef.current, queue: picked, index: 0 };
        }
        // The rest are a run behind the first, so a later pick goes after them.
        playNextRunRef.current = {
          currentId: picked[0].id,
          ids: new Set(picked.slice(1).map((track) => track.id)),
        };
        return true;
      }
      const previousRun = playNextRunRef.current;
      const run =
        previousRun?.currentId === playing.id ? previousRun.ids : new Set<string>();
      const ordered = withPlayNext(state.queue, state.index, picked, run);
      // With shuffle off the play order is the list order: keep them one list.
      const source = state.shuffle
        ? withPlayNext(
            state.sourceQueue,
            state.sourceQueue.findIndex((track) => track.id === playing.id),
            picked,
            run,
          ).list
        : ordered.list;
      // The prepared next track is now the wrong one. The pick keeps smooth
      // mix and gapless from using it until this commits, and the commit
      // drops it (see the nextTrackToPrepare effect).
      notePick();
      setQueue(ordered.list);
      setSourceQueue(source);
      setIndex(ordered.at);
      queueStateRef.current = {
        ...state,
        queue: ordered.list,
        sourceQueue: source,
        index: ordered.at,
      };
      playNextRunRef.current = {
        currentId: playing.id,
        ids: new Set([...run, ...picked.map((track) => track.id)]),
      };
      return true;
    },
    [isTrackPlayable, notePick],
  );

  const toggle = useCallback<PlayerControls["toggle"]>(() => {
    if (!current) return;
    if (failureRef.current?.trackId === current.id) retryFailedTrack(current);
    else setIsPlaying((p) => !p);
  }, [current, retryFailedTrack]);

  const resume = useCallback<PlayerControls["resume"]>(() => {
    if (current) startTrack(current);
  }, [current, startTrack]);

  const pause = useCallback<PlayerControls["pause"]>(() => {
    if (current) setIsPlaying(false);
  }, [current]);

  // Move to the next track: for next(), at a track's end, and ahead of the
  // end for smooth mix. With `fadeSeconds` it only crossfades into the track
  // prepared for that; when it can't (not ready yet, nothing next), it
  // changes nothing and returns false, and the current track plays on.
  const advance = useCallback((fadeSeconds = 0): boolean => {
    const crossfade = fadeSeconds > 0;
    const stop = () => {
      if (!crossfade) {
        clearPreparedNext();
        setIsPlaying(false);
      }
      return false;
    };
    // The queue as playNext may have just left it, not as last committed:
    // an ended event in between would otherwise apply the old list's next
    // position to the new one.
    const state = queueStateRef.current;
    const { queue, index, sourceQueue, shuffle } = state;
    if (!queue.length) return false;
    // Guard the empty forward range explicitly: firstPlayableIndex infers
    // scan direction from from/to ordering, so (index+1, length-1) at the
    // last track would scan BACKWARD and return the current track instead
    // of -1 — replaying it instead of stopping or wrapping.
    let nextIndex =
      index + 1 < queue.length
        ? firstPlayableIndex(queue, index + 1, queue.length - 1, isTrackPlayable)
        : -1;
    let nextQueue: TrackListItem[] | null = null;
    if (nextIndex === -1) {
      if (repeat !== "all") return stop();
      // Wrap. If shuffle is on, reshuffle for a fresh pass so you don't
      // replay the same permutation. Nothing was prepared from that one, so
      // it is never crossfaded into.
      if (shuffle && sourceQueue.length > 1) {
        if (crossfade) return false;
        const reshuffled = fisherYatesWithAnchor(sourceQueue, null);
        nextIndex = firstPlayableIndex(
          reshuffled,
          0,
          reshuffled.length - 1,
          isTrackPlayable,
        );
        if (nextIndex !== -1) nextQueue = reshuffled;
      } else {
        nextIndex = firstPlayableIndex(queue, 0, index, isTrackPlayable);
      }
      // Nothing playable anywhere in the queue — stop instead of looping
      // into tracks that cannot start.
      if (nextIndex === -1) return stop();
    }

    const nextTrack = (nextQueue ?? queue)[nextIndex] ?? null;
    if (!nextTrack) return stop();

    const prepared = preparedNextRef.current;
    const nextUri = resolvePlayableUri(nextTrack.id);
    const isPrepared = prepared?.trackId === nextTrack.id && prepared.uri === nextUri;
    if (crossfade && !(isPrepared && adapter.crossfadeToPrepared?.(nextUri, fadeSeconds))) {
      return false;
    }
    // A failed source can't restart in place; it is loaded again.
    const sameTrack = loadedTrackIdRef.current === nextTrack.id && !failureRef.current;
    playbackAttemptRef.current += 1;
    const activated =
      crossfade || (isPrepared && adapter.activatePrepared?.(nextUri) === true);
    if (activated) {
      loadedTrackIdRef.current = nextTrack.id;
      loadedUriRef.current = nextUri;
    } else {
      adapter.clearPrepared?.();
    }
    preparedNextRef.current = null;

    if (!activated) {
      // Start within the native ended callback. A backgrounded iOS app may
      // suspend before React commits the selection and runs playback effects.
      // A failed/unready preload must be just as independent of React as a
      // successful prepared handoff.
      if (sameTrack) {
        adapter.seek(0);
      } else {
        loadedTrackIdRef.current = nextTrack.id;
        loadedUriRef.current = nextUri;
        adapter.load(nextUri);
      }
      startPlayback();
    }
    handoffRef.current = { track: nextTrack, attempt: playbackAttemptRef.current };
    if (sameTrack) {
      lastFMScrobbledRef.current = null;
      trackStartedAtRef.current = Math.floor(Date.now() / 1000);
      listenedSecondsRef.current = 0;
      listeningTickRef.current = performance.now();
    }

    clearPlaybackError();
    if (nextQueue) setQueue(nextQueue);
    setIndex(nextIndex);
    setCurrent(nextTrack);
    playNextRunRef.current = null;
    queueStateRef.current = {
      ...state,
      current: nextTrack,
      queue: nextQueue ?? queue,
      index: nextIndex,
    };
    setIsPlaying(true);
    setCurrentTime(0);
    setDuration(activated || sameTrack ? adapter.duration() || 0 : 0);
    anchorRef.current = { audioTime: 0, wallTime: performance.now() };
    playbackReportedRef.current = null;
    return true;
  }, [
    adapter,
    clearPlaybackError,
    clearPreparedNext,
    isTrackPlayable,
    repeat,
    resolvePlayableUri,
    startPlayback,
  ]);

  const next = useCallback<PlayerControls["next"]>(() => {
    advance();
  }, [advance]);

  const prev = useCallback<PlayerControls["prev"]>(() => {
    if (!queue.length) return;
    const restartCurrent = () => {
      // A failed source can't restart in place; it is loaded again.
      if (current && failureRef.current?.trackId === current.id) {
        retryFailedTrack(current);
        return;
      }
      adapter.seek(0);
      setCurrentTime(0);
    };
    // If you're more than 3s into the current track, restart instead of
    // going back.
    if (adapter.currentTime() > 3) {
      restartCurrent();
      return;
    }
    const ni =
      index > 0
        ? firstPlayableIndex(queue, index - 1, 0, isTrackPlayable)
        : -1;
    if (ni === -1) {
      // Nothing playable behind us — restart the current track instead of
      // landing on an unplayable one.
      restartCurrent();
      return;
    }
    notePick();
    playNextRunRef.current = null;
    clearPreparedNext();
    setIndex(ni);
    setCurrent(queue[ni]);
    queueStateRef.current = { ...queueStateRef.current, current: queue[ni], index: ni };
    startTrack(queue[ni]);
    resetClockForTrackChange(queue[ni].id);
    playbackReportedRef.current = null;
  }, [adapter, clearPreparedNext, current, queue, index, isTrackPlayable, notePick, resetClockForTrackChange, retryFailedTrack, startTrack]);

  const jumpTo = useCallback<PlayerControls["jumpTo"]>(
    (i) => {
      if (i < 0 || i >= queue.length) return;
      // Silently ignore taps on tracks that can't start (unavailable, or not
      // downloaded while offline) — queue UIs dim them instead.
      if (!canStartTrack(queue[i], isTrackPlayable)) return;
      notePick();
      playNextRunRef.current = null;
      clearPreparedNext();
      setIndex(i);
      setCurrent(queue[i]);
      queueStateRef.current = { ...queueStateRef.current, current: queue[i], index: i };
      startTrack(queue[i]);
      resetClockForTrackChange(queue[i].id);
      playbackReportedRef.current = null;
    },
    [clearPreparedNext, queue, isTrackPlayable, notePick, resetClockForTrackChange, startTrack],
  );

  const seek = useCallback<PlayerControls["seek"]>(
    (seconds) => {
      adapter.seek(seconds);
      setCurrentTime(quantizeTime(seconds, adapter.duration()));
    },
    [adapter],
  );

  const setVolume = useCallback<PlayerControls["setVolume"]>((v) => {
    const clamped = clampVolume(v);
    setVolumeState(clamped);
    if (clamped > 0) setMuted(false);
  }, []);

  const toggleMute = useCallback<PlayerControls["toggleMute"]>(
    () => setMuted((m) => !m),
    [],
  );

  const setMutedValue = useCallback<PlayerControls["setMuted"]>((value) => {
    setMuted(value);
  }, []);

  const setShuffle = useCallback<PlayerControls["setShuffle"]>((value) => {
    if (value === shuffle) return;
    notePick();
    playNextRunRef.current = null;
    setShuffleState(value);
    if (!queue.length) {
      queueStateRef.current = { ...queueStateRef.current, shuffle: value };
      return;
    }
    const source = sourceQueue.length ? sourceQueue : queue;
    // On: reshuffle, keeping the playing track at 0 so playback doesn't
    // jump. Off: back to the list order, at the playing track's place in it.
    const nextQueue = value ? fisherYatesWithAnchor(source, current?.id ?? null) : source;
    const nextIndex =
      value || !current ? 0 : Math.max(0, source.findIndex((t) => t.id === current.id));
    setQueue(nextQueue);
    setIndex(nextIndex);
    queueStateRef.current = {
      ...queueStateRef.current,
      queue: nextQueue,
      index: nextIndex,
      shuffle: value,
    };
  }, [shuffle, queue, sourceQueue, current, notePick]);

  const toggleShuffle = useCallback<PlayerControls["toggleShuffle"]>(() => {
    setShuffle(!shuffle);
  }, [setShuffle, shuffle]);

  const setRepeat = useCallback<PlayerControls["setRepeat"]>((value) => {
    notePick();
    setRepeatState(value);
  }, [notePick]);

  const cycleRepeat = useCallback<PlayerControls["cycleRepeat"]>(() => {
    notePick();
    setRepeatState((r) => nextRepeatMode(r));
  }, [notePick]);

  const nextTrackToPrepare = useMemo(() => {
    if (!current || repeat === "one" || !queue.length) return null;
    // Same empty-range guard as next(): at the last track the unguarded
    // scan returns the CURRENT track and we'd preload what's playing.
    const ni =
      index + 1 < queue.length
        ? firstPlayableIndex(queue, index + 1, queue.length - 1, isTrackPlayable)
        : -1;
    if (ni !== -1) return queue[ni] ?? null;
    // A repeat-all shuffle creates a fresh permutation at the boundary, so
    // its next track is intentionally unknown until then.
    if (repeat === "all" && !shuffle) {
      const first = queue[0];
      if (first && canStartTrack(first, isTrackPlayable)) return first;
    }
    return null;
  }, [current, index, isTrackPlayable, queue, repeat, shuffle]);

  useEffect(() => {
    const prepared = preparedNextRef.current;
    if (prepared && prepared.trackId !== nextTrackToPrepare?.id) {
      clearPreparedNext();
    }
  }, [clearPreparedNext, nextTrackToPrepare?.id]);

  // Load before the playback effect below. Keeping play() in one effect
  // avoids issuing competing requests for every source change.
  useEffect(() => {
    if (!current) return;
    if (loadedTrackIdRef.current === current.id) return;
    loadedTrackIdRef.current = current.id;
    loadedUriRef.current = resolvePlayableUri(current.id);
    adapter.load(loadedUriRef.current);
  }, [adapter, current, resolvePlayableUri]);

  const currentId = current?.id;

  useEffect(() => {
    if (!currentId) return;
    trackStartedAtRef.current = Math.floor(Date.now() / 1000);
    lastFMScrobbledRef.current = null;
    listenedSecondsRef.current = 0;
    listeningTickRef.current = performance.now();
  }, [currentId]);

  // Keyed on the id, and the id is all the body reads. Previously the body
  // dereferenced `current` while declaring only `[current?.id]`, so two
  // different TrackListItem objects with the same id — the same track refetched
  // with updated favourite state, say — left the effect holding the old object.
  useEffect(() => {
    if (currentId && isPlaying) {
      void api.updateNowPlaying(currentId).catch(() => {});
    }
  }, [currentId, isPlaying]);

  // When isPlaying toggles without a track change, sync the adapter.
  useEffect(() => {
    if (!current) return;
    const handoff = handoffRef.current;
    handoffRef.current = null;
    if (isPlaying) {
      // next() has already started this selection synchronously. Do not
      // restart the native player or supersede its pending failure handler.
      if (handoff?.track === current && handoff.attempt === playbackAttemptRef.current) return;
      startPlayback();
    } else {
      playbackAttemptRef.current += 1;
      adapter.pause();
    }
  }, [adapter, isPlaying, current, startPlayback]);

  useEffect(() => () => { playbackAttemptRef.current += 1; }, [adapter]);

  // Values the adapter event handlers read at fire time. Held in a ref so the
  // subscription effect below can depend on `[adapter]` alone: it previously
  // listed isPlaying/current/next/nextTrackToPrepare/repeat, so all six
  // listeners were torn down and re-registered on essentially every playback
  // state change — exactly the churn the ref pattern elsewhere in this file
  // exists to avoid.
  const eventStateRef = useRef({
    isPlaying,
    current,
    next,
    advance,
    nextTrackToPrepare,
    repeat,
    resolvePlayableUri,
    crossfadeSeconds,
  });
  useEffect(() => {
    eventStateRef.current = {
      isPlaying,
      current,
      next,
      advance,
      nextTrackToPrepare,
      repeat,
      resolvePlayableUri,
      crossfadeSeconds,
    };
  }, [isPlaying, current, next, advance, nextTrackToPrepare, repeat, resolvePlayableUri, crossfadeSeconds]);

  useEffect(() => {
    committedPicksRef.current = picks;
  }, [picks]);

  // Wire adapter events → hook state.
  useEffect(() => {
    const syncListenedTime = () => {
      const now = performance.now();
      const previous = listeningTickRef.current;
      const playing = eventStateRef.current.isPlaying;
      if (previous != null && playing) {
        listenedSecondsRef.current += Math.max(0, (now - previous) / 1000);
      }
      listeningTickRef.current = playing ? now : null;
    };
    const syncAnchor = () => {
      anchorRef.current = {
        audioTime: adapter.currentTime(),
        wallTime: performance.now(),
      };
    };
    const offTime = adapter.on("timeupdate", () => {
      // Gently resync the anchor on every native update to prevent drift, but
      // don't touch React state here — the 250 ms sampler owns currentTime.
      syncAnchor();
      syncListenedTime();
      // Fire a single /play ping once past 30s OR >=50% of duration.
      const { current: currentTrack, nextTrackToPrepare: toPrepare } =
        eventStateRef.current;
      const trackId = currentTrack?.id;
      const now = adapter.currentTime();
      const d = adapter.duration();
      const selecting = picksRef.current !== committedPicksRef.current;
      if (
        !selecting &&
        toPrepare &&
        adapter.prepareNext &&
        d > 0 &&
        now / d >= NEXT_TRACK_PREPARE_RATIO &&
        preparedNextRef.current?.trackId !== toPrepare.id
      ) {
        const uri = eventStateRef.current.resolvePlayableUri(toPrepare.id);
        preparedNextRef.current = { trackId: toPrepare.id, uri };
        adapter.prepareNext(uri);
      }
      if (
        trackId &&
        playbackReportedRef.current !== trackId &&
        shouldReportPlay(now, d)
      ) {
        playbackReportedRef.current = trackId;
        const completion = d > 0 ? now / d : 0;
        void api.recordPlay(trackId, completion).catch(() => {});
      }
      const lastFMThreshold = d > 0 ? Math.min(d / 2, 240) : Infinity;
      if (
        trackId &&
        d > 30 &&
        listenedSecondsRef.current >= lastFMThreshold &&
        lastFMScrobbledRef.current !== trackId
      ) {
        lastFMScrobbledRef.current = trackId;
        void api
          .scrobbleTrack(
            trackId,
            trackStartedAtRef.current,
            listenedSecondsRef.current,
          )
          .catch(() => {});
      }
      // Smooth mix: start the next track before this one ends, so the fade
      // ends with it. A short next song fades in over half its length at
      // most, and starts that much later rather than cutting this one short.
      // Until the prepared track is ready, each update tries again with
      // what's left.
      const { crossfadeSeconds: fade, isPlaying: playing, advance: advanceTo } =
        eventStateRef.current;
      const remaining = d - now;
      const nextSeconds = (toPrepare?.duration_ms ?? 0) / 1000;
      const fadeLength = nextSeconds > 0 ? Math.min(fade, nextSeconds / 2) : fade;
      if (
        !selecting &&
        fade > 0 &&
        playing &&
        currentTrack &&
        toPrepare &&
        adapter.crossfadeToPrepared &&
        preparedNextRef.current?.trackId === toPrepare.id &&
        d > 0 &&
        remaining <= fadeLength &&
        remaining >= MIN_CROSSFADE_SEC &&
        !continuesAlbum(currentTrack, toPrepare)
      ) {
        advanceTo(remaining);
      }
    });
    const offMeta = adapter.on("loadedmetadata", () => {
      setDuration(adapter.duration() || 0);
      syncAnchor();
      setCurrentTime(quantizeTime(adapter.currentTime(), adapter.duration()));
    });
    const offEnd = adapter.on("ended", () => {
      // A selection React hasn't committed yet (play, a jump) replaced the
      // track that ended; it loads and starts once it commits, so the old
      // track's end moves nothing. playNext keeps the selection, so the
      // playing track's end still advances past a fresh pick.
      const selected = queueStateRef.current.current;
      if (selected && loadedTrackIdRef.current !== selected.id) return;
      const { repeat: repeatMode, current: currentTrack } = eventStateRef.current;
      if (repeatMode === "one") {
        // Restart the same track. Re-arm play reporting so each loop counts
        // as a fresh play — otherwise playbackReportedRef stays pinned to this
        // trackId and the timeupdate guard never fires recordPlay again.
        playbackReportedRef.current = null;
        lastFMScrobbledRef.current = null;
        trackStartedAtRef.current = Math.floor(Date.now() / 1000);
        listenedSecondsRef.current = 0;
        listeningTickRef.current = performance.now();
        if (currentTrack) void api.updateNowPlaying(currentTrack.id).catch(() => {});
        adapter.seek(0);
        // Mirror the other play() sites: if the platform refuses to restart
        // (e.g. audio-session activation failed mid-interruption), reflect the
        // pause in state instead of showing a playing UI over silence.
        startPlayback();
        return;
      }
      eventStateRef.current.next();
    });
    const offSeeked = adapter.on("seeked", () => {
      syncAnchor();
      setCurrentTime(quantizeTime(adapter.currentTime(), adapter.duration()));
    });
    const offPlay = adapter.on("play", () => {
      listeningTickRef.current = performance.now();
      syncAnchor();
      // Playback can start outside our controls (lock-screen play command,
      // an interruption ending with auto-resume) — adopt the platform state.
      setIsPlaying(true);
      // As in the pause handler. A pause and this play in one batch cancel
      // out and commit nothing, so the effect wouldn't set it back.
      eventStateRef.current.isPlaying = true;
    });
    const offPause = adapter.on("pause", () => {
      syncListenedTime();
      listeningTickRef.current = null;
      syncAnchor();
      setCurrentTime(quantizeTime(adapter.currentTime(), adapter.duration()));
      // System-originated pauses (headphones disconnecting, an audio
      // interruption, lock-screen pause) surface only as this event; without
      // mirroring it the UI keeps showing a playing state over silence.
      // Adapters filter buffering, source swaps and natural track end so
      // only genuine pauses reach this handler.
      playbackAttemptRef.current += 1;
      setIsPlaying(false);
      // Until that commits, a timeupdate from the same native status must
      // see the pause too, or smooth mix would start the next song.
      eventStateRef.current.isPlaying = false;
    });
    const offError = adapter.on("error", () => {
      // Stop on the failed track rather than skipping it: the failure is
      // shown there, and playing the track again retries it.
      playbackAttemptRef.current += 1;
      setIsPlaying(false);
      // As in the pause handler: nothing may fade out of a failed song.
      eventStateRef.current.isPlaying = false;
      const { current: track, resolvePlayableUri: resolveUri } = eventStateRef.current;
      if (!track) return;
      const failure = { trackId: track.id };
      failureRef.current = failure;
      // The source loaded for this track. Until a track change commits, the
      // next track's may be loaded already; this one is resolved again then.
      const uri =
        (loadedTrackIdRef.current === track.id && loadedUriRef.current) || resolveUri(track.id);
      const url = streamUrl(track.id);
      // A downloaded copy just didn't play; only a stream can be asked again.
      const streamed = uri === url;
      const details: PlaybackErrorDetails = {
        at: Date.now(),
        source: failedSource(uri),
        player: detailLine(adapter.errorDetail?.()),
        server: streamed ? undefined : null,
      };
      const report = (message: string, server = details.server) => {
        if (failureRef.current === failure) {
          setPlaybackError({ trackId: track.id, message, details: { ...details, server } });
        }
      };
      // Say so right away; the server's reason, if any, replaces it.
      report(PLAYBACK_ERROR_FALLBACK);
      probeRef.current?.abort();
      probeRef.current = null;
      if (streamed) {
        const probe = new AbortController();
        probeRef.current = probe;
        void probeStream(url, { firstByte: !isTidalTrack(track), signal: probe.signal }).then(
          ({ reason, answer }) => {
            if (probe.signal.aborted) return;
            if (probeRef.current === probe) probeRef.current = null;
            // Only TIDAL streams fail for a reason worth showing on the bar.
            report(isTidalTrack(track) && reason ? reason : PLAYBACK_ERROR_FALLBACK, answer);
          },
        );
      }
    });
    return () => {
      offTime();
      offMeta();
      offEnd();
      offSeeked();
      offPlay();
      offPause();
      offError();
    };
  }, [adapter, startPlayback]);

  useEffect(() => () => adapter.clearPrepared?.(), [adapter]);
  useEffect(() => () => probeRef.current?.abort(), []);

  // The exposed clock is quantized to 250 ms. Sample at that cadence while
  // retaining the audio/wall-clock anchor between native updates.
  useEffect(() => {
    if (!isPlaying || !interpolateProgress) return;
    const tick = () => {
      const { audioTime, wallTime } = anchorRef.current;
      const elapsed = (performance.now() - wallTime) / 1000;
      const estimated = audioTime + elapsed;
      const d = adapter.duration();
      const next = quantizeTime(estimated, d);
      setCurrentTime((prev) => (prev === next ? prev : next));
    };
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [adapter, interpolateProgress, isPlaying]);

  const state = useMemo<PlayerState>(
    () => ({
      current,
      queue,
      index,
      isPlaying,
      volume,
      muted,
      shuffle,
      repeat,
      playbackError,
    }),
    [current, queue, index, isPlaying, volume, muted, shuffle, repeat, playbackError],
  );

  const controls = useMemo<PlayerControls>(
    () => ({
      play,
      playNext,
      resume,
      pause,
      toggle,
      next,
      prev,
      jumpTo,
      seek,
      setVolume,
      setMuted: setMutedValue,
      toggleMute,
      setShuffle,
      toggleShuffle,
      setRepeat,
      cycleRepeat,
    }),
    [
      play,
      playNext,
      resume,
      pause,
      toggle,
      next,
      prev,
      jumpTo,
      seek,
      setVolume,
      setMutedValue,
      toggleMute,
      setShuffle,
      toggleShuffle,
      setRepeat,
      cycleRepeat,
    ],
  );

  const time = useMemo<TimeState>(
    () => ({ currentTime, duration }),
    [currentTime, duration],
  );

  return { state, controls, time };
}
