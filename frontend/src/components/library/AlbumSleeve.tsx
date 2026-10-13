import {
  Fragment,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  ArrowLeft as ArrowLeftIcon,
  Pencil as PencilIcon,
  Play as PlayIcon,
  Shuffle as ShuffleIcon,
} from "lucide-react";
import type { AlbumCredit, AlbumFact } from "@music-library/core/entity-labels";
import { startListPlayback } from "@music-library/core/player/play-list";
import type { TrackListItem } from "../../api";
import { usePlayer, useRemotePlayback } from "../../context/Player";
import { displayText } from "../../lib/format";
import { Button } from "../Button";
import CoverArt from "../CoverArt";
import SearchInput from "../SearchInput";
import { TrackSelectionToolbarPlaceholder } from "../TrackSelectionToolbar";

/** The list's tool row holds its Select button: pass to `TrackList`. */
export const ALBUM_SELECTION_HOST_ID = "album-track-selection";

/** Below this content width the column stacks into a header above the list. */
export const STACK_BELOW_PX = 720;

const NO_TRACKS: TrackListItem[] = [];

/** Facts the page shows as placeholders while the album loads. */
const LOADING_FACTS = ["Released", "Length"];

export interface AlbumSleeveAlbum {
  title: string;
  coverSrc?: string | null;
  /** No cover to try: show the placeholder straight away. */
  coverMissing?: boolean;
  credits: AlbumCredit[];
  facts: AlbumFact[];
  /** What a fact means on this kind of album page, shown on hover. */
  factHints?: Partial<Record<AlbumFact["key"], string>>;
  /** The whole list, for Play all (not the search's matches). */
  tracks: TrackListItem[];
}

export interface AlbumSleeveSearch {
  query: string;
  setQuery: (query: string) => void;
  matchCount: number;
  totalCount: number;
  searchActive: boolean;
}

/**
 * An album page as a sleeve: who it is in a column on the left (cover,
 * title, artists, Play, the album's details), a divider, and the list on the
 * right. The column stays put while a long list scrolls. When the view is too
 * narrow for both, the column stacks into a header above the list.
 *
 * `album` is null while the first load is out: the page then shows the same
 * frame with placeholders, so nothing pops in or shifts when it lands.
 */
