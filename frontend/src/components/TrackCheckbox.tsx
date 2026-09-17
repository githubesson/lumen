import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";
import clsx from "clsx";

interface TrackCheckboxProps {
  checked: boolean;
  indeterminate?: boolean;
  ariaLabel: string;
  onChange: (e: ReactMouseEvent<HTMLInputElement>) => void;
  className?: string;
  /** Set to -1 to keep the input out of the tab order (collapsed columns). */
  tabIndex?: number;
}

/**
 * Selection checkbox used inside track tables. Supports the indeterminate
 * state used by "select all" when only some rows are selected, and stops
 * click propagation so row clicks don't fight with checkbox clicks.
 */
export default function TrackCheckbox({
  checked,
  indeterminate = false,
  ariaLabel,
  onChange,
  className,
  tabIndex,
}: TrackCheckboxProps) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <input
      ref={ref}
      type="checkbox"
      className={clsx("track-check", className)}
      checked={checked}
      tabIndex={tabIndex}
      aria-label={ariaLabel}
      onClick={(e) => {
        e.stopPropagation();
        onChange(e);
      }}
      onChange={() => {}}
    />
  );
}
