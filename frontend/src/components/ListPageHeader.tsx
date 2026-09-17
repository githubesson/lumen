import type { ReactNode } from "react";
import { trackCoverUrl, type TrackListItem } from "../api";

const DEFAULT_FALLBACK_BACKGROUND = "var(--muted)";

/**
 * The `.detail-header` hero used by the list pages (Recent / Favorites, and
 * with a custom `art` slot, Replay / PlaylistDetail). Collapses the near-verbatim
 * header markup those pages duplicated.
 */
export default function ListPageHeader({
  kind,
  title,
  description,
  heroTrack,
  fallbackIcon,
  fallbackBackground,
  art,
  meta,
  actions,
  corner,
  className,
}: {
  kind: ReactNode;
  title: ReactNode;
  /** Muted paragraph between title and meta (e.g. a playlist description). */
  description?: ReactNode;
  heroTrack?: TrackListItem | null;
  fallbackIcon?: ReactNode;
  fallbackBackground?: string;
  /** Custom art node; overrides the heroTrack/fallback art when provided. */
  art?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  corner?: ReactNode;
  className?: string;
}) {
  const cover = heroTrack ? trackCoverUrl(heroTrack) : null;
  const headerClassName = [
    "detail-header",
    corner != null ? "has-corner" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <header className={headerClassName}>
      {art ?? (
        <div
          className="detail-art"
          style={
            cover
              ? { backgroundImage: `url(${cover})` }
              : { background: fallbackBackground ?? DEFAULT_FALLBACK_BACKGROUND }
          }
        >
          {!cover && fallbackIcon}
        </div>
      )}
      <div className="detail-body">
        <div className="detail-kind">{kind}</div>
        <h1 className="detail-title">{title}</h1>
        {description != null && (
          <p
            style={{
              color: "var(--muted-foreground)",
              fontSize: 14,
              margin: "0 0 10px",
              maxWidth: "60ch",
            }}
          >
            {description}
          </p>
        )}
        {meta != null && <div className="detail-meta">{meta}</div>}
        {actions != null && <div className="detail-actions">{actions}</div>}
      </div>
      {corner != null && <div className="detail-corner">{corner}</div>}
    </header>
  );
}
