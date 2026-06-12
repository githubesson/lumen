import { Link } from "react-router-dom";
import { PlayIcon } from "@heroicons/react/16/solid";
import type { MouseEventHandler, ReactNode } from "react";
import { swatchFor } from "../lib/swatch";

/**
 * Generic cover-art tile (the `.card` pattern): cover or hashed swatch, title,
 * subtitle, optional play-on-hover button and rank badge. Replaces the
 * copy-pasted track/album tile markup across Home and Replay.
 */
export default function MediaCard({
  to,
  coverUrl,
  swatchSeed,
  title,
  subtitle,
  rankBadge,
  onPlay,
  onContextMenu,
  playLabel,
}: {
  to?: string;
  coverUrl?: string | null;
  /** Seed for the placeholder gradient when there is no coverUrl. */
  swatchSeed?: string;
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
      style={
        coverUrl
          ? { backgroundImage: `url(${coverUrl})` }
          : swatchSeed
            ? { background: swatchFor(swatchSeed) }
            : undefined
      }
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
