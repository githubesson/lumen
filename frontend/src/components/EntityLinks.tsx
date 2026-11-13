import { Fragment, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import type { TrackListItem } from "@music-library/core";
import { displayText } from "../lib/format";
import { artistNames, trackArtistHref } from "../lib/nowPlayingLinks";

// The latest link activation, app-wide: a slow lookup that a later click
// (or a page opened meanwhile) has overtaken must not navigate late.
let latestActivation = 0;

/**
 * Text (or a cover) that opens a page, looked up when clicked. Needs a router.
 *
 * An inline link rather than a button: it sits in a line of text (a title, an
 * artist line), so that line's ellipsis truncates it like the words around it,
 * and screen readers hear it as navigation. The page is looked up on click,
 * so there's no href to give an `<a>`.
 */
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
  // A lookup that fails or finds nothing leaves the page as it is, as does
  // one that a later link or another page has overtaken.
  const open = () => {
    const activation = ++latestActivation;
    const from = window.location.href;
    void href()
      .then((to) => {
        if (to && activation === latestActivation && window.location.href === from) navigate(to);
      })
      .catch(() => {});
  };
  // A cover is a block, and a span can't hold one.
  const Tag = named ? "div" : "span";
  return (
    <Tag
      role="link"
      tabIndex={0}
      className={"entity-link" + (className ? ` ${className}` : "")}
      title={label}
      aria-label={named ? label : undefined}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || event.repeat) return;
        event.preventDefault();
        open();
      }}
    >
      {children}
    </Tag>
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
