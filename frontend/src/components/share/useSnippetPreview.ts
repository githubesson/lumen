import { useCallback, useEffect, useRef, useState } from "react";
import type Hls from "hls.js";
import { streamUrl, type TrackDetail } from "../../api";

/**
 * Plays the selected window of a track through a hidden <audio> element, so
 * the share dialog can preview exactly what the embed will play. The caller
 * renders the element and wires `audioRef`, `onTimeUpdate` and `onEnded`.
 */
export function useSnippetPreview({
  open,
  track,
  startSec,
  endSec,
}: {
  open: boolean;
  track: TrackDetail | null;
  startSec: number;
  endSec: number;
}) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentSec, setCurrentSec] = useState(0);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);

  // Attach the preview source. Local tracks are a plain progressive stream;
  // TIDAL tracks stream as HLS, which Chrome/Firefox only play through
  // hls.js (lazy-imported, same as the main player adapter). Safari falls
  // back to native HLS via a direct src assignment.
  const previewUrl = track ? streamUrl(track.id) : null;
  const previewIsHls = track?.source === "tidal";
  useEffect(() => {
    const a = audioRef.current;
    if (!a || !previewUrl || !open) return;
    let cancelled = false;
    if (previewIsHls) {
      void import("hls.js")
        .then(({ default: HlsRuntime }) => {
          if (cancelled) return;
          if (HlsRuntime.isSupported()) {
            const hls = new HlsRuntime();
            hlsRef.current = hls;
            hls.attachMedia(a);
            hls.loadSource(previewUrl);
          } else {
            a.src = previewUrl;
          }
        })
        .catch(() => {
          if (!cancelled) a.src = previewUrl;
        });
    } else {
      a.src = previewUrl;
    }
    return () => {
      cancelled = true;
      hlsRef.current?.destroy();
      hlsRef.current = null;
      a.pause();
      a.removeAttribute("src");
      a.load();
    };
  }, [previewUrl, previewIsHls, open]);

  // Pause any in-flight audio when the dialog unmounts so playback doesn't
  // continue in the background after closing.
  useEffect(() => {
    if (!open) {
      const a = audioRef.current;
      if (a) {
        a.pause();
        a.currentTime = 0;
      }
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsPlaying(false);
    }
  }, [open]);

  // When the selected window moves while the preview is playing, snap playback
  // to the new start. Without this the preview would keep running through
  // audio the user has already excluded from the window.
  useEffect(() => {
    const a = audioRef.current;
    if (!a || !isPlaying) return;
    if (a.currentTime < startSec || a.currentTime >= endSec) {
      a.currentTime = startSec;
    }
  }, [startSec, endSec, isPlaying]);

  // Auto-stop when the preview window ends. timeupdate fires ~4×/sec which
  // is plenty precise for ending the clip exactly at endSec.
  const onTimeUpdate = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    setCurrentSec(a.currentTime);
    if (a.currentTime >= endSec) {
      a.pause();
      a.currentTime = startSec;
      setIsPlaying(false);
    }
  }, [endSec, startSec]);

  const onEnded = useCallback(() => setIsPlaying(false), []);

  const togglePlay = async () => {
    const a = audioRef.current;
    if (!a) return;
    if (isPlaying) {
      a.pause();
      setIsPlaying(false);
      return;
    }
    // Start from the window's beginning every time — hearing exactly what
    // the embed will play is the whole point of the preview button.
    a.currentTime = startSec;
    try {
      await a.play();
      setIsPlaying(true);
    } catch {
      setIsPlaying(false);
    }
  };

  const reset = useCallback(() => {
    setIsPlaying(false);
    setCurrentSec(0);
  }, []);

  return { audioRef, isPlaying, currentSec, onTimeUpdate, onEnded, togglePlay, reset };
}
