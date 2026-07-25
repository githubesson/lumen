import { useEffect, useMemo, useRef } from 'react';
import type { AudioAdapter, AudioAdapterEvent } from '@music-library/core';
import { Playback, playbackEvents } from '../native/playback';

/**
 * Core's `AudioAdapter` over the AppKit/AVFoundation module.
 *
 * This is considerably simpler than the iOS client's expo-audio adapter
 * (`mobile/adapters/expo-audio-adapter.ts`), which has to diff successive
 * status snapshots to synthesise events and juggle seek/play ordering. Owning
 * the native side means every event core needs is emitted directly and in
 * order, so there is nothing to reconstruct here.
 *
 * The optional gapless methods (`prepareNext`/`activatePrepared`/
 * `clearPrepared`) are deliberately not implemented: core falls back to
 * `load()` + `play()` when they are absent.
 */
export function useAVPlayerAdapter(): AudioAdapter {
  const currentTimeRef = useRef(0);
  const durationRef = useRef(0);
  const listenersRef = useRef(new Map<AudioAdapterEvent, Set<() => void>>());

  useEffect(() => {
    const emit = (event: AudioAdapterEvent) => {
      const handlers = listenersRef.current.get(event);
      if (!handlers) return;
      for (const handler of handlers) handler();
    };

    const subscriptions = [
      playbackEvents.addListener(
        'loadedmetadata',
        ({ duration }: { duration: number }) => {
          durationRef.current = Number.isFinite(duration) ? duration : 0;
          emit('loadedmetadata');
        },
      ),
      playbackEvents.addListener(
        'timeupdate',
        ({ currentTime }: { currentTime: number }) => {
          currentTimeRef.current = Number.isFinite(currentTime) ? currentTime : 0;
          emit('timeupdate');
        },
      ),
      playbackEvents.addListener('play', () => emit('play')),
      playbackEvents.addListener('pause', () => emit('pause')),
      playbackEvents.addListener('seeked', () => emit('seeked')),
      playbackEvents.addListener('ended', () => emit('ended')),
    ];

    return () => {
      for (const subscription of subscriptions) subscription.remove();
    };
  }, []);

  return useMemo<AudioAdapter>(
    () => ({
      load(url) {
        // Reset locally so the UI does not show the previous track's position
        // for the frame before the first native tick arrives.
        currentTimeRef.current = 0;
        durationRef.current = 0;
        Playback.load(url);
      },
      play() {
        return Playback.play();
      },
      pause() {
        Playback.pause();
      },
      seek(seconds) {
        currentTimeRef.current = seconds;
        Playback.seek(seconds);
      },
      setVolume(v) {
        Playback.setVolume(v);
      },
      setMuted(m) {
        Playback.setMuted(m);
      },
      currentTime() {
        return currentTimeRef.current;
      },
      duration() {
        return durationRef.current;
      },
      on(event, handler) {
        const listeners = listenersRef.current;
        const handlers = listeners.get(event) ?? new Set<() => void>();
        handlers.add(handler);
        listeners.set(event, handlers);
        return () => {
          handlers.delete(handler);
        };
      },
      dispose() {
        Playback.dispose();
      },
    }),
    [],
  );
}
