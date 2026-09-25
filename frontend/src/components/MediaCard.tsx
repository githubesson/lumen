import { Link } from "react-router-dom";
import { Play as PlayIcon } from "lucide-react";
import type { MouseEventHandler, ReactNode } from "react";

/**
 * Generic cover-art tile (the `.card` pattern): cover or muted placeholder, title,
 * subtitle, optional play-on-hover button and rank badge. Replaces the
 * copy-pasted track/album tile markup across Home and Replay.
 */
export default function MediaCard({
  to,
  coverUrl,
  title,
  subtitle,
  rankBadge,
  onPlay,
  onContextMenu,
  playLabel,
}: {
  to?: string;
  coverUrl?: string | null;
  title: ReactNode;
  subtitle?: ReactNode;
  rankBadge?: ReactNode;
  onPlay?: () => void;
  onContextMenu?: MouseEventHandler<HTMLElement>;
  playLabel?: string;
}) {
  const art = (
    <div
      className="card-art"
      style={coverUrl ? { backgroundImage: `url(${coverUrl})` } : undefined}
      aria-hidden="true"
    >
      {rankBadge}
      {onPlay && (
        <button
          type="button"
          className="card-play"
          aria-label={playLabel ?? "Play"}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onPlay();
          }}
        >
          <PlayIcon className="size-4" />
        </button>
      )}
    </div>
  );
  const body = (
    <div>
      <div className="card-title">{title}</div>
      {subtitle != null && <div className="card-sub">{subtitle}</div>}
    </div>
  );
  if (to) {
    return (
      <Link className="card" to={to} onContextMenu={onContextMenu}>
        {art}
        {body}
      </Link>
    );
  }
  return (
    <div className="card" onContextMenu={onContextMenu}>
      {art}
      {body}
    </div>
  );
}

/**
 * Stand-ins for a row of cards that is still loading. Same box as a real
 * card (square art, one title line, one subtitle line), so the row doesn't
 * change height when the cards arrive.
 */
export function MediaCardPlaceholders({ count = 6 }: { count?: number }) {
  return Array.from({ length: count }, (_, i) => (
    <div key={i} className="card card-placeholder" aria-hidden="true">
      <div className="card-art" />
      <div>
        <div className="card-title">
          <span className="skeleton-text" style={{ width: "70%" }} />
        </div>
        <div className="card-sub">
          <span className="skeleton-text" style={{ width: "45%" }} />
        </div>
      </div>
    </div>
  ));
}
