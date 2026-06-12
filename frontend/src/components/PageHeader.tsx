import type { ReactNode } from "react";

/**
 * Top-level page header: big title + optional mono count + right-aligned
 * actions. Replaces the inline-styled `<h1>` header chrome duplicated across
 * Playlists / PendingInvites / PlaylistNew / Admin.
 */
export default function PageHeader({
  title,
  count,
  actions,
}: {
  title: ReactNode;
  count?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <h1 className="page-title">{title}</h1>
      {count != null && <div className="mono page-count">{count}</div>}
      <div style={{ flex: 1 }} />
      {actions}
    </header>
  );
}
