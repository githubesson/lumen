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
      className={`mono ${className ?? ""}`.trim()}
      style={{
        fontSize: 10,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        color: "var(--fg-subtle)",
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
          color: "var(--fg-muted)",
          fontSize: 12.5,
          margin: 0,
          maxWidth: "72ch",
        }}
      >
        {description}
      </p>
    </div>
  );
}
