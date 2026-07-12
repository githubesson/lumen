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
  audioRefs: readonly [RefObject<HTMLAudioElement>, RefObject<HTMLAudioElement>];
} {
  const audioRef = useRef<HTMLAudioElement>(null);
  const preloadAudioRef = useRef<HTMLAudioElement>(null);
  const activeAudioRef = useRef<HTMLAudioElement | null>(null);
  const preparedAudioRef = useRef<HTMLAudioElement | null>(null);
  const preparedUrlRef = useRef<string | null>(null);
  const preparedPendingRef = useRef<Promise<void> | null>(null);
  const preparedGenerationRef = useRef(0);
  const hlsRef = useRef<Hls | null>(null);
  const preparedHlsRef = useRef<Hls | null>(null);
  const pendingLoadRef = useRef<Promise<void> | null>(null);
  const loadGenerationRef = useRef(0);
  const playIntentRef = useRef(0);
  const listenersRef = useRef<Map<AudioAdapterEvent, Set<() => void>>>(
    new Map(),
  );

  const dispatch = (event: AudioAdapterEvent) => {
    const set = listenersRef.current.get(event);
    if (!set) return;
    for (const fn of set) fn();
  };

  // Wire native events → listener registry once the element mounts.
  useEffect(() => {
    const primary = audioRef.current;
    const secondary = preloadAudioRef.current;
    if (!primary || !secondary) return;
    activeAudioRef.current = primary;

    const wire = (a: HTMLAudioElement) => {
      const dispatchIfActive = (event: AudioAdapterEvent) => () => {
        if (activeAudioRef.current === a) dispatch(event);
      };
      const handlers = {
        timeupdate: dispatchIfActive("timeupdate"),
        loadedmetadata: dispatchIfActive("loadedmetadata"),
        ended: dispatchIfActive("ended"),
        seeked: dispatchIfActive("seeked"),
        play: dispatchIfActive("play"),
        pause: dispatchIfActive("pause"),
      };
      for (const [event, handler] of Object.entries(handlers)) {
        a.addEventListener(event, handler);
      }
      return () => {
        for (const [event, handler] of Object.entries(handlers)) {
          a.removeEventListener(event, handler);
        }
      };
    };

    const unwirePrimary = wire(primary);
    const unwireSecondary = wire(secondary);

    return () => {
      unwirePrimary();
      unwireSecondary();
      activeAudioRef.current = null;
    };
  }, []);

  useEffect(
    () => () => {
      loadGenerationRef.current += 1;
      playIntentRef.current += 1;
      pendingLoadRef.current = null;
      hlsRef.current?.destroy();
      hlsRef.current = null;
      preparedGenerationRef.current += 1;
      preparedPendingRef.current = null;
      preparedHlsRef.current?.destroy();
      preparedHlsRef.current = null;
      preparedAudioRef.current = null;
      preparedUrlRef.current = null;
    },
    [],
  );

  const adapter = useMemo<AudioAdapter>(
    () => ({
      load(url) {
        const a = activeAudioRef.current ?? audioRef.current;
        if (!a) return;
        const prepared = preparedAudioRef.current;
        preparedGenerationRef.current += 1;
        preparedPendingRef.current = null;
        preparedHlsRef.current?.destroy();
        preparedHlsRef.current = null;
        preparedAudioRef.current = null;
        preparedUrlRef.current = null;
        if (prepared && prepared !== a) resetAudio(prepared);
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
                activeAudioRef.current !== a
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
                activeAudioRef.current === a
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
      prepareNext(url) {
        if (preparedUrlRef.current === url) return;
        const active = activeAudioRef.current ?? audioRef.current;
        const primary = audioRef.current;
        const secondary = preloadAudioRef.current;
        const next = active === primary ? secondary : primary;
        if (!active || !next) return;

        const previous = preparedAudioRef.current;
        preparedGenerationRef.current += 1;
        preparedPendingRef.current = null;
        preparedHlsRef.current?.destroy();
        preparedHlsRef.current = null;
        if (previous && previous !== active) resetAudio(previous);

        const generation = preparedGenerationRef.current;
        preparedAudioRef.current = next;
        preparedUrlRef.current = url;
        resetAudio(next);
        next.preload = "auto";
        next.volume = active.volume;
        next.muted = active.muted;

        if (shouldUseHLS(url)) {
          const pending = import("hls.js")
            .then(({ default: HlsRuntime }) => {
              if (
                generation !== preparedGenerationRef.current ||
                preparedAudioRef.current !== next ||
                preparedUrlRef.current !== url
              ) {
                return;
              }
              if (HlsRuntime.isSupported()) {
                const hls = new HlsRuntime({
                  maxBufferLength: 20,
                  maxMaxBufferLength: 30,
                });
                preparedHlsRef.current = hls;
                hls.attachMedia(next);
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
                  if (preparedHlsRef.current === hls) {
                    preparedHlsRef.current = null;
                    preparedAudioRef.current = null;
                    preparedUrlRef.current = null;
                  } else if (hlsRef.current === hls) {
                    hlsRef.current = null;
                  }
                });
                return;
              }
              next.src = url;
              next.load();
            })
            .catch(() => {
              if (
                generation === preparedGenerationRef.current &&
                preparedAudioRef.current === next
              ) {
                next.src = url;
                next.load();
              }
            });
          preparedPendingRef.current = pending;
          void pending.finally(() => {
            if (preparedPendingRef.current === pending) {
              preparedPendingRef.current = null;
            }
          });
          return;
        }

        next.src = url;
        next.load();
      },
      activatePrepared(url) {
        const next = preparedAudioRef.current;
        const old = activeAudioRef.current ?? audioRef.current;
        if (
          !next ||
          !old ||
          preparedUrlRef.current !== url ||
          preparedPendingRef.current ||
          next.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
        ) {
          return false;
        }

        loadGenerationRef.current += 1;
        playIntentRef.current += 1;
        pendingLoadRef.current = null;
        const previousHls = hlsRef.current;
        hlsRef.current = preparedHlsRef.current;
        preparedHlsRef.current = null;
        preparedGenerationRef.current += 1;
        preparedPendingRef.current = null;
        preparedAudioRef.current = null;
        preparedUrlRef.current = null;
        activeAudioRef.current = next;
        previousHls?.destroy();
        old.pause();
        resetAudio(old);
        dispatch("loadedmetadata");
        try {
          void next.play().catch(() => dispatch("pause"));
          return true;
        } catch {
          return false;
        }
      },
      clearPrepared() {
        const prepared = preparedAudioRef.current;
        preparedGenerationRef.current += 1;
        preparedPendingRef.current = null;
        preparedHlsRef.current?.destroy();
        preparedHlsRef.current = null;
        preparedAudioRef.current = null;
        preparedUrlRef.current = null;
        if (prepared && prepared !== activeAudioRef.current) resetAudio(prepared);
      },
      play() {
        const a = activeAudioRef.current ?? audioRef.current;
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
        activeAudioRef.current?.pause();
      },
      seek(seconds) {
        const a = activeAudioRef.current ?? audioRef.current;
        if (!a) return;
        a.currentTime = seconds;
      },
      setVolume(v) {
        if (audioRef.current) audioRef.current.volume = v;
        if (preloadAudioRef.current) preloadAudioRef.current.volume = v;
      },
      setMuted(m) {
        if (audioRef.current) audioRef.current.muted = m;
        if (preloadAudioRef.current) preloadAudioRef.current.muted = m;
      },
      currentTime() {
        return activeAudioRef.current?.currentTime ?? 0;
      },
      duration() {
        return activeAudioRef.current?.duration ?? 0;
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
        preparedGenerationRef.current += 1;
        preparedPendingRef.current = null;
        preparedHlsRef.current?.destroy();
        preparedHlsRef.current = null;
        preparedAudioRef.current = null;
        preparedUrlRef.current = null;
        if (audioRef.current) resetAudio(audioRef.current);
        if (preloadAudioRef.current) resetAudio(preloadAudioRef.current);
        listenersRef.current.clear();
      },
    }),
    [],
  );
  const audioRefs = useMemo(
    () => [audioRef, preloadAudioRef] as const,
    [],
  );

  return { adapter, audioRefs };
}

function resetAudio(audio: HTMLAudioElement): void {
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
}

function shouldUseHLS(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.includes("/api/tracks/tidal%3a") || lower.includes(".m3u8");
}