export function AlbumSleeve({
  kind,
  onBack,
  album,
  loadingLabel,
  actions,
  reserveActions = false,
  detailsLink,
  onEdit,
  search,
  searchRef,
  children,
}: {
  kind: ReactNode;
  onBack: () => void;
  album: AlbumSleeveAlbum | null;
  /** Announced while `album` is null. */
  loadingLabel: string;
  /**
   * A row under Play for one more action (an album download, or the library
   * copy of a release that's all saved). One control, so the row never wraps
   * and the loading frame can hold its exact height.
   */
  actions?: ReactNode;
  /**
   * While loading, hold a row for `actions` when the loaded page will almost
   * surely have them, so the details below don't move when it lands.
   */
  reserveActions?: boolean;
  /** A quiet link under the details (a TIDAL release's library copy). */
  detailsLink?: ReactNode;
  /** Admin: opens the album editor from the Details heading. */
  onEdit?: () => void;
  search: AlbumSleeveSearch;
  /** The search input, which mod+F focuses. */
  searchRef: RefObject<HTMLInputElement>;
  /** The list: an error banner and the TrackList. */
  children?: ReactNode;
}) {
  const viewRef = useRef<HTMLDivElement>(null);
  const sideRef = useRef<HTMLElement>(null);
  useSleeveLayout(viewRef, sideRef);
  const title = album ? displayText(album.title) : null;

  return (
    <div ref={viewRef} className="view album-sleeve" aria-busy={album ? undefined : true}>
      <header ref={sideRef} className="album-sleeve-side">
        <Button
          variant="ghost"
          size="sm"
          className="album-sleeve-back"
          onClick={onBack}
          leadingIcon={<ArrowLeftIcon className="size-3.5" />}
        >
          Library
        </Button>
        {album ? (
          <CoverArt
            className="album-sleeve-art"
            src={album.coverSrc}
            label={album.title}
            forcePlaceholder={album.coverMissing}
          />
        ) : (
          <div className="album-sleeve-art cover-art" aria-hidden="true" />
        )}
        <div className="album-sleeve-head">
          <div className="album-sleeve-name">
            <div className="detail-kind">{kind}</div>
            <h1 className="album-sleeve-title">
              {title ?? (
                // Two lines, the usual length of a title in the column.
                <>
                  <span className="skeleton-text" style={{ width: "90%" }} />
                  <br />
                  <span className="skeleton-text" style={{ width: "55%" }} />
                </>
              )}
            </h1>
            {album ? (
              album.credits.length > 0 && <AlbumCredits credits={album.credits} />
            ) : (
              <div className="album-sleeve-by" role="status">
                {loadingLabel}
              </div>
            )}
          </div>
          <SleevePlay tracks={album?.tracks ?? NO_TRACKS} loading={!album} />
          {album
            ? actions != null && <div className="album-sleeve-more">{actions}</div>
            : reserveActions && (
                <div className="album-sleeve-more" aria-hidden="true">
                  <span className="skeleton-text album-sleeve-more-skeleton" />
                </div>
              )}
        </div>
        <section className="album-sleeve-details">
          <div className="album-sleeve-details-head">
            <h2 className="eyebrow">Details</h2>
            {onEdit && (
              <button
                type="button"
                className="iconbtn"
                aria-label="Edit album"
                title="Edit album"
                onClick={onEdit}
              >
                <PencilIcon className="size-3.5" />
              </button>
            )}
          </div>
          <dl className="track-info-fields">
            {album
              ? album.facts.map((fact) => (
                  <div key={fact.key}>
                    <dt>{fact.label}</dt>
                    <dd title={album.factHints?.[fact.key]}>{fact.value}</dd>
                  </div>
                ))
              : LOADING_FACTS.map((label) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>
                      <span className="skeleton-text" style={{ width: "5em" }} />
                    </dd>
                  </div>
                ))}
          </dl>
          {album && detailsLink && <div className="album-sleeve-details-foot">{detailsLink}</div>}
        </section>
      </header>
      <div className="album-sleeve-rule" aria-hidden="true" />
      <div className="album-sleeve-list">
        <div className="album-sleeve-tools">
          <SearchInput
            ref={searchRef}
            className="album-sleeve-search"
            value={search.query}
            onChange={(e) => search.setQuery(e.target.value)}
            onClear={() => search.setQuery("")}
            placeholder="Search this album"
            aria-label="Search this album"
          />
          {search.searchActive && (
            <div className="mono detail-track-search-count">
              {search.matchCount} of {search.totalCount} match
            </div>
          )}
          <div id={ALBUM_SELECTION_HOST_ID} className="track-selectbar-host album-sleeve-select" />
          {!album && <TrackSelectionToolbarPlaceholder hostId={ALBUM_SELECTION_HOST_ID} />}
        </div>
        {children}
      </div>
    </div>
  );
}

/** Play all, and the player's shuffle beside it (Play all honours it). */
function SleevePlay({ tracks, loading }: { tracks: TrackListItem[]; loading: boolean }) {
  // Displayed state: `shuffle` is the controlled device's while casting.
  const { play, shuffle, toggleShuffle } = usePlayer();
  const { commandPending } = useRemotePlayback();
  const canPlay = tracks.some((track) => !track.unavailable);
  return (
    <div className="album-sleeve-play">
      <Button
        variant="primary"
        className="album-sleeve-play-all"
        disabled={!canPlay}
        onClick={() => startListPlayback(play, tracks, shuffle)}
        leadingIcon={<PlayIcon className="size-4" />}
      >
        Play all
      </Button>
      <Button
        className={"album-sleeve-shuffle" + (shuffle ? " active" : "")}
        aria-label="Shuffle"
        aria-pressed={shuffle}
        title={shuffle ? "Shuffle is on" : "Shuffle"}
        disabled={loading || commandPending}
        onClick={toggleShuffle}
      >
        <ShuffleIcon className="size-4" />
      </Button>
    </div>
  );
}

