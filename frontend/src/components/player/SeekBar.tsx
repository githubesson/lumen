import { useCallback, useEffect, useRef, useState } from "react";

export default function SeekBar({
  value,
  onSeek,
  label,
  commitOnRelease = true,
}: {
  value: number;
  onSeek: (v: number) => void;
  label: string;
  commitOnRelease?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<number | null>(null);
  const pointer = useRef<number | null>(null);

  const endDrag = useCallback(() => {
    pointer.current = null;
    setPreview(null);
    setDragging(false);
  }, []);

  const fromEvent = useCallback((clientX: number) => {
    const el = ref.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(r.width, clientX - r.left));
    return r.width > 0 ? x / r.width : 0;
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId === pointer.current) {
        const next = fromEvent(ev.clientX);
        setPreview(next);
        if (!commitOnRelease) onSeek(next);
      }
    };
    const finish = (ev: PointerEvent) => {
      if (ev.pointerId !== pointer.current) return;
      if (ev.type === "pointerup") onSeek(fromEvent(ev.clientX));
      endDrag();
    };
    // Switching away mid-drag never delivers a release: drop the preview
    // rather than leave the thumb stuck there.
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("blur", endDrag);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", endDrag);
    };
  }, [dragging, onSeek, fromEvent, commitOnRelease, endDrag]);

  const onPointerDown: React.PointerEventHandler<HTMLDivElement> = (e) => {
    e.preventDefault();
    if (e.button !== 0) return;
    e.currentTarget.focus();
    // Keep the drag's events (above all its release) coming when the
    // pointer leaves the bar or the window.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Not a live pointer (synthetic events); the window listeners remain.
    }
    pointer.current = e.pointerId;
    setDragging(true);
    setPreview(fromEvent(e.clientX));
    if (!commitOnRelease) onSeek(fromEvent(e.clientX));
  };

  const onKeyDown: React.KeyboardEventHandler<HTMLDivElement> = (e) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      onSeek(Math.max(0, value - 0.05));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      onSeek(Math.min(1, value + 0.05));
    } else if (e.key === "Home") {
      e.preventDefault();
      onSeek(0);
    } else if (e.key === "End") {
      e.preventDefault();
      onSeek(1);
    }
  };

  const pct = Math.max(0, Math.min(1, preview ?? value)) * 100;
  const pctStr = pct.toFixed(3);

  return (
    <div
      ref={ref}
      className={"bar" + (dragging ? " dragging" : "")}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      onPointerDown={onPointerDown}
      onLostPointerCapture={(e) => {
        // After a release this is a no-op; otherwise the drag was lost.
        if (e.pointerId === pointer.current) endDrag();
      }}
      onKeyDown={onKeyDown}
    >
      <div
        className="bar-fill"
        style={{ ["--bar-progress" as string]: (pct / 100).toFixed(5) }}
      />
      <div className="bar-thumb" style={{ left: `${pctStr}%` }} />
    </div>
  );
}
