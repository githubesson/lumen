import type { CSSProperties, ReactNode } from "react";

/**
 * The admin pages' eyebrow heading (wider 0.12em tracking than the shared
 * `.eyebrow` class). Replaces the eight inline copies across the admin
 * sections; pass margins via `style` at the call site.
 */
export function AdminSectionTitle({
  as: Tag = "h2",
  id,
  className,
  style,
  children,
}: {
  as?: "h2" | "div";
  id?: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <Tag
      id={id}
      className={`eyebrow ${className ?? ""}`.trim()}
      style={{
        margin: 0,
        ...style,
      }}
    >
      {children}
    </Tag>
  );
}

/**
 * Title + muted description intro shared by the pin sections
 * (ArtistGrid / Filen).
 */
export function AdminSectionIntro({
  id,
  title,
  description,
}: {
  id?: string;
  title: ReactNode;
  description: ReactNode;
}) {
  return (
    <div>
      <AdminSectionTitle id={id} style={{ margin: "0 0 6px" }}>
        {title}
      </AdminSectionTitle>
      <p
        style={{
          color: "var(--muted-foreground)",
          fontSize: 14,
          margin: 0,
          maxWidth: "72ch",
        }}
      >
        {description}
      </p>
    </div>
  );
}
