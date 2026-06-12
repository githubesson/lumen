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
  return (
    <div
      className={`segmented ${className ?? ""}`.trim()}
      role="tablist"
      aria-label={ariaLabel}
      style={style}
    >
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
