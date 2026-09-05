import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  clearPreloadedSource,
  preload,
  type AudioLockScreenOptions,
  type AudioMetadata,
  type AudioStatus,
} from "expo-audio";
import { useReleasingSharedObject } from "expo-modules-core";
import AudioModule from "expo-audio/build/AudioModule";
import type { AudioPlayer } from "expo-audio/build/AudioModule.types";
import type {
  AudioAdapter,
  AudioAdapterEvent,
} from "@music-library/core";

function isReleasedSharedObjectError(error: unknown) {
  if (!(error instanceof Error)) return false;
  return (
    error.message.includes("NativeSharedObjectNotFoundException") ||
    error.message.includes("Unable to find the native shared object")
  );
}

export interface ExpoAudioAdapter extends AudioAdapter {
  setActiveForLockScreen(
    active: boolean,
    metadata?: AudioMetadata,
    options?: AudioLockScreenOptions,
  ): void;
  updateLockScreenMetadata(metadata: AudioMetadata): void;
  clearLockScreenControls(): void;
}

/**
 * Mobile `AudioAdapter` backed by `expo-audio`. The native player is exposed
 * through a hook so React can release the shared object on unmount.
 *
 * Event translation: `expo-audio`'s single `playbackStatusUpdate` stream of
 * status snapshots is diffed into the web-style events the shared
 * `usePlayerCore` hook expects (loadedmetadata, play, pause, timeupdate,
 * ended). `seeked` is synthesized from the adapter's own `seek()` call since
 * `expo-audio` doesn't emit a discrete event for it. `pause` is dispatched
 * only for genuine pauses (user or system — e.g. headphones disconnecting or
 * an audio interruption): buffering stalls, source swaps and natural track
 * end all pass through `playing: false` natively but fire no `pause` in the
 * web event model, and the core mirrors `pause` straight into `isPlaying`.
 */
