import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api, streamUrl, type TrackListItem } from "../api";
import type { Storage } from "../storage";
import type { AudioAdapter } from "./audio-adapter";
import {
  VOLUME_STORAGE_KEY,
  clampVolume,
  fisherYatesWithAnchor,
  nextRepeatMode,
  shouldReportPlay,
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
}

export interface UsePlayerCoreReturn {
  state: PlayerState;
  controls: PlayerControls;
  time: TimeState;
}

const TIME_STATE_GRANULARITY_SEC = 0.25;
const NEXT_TRACK_PREPARE_RATIO = 0.7;

function quantizeTime(seconds: number, duration: number): number {
  const clamped =
    Number.isFinite(duration) && duration > 0
      ? Math.min(Math.max(0, seconds), duration)
      : Math.max(0, seconds);
  return Math.round(clamped / TIME_STATE_GRANULARITY_SEC) * TIME_STATE_GRANULARITY_SEC;
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
  const playbackReportedRef = useRef<string | null>(null);
  const lastFMScrobbledRef = useRef<string | null>(null);
  const trackStartedAtRef = useRef(Math.floor(Date.now() / 1000));
  const listenedSecondsRef = useRef(0);
  const listeningTickRef = useRef<number | null>(null);
  const loadedTrackIdRef = useRef<string | null>(null);
  const preparedNextRef = useRef<{ trackId: string; uri: string } | null>(null);
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

  useEffect(() => {
    if (!volumeHydrated) return;
    void storage.setItem(VOLUME_STORAGE_KEY, String(volume));
  }, [storage, volume, volumeHydrated]);

  const play = useCallback<PlayerControls["play"]>(
    (track, q) => {
      const base = q && q.length ? q : [track];
      setSourceQueue(base);
      if (shuffle) {
        // Pin the clicked track at position 0, shuffle the rest. The user
        // will play through every track exactly once before any wrap.
        setQueue(fisherYatesWithAnchor(base, track.id));
        setIndex(0);
      } else {
        setQueue(base);
        setIndex(Math.max(0, base.findIndex((t) => t.id === track.id)));
      }
      setCurrent(track);
      setIsPlaying(true);
      playbackReportedRef.current = null;
    },
    [shuffle],
  );

  const toggle = useCallback<PlayerControls["toggle"]>(() => {
    if (!current) return;
    setIsPlaying((p) => !p);
  }, [current]);

  const resume = useCallback<PlayerControls["resume"]>(() => {
    if (current) setIsPlaying(true);
  }, [current]);

  const pause = useCallback<PlayerControls["pause"]>(() => {
    if (current) setIsPlaying(false);
  }, [current]);

  const resolvePlayableUri = useCallback(
    (trackId: string) => resolveTrackUri?.(trackId) || streamUrl(trackId),
    [resolveTrackUri],
  );

  const clearPreparedNext = useCallback(() => {
    preparedNextRef.current = null;
    adapter.clearPrepared?.();
  }, [adapter]);

  const next = useCallback<PlayerControls["next"]>(() => {
    if (!queue.length) return;
    const ni = index + 1;
    let nextTrack: TrackListItem | null = null;
    let nextIndex = ni;
    let nextQueue: TrackListItem[] | null = null;
    if (ni >= queue.length) {
      if (repeat !== "all") {
        clearPreparedNext();
        setIsPlaying(false);
        return;
      }
      // Wrap. If shuffle is on, reshuffle for a fresh pass so you don't
      // replay the same permutation.
      if (shuffle && sourceQueue.length > 1) {
        nextQueue = fisherYatesWithAnchor(sourceQueue, null);
        nextTrack = nextQueue[0] ?? null;
      } else {
        nextTrack = queue[0] ?? null;
      }
      nextIndex = 0;
    } else {
      nextTrack = queue[ni] ?? null;
    }

    if (!nextTrack) {
      clearPreparedNext();
      setIsPlaying(false);
      return;
    }

    const prepared = preparedNextRef.current;
    const nextUri = resolvePlayableUri(nextTrack.id);
    const activated =
      prepared?.trackId === nextTrack.id &&
      prepared.uri === nextUri &&
      adapter.activatePrepared?.(nextUri) === true;
    if (activated) {
      loadedTrackIdRef.current = nextTrack.id;
    } else {
      adapter.clearPrepared?.();
    }
    preparedNextRef.current = null;

    if (nextQueue) setQueue(nextQueue);
    setIndex(nextIndex);
    setCurrent(nextTrack);
    setIsPlaying(true);
    setCurrentTime(0);
    setDuration(activated ? adapter.duration() || 0 : 0);
    anchorRef.current = { audioTime: 0, wallTime: performance.now() };
    playbackReportedRef.current = null;
  }, [
    adapter,
    clearPreparedNext,
    index,
    queue,
    repeat,
    resolvePlayableUri,
    shuffle,
    sourceQueue,
  ]);

  const prev = useCallback<PlayerControls["prev"]>(() => {
    if (!queue.length) return;
    // If you're more than 3s into the current track, restart instead of
    // going back.
    if (adapter.currentTime() > 3) {
      adapter.seek(0);
      setCurrentTime(0);
      return;
    }
    const ni = Math.max(0, index - 1);
    clearPreparedNext();
    setIndex(ni);
    setCurrent(queue[ni]);
    setIsPlaying(true);
    playbackReportedRef.current = null;
  }, [adapter, clearPreparedNext, queue, index]);

  const jumpTo = useCallback<PlayerControls["jumpTo"]>(
    (i) => {
      if (i < 0 || i >= queue.length) return;
      clearPreparedNext();
      setIndex(i);
      setCurrent(queue[i]);
      setIsPlaying(true);
      playbackReportedRef.current = null;
    },
    [clearPreparedNext, queue],
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
    setShuffleState(value);
    if (!queue.length) return;
    if (value) {
      // Reshuffle remaining queue; keep the currently playing track at 0 so
      // playback doesn't jump.
      const source = sourceQueue.length ? sourceQueue : queue;
      const pinned = current?.id ?? null;
      setQueue(fisherYatesWithAnchor(source, pinned));
      setIndex(0);
    } else {
      // Restore the original order; keep the current track "playing" at its
      // natural position.
      const source = sourceQueue.length ? sourceQueue : queue;
      setQueue(source);
      setIndex(
        current ? Math.max(0, source.findIndex((t) => t.id === current.id)) : 0,
      );
    }
  }, [shuffle, queue, sourceQueue, current]);

  const toggleShuffle = useCallback<PlayerControls["toggleShuffle"]>(() => {
    setShuffle(!shuffle);
  }, [setShuffle, shuffle]);

  const setRepeat = useCallback<PlayerControls["setRepeat"]>((value) => {
    setRepeatState(value);
  }, []);

  const cycleRepeat = useCallback<PlayerControls["cycleRepeat"]>(
    () => setRepeatState((r) => nextRepeatMode(r)),
    [],
  );

  const nextTrackToPrepare = useMemo(() => {
    if (!current || repeat === "one" || !queue.length) return null;
    if (index + 1 < queue.length) return queue[index + 1] ?? null;
    // A repeat-all shuffle creates a fresh permutation at the boundary, so
    // its next track is intentionally unknown until then.
    if (repeat === "all" && !shuffle) return queue[0] ?? null;
    return null;
  }, [current, index, queue, repeat, shuffle]);

  useEffect(() => {
    const prepared = preparedNextRef.current;
    if (prepared && prepared.trackId !== nextTrackToPrepare?.id) {
      clearPreparedNext();
    }
  }, [clearPreparedNext, nextTrackToPrepare?.id]);

  // When the track changes, replace the adapter's source and (optionally)
  // kick off playback.
  useEffect(() => {
    if (!current) return;
    if (loadedTrackIdRef.current === current.id) return;
    loadedTrackIdRef.current = current.id;
    adapter.load(resolvePlayableUri(current.id));
    if (isPlaying) {
      adapter.play().catch(() => setIsPlaying(false));
    }
  }, [adapter, current, isPlaying, resolvePlayableUri]);

  useEffect(() => {
    if (!current) return;
    trackStartedAtRef.current = Math.floor(Date.now() / 1000);
    lastFMScrobbledRef.current = null;
    listenedSecondsRef.current = 0;
    listeningTickRef.current = performance.now();
  }, [current?.id]);

  useEffect(() => {
    if (current && isPlaying) {
      void api.updateNowPlaying(current.id).catch(() => {});
    }
  }, [current?.id, isPlaying]);

  // When isPlaying toggles without a track change, sync the adapter.
  useEffect(() => {
    if (!current) return;
    if (isPlaying) {
      adapter.play().catch(() => setIsPlaying(false));
    } else {
      adapter.pause();
    }
  }, [adapter, isPlaying, current]);

  // Wire adapter events → hook state.
  useEffect(() => {
    const syncListenedTime = () => {
      const now = performance.now();
      const previous = listeningTickRef.current;
      if (previous != null && isPlaying) {
        listenedSecondsRef.current += Math.max(0, (now - previous) / 1000);
      }
      listeningTickRef.current = isPlaying ? now : null;
    };
    const syncAnchor = () => {
      anchorRef.current = {
        audioTime: adapter.currentTime(),
        wallTime: performance.now(),
      };
    };
    const offTime = adapter.on("timeupdate", () => {
      // Gently resync the anchor on every native update to prevent drift, but
      // don't touch React state here — the rAF loop owns currentTime.
      syncAnchor();
      syncListenedTime();
      // Fire a single /play ping once past 30s OR >=50% of duration.
      const trackId = current?.id;
      const now = adapter.currentTime();
      const d = adapter.duration();
      if (
        nextTrackToPrepare &&
        adapter.prepareNext &&
        d > 0 &&
        now / d >= NEXT_TRACK_PREPARE_RATIO &&
        preparedNextRef.current?.trackId !== nextTrackToPrepare.id
      ) {
        const uri = resolvePlayableUri(nextTrackToPrepare.id);
        preparedNextRef.current = { trackId: nextTrackToPrepare.id, uri };
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
    });
    const offMeta = adapter.on("loadedmetadata", () => {
      setDuration(adapter.duration() || 0);
      syncAnchor();
      setCurrentTime(quantizeTime(adapter.currentTime(), adapter.duration()));
    });
    const offEnd = adapter.on("ended", () => {
      if (repeat === "one") {
        // Restart the same track. Re-arm play reporting so each loop counts
        // as a fresh play — otherwise playbackReportedRef stays pinned to this
        // trackId and the timeupdate guard never fires recordPlay again.
        playbackReportedRef.current = null;
        lastFMScrobbledRef.current = null;
        trackStartedAtRef.current = Math.floor(Date.now() / 1000);
        listenedSecondsRef.current = 0;
        listeningTickRef.current = performance.now();
        if (current) void api.updateNowPlaying(current.id).catch(() => {});
        adapter.seek(0);
        void adapter.play().catch(() => {});
        return;
      }
      next();
    });
    const offSeeked = adapter.on("seeked", () => {
      syncAnchor();
      setCurrentTime(quantizeTime(adapter.currentTime(), adapter.duration()));
    });
    const offPlay = adapter.on("play", () => {
      listeningTickRef.current = performance.now();
      syncAnchor();
    });
    const offPause = adapter.on("pause", () => {
      syncListenedTime();
      listeningTickRef.current = null;
      syncAnchor();
      setCurrentTime(quantizeTime(adapter.currentTime(), adapter.duration()));
    });
    return () => {
      offTime();
      offMeta();
      offEnd();
      offSeeked();
      offPlay();
      offPause();
    };
  }, [
    adapter,
    current,
    isPlaying,
    next,
    nextTrackToPrepare,
    repeat,
    resolvePlayableUri,
  ]);

  useEffect(() => () => adapter.clearPrepared?.(), [adapter]);

  // rAF-driven smoothing: while playing, interpolate between the adapter's
  // last-known position and the current wall-clock moment. Native update
  // cadence is ~2–4 Hz on most platforms, so reading position directly each
  // frame still looks jerky — the wall clock gives us 60fps motion.
  useEffect(() => {
    if (!isPlaying || !interpolateProgress) return;
    let raf = 0;
    const tick = () => {
      const { audioTime, wallTime } = anchorRef.current;
      const elapsed = (performance.now() - wallTime) / 1000;
      const estimated = audioTime + elapsed;
      const d = adapter.duration();
      const next = quantizeTime(estimated, d);
      setCurrentTime((prev) => (prev === next ? prev : next));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
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
    }),
    [current, queue, index, isPlaying, volume, muted, shuffle, repeat],
  );

  const controls = useMemo<PlayerControls>(
    () => ({
      play,
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
