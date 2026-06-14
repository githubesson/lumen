import type { ReactNode } from "react";
import { trackCoverUrl, type TrackListItem } from "../api";

const DEFAULT_GRADIENT =
  "linear-gradient(135deg, color-mix(in oklch, var(--accent) 30%, var(--bg-elev-2)), var(--bg-elev-3))";

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
  fallbackGradient,
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
  fallbackGradient?: string;
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
              : { background: fallbackGradient ?? DEFAULT_GRADIENT }
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
              color: "var(--fg-muted)",
              fontSize: 13,
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
