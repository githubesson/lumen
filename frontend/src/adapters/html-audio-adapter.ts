import { useEffect, useMemo, useRef, type RefObject } from "react";
import type { AudioAdapter, AudioAdapterEvent } from "@music-library/core";

/**
 * Wraps an `HTMLAudioElement` in the shared `AudioAdapter` interface. The
 * hook exposes the adapter alongside a ref the caller must attach to an
 * `<audio>` element — ownership stays with the React tree so `PlayerProvider`
 * can render the element itself.
 *
 * Events are funneled through an internal listener registry so repeated calls
 * to `adapter.on()` don't accumulate duplicate native listeners, and unsubscribe
 * on component unmount is handled by the single wiring effect.
 */
export function useHtmlAudioAdapter(): {
  adapter: AudioAdapter;
  audioRef: RefObject<HTMLAudioElement>;
} {
  const audioRef = useRef<HTMLAudioElement>(null);
  const listenersRef = useRef<Map<AudioAdapterEvent, Set<() => void>>>(
    new Map(),
  );

  // Wire native events → listener registry once the element mounts.
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;

    const dispatchEvent = (event: AudioAdapterEvent) => () => {
      const set = listenersRef.current.get(event);
      if (!set) return;
      for (const fn of set) fn();
    };

    const onTime = dispatchEvent("timeupdate");
    const onMeta = dispatchEvent("loadedmetadata");
    const onEnd = dispatchEvent("ended");
    const onSeeked = dispatchEvent("seeked");
    const onPlay = dispatchEvent("play");
    const onPause = dispatchEvent("pause");

    a.addEventListener("timeupdate", onTime);
    a.addEventListener("loadedmetadata", onMeta);
    a.addEventListener("ended", onEnd);
    a.addEventListener("seeked", onSeeked);
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);

    return () => {
      a.removeEventListener("timeupdate", onTime);
      a.removeEventListener("loadedmetadata", onMeta);
      a.removeEventListener("ended", onEnd);
      a.removeEventListener("seeked", onSeeked);
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onPause);
    };
  }, []);

  const adapter = useMemo<AudioAdapter>(
    () => ({
      load(url) {
        const a = audioRef.current;
        if (!a) return;
        a.src = url;
      },
      play() {
        const a = audioRef.current;
        if (!a) return Promise.reject(new Error("audio element not mounted"));
        const result = a.play();
        return result ?? Promise.resolve();
      },
      pause() {
        audioRef.current?.pause();
      },
      seek(seconds) {
        const a = audioRef.current;
        if (!a) return;
        a.currentTime = seconds;
      },
      setVolume(v) {
        const a = audioRef.current;
        if (!a) return;
        a.volume = v;
      },
      setMuted(m) {
        const a = audioRef.current;
        if (!a) return;
        a.muted = m;
      },
      currentTime() {
        return audioRef.current?.currentTime ?? 0;
      },
      duration() {
        return audioRef.current?.duration ?? 0;
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
    [],
  );

  return { adapter, audioRef };
}
