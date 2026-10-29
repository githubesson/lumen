import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type Hls from "hls.js";
import type { ErrorData } from "hls.js";
import {
  createAudioAdapterEmitter,
  type AudioAdapter,
  type AudioAdapterEvent,
} from "@music-library/core";
import { usesNativeHls } from "../lib/nativeHls";

// How often a crossfade steps the volumes.
const FADE_STEP_MS = 50;

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
  // The user's volume. A crossfade scales each element's share of it.
  const volumeRef = useRef(1);
  // A crossfade under way: the outgoing element plays on, fading out, while
  // the active one fades in.
  const fadeRef = useRef<{
    outgoing: HTMLAudioElement;
    outgoingHls: Hls | null;
    startedAt: number;
    seconds: number;
    timer: ReturnType<typeof setInterval>;
  } | null>(null);
  // One registry for the adapter's lifetime: useState never replaces it, so
  // listing it as a dependency below re-runs nothing.
  const [listeners] = useState(createAudioAdapterEmitter);
  // What the element or hls.js said about the latest failure; set right
  // before each "error" is emitted.
  const errorDetailRef = useRef<string | null>(null);

  // Wire native events → listener registry once the element mounts.
  useEffect(() => {
    const primary = audioRef.current;
    const secondary = preloadAudioRef.current;
    if (!primary || !secondary) return;
    activeAudioRef.current = primary;

    const wire = (a: HTMLAudioElement) => {
      const dispatchIfActive = (event: AudioAdapterEvent) => () => {
        if (activeAudioRef.current === a) listeners.emit(event);
      };
      const dispatchError = dispatchIfActive("error");
      const handlers = {
        timeupdate: dispatchIfActive("timeupdate"),
        loadedmetadata: dispatchIfActive("loadedmetadata"),
        ended: dispatchIfActive("ended"),
        seeked: dispatchIfActive("seeked"),
        play: dispatchIfActive("play"),
        pause: dispatchIfActive("pause"),
        // An element emptied by load() or resetAudio has no source to fail
        // (it may still report the missing src), and hls.js reports and
        // recovers the media it drives itself.
        error: () => {
          if (!a.getAttribute("src") || hlsRef.current) return;
          errorDetailRef.current = describeMediaError(a.error);
          dispatchError();
        },
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
  }, [listeners]);

  // Teardown goes through the adapter's own dispose(). The hand-rolled version
  // that used to live here was a partial copy: it omitted the element reset and
  // listener clear, so listener sets survived a provider remount.
  const disposeRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      disposeRef.current?.();
    },
    [],
  );

  const adapter = useMemo<AudioAdapter>(() => {
    // The user's volume on each element, times its share of a crossfade.
    // Equal-power curves, so the mix doesn't dip halfway through.
    const applyVolume = () => {
      const volume = volumeRef.current;
      const fade = fadeRef.current;
      if (!fade) {
        if (audioRef.current) audioRef.current.volume = volume;
        if (preloadAudioRef.current) preloadAudioRef.current.volume = volume;
        return;
      }
      const progress = Math.min(1, (performance.now() - fade.startedAt) / (fade.seconds * 1000));
      const active = activeAudioRef.current;
      if (active) active.volume = volume * Math.sin((progress * Math.PI) / 2);
      fade.outgoing.volume = volume * Math.cos((progress * Math.PI) / 2);
    };

    // End a crossfade now: the outgoing element stops and the active one
    // plays at full volume. Anything that takes over playback (a pause, a
    // seek, another source) ends it first.
    const finishFade = () => {
      const fade = fadeRef.current;
      if (!fade) return;
      fadeRef.current = null;
      clearInterval(fade.timer);
      fade.outgoingHls?.destroy();
      resetAudio(fade.outgoing);
      applyVolume();
    };

    const stepFade = () => {
      const fade = fadeRef.current;
      if (!fade) return;
      if (performance.now() - fade.startedAt >= fade.seconds * 1000) finishFade();
      else applyVolume();
    };

    // Make the prepared element the active one and start it: at once, or
    // fading in over `fadeSeconds` while the old one fades out.
    const activate = (url: string, fadeSeconds: number): boolean => {
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
      finishFade();

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
      if (fadeSeconds > 0) {
        fadeRef.current = {
          outgoing: old,
          outgoingHls: previousHls,
          startedAt: performance.now(),
          seconds: fadeSeconds,
          timer: setInterval(stepFade, FADE_STEP_MS),
        };
        applyVolume();
      } else {
        previousHls?.destroy();
        old.pause();
        resetAudio(old);
      }
      listeners.emit("loadedmetadata");
      try {
        void next.play().catch(() => listeners.emit("pause"));
        return true;
      } catch {
        return false;
      }
    };

    return {
      load(url) {
        const a = activeAudioRef.current ?? audioRef.current;
        if (!a) return;
        finishFade();
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
        if (shouldUseHLS(url) && !usesNativeHls(a)) {
          // hls.js is by far the largest renderer dependency. Load it only for
          // an HLS source, and make play() wait for this one-time import so the
          // player's immediate load() -> play() sequence remains race-safe.
          const pending = import("hls.js/light")
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
                  if (!data.fatal || !giveUpOnFatalHlsError(HlsRuntime, hls, data)) return;
                  if (hlsRef.current === hls) {
                    hlsRef.current = null;
                    errorDetailRef.current = describeHlsError(data);
                    listeners.emit("error");
                  }
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
        // The element to prepare may still be fading out.
        finishFade();

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
        next.volume = volumeRef.current;
        next.muted = active.muted;

        if (shouldUseHLS(url) && !usesNativeHls(next)) {
          const pending = import("hls.js/light")
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
                  if (!data.fatal || !giveUpOnFatalHlsError(HlsRuntime, hls, data)) return;
                  // Still prepared: drop it quietly, and activatePrepared()
                  // falls back to load(), which reports a failure for real.
                  if (preparedHlsRef.current === hls) {
                    preparedHlsRef.current = null;
                    preparedAudioRef.current = null;
                    preparedUrlRef.current = null;
                  } else if (hlsRef.current === hls) {
                    hlsRef.current = null;
                    errorDetailRef.current = describeHlsError(data);
                    listeners.emit("error");
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
        return activate(url, 0);
      },
      crossfadeToPrepared(url, seconds) {
        const next = preparedAudioRef.current;
        const current = activeAudioRef.current ?? audioRef.current;
        // A paused song has nothing to fade from. The browser marks an element
        // paused before the timeupdate it sends with the pause, so a pause it
        // makes itself can't start the next song.
        if (!next || !current || current.paused || !(seconds > 0) || !volumeIsSettable(next)) {
          return false;
        }
        return activate(url, seconds);
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
        finishFade();
        activeAudioRef.current?.pause();
      },
      seek(seconds) {
        const a = activeAudioRef.current ?? audioRef.current;
        if (!a) return;
        finishFade();
        a.currentTime = seconds;
      },
      setVolume(v) {
        volumeRef.current = v;
        applyVolume();
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
      on: listeners.on,
      errorDetail() {
        return errorDetailRef.current;
      },
      dispose() {
        finishFade();
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
        listeners.clear();
      },
    };
  }, [listeners]);
  useEffect(() => {
    disposeRef.current = () => adapter.dispose?.();
  }, [adapter]);

  const audioRefs = useMemo(
    () => [audioRef, preloadAudioRef] as const,
    [],
  );

  return { adapter, audioRefs };
}

const MEDIA_ERROR_NAMES: Record<number, string> = {
  1: "MEDIA_ERR_ABORTED",
  2: "MEDIA_ERR_NETWORK",
  3: "MEDIA_ERR_DECODE",
  4: "MEDIA_ERR_SRC_NOT_SUPPORTED",
};

/**
 * The element's own account of a failure, e.g. "MEDIA_ERR_SRC_NOT_SUPPORTED:
 * DEMUXER_ERROR_COULD_NOT_OPEN: FFmpegDemuxer: open context failed".
 */
function describeMediaError(error: MediaError | null): string | null {
  if (!error) return null;
  const name = MEDIA_ERROR_NAMES[error.code] ?? `MediaError ${error.code}`;
  return error.message ? `${name}: ${error.message}` : name;
}

/**
 * hls.js's account of the error it gave up on, e.g. "hls.js manifestLoadError:
 * A network error (status 502) occurred while loading manifest". Never the
 * URL: a segment's carries TIDAL's signed address.
 */
function describeHlsError(data: ErrorData): string {
  const message = data.error?.message;
  return `hls.js ${data.details}${message ? `: ${message}` : ""}`;
}

/**
 * Recover from a fatal hls.js error where hls.js can, else destroy it.
 * Returns true when it gave up and the source is gone. A playlist that never
 * loaded is past recovery: hls.js has already retried it per its load
 * policy, and startLoad() only resumes loading segments. So is a playlist or
 * segment the server refused (4xx, e.g. an expired TIDAL URL): loading it
 * again gets the same answer, and only a reload of the source gets new URLs.
 */
function giveUpOnFatalHlsError(HlsRuntime: typeof Hls, hls: Hls, data: ErrorData): boolean {
  const { ErrorDetails, ErrorTypes } = HlsRuntime;
  const status = data.response?.code ?? 0;
  const manifestFailed =
    data.details === ErrorDetails.MANIFEST_LOAD_ERROR ||
    data.details === ErrorDetails.MANIFEST_LOAD_TIMEOUT ||
    data.details === ErrorDetails.MANIFEST_PARSING_ERROR;
  const refused = status >= 400 && status < 500;
  if (!manifestFailed && !refused && data.type === ErrorTypes.NETWORK_ERROR) {
    hls.startLoad();
    return false;
  }
  if (data.type === ErrorTypes.MEDIA_ERROR) {
    hls.recoverMediaError();
    return false;
  }
  hls.destroy();
  return true;
}

/**
 * Whether the element takes a volume. iOS Safari ignores it (the hardware
 * buttons own the level), and a crossfade there would only play both songs
 * at full volume.
 */
function volumeIsSettable(audio: HTMLAudioElement): boolean {
  const before = audio.volume;
  audio.volume = before === 0.5 ? 0.25 : 0.5;
  const settable = audio.volume !== before;
  audio.volume = before;
  return settable;
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
