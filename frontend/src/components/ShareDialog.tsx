import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type Hls from "hls.js";
import {
  ArrowPathIcon,
  CheckIcon,
  ClipboardDocumentIcon,
  PauseIcon,
  PlayIcon,
} from "@heroicons/react/16/solid";
import {
  DEFAULT_SHARE_SNIPPET_DURATION_SEC,
  MAX_SHARE_SNIPPET_DURATION_SEC,
  MIN_SHARE_SNIPPET_DURATION_SEC,
  createTrackShareLink,
  errorMessage,
  streamUrl,
  trackCoverUrl,
  type TrackDetail,
} from "../api";
import { Button } from "./Button";
import CoverArt from "./CoverArt";
import DialogFooter from "./DialogFooter";
import { DialogShell } from "./DialogShell";
import { fmtDurationMs, fmtDurationSec } from "../lib/format";
import { copyText } from "../lib/clipboard";
import { useTrackDetail } from "../lib/useTrackDetail";

interface Props {
  open: boolean;
  trackId: string | null;
  onClose: () => void;
}

/**
 * Share dialog: pick a variable-length window of a track and copy a link that
 * unfurls into a Discord/chat video embed (cover + audio snippet).
 *
 * The picker is a scrubber over the track's full timeline with a
 * highlighted window the user can drag. Play/pause previews just that
 * window end-to-end, so the user hears exactly what friends will hear in
 * the embed. Copy is disabled until the user adjusts either the length or
 * position at least once, so the default is never shared accidentally.
 */

