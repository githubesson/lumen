import type { CSSProperties, ReactNode } from "react";

/**
 * `.section` block with the standard head (eyebrow sub + title, optional
 * right-aligned action like a "view all" link). Replaces the six inline
 * copies across Home's shelves and Replay's stat sections.
 */
export default function Section({
  sub,
  title,
  action,
  className,
  style,
  children,
  ...data
}: {
  sub?: ReactNode;
  title: ReactNode;
  action?: ReactNode;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
  /** `data-*` attributes for the section element. */
  [data: `data-${string}`]: string | undefined;
}) {
  return (
    <section className={`section ${className ?? ""}`.trim()} style={style} {...data}>
      <div className="section-head">
        <div>
          {sub != null && <div className="section-sub">{sub}</div>}
          <div className="section-title">{title}</div>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
