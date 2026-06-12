import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  type AudioLockScreenOptions,
  type AudioMetadata,
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
 * `expo-audio` doesn't emit a discrete event for it.
 */
export function useExpoAudioAdapter(): ExpoAudioAdapter {
  // We only need coarse native ticks because the UI smooths progress locally.
  const player = useCompatibleAudioPlayer(1000);

  const listenersRef = useRef<Map<AudioAdapterEvent, Set<() => void>>>(
    new Map(),
  );
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
      const playing = status.playing;
      const didJustFinish = status.didJustFinish;
      const duration = status.duration;

      if (!prev.isLoaded && isLoaded) {
        dispatch("loadedmetadata");
      } else if (duration > 0 && prev.duration === 0) {
        dispatch("loadedmetadata");
      }

      if (!prev.playing && playing) dispatch("play");
      if (prev.playing && !playing) dispatch("pause");
      if (isLoaded) dispatch("timeupdate");
      if (!prev.didJustFinish && didJustFinish) dispatch("ended");

      prevStatusRef.current = { isLoaded, playing, didJustFinish, duration };
    });

    return () => {
      subscription.remove();
    };
  }, [dispatch, player]);

  const adapter = useMemo<ExpoAudioAdapter>(
    () => ({
      load(url) {
        player.replace({ uri: url });
        // Reset the status diff so the new track's first loadedmetadata fires.
        prevStatusRef.current.isLoaded = false;
        prevStatusRef.current.duration = 0;
        prevStatusRef.current.didJustFinish = false;
      },
      async play() {
        player.play();
      },
      pause() {
        player.pause();
      },
      seek(seconds) {
        void player.seekTo(seconds);
        dispatch("seeked");
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
        listenersRef.current.clear();
      },
    }),
    [dispatch, player],
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
