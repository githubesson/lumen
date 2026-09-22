import {
  normalizeSnippetSelection,
  snippetWindow,
} from "@music-library/core/share-snippet";
import { useEffect, useMemo, useState } from "react";
import { Pause as PauseIcon, Play as PlayIcon } from "lucide-react";
import {
  DEFAULT_SHARE_SNIPPET_DURATION_SEC,
  trackCoverUrl,
  type TrackDetail,
} from "../api";
import { Button } from "./Button";
import CoverArt from "./CoverArt";
import DialogFooter from "./DialogFooter";
import { DialogShell } from "./DialogShell";
import CopyLinkButton, { useCopyLabel } from "./share/CopyLinkButton";
import PreviewStrip from "./share/PreviewStrip";
import { useShareLink } from "./share/useShareLink";
import { useSnippetPreview } from "./share/useSnippetPreview";
import { fmtDurationMs, fmtDurationSec } from "../lib/format";
import { useTrackDetail } from "../lib/useTrackDetail";

interface Props {
  open: boolean;
  trackId: string | null;
  onClose: () => void;
}

/** The clip window. Its fields only ever change together: on reset and when
 *  the user drags or keys the window. */
interface Selection {
  startSec: number;
  durationSec: number;
  picked: boolean; // user has moved the window
}

const INITIAL_SELECTION: Selection = {
  startSec: 0,
  durationSec: DEFAULT_SHARE_SNIPPET_DURATION_SEC,
  picked: false,
};

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

  const [selection, setSelection] = useState(INITIAL_SELECTION);
  const { startSec, durationSec: selectedDurationSec, picked } = selection;

  const {
    shareUrl,
    busy,
    copied,
    copyError,
    copy: copyShareLink,
    invalidate: invalidateShareLink,
    reset: resetShareLink,
  } = useShareLink();
  const { shownLabel, swapping } = useCopyLabel(busy, copied);

  const durationSec = useMemo(
    () => (track ? Math.max(0, track.duration_ms / 1000) : 0),
    [track],
  );
  const {
    maxDurationSec: maxPreviewDurationSec,
    minDurationSec: minPreviewDurationSec,
    effectiveDurationSec: effectivePreviewSec,
    maxStartSec,
    endSec,
    displayDurationSec: displayPreviewSec,
  } = snippetWindow(durationSec, selectedDurationSec, startSec);

  const {
    audioRef,
    isPlaying,
    currentSec,
    onTimeUpdate,
    onEnded,
    togglePlay,
    reset: resetPreview,
  } = useSnippetPreview({ open, track, startSec, endSec });

  // Reset picker state on open / track changes so reopening on a different row
  // starts clean. Track metadata itself is loaded by useTrackDetail, which
  // guards against stale slow responses from a previous track.
  useEffect(() => {
    if (!open || !trackId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelection(INITIAL_SELECTION);
    resetPreview();
    resetShareLink();
  }, [open, trackId, resetPreview, resetShareLink]);

  const onWindowChange = (nextStartSec: number, nextDurationSec: number) => {
    const { startSec: nextStart, durationSec: nextDuration } =
      normalizeSnippetSelection(durationSec, nextStartSec, nextDurationSec);
    // Keep the same object when a drag is clamped in place, so it doesn't
    // re-render the dialog for nothing.
    setSelection((prev) =>
      prev.picked &&
      prev.startSec === nextStart &&
      prev.durationSec === nextDuration
        ? prev
        : { startSec: nextStart, durationSec: nextDuration, picked: true },
    );
    // Invalidate any previously-generated share URL — it's tied to the
    // old window. User needs to confirm the new selection.
    invalidateShareLink();
  };

  const onCopy = async () => {
    if (!trackId || !picked) return;
    await copyShareLink(trackId, startSec, effectivePreviewSec);
  };

  const body = loadError ? (
    <div style={{ padding: 16, color: "var(--destructive)" }}>{loadError}</div>
  ) : !track ? (
    <div
      className="mono"
      style={{ padding: 16, color: "var(--muted-foreground)", fontSize: 12 }}
    >
      Loading…
    </div>
  ) : (
    <div style={{ padding: 16, display: "grid", gap: 14, fontSize: 14 }}>
      <HeaderBlock track={track} />

      <div style={{ display: "grid", gap: 7 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span style={{ color: "var(--muted-foreground)" }}>Clip window</span>
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
            color: "var(--muted-foreground)",
            fontSize: 12,
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
          style={{ color: "var(--muted-foreground)", fontSize: 12 }}
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
          <div className="eyebrow">
            Share link
          </div>
          <div
            className="font-mono"
            style={{
              fontSize: 12,
              wordBreak: "break-all",
              color: "var(--foreground)",
            }}
          >
            {shareUrl}
          </div>
        </div>
      )}

      {copyError && (
        <div
          role="alert"
          style={{ color: "var(--destructive)", fontSize: 12 }}
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
        onEnded={onEnded}
        style={{ display: "none" }}
      />
    </div>
  );

  const footer = (
    <DialogFooter>
      <Button variant="ghost" onClick={onClose} disabled={busy}>
        Close
      </Button>
      <CopyLinkButton
        shownLabel={shownLabel}
        swapping={swapping}
        onClick={() => void onCopy()}
        disabled={!picked || busy || !track}
      />
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
            color: "var(--muted-foreground)",
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
          style={{ color: "var(--muted-foreground)", fontSize: 12, marginTop: 2 }}
        >
          {fmtDurationMs(track.duration_ms)}
        </div>
      </div>
    </div>
  );
}