/**
 * The artists under the title. One with a library page links to it; the
 * link keeps the rest of the library's state (tab, search) so its Back
 * returns there.
 */
function AlbumCredits({ credits }: { credits: AlbumCredit[] }) {
  const [params] = useSearchParams();
  const artistLink = (artistId: string) => {
    const next = new URLSearchParams(params);
    for (const key of ["album", "tidalAlbum", "tidalArtist", "artistName"]) next.delete(key);
    next.set("artist", artistId);
    return { pathname: "/library", search: `?${next}` };
  };
  return (
    <div className="album-sleeve-by">
      {credits.map((credit, index) => (
        <Fragment key={credit.name}>
          {index > 0 && ", "}
          {credit.artistId ? (
            <Link className="album-sleeve-artist" to={artistLink(credit.artistId)}>
              {credit.name}
            </Link>
          ) : (
            <span>{credit.name}</span>
          )}
        </Fragment>
      ))}
    </div>
  );
}

/**
 * The sleeve's layout for what it measures: stacked when the view's content
 * is narrower than STACK_BELOW_PX, and otherwise the column's sticky top.
 * The column keeps its place under the view's top padding; one taller than
 * the content area gets a negative top, so it first scrolls until its bottom
 * shows (with the same padding under it), then stays.
 */
export function sleeveLayout({
  contentWidth,
  padTop,
  viewportHeight,
  columnHeight,
}: {
  contentWidth: number;
  padTop: number;
  /** The scrolling content area's height; null when there is none. */
  viewportHeight: number | null;
  columnHeight: number;
}): { stacked: boolean; top: number } {
  const room = viewportHeight === null ? 0 : viewportHeight - columnHeight - 2 * padTop;
  return { stacked: contentWidth < STACK_BELOW_PX, top: padTop + Math.min(0, room) };
}

/**
 * Applies `sleeveLayout` before paint and whenever the view, the column or
 * the content area changes size. Container queries can't do the width part:
 * a query container contains fixed-position descendants, and the list's
 * dialogs are fixed.
 */
function useSleeveLayout(
  viewRef: RefObject<HTMLDivElement>,
  sideRef: RefObject<HTMLElement>,
) {
  useLayoutEffect(() => {
    const view = viewRef.current;
    const side = sideRef.current;
    if (!view || !side) return;
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => update());
    let scroller: HTMLElement | null = null;
    function update() {
      // Looked up on every pass, not once: the page may mount outside its
      // scroller, and an earlier miss mustn't stick.
      if (!scroller?.isConnected) {
        scroller = scrollContainer(view!);
        if (scroller) observer?.observe(scroller);
      }
      const style = getComputedStyle(view!);
      const padTop = parseFloat(style.paddingTop) || 0;
      const { stacked, top } = sleeveLayout({
        contentWidth:
          view!.clientWidth -
          (parseFloat(style.paddingLeft) || 0) -
          (parseFloat(style.paddingRight) || 0),
        padTop,
        viewportHeight: scroller ? scroller.clientHeight : null,
        columnHeight: side!.offsetHeight,
      });
      view!.toggleAttribute("data-stacked", stacked);
      view!.style.setProperty("--sleeve-top", `${top}px`);
    }
    update();
    observer?.observe(view);
    observer?.observe(side);
    return () => observer?.disconnect();
  }, [viewRef, sideRef]);
}

/**
 * The ancestor the page scrolls in. Unlike `findScrollParent`, it doesn't
 * wait for the content to overflow: on a first visit the loading frame
 * doesn't, and the column's offset needs the area's height all the same.
 */
function scrollContainer(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(p).overflowY)) return p;
  }
  return null;
}
