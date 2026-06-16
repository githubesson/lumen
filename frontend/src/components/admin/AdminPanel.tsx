import type { ReactNode } from "react";
import clsx from "clsx";

interface AdminPanelProps {
  children: ReactNode;
  className?: string;
}

/**
 * The standard outer wrapper for an admin section page. Provides the
 * consistent vertical rhythm shared by LibraryAdminSection,
 * UsersAdminSection, and InvitesAdminSection.
 */
export default function AdminPanel({ children, className }: AdminPanelProps) {
  return (
    <div
      className={clsx("admin-section-wrap", className)}
      style={{ display: "grid", gap: 20 }}
    >
      {children}
    </div>
  );
}
