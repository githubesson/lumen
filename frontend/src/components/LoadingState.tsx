/**
 * The one canonical "Loading…" placeholder (one glyph, one padding). Replaces
 * the 10-15 inline variants that disagreed on element, spacing, and "…" vs "...".
 */
export default function LoadingState({
  label = "Loading…",
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div className={`loading-state mono${className ? ` ${className}` : ""}`}>
      {label}
    </div>
  );
}
