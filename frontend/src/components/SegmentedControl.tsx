import { useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

export interface SegmentedOption<V extends string> {
  value: V;
  label: ReactNode;
  /** Accessible name when `label` is icon-only. */
  ariaLabel?: string;
}

/**
 * The `.segmented` button group used for view tabs and toggles. Replaces the
 * hand-rolled copies in Admin / Library / PlaylistDetail, which had drifted on
 * a11y (only Admin set `role="tab"` / `aria-selected`).
 */
export default function SegmentedControl<V extends string>({
  value,
  onChange,
  options,
  "aria-label": ariaLabel,
  className,
  style,
}: {
  value: V;
  onChange: (value: V) => void;
  options: SegmentedOption<V>[];
  "aria-label"?: string;
  className?: string;
  style?: CSSProperties;
}) {
  // The active pill is one element that travels, rather than a background
  // painted on whichever button is selected, so the selection keeps its
  // spatial continuity when you switch tabs.
  const listRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<{ x: number; w: number } | null>(null);
  // The first measurement must land with transitions still off, or the pill
  // animates in from zero width on mount (and slides in from the left edge
  // whenever the preselected option isn't the first). `measure()` reads
  // offsetLeft, which flushes a style recalc, so the browser has a computed
  // style to transition *from* by the time the real values arrive -- one
  // painted frame of `data-initial` is what prevents that.
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      const active = list.querySelector<HTMLButtonElement>("button.active");
      if (!active) {
        setRect(null);
        return;
      }
      setRect({ x: active.offsetLeft, w: active.offsetWidth });
    };
    measure();
    // Never reset to false: re-running on a `value` change must not disarm the
    // travel transition. Re-setting the same value is a no-op in React.
    const raf = requestAnimationFrame(() => setReady(true));
    // Labels can change width (font load, i18n, a count badge appearing).
    if (typeof ResizeObserver === "undefined") {
      return () => cancelAnimationFrame(raf);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(list);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [value, options]);

  return (
    <div
      ref={listRef}
      className={`segmented ${className ?? ""}`.trim()}
      role="tablist"
      aria-label={ariaLabel}
      style={style}
    >
      <span
        className="segmented-indicator"
        aria-hidden="true"
        data-initial={!ready || rect === null || undefined}
        style={{
          ["--seg-x" as string]: `${rect?.x ?? 0}px`,
          ["--seg-w" as string]: `${rect?.w ?? 0}px`,
        }}
      />
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          aria-label={o.ariaLabel}
          className={o.value === value ? "active" : ""}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
