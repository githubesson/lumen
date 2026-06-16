import type { CSSProperties, ReactNode } from "react";
import clsx from "clsx";
import { AdminSectionTitle } from "../../pages/admin/AdminSectionTitle";

interface AdminSectionProps {
  title?: ReactNode;
  titleId?: string;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  surface?: boolean;
}

/**
 * Reusable admin section wrapper: optional mono title + consistent vertical
 * rhythm. Use `surface` when the section needs the elevated panel background
 * (e.g. forms); leave it off for tables/lists.
 */
export default function AdminSection({
  title,
  titleId,
  children,
  className,
  style,
  surface = false,
}: AdminSectionProps) {
  return (
    <section
      className={clsx(surface ? "surface" : undefined, className)}
      style={{
        display: "grid",
        gap: 14,
        ...(surface ? { padding: 20 } : null),
        ...style,
      }}
    >
      {title != null && (
        <AdminSectionTitle id={titleId} style={{ margin: 0 }}>
          {title}
        </AdminSectionTitle>
      )}
      {children}
    </section>
  );
}
