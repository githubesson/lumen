import { Fragment, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import type { TrackListItem } from "@music-library/core";
import { displayText } from "../lib/format";
import { artistNames, trackArtistHref } from "../lib/nowPlayingLinks";

/** Text (or a cover) that opens a page, looked up when clicked. Needs a router. */
export function PageLink({
  label,
  href,
  className,
  named,
  children,
}: {
  label: string;
  /** Use `label` as its name: for a link with no text of its own (a cover). */
  named?: boolean;
  href: () => Promise<string | null>;
  className?: string;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      className={"entity-link" + (className ? ` ${className}` : "")}
      title={label}
      aria-label={named ? label : undefined}
      // A lookup that fails or finds nothing leaves the page as it is.
      onClick={() => void href().then((to) => to && navigate(to)).catch(() => {})}
    >
      {children}
    </button>
  );
}

/** A track's artists, each opening their page. */
export function ArtistLinks({ track, fallback = "Unknown artist" }: { track: TrackListItem; fallback?: string }) {
  const names = artistNames(track.artist);
  if (names.length === 0) return <>{fallback}</>;
  return (
    <>
      {names.map((name, i) => (
        <Fragment key={name + i}>
          {i > 0 && ", "}
          <PageLink label={`Go to ${name}`} href={() => trackArtistHref(track, name)}>
            {displayText(name)}
          </PageLink>
        </Fragment>
      ))}
    </>
  );
}