export function ShareDialog({ open, trackId, onClose }: Props) {
  const { track, error: loadError } = useTrackDetail(open, trackId);

  const [startSec, setStartSec] = useState(0);
  const [selectedDurationSec, setSelectedDurationSec] = useState(
    DEFAULT_SHARE_SNIPPET_DURATION_SEC,
  );
  const [picked, setPicked] = useState(false); // user has moved the window
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentSec, setCurrentSec] = useState(0);

  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
    },
    [],
  );
  const [copyError, setCopyError] = useState<string | null>(null);

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

  const durationSec = useMemo(
    () => (track ? Math.max(0, track.duration_ms / 1000) : 0),
    [track],
  );
  const maxPreviewDurationSec = durationSec > 0
    ? Math.min(MAX_SHARE_SNIPPET_DURATION_SEC, Math.max(1, Math.ceil(durationSec)))
    : DEFAULT_SHARE_SNIPPET_DURATION_SEC;
  const minPreviewDurationSec = Math.min(
    MIN_SHARE_SNIPPET_DURATION_SEC,
    maxPreviewDurationSec,
  );
  const effectivePreviewSec = Math.min(
    Math.max(minPreviewDurationSec, selectedDurationSec),
    maxPreviewDurationSec,
  );
  const maxStartSec = Math.max(0, Math.floor(durationSec - effectivePreviewSec));
  const endSec = Math.min(durationSec, startSec + effectivePreviewSec);
  const displayPreviewSec = durationSec > 0
    ? Math.min(effectivePreviewSec, durationSec)
    : effectivePreviewSec;
  const displayMinPreviewSec = Math.min(minPreviewDurationSec, displayPreviewSec);
  const displayMaxPreviewSec = durationSec > 0
    ? Math.min(maxPreviewDurationSec, durationSec)
    : maxPreviewDurationSec;

  // Reset picker state on open / track changes so reopening on a different row
  // starts clean. Track metadata itself is loaded by useTrackDetail, which
  // guards against stale slow responses from a previous track.
  useEffect(() => {
    if (!open || !trackId) return;
    setStartSec(0);
    setSelectedDurationSec(DEFAULT_SHARE_SNIPPET_DURATION_SEC);
    setPicked(false);
    setIsPlaying(false);
    setCurrentSec(0);
    setShareUrl(null);
    setBusy(false);
    setCopied(false);
    setCopyError(null);
  }, [open, trackId]);

  // Pause any in-flight audio when the dialog unmounts so playback doesn't
  // continue in the background after closing.
  useEffect(() => {
    if (!open) {
      const a = audioRef.current;
      if (a) {
        a.pause();
        a.currentTime = 0;
      }
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

  const onStartChange = (value: number) => {
    const clamped = Math.max(0, Math.min(maxStartSec, Math.floor(value)));
    setStartSec(clamped);
    setPicked(true);
    // Invalidate any previously-generated share URL — it's tied to the
    // old window. User needs to confirm the new selection.
    setShareUrl(null);
    setCopied(false);
  };

  const onDurationChange = (value: number) => {
    const nextDuration = Math.max(
      minPreviewDurationSec,
      Math.min(maxPreviewDurationSec, Math.floor(value)),
    );
    const nextMaxStart = Math.max(0, Math.floor(durationSec - nextDuration));
    setSelectedDurationSec(nextDuration);
    setStartSec((current) => Math.min(current, nextMaxStart));
    setPicked(true);
    setShareUrl(null);
    setCopied(false);
  };

  const onCopy = async () => {
    if (!trackId || !picked) return;
    setBusy(true);
    setCopyError(null);
    try {
      let url = shareUrl;
      if (!url) {
        const res = await createTrackShareLink(trackId, startSec, effectivePreviewSec);
        url = res.url;
        setShareUrl(url);
      }
      const copiedOk = await copyText(url);
      if (!copiedOk) throw new Error("copy failed");
      setCopied(true);
      // Reset the "copied!" indicator after a moment so repeat copies
      // still feel snappy. Tracked so closing the dialog inside the window
      // doesn't leave a setState firing after unmount.
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
      copiedTimerRef.current = window.setTimeout(() => {
        copiedTimerRef.current = null;
        setCopied(false);
      }, 1800);
    } catch (err) {
      setCopyError(
        errorMessage(
          err,
          "Couldn't copy link — try again or copy the URL manually.",
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  const body = loadError ? (
    <div style={{ padding: 16, color: "var(--danger-fg)" }}>{loadError}</div>
  ) : !track ? (
    <div
      className="mono"
      style={{ padding: 16, color: "var(--fg-subtle)", fontSize: 11 }}
    >
      Loading…
    </div>
  ) : (
    <div style={{ padding: 16, display: "grid", gap: 14, fontSize: 12.5 }}>
      <HeaderBlock track={track} />

      <div style={{ display: "grid", gap: 6 }}>
        <label
          htmlFor="share-snippet-duration"
          style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
        >
          <span style={{ color: "var(--fg-muted)" }}>Clip length</span>
          <span className="mono" style={{ fontVariantNumeric: "tabular-nums" }}>
            {fmtDurationSec(displayPreviewSec)}
          </span>
        </label>
        <input
          id="share-snippet-duration"
          type="range"
          min={minPreviewDurationSec}
          max={maxPreviewDurationSec}
          step={1}
          value={effectivePreviewSec}
          disabled={maxPreviewDurationSec <= minPreviewDurationSec}
          aria-label="Share clip length in seconds"
          onChange={(event) => onDurationChange(Number(event.target.value))}
          style={{ width: "100%", accentColor: "var(--accent)" }}
        />
        <div
          className="mono"
          style={{ display: "flex", justifyContent: "space-between", color: "var(--fg-subtle)", fontSize: 10.5 }}
        >
          <span>
            {fmtDurationSec(displayMinPreviewSec)}
          </span>
          <span>
            {fmtDurationSec(displayMaxPreviewSec)}
          </span>
        </div>
      </div>

      <PreviewStrip
        durationSec={durationSec}
        startSec={startSec}
        endSec={endSec}
        currentSec={isPlaying ? currentSec : startSec}
        maxStartSec={maxStartSec}
        onStartChange={onStartChange}
      />

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          color: "var(--fg-subtle)",
          fontSize: 11,
        }}
        className="mono"
      >
        <span>Preview window</span>
        <span>
          {fmtDurationSec(startSec)} – {fmtDurationSec(endSec)}
          {durationSec > 0 && ` · of ${fmtDurationSec(durationSec)}`}
        </span>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void togglePlay()}
          leadingIcon={
            isPlaying ? (
              <PauseIcon className="size-3.5" />
            ) : (
              <PlayIcon className="size-3.5" />
            )
          }
        >
          {isPlaying ? "Pause preview" : "Play preview"}
        </Button>
        <span
          className="mono"
          style={{ color: "var(--fg-subtle)", fontSize: 11 }}
        >
          {picked
            ? "Happy with the window? Copy the link."
            : "Choose a length or drag the window into place."}
        </span>
      </div>

      {shareUrl && (
        <div
          className="surface-inset"
          style={{ padding: 10, display: "grid", gap: 6 }}
        >
          <div
            className="mono"
            style={{
              fontSize: 10,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: "var(--fg-subtle)",
            }}
          >
            Share link
          </div>
          <div
            className="mono"
            style={{
              fontSize: 11,
              wordBreak: "break-all",
              color: "var(--fg)",
            }}
          >
            {shareUrl}
          </div>
        </div>
      )}

      {copyError && (
        <div
          role="alert"
          style={{ color: "var(--danger-fg)", fontSize: 12 }}
        >
          {copyError}
        </div>
      )}

      {/* Audio element drives the preview playback. Hidden — play/pause lives
          in the explicit button above so users aren't confused by two sets
          of transport controls. */}
      <audio
        ref={audioRef}
        preload="metadata"
        onTimeUpdate={onTimeUpdate}
        onEnded={() => setIsPlaying(false)}
        style={{ display: "none" }}
      />
    </div>
  );

  const footer = (
    <DialogFooter>
      <Button variant="ghost" onClick={onClose} disabled={busy}>
        Close
      </Button>
      <Button
        variant="primary"
        onClick={() => void onCopy()}
        disabled={!picked || busy || !track}
        leadingIcon={
          busy ? (
            <ArrowPathIcon className="size-3.5 animate-spin" />
          ) : copied ? (
            <CheckIcon className="size-3.5" />
          ) : (
            <ClipboardDocumentIcon className="size-3.5" />
          )
        }
      >
        {busy ? "Generating…" : copied ? "Copied!" : "Copy share link"}
      </Button>
    </DialogFooter>
  );

  return (
    <DialogShell open={open} title="Share track" onClose={onClose}>
      <div
        style={{
          display: "grid",
          gridTemplateRows: "1fr auto",
          minHeight: 0,
          overflow: "hidden",
        }}
      >
        <div style={{ overflowY: "auto" }}>{body}</div>
        {footer}
      </div>
    </DialogShell>
  );
}

function HeaderBlock({ track }: { track: TrackDetail }) {
  const primary =
    track.artists.find((a) => a.role === "primary")?.name ??
    track.artists[0]?.name ??
    "Unknown artist";
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
      <CoverArt
        src={track.has_cover ? trackCoverUrl(track) : undefined}
        seed={track.album_id ?? track.id}
        label={track.title}
        size={64}
        radius={10}
      />
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: 14,
            fontWeight: 600,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {track.title}
        </div>
        <div
          style={{
            color: "var(--fg-muted)",
            fontSize: 12,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {primary}
          {track.album_title ? ` · ${track.album_title}` : ""}
        </div>
        <div
          className="mono"
          style={{ color: "var(--fg-subtle)", fontSize: 10.5, marginTop: 2 }}
        >
          {fmtDurationMs(track.duration_ms)}
        </div>
      </div>
    </div>
  );
}

/**
 * PreviewStrip renders the scrubber: a horizontal track with the selected
 * window highlighted and a grabbable handle at its start. Dragging the
 * window (or clicking anywhere on the strip) sets the new start time.
 * Pointer Events are captured on the strip so the drag stays live even if
 * the user's cursor leaves the element.
 */
function PreviewStrip({
  durationSec,
  startSec,
  endSec,
  currentSec,
  maxStartSec,
  onStartChange,
}: {
  durationSec: number;
  startSec: number;
  endSec: number;
  currentSec: number;
  maxStartSec: number;
  onStartChange: (s: number) => void;
}) {
  const stripRef = useRef<HTMLDivElement | null>(null);

  const setFromPointer = useCallback(
    (clientX: number) => {
      const el = stripRef.current;
      if (!el || durationSec <= 0) return;
      const rect = el.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      // Center the selected window on the click point, then clamp so it never
      // extends past the track. This makes click-to-place feel natural:
      // wherever you click, that moment is roughly the middle of the
      // preview, not the start.
      const centerSec = ratio * durationSec;
      const windowHalf = (endSec - startSec) / 2;
      const next = Math.round(centerSec - windowHalf);
      onStartChange(Math.max(0, Math.min(maxStartSec, next)));
    },
    [durationSec, startSec, endSec, maxStartSec, onStartChange],
  );

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (durationSec <= 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setFromPointer(e.clientX);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.buttons === 0) return;
    setFromPointer(e.clientX);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const pct = (sec: number) =>
    durationSec > 0 ? (Math.max(0, Math.min(durationSec, sec)) / durationSec) * 100 : 0;
  const startPct = pct(startSec);
  const endPct = pct(endSec);
  const playheadPct = pct(currentSec);

  return (
    <div
      ref={stripRef}
      role="slider"
      aria-label="Preview window start"
      aria-valuemin={0}
      aria-valuemax={Math.max(0, maxStartSec)}
      aria-valuenow={startSec}
      tabIndex={0}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 5 : 1;
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          onStartChange(startSec - step);
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          onStartChange(startSec + step);
        } else if (e.key === "Home") {
          e.preventDefault();
          onStartChange(0);
        } else if (e.key === "End") {
          e.preventDefault();
          onStartChange(maxStartSec);
        }
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{
        position: "relative",
        height: 44,
        borderRadius: 6,
        background: "var(--bg-elev-1)",
        border: "1px solid var(--border-soft)",
        cursor: durationSec > 0 ? "pointer" : "not-allowed",
        touchAction: "none",
        userSelect: "none",
      }}
    >
      {/* Highlighted share window */}
      <div
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: `${startPct}%`,
          width: `${Math.max(2, endPct - startPct)}%`,
          background: "color-mix(in oklch, var(--accent) 30%, transparent)",
          borderLeft: "2px solid var(--accent)",
          borderRight: "2px solid var(--accent)",
          pointerEvents: "none",
        }}
      />
      {/* Playhead while previewing */}
      <div
        style={{
          position: "absolute",
          top: -2,
          bottom: -2,
          left: `${playheadPct}%`,
          width: 2,
          background: "var(--fg)",
          opacity: 0.7,
          pointerEvents: "none",
        }}
      />
    </div>
  );
}
