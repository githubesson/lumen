import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
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
  // Reset picker state on open / track changes so reopening on a different row
  // starts clean. Track metadata itself is loaded by useTrackDetail, which
  // guards against stale slow responses from a previous track.
  useEffect(() => {
    if (!open || !trackId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
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

  const onWindowChange = (nextStartSec: number, nextDurationSec: number) => {
    const nextDuration = Math.max(
      minPreviewDurationSec,
      Math.min(maxPreviewDurationSec, Math.round(nextDurationSec)),
    );
    const nextMaxStart = Math.max(0, Math.floor(durationSec - nextDuration));
    const nextStart = Math.max(
      0,
      Math.min(nextMaxStart, Math.round(nextStartSec)),
    );
    setSelectedDurationSec(nextDuration);
    setStartSec(nextStart);
    setPicked(true);
    // Invalidate any previously-generated share URL — it's tied to the
    // old window. User needs to confirm the new selection.
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

      <div style={{ display: "grid", gap: 7 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span style={{ color: "var(--fg-muted)" }}>Clip window</span>
          <span
            className="mono"
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            {fmtDurationSec(displayPreviewSec)}
          </span>
        </div>
        <PreviewStrip
          durationSec={durationSec}
          startSec={startSec}
          endSec={endSec}
          currentSec={isPlaying ? currentSec : startSec}
          minPreviewDurationSec={minPreviewDurationSec}
          maxPreviewDurationSec={maxPreviewDurationSec}
          maxStartSec={maxStartSec}
          onWindowChange={onWindowChange}
        />
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            color: "var(--fg-subtle)",
            fontSize: 10.5,
          }}
          className="mono"
        >
          <span>Drag edges to resize · drag middle to move</span>
          <span style={{ whiteSpace: "nowrap" }}>
            {fmtDurationSec(startSec)} – {fmtDurationSec(endSec)}
            {durationSec > 0 && ` · of ${fmtDurationSec(durationSec)}`}
          </span>
        </div>
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
            : "Trim the edges or drag the window into place."}
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
        {busy ? "Generating share link…" : copied ? "Link copied" : "Copy share link"}
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
 * PreviewStrip renders the scrubber: drag either edge of the highlighted
 * window to trim the clip, or drag its middle to move the selection without
 * changing its duration. Pointer Events are captured on the strip so the drag
 * stays live even if the user's cursor leaves the element.
 */
function PreviewStrip({
  durationSec,
  startSec,
  endSec,
  currentSec,
  minPreviewDurationSec,
  maxPreviewDurationSec,
  maxStartSec,
  onWindowChange,
}: {
  durationSec: number;
  startSec: number;
  endSec: number;
  currentSec: number;
  minPreviewDurationSec: number;
  maxPreviewDurationSec: number;
  maxStartSec: number;
  onWindowChange: (startSec: number, durationSec: number) => void;
}) {
  const stripRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    kind: "start" | "end" | "window";
    grabOffsetSec: number;
  } | null>(null);
  const selectableEndSec = durationSec < minPreviewDurationSec
    ? durationSec
    : Math.floor(durationSec);

  const pointerSec = useCallback(
    (clientX: number) => {
      const el = stripRef.current;
      if (!el || durationSec <= 0) return 0;
      const rect = el.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return ratio * durationSec;
    },
    [durationSec],
  );

  const setFromPointer = useCallback(
    (clientX: number) => {
      const drag = dragRef.current;
      if (!drag || durationSec <= 0) return;

      const atSec = pointerSec(clientX) - drag.grabOffsetSec;
      if (drag.kind === "start") {
        const minStart = Math.max(0, endSec - maxPreviewDurationSec);
        const maxStart = Math.max(minStart, endSec - minPreviewDurationSec);
        const nextStart = Math.max(
          minStart,
          Math.min(maxStart, Math.round(atSec)),
        );
        onWindowChange(nextStart, endSec - nextStart);
        return;
      }

      if (drag.kind === "end") {
        const minEnd = Math.min(
          selectableEndSec,
          startSec + minPreviewDurationSec,
        );
        const maxEnd = Math.min(
          selectableEndSec,
          startSec + maxPreviewDurationSec,
        );
        const nextEnd = Math.max(
          minEnd,
          Math.min(maxEnd, Math.round(atSec)),
        );
        onWindowChange(startSec, nextEnd - startSec);
        return;
      }

      const windowDuration = endSec - startSec;
      const nextStart = Math.max(
        0,
        Math.min(maxStartSec, Math.round(atSec)),
      );
      onWindowChange(nextStart, windowDuration);
    },
    [
      durationSec,
      endSec,
      maxPreviewDurationSec,
      maxStartSec,
      minPreviewDurationSec,
      onWindowChange,
      pointerSec,
      selectableEndSec,
      startSec,
    ],
  );

  const beginDrag = (
    kind: "start" | "end" | "window",
    event: ReactPointerEvent<HTMLDivElement>,
    grabOffsetSec = 0,
  ) => {
    if (
      durationSec <= 0 ||
      (event.pointerType === "mouse" && event.button !== 0)
    ) {
      return;
    }
    event.stopPropagation();
    dragRef.current = { kind, grabOffsetSec };
    stripRef.current?.setPointerCapture(event.pointerId);
    setFromPointer(event.clientX);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const el = stripRef.current;
    if (!el || durationSec <= 0) return;
    const atSec = pointerSec(event.clientX);
    const edgeHitSec = (14 / el.getBoundingClientRect().width) * durationSec;
    const startDistance = Math.abs(atSec - startSec);
    const endDistance = Math.abs(atSec - endSec);

    if (Math.min(startDistance, endDistance) <= edgeHitSec) {
      if (startDistance <= endDistance) {
        beginDrag("start", event, atSec - startSec);
      } else {
        beginDrag("end", event, atSec - endSec);
      }
      return;
    }

    if (atSec >= startSec && atSec <= endSec) {
      beginDrag("window", event, atSec - startSec);
      return;
    }

    beginDrag("window", event, (endSec - startSec) / 2);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    setFromPointer(event.clientX);
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    const el = stripRef.current;
    if (el?.hasPointerCapture(event.pointerId)) {
      el.releasePointerCapture(event.pointerId);
    }
  };

  const resizeFromKeyboard = (
    edge: "start" | "end",
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    const step = event.shiftKey ? 5 : 1;
    if (edge === "start") {
      const minStart = Math.max(0, endSec - maxPreviewDurationSec);
      const maxStart = Math.max(minStart, endSec - minPreviewDurationSec);
      let nextStart: number | null = null;
      if (event.key === "ArrowLeft") nextStart = startSec - step;
      if (event.key === "ArrowRight") nextStart = startSec + step;
      if (event.key === "Home") nextStart = minStart;
      if (event.key === "End") nextStart = maxStart;
      if (nextStart === null) return;
      event.preventDefault();
      nextStart = Math.max(minStart, Math.min(maxStart, nextStart));
      onWindowChange(nextStart, endSec - nextStart);
      return;
    }

    const minEnd = Math.min(
      selectableEndSec,
      startSec + minPreviewDurationSec,
    );
    const maxEnd = Math.min(
      selectableEndSec,
      startSec + maxPreviewDurationSec,
    );
    let nextEnd: number | null = null;
    if (event.key === "ArrowLeft") nextEnd = endSec - step;
    if (event.key === "ArrowRight") nextEnd = endSec + step;
    if (event.key === "Home") nextEnd = minEnd;
    if (event.key === "End") nextEnd = maxEnd;
    if (nextEnd === null) return;
    event.preventDefault();
    nextEnd = Math.max(minEnd, Math.min(maxEnd, nextEnd));
    onWindowChange(startSec, nextEnd - startSec);
  };

  const pct = (sec: number) =>
    durationSec > 0
      ? (Math.max(0, Math.min(durationSec, sec)) / durationSec) * 100
      : 0;
  const startPct = pct(startSec);
  const endPct = pct(endSec);
  const playheadPct = pct(currentSec);

  return (
    <div
      ref={stripRef}
      role="group"
      aria-label="Clip window"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
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
        role="slider"
        aria-label="Move clip window"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, maxStartSec)}
        aria-valuenow={startSec}
        aria-valuetext={`${fmtDurationSec(startSec)} to ${fmtDurationSec(endSec)}`}
        tabIndex={0}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 5 : 1;
          let nextStart: number | null = null;
          if (event.key === "ArrowLeft") nextStart = startSec - step;
          if (event.key === "ArrowRight") nextStart = startSec + step;
          if (event.key === "Home") nextStart = 0;
          if (event.key === "End") nextStart = maxStartSec;
          if (nextStart === null) return;
          event.preventDefault();
          onWindowChange(nextStart, endSec - startSec);
        }}
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: `${startPct}%`,
          width: `${Math.max(0, endPct - startPct)}%`,
          background: "color-mix(in oklch, var(--accent) 30%, transparent)",
          borderTop:
            "1px solid color-mix(in oklch, var(--accent) 65%, transparent)",
          borderBottom:
            "1px solid color-mix(in oklch, var(--accent) 65%, transparent)",
          cursor: "grab",
        }}
      />
      <TrimHandle
        edge="start"
        positionPct={startPct}
        valueSec={startSec}
        minSec={Math.max(0, endSec - maxPreviewDurationSec)}
        maxSec={Math.max(0, endSec - minPreviewDurationSec)}
        onKeyDown={(event) => resizeFromKeyboard("start", event)}
      />
      <TrimHandle
        edge="end"
        positionPct={endPct}
        valueSec={endSec}
        minSec={Math.min(
          selectableEndSec,
          startSec + minPreviewDurationSec,
        )}
        maxSec={Math.min(
          selectableEndSec,
          startSec + maxPreviewDurationSec,
        )}
        onKeyDown={(event) => resizeFromKeyboard("end", event)}
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

