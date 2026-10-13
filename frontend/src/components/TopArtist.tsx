import { Link } from "react-router-dom";
import { ArrowRight as ArrowRightIcon, Play as PlayIcon } from "lucide-react";
import type { TopArtistAction } from "@music-library/core/replay/replay";

/**
 * The pieces of a top-artist tile shared by Home's board and Replay, so the
 * two behave alike: the tile opens the artist's page when there is one and
 * otherwise plays them (see `topArtistAction`), its glyph shows which, and
 * its accessible name says it.
 */

/** A library artist's page. */
export const artistHref = (id: string) => `/library?view=artists&artist=${encodeURIComponent(id)}`;

/**
 * The tile's name, which is also its hit area (`className` stretches it over
 * the tile): a link to the artist's page or a button that plays them, read
 * out as "Open <name>" or "Play <name>". Plain text when the tile does
 * nothing.
 */
export function TopArtistName({
  action,
  artistId,
  name,
  onPlay,
  className,
  plainClassName,
}: {
  action: TopArtistAction;
  artistId: string;
  name: string;
  onPlay: () => void;
  /** For the link or button. */
  className: string;
  /** For the plain text. */
  plainClassName: string;
}) {
  if (action === "open") {
    return (
      <Link className={className} to={artistHref(artistId)}>
        <span className="sr-only">Open</span> {name}
      </Link>
    );
  }
  if (action === "play") {
    return (
      <button type="button" className={className} onClick={onPlay}>
        <span className="sr-only">Play</span> {name}
      </button>
    );
  }
  return <div className={plainClassName}>{name}</div>;
}

/**
 * What the tile does, drawn over its picture on hover: an arrow where it
 * opens a page, the play triangle where it plays. Decorative; the name says
 * the same to screen readers.
 */
export function TopArtistGlyph({
  action,
  className,
  iconClassName,
}: {
  action: TopArtistAction;
  className: string;
  iconClassName: string;
}) {
  if (!action) return null;
  const Icon = action === "open" ? ArrowRightIcon : PlayIcon;
  return (
    <span className={className} data-action={action} aria-hidden="true">
      <Icon className={iconClassName} />
    </span>
  );
}