export function useExpoAudioAdapter(): ExpoAudioAdapter {
  // We only need coarse native ticks because the UI smooths progress locally.
  const player = useCompatibleAudioPlayer(1000);

  const listenersRef = useRef<Map<AudioAdapterEvent, Set<() => void>>>(
    new Map(),
  );
  const preparedRef = useRef<{
    url: string;
    ready: boolean;
    generation: number;
  } | null>(null);
  const prepareGenerationRef = useRef(0);
  const pendingPreparedPlaybackRef = useRef<{ shouldPlay: boolean } | null>(
    null,
  );
  // In-flight seekTo(). expo-audio's seekTo is an async native function while
  // play() is sync, so an unawaited seek(0)+play() pair reaches the native
  // player in reverse order. At a natural track end (repeat-one restart) the
  // reversed play() is consumed by the still-ended item and iOS re-pauses,
  // leaving the track stopped at 0:00. play() awaits this to restore ordering.
  const pendingSeekRef = useRef<Promise<void> | null>(null);
  const prevStatusRef = useRef<{
    isLoaded: boolean;
    playing: boolean;
    didJustFinish: boolean;
    duration: number;
  }>({
    isLoaded: false,
    playing: false,
    didJustFinish: false,
    duration: 0,
  });

  const dispatch = useCallback((event: AudioAdapterEvent) => {
    const set = listenersRef.current.get(event);
    if (!set) return;
    for (const fn of set) fn();
  }, []);

  const startPreparedPlaybackIfReady = useCallback(
    (status: AudioStatus) => {
      const pending = pendingPreparedPlaybackRef.current;
      if (!pending || !status.isLoaded || status.didJustFinish) return;
      pendingPreparedPlaybackRef.current = null;
      if (pending.shouldPlay) player.play();
    },
    [player],
  );

  // Subscribe directly to native player events so the app doesn't re-render on
  // every playback tick.
  useEffect(() => {
    const current = player.currentStatus;
    prevStatusRef.current = {
      isLoaded: current.isLoaded,
      playing: current.playing,
      didJustFinish: current.didJustFinish,
      duration: current.duration,
    };

    const subscription = player.addListener("playbackStatusUpdate", (status) => {
      const prev = prevStatusRef.current;
      const isLoaded = status.isLoaded;
      const didJustFinish = status.didJustFinish;
      const duration = status.duration;
      // iOS reports `playing: false` while the player is merely rebuffering
      // (timeControlStatus "waitingToPlayAtSpecifiedRate"), but a stall is
      // not a pause — the web event model this adapter translates to fires
      // `waiting` there, never `pause`, and the core mirrors `pause` into
      // isPlaying. Fold stalls back into "playing" the way Android's native
      // side already does. `noItemToPlay` is excluded: a queue waiting on a
      // source is not playback.
      const playing =
        status.playing ||
        (status.timeControlStatus === "waitingToPlayAtSpecifiedRate" &&
          status.reasonForWaitingToPlay !== "noItemToPlay");

      startPreparedPlaybackIfReady(status);

      if (!prev.isLoaded && isLoaded) {
        dispatch("loadedmetadata");
      } else if (duration > 0 && prev.duration === 0) {
        dispatch("loadedmetadata");
      }

      if (!prev.playing && playing) dispatch("play");
      // Natural track end also passes through playing=false, but the web
      // contract fires only `ended` there; dispatching `pause` too would
      // flip the core's isPlaying off while its own `ended` handler is
      // advancing to the next track.
      if (prev.playing && !playing && !didJustFinish) dispatch("pause");
      if (isLoaded) dispatch("timeupdate");
      if (!prev.didJustFinish && didJustFinish) dispatch("ended");

      prevStatusRef.current = { isLoaded, playing, didJustFinish, duration };
    });

    return () => {
      subscription.remove();
    };
  }, [dispatch, player, startPreparedPlaybackIfReady]);

  const adapter = useMemo<ExpoAudioAdapter>(
    () => ({
      load(url) {
        pendingPreparedPlaybackRef.current = null;
        // Seeks against the outgoing item must not delay the new track.
        pendingSeekRef.current = null;
        const prepared = preparedRef.current;
        if (prepared) {
          preparedRef.current = null;
          prepareGenerationRef.current += 1;
          void clearPreloadedSource(prepared.url).catch(() => {});
        }
        player.replace({ uri: url });
        // Reset the status diff so the new track's first loadedmetadata fires.
        prevStatusRef.current.isLoaded = false;
        prevStatusRef.current.duration = 0;
        prevStatusRef.current.didJustFinish = false;
        // The outgoing track may have been playing; the incoming item's
        // paused statuses during the swap are a transition, not a pause the
        // core should mirror into isPlaying.
        prevStatusRef.current.playing = false;
      },
      prepareNext(url) {
        if (preparedRef.current?.url === url) return;
        const previous = preparedRef.current;
        if (previous) void clearPreloadedSource(previous.url).catch(() => {});
        const generation = ++prepareGenerationRef.current;
        preparedRef.current = { url, ready: false, generation };
        void preload(url, { preferredForwardBufferDuration: 20 })
          .then(() => {
            const prepared = preparedRef.current;
            if (prepared?.url === url && prepared.generation === generation) {
              prepared.ready = true;
            }
          })
          .catch(() => {
            const prepared = preparedRef.current;
            if (prepared?.url === url && prepared.generation === generation) {
              preparedRef.current = null;
            }
          });
      },
      activatePrepared(url) {
        const prepared = preparedRef.current;
        if (!prepared || prepared.url !== url || !prepared.ready) return false;
        preparedRef.current = null;
        prepareGenerationRef.current += 1;
        try {
          // A preloaded AVPlayerItem can still report loading briefly while it
          // is moved onto the active player. At a natural track end the old
          // player is already paused, so expo-audio's replace() deliberately
          // does not auto-resume it. Defer play until the replacement emits a
          // loaded status; an immediate play() can be consumed by the ended
          // item and leave the shared timeline running over silent audio.
          pendingPreparedPlaybackRef.current = {
            shouldPlay: true,
          };
          pendingSeekRef.current = null;
          player.replace({ uri: url });
          prevStatusRef.current.isLoaded = false;
          prevStatusRef.current.duration = 0;
          prevStatusRef.current.didJustFinish = false;
          // Same as load(): the swap's paused statuses are not a real pause.
          prevStatusRef.current.playing = false;
          startPreparedPlaybackIfReady(player.currentStatus);
          // replace() has consumed the native preload; Android/web retain the
          // cache entry until explicitly cleared, while iOS treats this as a
          // harmless no-op after consumption.
          void clearPreloadedSource(url).catch(() => {});
          return true;
        } catch {
          pendingPreparedPlaybackRef.current = null;
          void clearPreloadedSource(url).catch(() => {});
          return false;
        }
      },
      clearPrepared() {
        pendingPreparedPlaybackRef.current = null;
        const prepared = preparedRef.current;
        preparedRef.current = null;
        prepareGenerationRef.current += 1;
        if (prepared) void clearPreloadedSource(prepared.url).catch(() => {});
      },
      async play() {
        const pending = pendingPreparedPlaybackRef.current;
        if (pending) {
          pending.shouldPlay = true;
          startPreparedPlaybackIfReady(player.currentStatus);
          return;
        }
        const pendingSeek = pendingSeekRef.current;
        if (pendingSeek) {
          await pendingSeek;
          // A load()/activatePrepared() while the seek settled owns playback
          // ordering itself; don't also start the (replaced) item.
          if (pendingPreparedPlaybackRef.current) return;
        }
        player.play();
      },
      pause() {
        const pending = pendingPreparedPlaybackRef.current;
        if (pending) pending.shouldPlay = false;
        player.pause();
      },
      seek(seconds) {
        const seekPromise = player.seekTo(seconds).then(
          () => {
            if (pendingSeekRef.current !== seekPromise) return;
            pendingSeekRef.current = null;
            // The core and remote activity publisher read currentTime on
            // this event, so it must wait until the native seek completes.
            dispatch("seeked");
          },
          () => {
            if (pendingSeekRef.current === seekPromise) {
              pendingSeekRef.current = null;
            }
          },
        );
        pendingSeekRef.current = seekPromise;
      },
      setVolume(v) {
        player.volume = v;
      },
      setMuted(m) {
        player.muted = m;
      },
      currentTime() {
        return player.currentTime ?? 0;
      },
      duration() {
        return player.duration ?? 0;
      },
      setActiveForLockScreen(active, metadata, options) {
        player.setActiveForLockScreen(active, metadata, options);
      },
      updateLockScreenMetadata(metadata) {
        player.updateLockScreenMetadata(metadata);
      },
      clearLockScreenControls() {
        try {
          player.clearLockScreenControls();
        } catch (error) {
          if (!isReleasedSharedObjectError(error)) throw error;
        }
      },
      on(event, handler) {
        let set = listenersRef.current.get(event);
        if (!set) {
          set = new Set();
          listenersRef.current.set(event, set);
        }
        set.add(handler);
        return () => {
          set!.delete(handler);
        };
      },
      dispose() {
        pendingPreparedPlaybackRef.current = null;
        const prepared = preparedRef.current;
        preparedRef.current = null;
        prepareGenerationRef.current += 1;
        if (prepared) void clearPreloadedSource(prepared.url).catch(() => {});
        listenersRef.current.clear();
      },
    }),
    [dispatch, player, startPreparedPlaybackIfReady],
  );

  return adapter;
}

function useCompatibleAudioPlayer(updateInterval: number): AudioPlayer {
  return useReleasingSharedObject(
    () => createCompatibleAudioPlayer(updateInterval),
    [updateInterval],
  );
}

function createCompatibleAudioPlayer(updateInterval: number): AudioPlayer {
  const AudioPlayerCtor = AudioModule.AudioPlayer as unknown as {
    new (
      source: null,
      updateInterval: number,
      keepAudioSessionActive: boolean,
      preferredForwardBufferDuration?: number,
    ): AudioPlayer;
  };

  // keepAudioSessionActive=true: otherwise iOS deactivates the AVAudioSession
  // on track-end (`onPlaybackComplete`), which suspends background JS before
  // our "ended" handler can load and start the next track.
  try {
    return new AudioPlayerCtor(null, updateInterval, true, 0);
  } catch (error) {
    if (!isLegacyAudioPlayerConstructorError(error)) throw error;
    return new AudioPlayerCtor(null, updateInterval, true);
  }
}

function isLegacyAudioPlayerConstructorError(error: unknown) {
  return (
    error instanceof Error &&
    error.message.includes("Received 4 arguments, but 3 was expected")
  );
}
