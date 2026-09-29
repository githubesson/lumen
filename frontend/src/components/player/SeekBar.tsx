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
      pointer.current = null;
      setPreview(null);
      setDragging(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
  }, [dragging, onSeek, fromEvent, commitOnRelease]);

  const onPointerDown: React.PointerEventHandler<HTMLDivElement> = (e) => {
    e.preventDefault();
    if (e.button !== 0) return;
    e.currentTarget.focus();
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
