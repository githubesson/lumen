import { Link } from "react-router-dom";
import { Play as PlayIcon } from "lucide-react";
import type { MouseEventHandler, ReactNode } from "react";
import CoverArt from "./CoverArt";

/**
 * Generic cover-art tile (the `.card` pattern): cover or lettered placeholder, title,
 * subtitle, optional play-on-hover button and rank badge. Replaces the
 * copy-pasted track/album tile markup across Home and Replay.
 */
export default function MediaCard({
  to,
  coverUrl,
  artLabel,
  title,
  subtitle,
  rankBadge,
  onPlay,
  onContextMenu,
  playLabel,
}: {
  to?: string;
  coverUrl?: string | null;
  /** Initial for the placeholder when there's no cover; defaults to a string title. */
  artLabel?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  rankBadge?: ReactNode;
  onPlay?: () => void;
  onContextMenu?: MouseEventHandler<HTMLElement>;
  playLabel?: string;
}) {
  const playButton = onPlay && (
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
  );
  const linked = !!(to && onPlay);
  const art = (
    <CoverArt
      className="card-art"
      src={coverUrl}
      label={artLabel ?? (typeof title === "string" ? title : "")}
    >
      {rankBadge}
      {!linked && playButton}
    </CoverArt>
  );
  const sub = subtitle != null && <div className="card-sub">{subtitle}</div>;
  if (to && linked) {
    // Opens and plays. The play button can't sit inside the link, so the
    // title is the link and stretches over the whole card (`.card-link`),
    // with the play button after it (for Tab order) and above it.
    return (
      <div className="card card-linked" onContextMenu={onContextMenu}>
        {art}
        <div>
          <Link className="card-title card-link" to={to}>
            {title}
          </Link>
          {sub}
        </div>
        {playButton}
      </div>
    );
  }
  const body = (
    <div>
      <div className="card-title">{title}</div>
      {sub}
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
