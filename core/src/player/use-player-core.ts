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
}

export interface UsePlayerCoreReturn {
  state: PlayerState;
  controls: PlayerControls;
  time: TimeState;
}

const TIME_STATE_GRANULARITY_SEC = 0.25;

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
  const [muted, setMuted] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState<RepeatMode>("off");
  const playbackReportedRef = useRef<string | null>(null);
  const loadedTrackIdRef = useRef<string | null>(null);
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
      if (cancelled || v == null) return;
      const parsed = parseFloat(v);
      if (Number.isFinite(parsed)) setVolumeState(clampVolume(parsed));
    });
    return () => {
      cancelled = true;
    };
  }, [storage]);

  // Push volume / mute to the adapter and persist.
  useEffect(() => {
    adapter.setVolume(volume);
    adapter.setMuted(muted);
    void storage.setItem(VOLUME_STORAGE_KEY, String(volume));
  }, [adapter, storage, volume, muted]);

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

  const next = useCallback<PlayerControls["next"]>(() => {
    if (!queue.length) return;
    const ni = index + 1;
    if (ni >= queue.length) {
      if (repeat !== "all") return;
      // Wrap. If shuffle is on, reshuffle for a fresh pass so you don't
      // replay the same permutation.
      if (shuffle && sourceQueue.length > 1) {
        const reshuffled = fisherYatesWithAnchor(sourceQueue, null);
        setQueue(reshuffled);
        setIndex(0);
        setCurrent(reshuffled[0] ?? null);
      } else {
        setIndex(0);
        setCurrent(queue[0]);
      }
      setIsPlaying(true);
      playbackReportedRef.current = null;
      return;
    }
    setIndex(ni);
    setCurrent(queue[ni]);
    setIsPlaying(true);
    playbackReportedRef.current = null;
  }, [queue, index, shuffle, repeat, sourceQueue]);

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
    setIndex(ni);
    setCurrent(queue[ni]);
    setIsPlaying(true);
    playbackReportedRef.current = null;
  }, [adapter, queue, index]);

  const jumpTo = useCallback<PlayerControls["jumpTo"]>(
    (i) => {
      if (i < 0 || i >= queue.length) return;
      setIndex(i);
      setCurrent(queue[i]);
      setIsPlaying(true);
      playbackReportedRef.current = null;
    },
    [queue],
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

  const toggleShuffle = useCallback<PlayerControls["toggleShuffle"]>(() => {
    const turningOn = !shuffle;
    setShuffle(turningOn);
    if (!queue.length) return;
    if (turningOn) {
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

  const cycleRepeat = useCallback<PlayerControls["cycleRepeat"]>(
    () => setRepeat((r) => nextRepeatMode(r)),
    [],
  );

  // When the track changes, replace the adapter's source and (optionally)
  // kick off playback.
  useEffect(() => {
    if (!current) return;
    if (loadedTrackIdRef.current === current.id) return;
    loadedTrackIdRef.current = current.id;
    adapter.load(streamUrl(current.id));
    if (isPlaying) {
      adapter.play().catch(() => setIsPlaying(false));
    }
  }, [adapter, current, isPlaying]);

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
      // Fire a single /play ping once past 30s OR >=50% of duration.
      const trackId = current?.id;
      const now = adapter.currentTime();
      const d = adapter.duration();
      if (
        trackId &&
        playbackReportedRef.current !== trackId &&
        shouldReportPlay(now, d)
      ) {
        playbackReportedRef.current = trackId;
        const completion = d > 0 ? now / d : 0;
        void api.recordPlay(trackId, completion).catch(() => {});
      }
    });
    const offMeta = adapter.on("loadedmetadata", () => {
      setDuration(adapter.duration() || 0);
      syncAnchor();
      setCurrentTime(quantizeTime(adapter.currentTime(), adapter.duration()));
    });
    const offEnd = adapter.on("ended", () => {
      if (repeat === "one") {
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
    const offPlay = adapter.on("play", () => syncAnchor());
    const offPause = adapter.on("pause", () => {
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
  }, [adapter, current, next, repeat]);

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
      toggle,
      next,
      prev,
      jumpTo,
      seek,
      setVolume,
      toggleMute,
      toggleShuffle,
      cycleRepeat,
    }),
    [
      play,
      toggle,
      next,
      prev,
      jumpTo,
      seek,
      setVolume,
      toggleMute,
      toggleShuffle,
      cycleRepeat,
    ],
  );

  const time = useMemo<TimeState>(
    () => ({ currentTime, duration }),
    [currentTime, duration],
  );

  return { state, controls, time };
}
