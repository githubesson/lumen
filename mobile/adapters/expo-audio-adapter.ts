import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clearPreloadedSource,
  preload,
  type AudioLockScreenOptions,
  type AudioMetadata,
  type AudioStatus,
} from "expo-audio";
import { useReleasingSharedObject } from "expo-modules-core";
import { AppState } from "react-native";
import * as Updates from "expo-updates";
import { createPlaybackDiagnostics } from "../lib/diagnostics/playback";
import AudioModule from "expo-audio/build/AudioModule";
import type { AudioPlayer } from "expo-audio/build/AudioModule.types";
import type {
  AudioAdapter,
  AudioAdapterEvent,
} from "@music-library/core";
import { createAudioAdapterEmitter } from "@music-library/core/player/audio-adapter";

// How often a crossfade steps the two players' volumes.
const FADE_STEP_MS = 50;

function isReleasedSharedObjectError(error: unknown) {
  if (!(error instanceof Error)) return false;
  return (
    error.message.includes("NativeSharedObjectNotFoundException") ||
    error.message.includes("Unable to find the native shared object")
  );
}

function isPlaybackActive(status: AudioStatus): boolean {
  return status.playing ||
    (status.timeControlStatus === "waitingToPlayAtSpecifiedRate" &&
      status.reasonForWaitingToPlay !== "noItemToPlay");
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
 * ended, error). `seeked` is synthesized from the adapter's own `seek()` call
 * since `expo-audio` doesn't emit a discrete event for it. `pause` is dispatched
 * only for genuine pauses (user or system — e.g. headphones disconnecting or
 * an audio interruption): buffering stalls, source swaps and natural track
 * end all pass through `playing: false` natively but must not be forwarded
 * as pauses, since the core mirrors `pause` straight into `isPlaying`.
 *
 * Smooth mix plays the next song on a second native player while the current
 * one fades out, and the two then swap roles. Only the active player's
 * statuses become events, and the lock screen moves with it. Without smooth
 * mix only the first player ever plays.
 */
