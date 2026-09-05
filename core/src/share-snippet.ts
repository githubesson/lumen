import {
  DEFAULT_SHARE_SNIPPET_DURATION_SEC,
  MAX_SHARE_SNIPPET_DURATION_SEC,
  MIN_SHARE_SNIPPET_DURATION_SEC,
} from "./api-media";

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
