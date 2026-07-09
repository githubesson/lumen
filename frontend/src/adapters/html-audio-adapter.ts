import { useEffect, useMemo, useRef, type RefObject } from "react";
import type Hls from "hls.js";
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
  const hlsRef = useRef<Hls | null>(null);
  const pendingLoadRef = useRef<Promise<void> | null>(null);
  const loadGenerationRef = useRef(0);
  const playIntentRef = useRef(0);
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

  useEffect(
    () => () => {
      loadGenerationRef.current += 1;
      playIntentRef.current += 1;
      pendingLoadRef.current = null;
      hlsRef.current?.destroy();
      hlsRef.current = null;
    },
    [],
  );

  const adapter = useMemo<AudioAdapter>(
    () => ({
      load(url) {
        const a = audioRef.current;
        if (!a) return;
        const generation = ++loadGenerationRef.current;
        playIntentRef.current += 1;
        pendingLoadRef.current = null;
        hlsRef.current?.destroy();
        hlsRef.current = null;
        a.removeAttribute("src");
        a.load();
        if (shouldUseHLS(url)) {
          // hls.js is by far the largest renderer dependency. Load it only for
          // an HLS source, and make play() wait for this one-time import so the
          // player's immediate load() -> play() sequence remains race-safe.
          const pending = import("hls.js")
            .then(({ default: HlsRuntime }) => {
              if (
                generation !== loadGenerationRef.current ||
                audioRef.current !== a
              ) {
                return;
              }
              if (HlsRuntime.isSupported()) {
                const hls = new HlsRuntime();
                hlsRef.current = hls;
                hls.attachMedia(a);
                hls.loadSource(url);
                hls.on(HlsRuntime.Events.ERROR, (_event, data) => {
                  if (!data.fatal) return;
                  if (data.type === HlsRuntime.ErrorTypes.NETWORK_ERROR) {
                    hls.startLoad();
                    return;
                  }
                  if (data.type === HlsRuntime.ErrorTypes.MEDIA_ERROR) {
                    hls.recoverMediaError();
                    return;
                  }
                  hls.destroy();
                  if (hlsRef.current === hls) hlsRef.current = null;
                });
                return;
              }
              a.src = url;
            })
            .catch(() => {
              if (
                generation === loadGenerationRef.current &&
                audioRef.current === a
              ) {
                // Native HLS-capable browsers can still recover if the optional
                // module fails to load; other browsers surface the normal media
                // error through HTMLAudioElement.
                a.src = url;
              }
            });
          pendingLoadRef.current = pending;
          void pending.finally(() => {
            if (pendingLoadRef.current === pending) {
              pendingLoadRef.current = null;
            }
          });
          return;
        }
        a.src = url;
      },
      play() {
        const a = audioRef.current;
        if (!a) return Promise.reject(new Error("audio element not mounted"));
        const intent = ++playIntentRef.current;
        const playNow = () =>
          intent === playIntentRef.current
            ? (a.play() ?? Promise.resolve())
            : Promise.resolve();
        return pendingLoadRef.current
          ? pendingLoadRef.current.then(playNow)
          : playNow();
      },
      pause() {
        playIntentRef.current += 1;
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
        loadGenerationRef.current += 1;
        playIntentRef.current += 1;
        pendingLoadRef.current = null;
        hlsRef.current?.destroy();
        hlsRef.current = null;
        listenersRef.current.clear();
      },
    }),
    [],
  );

  return { adapter, audioRef };
}

function shouldUseHLS(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.includes("/api/tracks/tidal%3a") || lower.includes(".m3u8");
}