export function useExpoAudioAdapter(): ExpoAudioAdapter {
  // We only need coarse native ticks because the UI smooths progress locally.
  const first = useCompatibleAudioPlayer(1000);
  const second = useCompatibleAudioPlayer(1000);
  const players = useMemo(() => [first, second] as const, [first, second]);
  // Which player has the current song; the other is idle or fading out.
  const activeIndexRef = useRef(0);
  const activePlayer = useCallback(() => players[activeIndexRef.current], [players]);
  const diagnostics = useMemo(
    () => createPlaybackDiagnostics(() => activePlayer().currentStatus),
    [activePlayer],
  );

  const [listeners] = useState(createAudioAdapterEmitter);
  const preparedRef = useRef<{
    url: string;
    ready: boolean;
    generation: number;
  } | null>(null);
  const prepareGenerationRef = useRef(0);
  const pendingPreparedPlaybackRef = useRef<{ shouldPlay: boolean } | null>(
    null,
  );
  const awaitingSourceStatusRef = useRef(false);
  // Whether the source replaced by the last swap was still loading, so its
  // failure could already be on its way when the swap happened.
  const outgoingMayFailRef = useRef(false);
  const hasSourceRef = useRef(false);
  // In-flight seekTo(). expo-audio's seekTo is an async native function while
  // play() is sync, so an unawaited seek(0)+play() pair reaches the native
  // player in reverse order. At a natural track end (repeat-one restart) the
  // reversed play() is consumed by the still-ended item and iOS re-pauses,
  // leaving the track stopped at 0:00. play() awaits this to restore ordering.
  const pendingSeekRef = useRef<Promise<void> | null>(null);
  // Invalidate play() calls waiting on a seek when a newer command takes over.
  const playbackGenerationRef = useRef(0);
  const prevStatusRef = useRef<{
    isLoaded: boolean;
    playing: boolean;
    didJustFinish: boolean;
    duration: number;
    failed: boolean;
  }>({
    isLoaded: false,
    playing: false,
    didJustFinish: false,
    duration: 0,
    failed: false,
  });
  // The user's volume. A crossfade scales each player's share of it.
  const volumeRef = useRef(1);
  // A crossfade under way: `outgoing` plays on, fading out, while the active
  // player fades in.
  const fadeRef = useRef<{
    outgoing: AudioPlayer;
    startedAt: number;
    seconds: number;
    timer: ReturnType<typeof setInterval>;
  } | null>(null);
  // What the lock screen shows, so it can move to the other player.
  const lockScreenRef = useRef<{
    metadata?: AudioMetadata;
    options?: AudioLockScreenOptions;
  } | null>(null);

  const dispatch = useCallback((event: AudioAdapterEvent) => {
    if (event !== "timeupdate") {
      diagnostics.record("audio-event", {
        event,
        pendingStart: Boolean(pendingPreparedPlaybackRef.current),
        pendingSeek: Boolean(pendingSeekRef.current),
      });
    }
    listeners.emit(event);
  }, [diagnostics, listeners]);

  useEffect(() => {
    diagnostics.record("audio-session", {
      updateId: Updates.updateId ?? "embedded",
      runtime: Updates.runtimeVersion ?? "unknown",
      appState: AppState.currentState,
    });
    const subscription = AppState.addEventListener("change", (appState) => {
      diagnostics.record("audio-app-state", { appState });
    });
    return () => subscription.remove();
  }, [diagnostics]);

  const startPreparedPlaybackIfReady = useCallback(
    (status: AudioStatus) => {
      const pending = pendingPreparedPlaybackRef.current;
      if (!pending || !status.isLoaded || status.didJustFinish) return;
      pendingPreparedPlaybackRef.current = null;
      if (pending.shouldPlay) {
        diagnostics.record("audio-prepared-start", {}, status);
        activePlayer().play();
        diagnostics.record("audio-play-issued");
      }
    },
    [activePlayer, diagnostics],
  );

  // Subscribe directly to native player events so the app doesn't re-render on
  // every playback tick.
  useEffect(() => {
    const current = activePlayer().currentStatus;
    prevStatusRef.current = {
      isLoaded: current.isLoaded,
      playing: current.playing,
      didJustFinish: current.didJustFinish,
      duration: current.duration,
      failed: false,
    };

    const subscriptions = players.map((player) => player.addListener("playbackStatusUpdate", (status) => {
      if (player !== activePlayer()) {
        // Besides the active player, only one fading out may play. Something
        // native restarting the other (Android resuming every player when
        // audio focus returns) would put an old song under the current one.
        if (status.playing && fadeRef.current?.outgoing !== player) player.pause();
        return;
      }
      diagnostics.observe(status, Boolean(pendingPreparedPlaybackRef.current), Boolean(pendingSeekRef.current));
      // A synchronous prepared start can clear the pending-play flag before
      // queued events arrive. Suppress outgoing ends until an ordinary source
      // status arrives, and while a prepared source still awaits playback.
      if (
        status.didJustFinish &&
        (awaitingSourceStatusRef.current || pendingPreparedPlaybackRef.current)
      ) {
        diagnostics.record("audio-end-suppressed", {}, status);
        return;
      }
      const firstSourceStatus = awaitingSourceStatusRef.current;
      const outgoingMayFail = outgoingMayFailRef.current;
      awaitingSourceStatusRef.current = false;
      outgoingMayFailRef.current = false;
      const prev = prevStatusRef.current;
      const isLoaded = status.isLoaded;
      const didJustFinish = status.didJustFinish;
      const duration = status.duration;
      // expo-audio reports a failed source once, in the one status whose
      // `error` is set. A new source that fails at once (a refused stream)
      // reports it in its first status. That status is the outgoing source's
      // failure instead only if that source was still loading when replaced.
      const staleError = Boolean(status.error) && firstSourceStatus && outgoingMayFail;
      if (staleError) diagnostics.record("audio-error-suppressed", {}, status);
      const failed = Boolean(status.error) && !staleError;
      // iOS's periodic observer can see the stopped playhead before its
      // separate end notification arrives. That ordinary snapshot still has
      // didJustFinish=false. Treat it as an end transition, or the core's
      // pause effect can cancel the seek/play that restarts a loop.
      const atEnd =
        isLoaded &&
        Number.isFinite(duration) &&
        duration > 0 &&
        status.currentTime >= duration;
      // iOS reports `playing: false` while the player is merely rebuffering
      // (timeControlStatus "waitingToPlayAtSpecifiedRate"), but a stall is
      // not a pause — the web event model this adapter translates to fires
      // `waiting` there, never `pause`, and the core mirrors `pause` into
      // isPlaying. Fold stalls back into "playing" the way Android's native
      // side already does. `noItemToPlay` is excluded: a queue waiting on a
      // source is not playback.
      let playing = isPlaybackActive(status);
      if (!didJustFinish && playing !== prev.playing) {
        // Events cross the native/JS boundary asynchronously. A source swap
        // can deliver an old noItemToPlay/paused snapshot after the native
        // player has already begun buffering or playing the new song. If we
        // publish that stale pause, the core sends pause() and cancels it.
        // Confirm state transitions against the live getter in BOTH directions
        // so a queued play also cannot undo a newer lock-screen/system pause.
        // didJustFinish is an event-only flag; the live getter cannot replace it.
        const livePlaying = isPlaybackActive(player.currentStatus);
        if (playing !== livePlaying) {
          diagnostics.record("audio-stale-status-ignored", { observedPlaying: playing, livePlaying }, status);
          playing = livePlaying;
        }
      }

      // Commit before dispatch: an ended listener can synchronously replace
      // the source and reset this diff for the incoming track.
      prevStatusRef.current = { isLoaded, playing, didJustFinish, duration, failed };

      // Loading succeeded even if starting playback fails. Publish metadata
      // before that attempt so a paused song still has a usable timeline.
      if (!prev.isLoaded && isLoaded) {
        dispatch("loadedmetadata");
      } else if (duration > 0 && prev.duration === 0) {
        dispatch("loadedmetadata");
      }

      try {
        startPreparedPlaybackIfReady(status);
      } catch (error) {
        // Unlike adapter.play(), this native event callback has no promise
        // for the core to catch. Reflect the failure as paused so it can be
        // retried, and stop processing the snapshot that preceded the error.
        prevStatusRef.current.playing = false;
        console.warn("Could not start prepared audio playback", error);
        dispatch("pause");
        return;
      }

      if (!prev.playing && playing) dispatch("play");
      // Natural track end also passes through playing=false, but our adapter
      // contract fires only `ended` there; dispatching `pause` too would
      // flip the core's isPlaying off while its own `ended` handler is
      // advancing to the next track.
      if (prev.playing && !playing && !didJustFinish && !atEnd) dispatch("pause");
      if (isLoaded) dispatch("timeupdate");
      if (!prev.didJustFinish && didJustFinish) dispatch("ended");
      if (!prev.failed && failed) dispatch("error");
    }));

    return () => {
      for (const subscription of subscriptions) subscription.remove();
    };
  }, [activePlayer, diagnostics, dispatch, players, startPreparedPlaybackIfReady]);

  // Stop a crossfade's volume steps with the players.
  useEffect(
    () => () => {
      const fade = fadeRef.current;
      fadeRef.current = null;
      if (fade) clearInterval(fade.timer);
    },
    [],
  );

  // Before each swap: whether the source being replaced was still loading.
  const noteOutgoingSource = useCallback(() => {
    const outgoing = prevStatusRef.current;
    outgoingMayFailRef.current = hasSourceRef.current && !outgoing.isLoaded && !outgoing.failed;
    hasSourceRef.current = true;
  }, []);

  const adapter = useMemo<ExpoAudioAdapter>(() => {
    // A new source on the active player. Reset the status diff so its first
    // loadedmetadata fires. The outgoing track may have been playing; the
    // incoming item's paused statuses during the swap are a transition, not a
    // pause the core should mirror into isPlaying.
    const resetStatusDiff = () => {
      const prev = prevStatusRef.current;
      prev.isLoaded = false;
      prev.duration = 0;
      prev.didJustFinish = false;
      prev.failed = false;
      prev.playing = false;
    };

    // The user's volume on each player, times its share of a crossfade.
    // Equal-power curves, so the mix doesn't dip halfway through.
    const applyVolume = () => {
      const volume = volumeRef.current;
      const fade = fadeRef.current;
      if (!fade) {
        for (const player of players) player.volume = volume;
        return;
      }
      const progress = Math.min(1, (performance.now() - fade.startedAt) / (fade.seconds * 1000));
      activePlayer().volume = volume * Math.sin((progress * Math.PI) / 2);
      fade.outgoing.volume = volume * Math.cos((progress * Math.PI) / 2);
    };

    // End a crossfade now: the outgoing player stops and the active one plays
    // at full volume. Anything that takes over playback (a pause, a seek,
    // another source) ends it first.
    const finishFade = () => {
      const fade = fadeRef.current;
      if (!fade) return;
      fadeRef.current = null;
      clearInterval(fade.timer);
      fade.outgoing.pause();
      // Empty it as well: when an interruption ends, iOS resumes every player
      // it paused, and the old song must not come back.
      fade.outgoing.replace({});
      applyVolume();
      diagnostics.record("audio-crossfade-finished");
    };

    const stepFade = () => {
      const fade = fadeRef.current;
      if (!fade) return;
      if (performance.now() - fade.startedAt >= fade.seconds * 1000) finishFade();
      else applyVolume();
    };

    return {
      load(url) {
        diagnostics.source(url.startsWith("file:") ? "local" : "stream", false);
        finishFade();
        const player = activePlayer();
        playbackGenerationRef.current += 1;
        pendingPreparedPlaybackRef.current = null;
        // Seeks against the outgoing item must not delay the new track.
        pendingSeekRef.current = null;
        const prepared = preparedRef.current;
        if (prepared) {
          preparedRef.current = null;
          prepareGenerationRef.current += 1;
          void clearPreloadedSource(prepared.url).catch(() => {});
        }
        noteOutgoingSource();
        awaitingSourceStatusRef.current = true;
        try {
          player.replace({ uri: url });
        } catch {
          // replace() hands a still-preloaded copy of this URL to the player.
          // Picking the prepared next track gets here before the async
          // clearPreloadedSource() drops that copy, and iOS can refuse the
          // handoff with an Objective-C exception ("Exception in HostFunction:
          // <unknown>"). The failed call has already taken the copy out of
          // the preload cache, so a second replace() loads the URL afresh.
          diagnostics.record("audio-preload-handoff-failed");
          player.replace({ uri: url });
        }
        diagnostics.record("audio-source-replaced");
        resetStatusDiff();
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
        diagnostics.source(url.startsWith("file:") ? "local" : "stream", true);
        finishFade();
        const player = activePlayer();
        preparedRef.current = null;
        prepareGenerationRef.current += 1;
        playbackGenerationRef.current += 1;
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
          noteOutgoingSource();
          awaitingSourceStatusRef.current = true;
          player.replace({ uri: url });
          diagnostics.record("audio-source-replaced");
          resetStatusDiff();
          startPreparedPlaybackIfReady(player.currentStatus);
          diagnostics.record("audio-prepared-activated", { pendingStart: Boolean(pendingPreparedPlaybackRef.current) });
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
      crossfadeToPrepared(url, seconds) {
        const prepared = preparedRef.current;
        if (!prepared || prepared.url !== url || !prepared.ready || !(seconds > 0)) return false;
        diagnostics.source(url.startsWith("file:") ? "local" : "stream", true);
        finishFade();
        const outgoing = activePlayer();
        const incomingIndex = 1 - activeIndexRef.current;
        const incoming = players[incomingIndex];
        preparedRef.current = null;
        prepareGenerationRef.current += 1;
        try {
          incoming.volume = 0;
          incoming.replace({ uri: url });
        } catch {
          // As in activatePrepared, the current song plays on and its end
          // loads this one afresh.
          diagnostics.record("audio-crossfade-failed");
          applyVolume();
          void clearPreloadedSource(url).catch(() => {});
          return false;
        }
        playbackGenerationRef.current += 1;
        activeIndexRef.current = incomingIndex;
        fadeRef.current = {
          outgoing,
          startedAt: performance.now(),
          seconds,
          timer: setInterval(stepFade, FADE_STEP_MS),
        };
        applyVolume();
        // Start it on its first loaded status, as activatePrepared does.
        pendingPreparedPlaybackRef.current = { shouldPlay: true };
        pendingSeekRef.current = null;
        awaitingSourceStatusRef.current = true;
        // This player's last source finished long ago: no failure of it can
        // still be on its way.
        outgoingMayFailRef.current = false;
        hasSourceRef.current = true;
        resetStatusDiff();
        // The lock screen, Control Center and their commands follow the song.
        const lockScreen = lockScreenRef.current;
        if (lockScreen) incoming.setActiveForLockScreen(true, lockScreen.metadata, lockScreen.options);
        startPreparedPlaybackIfReady(incoming.currentStatus);
        diagnostics.record("audio-crossfade-started", { seconds, pendingStart: Boolean(pendingPreparedPlaybackRef.current) });
        void clearPreloadedSource(url).catch(() => {});
        return true;
      },
      clearPrepared() {
        if (pendingPreparedPlaybackRef.current) diagnostics.record("audio-pending-start-cleared");
        pendingPreparedPlaybackRef.current = null;
        const prepared = preparedRef.current;
        preparedRef.current = null;
        prepareGenerationRef.current += 1;
        if (prepared) void clearPreloadedSource(prepared.url).catch(() => {});
      },
      async play() {
        diagnostics.record("audio-play-request", {
          pendingStart: Boolean(pendingPreparedPlaybackRef.current),
          pendingSeek: Boolean(pendingSeekRef.current),
        });
        const generation = playbackGenerationRef.current;
        const pending = pendingPreparedPlaybackRef.current;
        if (pending) {
          pending.shouldPlay = true;
          startPreparedPlaybackIfReady(activePlayer().currentStatus);
          return;
        }
        const pendingSeek = pendingSeekRef.current;
        if (pendingSeek) {
          await pendingSeek;
          // A newer source, pause or disposal owns playback now; the old
          // seek completion must not restart it.
          if (
            generation !== playbackGenerationRef.current ||
            pendingPreparedPlaybackRef.current
          ) {
            return;
          }
        }
        activePlayer().play();
        diagnostics.record("audio-play-issued");
      },
      pause() {
        diagnostics.record("audio-pause-request");
        finishFade();
        playbackGenerationRef.current += 1;
        const pending = pendingPreparedPlaybackRef.current;
        if (pending) pending.shouldPlay = false;
        activePlayer().pause();
      },
      seek(seconds) {
        diagnostics.record("audio-seek-request", { seconds });
        finishFade();
        const seekPromise = activePlayer().seekTo(seconds).then(
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
        volumeRef.current = v;
        applyVolume();
      },
      setMuted(m) {
        for (const player of players) player.muted = m;
      },
      currentTime() {
        return activePlayer().currentTime ?? 0;
      },
      duration() {
        return activePlayer().duration ?? 0;
      },
      setActiveForLockScreen(active, metadata, options) {
        lockScreenRef.current = active ? { metadata, options } : null;
        activePlayer().setActiveForLockScreen(active, metadata, options);
      },
      updateLockScreenMetadata(metadata) {
        if (lockScreenRef.current) lockScreenRef.current.metadata = metadata;
        activePlayer().updateLockScreenMetadata(metadata);
      },
      clearLockScreenControls() {
        lockScreenRef.current = null;
        try {
          activePlayer().clearLockScreenControls();
        } catch (error) {
          if (!isReleasedSharedObjectError(error)) throw error;
        }
      },
      on: listeners.on,
      dispose() {
        diagnostics.record("audio-dispose");
        finishFade();
        playbackGenerationRef.current += 1;
        pendingSeekRef.current = null;
        pendingPreparedPlaybackRef.current = null;
        const prepared = preparedRef.current;
        preparedRef.current = null;
        prepareGenerationRef.current += 1;
        if (prepared) void clearPreloadedSource(prepared.url).catch(() => {});
        listeners.clear();
      },
    };
  }, [activePlayer, diagnostics, dispatch, listeners, noteOutgoingSource, players, startPreparedPlaybackIfReady]);

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
