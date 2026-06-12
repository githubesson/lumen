import type { ReactNode } from "react";

/**
 * Centered empty/placeholder panel. Replaces the per-page reimplementations
 * (two divergent local EmptyState components plus inline copies). `hint`
 * accepts a node so callers can pass a link (e.g. /replay's "import" prompt).
 */
export default function EmptyState({
  icon,
  title,
  hint,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  hint?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`empty-state${className ? ` ${className}` : ""}`}>
      {icon && (
        <div className="empty-state-icon" aria-hidden="true">
          {icon}
        </div>
      )}
      <div className="empty-state-title">{title}</div>
      {hint && <div className="empty-state-hint">{hint}</div>}
    </div>
  );
}
