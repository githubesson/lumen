import type { TrackArtist } from "./api";
import {
  DEFAULT_SHARE_SNIPPET_DURATION_SEC,
  MAX_SHARE_SNIPPET_DURATION_SEC,
  MIN_SHARE_SNIPPET_DURATION_SEC,
  parseTrackShareUrl,
  primaryArtistName,
  type TrackShareRef,
} from "./api-media";
import { sanitizeFilename } from "./audio-format";

/** Bounds used by both the preview and its trim controls, in seconds. */
export function snippetWindow(
  durationSec: number,
  selectedDurationSec: number,
  startSec: number,
) {
  const maxDurationSec =
    durationSec > 0
      ? Math.min(
          MAX_SHARE_SNIPPET_DURATION_SEC,
          Math.max(1, Math.ceil(durationSec)),
        )
      : DEFAULT_SHARE_SNIPPET_DURATION_SEC;
  const minDurationSec = Math.min(
    MIN_SHARE_SNIPPET_DURATION_SEC,
    maxDurationSec,
  );
  const effectiveDurationSec = Math.min(
    Math.max(minDurationSec, selectedDurationSec),
    maxDurationSec,
  );
  return {
    minDurationSec,
    maxDurationSec,
    effectiveDurationSec,
    maxStartSec: Math.max(0, Math.floor(durationSec - effectiveDurationSec)),
    endSec: Math.min(durationSec, startSec + effectiveDurationSec),
    displayDurationSec:
      durationSec > 0
        ? Math.min(effectiveDurationSec, durationSec)
        : effectiveDurationSec,
  };
}

/** Apply a trim gesture after the client converts its pointer to seconds. */
export function adjustSnippetWindow({
  kind,
  atSec,
  startSec,
  endSec,
  durationSec,
  minDurationSec,
  maxDurationSec,
  maxStartSec,
}: {
  kind: "start" | "end" | "window";
  atSec: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  minDurationSec: number;
  maxDurationSec: number;
  maxStartSec: number;
}): { startSec: number; durationSec: number } {
  const bounds = snippetHandleBounds({
    durationSec,
    startSec,
    endSec,
    minDurationSec,
    maxDurationSec,
  });
  if (kind === "start") {
    const nextStart = clamp(
      Math.round(atSec),
      bounds.minStartSec,
      bounds.maxStartSec,
    );
    return { startSec: nextStart, durationSec: endSec - nextStart };
  }
  if (kind === "end") {
    const nextEnd = clamp(
      Math.round(atSec),
      bounds.minEndSec,
      bounds.maxEndSec,
    );
    return { startSec, durationSec: nextEnd - startSec };
  }
  return {
    startSec: clamp(Math.round(atSec), 0, maxStartSec),
    durationSec: endSec - startSec,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Round and constrain a proposed selection before storing it in UI state. */
export function normalizeSnippetSelection(
  durationSec: number,
  startSec: number,
  selectedDurationSec: number,
) {
  const bounds = snippetWindow(
    durationSec,
    Math.round(selectedDurationSec),
    startSec,
  );
  return {
    startSec: clamp(Math.round(startSec), 0, bounds.maxStartSec),
    durationSec: bounds.effectiveDurationSec,
  };
}

/** Shared limits for pointer, keyboard, and accessibility trim controls. */
export function snippetHandleBounds({
  durationSec,
  startSec,
  endSec,
  minDurationSec,
  maxDurationSec,
}: {
  durationSec: number;
  startSec: number;
  endSec: number;
  minDurationSec: number;
  maxDurationSec: number;
}) {
  const minStartSec = Math.max(0, endSec - maxDurationSec);
  const selectableEndSec =
    durationSec < minDurationSec ? durationSec : Math.floor(durationSec);
  return {
    minStartSec,
    maxStartSec: Math.max(minStartSec, endSec - minDurationSec),
    minEndSec: Math.min(selectableEndSec, startSec + minDurationSec),
    maxEndSec: Math.min(selectableEndSec, startSec + maxDurationSec),
  };
}

/** How close, in pixels, a press has to land to an edge to grab it rather than the window. */
export const SNIPPET_EDGE_HIT_PX = 14;

/**
 * What a press on the strip grabs. Within `SNIPPET_EDGE_HIT_PX` of an edge it
 * grabs the nearer edge; inside the window, the window where it was pressed;
 * outside, the window by its middle, `recenter` asking the caller to move it
 * there at once. `grabOffsetSec` is subtracted from later pointer positions,
 * so the grabbed spot stays under the finger.
 */
export function snippetDragTarget({
  atSec,
  startSec,
  endSec,
  durationSec,
  widthPx,
}: {
  atSec: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  widthPx: number;
}): { kind: "start" | "end" | "window"; grabOffsetSec: number; recenter: boolean } {
  const edgeHitSec = widthPx > 0 ? (SNIPPET_EDGE_HIT_PX / widthPx) * durationSec : 0;
  const startDistance = Math.abs(atSec - startSec);
  const endDistance = Math.abs(atSec - endSec);
  if (Math.min(startDistance, endDistance) <= edgeHitSec) {
    return startDistance <= endDistance
      ? { kind: "start", grabOffsetSec: atSec - startSec, recenter: false }
      : { kind: "end", grabOffsetSec: atSec - endSec, recenter: false };
  }
  if (atSec >= startSec && atSec <= endSec) {
    return { kind: "window", grabOffsetSec: atSec - startSec, recenter: false };
  }
  return { kind: "window", grabOffsetSec: (endSec - startSec) / 2, recenter: true };
}

/**
 * A share page's own parameters (the route's track id and the `t`, `d` and
 * `sig` query values) checked by the same rules as a pasted share URL. They
 * are put back into a share path and read with `parseTrackShareUrl`, so there
 * is one validator to keep in step with the server.
 */
export function parseTrackShareParams({
  trackId,
  t,
  d,
  sig,
}: {
  trackId: string | null | undefined;
  t: string | null | undefined;
  d: string | null | undefined;
  sig: string | null | undefined;
}): TrackShareRef | null {
  if (!trackId) return null;
  const query = new URLSearchParams();
  if (t != null) query.set("t", t);
  if (d != null) query.set("d", d);
  if (sig != null) query.set("sig", sig);
  const ref = parseTrackShareUrl(
    `/share/track/${encodeURIComponent(trackId)}?${query.toString()}`,
  );
  return ref && { ...ref, trackId };
}

/**
 * The file name (without extension) for a saved clip: "Artist - Title
 * (clip)", made filename-safe. A track with no known artist is just "Title
 * (clip)" rather than "Unknown artist - …".
 */
export function shareClipName(
  track:
    | { title?: string | null; artist?: string | null; artists?: TrackArtist[] }
    | null
    | undefined,
): string {
  const artist = (
    track?.artists?.length ? primaryArtistName(track, "") : (track?.artist ?? "")
  ).trim();
  const title = track?.title?.trim() || "Lumen";
  return sanitizeFilename(`${artist ? `${artist} - ` : ""}${title} (clip)`);
}
