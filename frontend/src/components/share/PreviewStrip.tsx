import {
  snippetHandleBounds,
  adjustSnippetWindow,
} from "@music-library/core/share-snippet";
import {
  useCallback,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { fmtDurationSec } from "../../lib/format";

/**
 * PreviewStrip renders the scrubber: drag either edge of the highlighted
 * window to trim the clip, or drag its middle to move the selection without
 * changing its duration. Pointer Events are captured on the strip so the drag
 * stays live even if the user's cursor leaves the element.
 */
export default function PreviewStrip({
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
  const {
    minStartSec,
    maxStartSec: maxResizeStartSec,
    minEndSec,
    maxEndSec,
  } = snippetHandleBounds({
    durationSec,
    startSec,
    endSec,
    minDurationSec: minPreviewDurationSec,
    maxDurationSec: maxPreviewDurationSec,
  });

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
      const next = adjustSnippetWindow({
        kind: drag.kind,
        atSec,
        startSec,
        endSec,
        durationSec,
        minDurationSec: minPreviewDurationSec,
        maxDurationSec: maxPreviewDurationSec,
        maxStartSec,
      });
      onWindowChange(next.startSec, next.durationSec);
    },
    [
      durationSec,
      endSec,
      maxPreviewDurationSec,
      maxStartSec,
      minPreviewDurationSec,
      onWindowChange,
      pointerSec,
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
    const value = edge === "start" ? startSec : endSec;
    let atSec: number | null = null;
    if (event.key === "ArrowLeft") atSec = value - step;
    if (event.key === "ArrowRight") atSec = value + step;
    if (event.key === "Home") atSec = edge === "start" ? minStartSec : minEndSec;
    if (event.key === "End") atSec = edge === "start" ? maxResizeStartSec : maxEndSec;
    if (atSec === null) return;
    event.preventDefault();
    const next = adjustSnippetWindow({
      kind: edge,
      atSec,
      startSec,
      endSec,
      durationSec,
      maxStartSec,
      minDurationSec: minPreviewDurationSec,
      maxDurationSec: maxPreviewDurationSec,
    });
    onWindowChange(next.startSec, next.durationSec);
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
        background: "var(--card)",
        border: "1px solid var(--border)",
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
          background: "color-mix(in oklch, var(--primary) 30%, transparent)",
          borderTop:
            "1px solid color-mix(in oklch, var(--primary) 65%, transparent)",
          borderBottom:
            "1px solid color-mix(in oklch, var(--primary) 65%, transparent)",
          cursor: "grab",
        }}
      />
      <TrimHandle
        edge="start"
        positionPct={startPct}
        valueSec={startSec}
        minSec={minStartSec}
        maxSec={maxResizeStartSec}
        onKeyDown={(event) => resizeFromKeyboard("start", event)}
      />
      <TrimHandle
        edge="end"
        positionPct={endPct}
        valueSec={endSec}
        minSec={minEndSec}
        maxSec={maxEndSec}
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
          background: "var(--foreground)",
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
          "color-mix(in oklch, var(--primary) 22%, var(--card))",
        borderLeft: "2px solid var(--primary)",
        borderRight: "2px solid var(--primary)",
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
          background: "color-mix(in oklch, var(--primary) 70%, var(--foreground))",
          opacity: 0.8,
          pointerEvents: "none",
        }}
      />
    </div>
  );
}