function TrimHandle({
  edge,
  positionPct,
  valueSec,
  minSec,
  maxSec,
  onKeyDown,
}: {
  edge: "start" | "end";
  positionPct: number;
  valueSec: number;
  minSec: number;
  maxSec: number;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      role="slider"
      aria-label={`Clip ${edge}`}
      aria-valuemin={Math.round(minSec)}
      aria-valuemax={Math.round(maxSec)}
      aria-valuenow={Math.round(valueSec)}
      aria-valuetext={fmtDurationSec(valueSec)}
      tabIndex={0}
      onKeyDown={onKeyDown}
      style={{
        position: "absolute",
        zIndex: 2,
        top: 0,
        bottom: 0,
        left: `${positionPct}%`,
        width: 8,
        transform: edge === "start" ? "translateX(0)" : "translateX(-100%)",
        display: "grid",
        placeItems: "center",
        background:
          "color-mix(in oklch, var(--accent) 22%, var(--bg-elev-1))",
        borderLeft: "2px solid var(--accent)",
        borderRight: "2px solid var(--accent)",
        cursor: "ew-resize",
        touchAction: "none",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 2,
          height: 14,
          borderRadius: 999,
          background: "color-mix(in oklch, var(--accent) 70%, var(--fg))",
          opacity: 0.8,
          pointerEvents: "none",
        }}
      />
    </div>
  );
}
