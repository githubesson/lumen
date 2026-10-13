import type { CSSProperties, MouseEventHandler, ReactNode } from "react";
import { Link } from "react-router-dom";
import { ListMusic as QueueListIcon, Play as PlayIcon } from "lucide-react";
import { playlistArtUrl, trackCoverUrl, type Playlist, type TrackListItem } from "../../api";
import { playlistSubtitle } from "@music-library/core/playlist-details";
import type { TopArtistAction } from "@music-library/core/replay/replay";
import CoverArt from "../CoverArt";
import { TopArtistGlyph, TopArtistName } from "../TopArtist";
import Section from "../Section";
import { Button } from "../Button";
import ErrorBanner from "../ErrorBanner";
import { displayText } from "../../lib/format";
import type { BoardCell } from "./boardLayout";

/**
 * The pieces of Home's board: a panel (eyebrow, title, "view all", its own
 * loading and error state) and the compact rows and tiles panels list.
 * Every row is one click from playing or opening: its title is the button
 * or link, stretched over the whole row.
 */

// Row art is 40-48px; the server's next size up covers a 2x screen.
const ROW_ART_SIZE = 128;

/** The grid spans `boardLayout` gave a panel, for the board's CSS. */
export function boardCellStyle(cell: BoardCell): CSSProperties {
  return {
    "--board-span": cell.span,
    "--board-rows": cell.rows,
    "--board-span-md": cell.spanMd,
    "--board-rows-md": cell.rowsMd,
  } as CSSProperties;
}

export function BoardPanel({
  sub,
  title,
  to,
  status,
  alert,
  footer,
  children,
}: {
  sub: string;
  title: string;
  /** The page "view all" opens. */
  to: string;
  status?: ReactNode;
  /** Why a Play started from this panel failed. */
  alert?: string | null;
  footer?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Section
      className="board-panel"
      sub={sub}
      title={title}
      action={
        <Link to={to} className="section-link">
          view all →
        </Link>
      }
    >
      {alert && <ErrorBanner className="board-alert" message={alert} />}
      {status}
      {children}
      {footer && <div className="board-panel-foot">{footer}</div>}
    </Section>
  );
}

/**
 * A panel's load state. While loading, its placeholders show it and this is
 * for screen readers only, so it doesn't push the panel down and back up.
 */
export function PanelStatus({
  title,
  loading,
  error,
  reload,
}: {
  title: string;
  loading: boolean;
  error: string | null;
  reload: () => void;
}) {
  if (!loading && !error) return null;
  return (
    <div role="status" aria-busy={loading} className={loading ? "sr-only" : "board-status"}>
      {loading ? (
        `Loading ${title.toLowerCase()}…`
      ) : (
        <>
          <p>{error}</p>
          <Button size="sm" onClick={reload}>
            Retry {title.toLowerCase()}
          </Button>
        </>
      )}
    </div>
  );
}

/** Rows of a list laid out in two columns once its panel is wide. */
function listStyle(count: number): CSSProperties {
  return { "--board-list-rows": Math.ceil(count / 2) } as CSSProperties;
}

/** A list of track rows; ranked lists number them and show plays. */
export function BoardTrackList({
  tracks,
  ranked,
  meta,
  onPlay,
  onContextMenu,
}: {
  tracks: TrackListItem[];
  ranked?: boolean;
  /** The row's end column (a duration, a play count). */
  meta: (track: TrackListItem) => ReactNode;
  onPlay: (track: TrackListItem) => void;
  onContextMenu: (track: TrackListItem) => MouseEventHandler<HTMLElement>;
}) {
  const List = ranked ? "ol" : "ul";
  return (
    <List className="board-list" style={listStyle(tracks.length)}>
      {tracks.map((track, i) => (
        <li
          key={track.id}
          className="board-row"
          data-ranked={ranked || undefined}
          data-unavailable={track.unavailable || undefined}
          title={track.unavailable ? "No longer on TIDAL" : undefined}
          onContextMenu={onContextMenu(track)}
        >
          {ranked && (
            <span className="board-rank" aria-hidden="true">
              <span>{i + 1}</span>
              <PlayIcon className="board-rank-play size-3.5" />
            </span>
          )}
          <CoverArt
            className="board-art"
            src={trackCoverUrl(track, ROW_ART_SIZE)}
            label={track.album_title || track.title}
          />
          <div className="board-row-text">
            {/* An unavailable track's button is aria-disabled rather than
                disabled: it covers the row, and the browser sends no
                mouse events to a disabled control, so a right-click on
                the row would never open the track's menu. */}
            <button
              type="button"
              className="card-title board-hit"
              aria-disabled={track.unavailable || undefined}
              onClick={() => {
                if (!track.unavailable) onPlay(track);
              }}
            >
              <span className="sr-only">Play</span>{" "}
              {displayText(track.title)}
            </button>
            <div className="card-sub">{displayText(track.artist, "Unknown artist")}</div>
          </div>
          <span className="board-row-end">
            <span className="board-row-meta">{meta(track)}</span>
            {!ranked && (
              <span className="board-play" aria-hidden="true">
                <PlayIcon className="size-3.5" />
              </span>
            )}
          </span>
        </li>
      ))}
    </List>
  );
}

/** Playlists as rows: the row opens the playlist, its button plays it. */
export function BoardPlaylistList({
  playlists,
  onPlay,
}: {
  playlists: Playlist[];
  onPlay: (playlist: Playlist) => void;
}) {
  return (
    <ul className="board-list" style={listStyle(playlists.length)}>
      {playlists.map((playlist) => {
        const art = playlistArtUrl(playlist, ROW_ART_SIZE);
        return (
          <li key={playlist.id} className="board-row">
            {art ? (
              <CoverArt className="board-art" src={art} label={playlist.name} />
            ) : (
              <div className="board-art card-art-icon" aria-hidden="true">
                <QueueListIcon className="size-4" />
              </div>
            )}
            <div className="board-row-text">
              <Link to={`/playlists/${playlist.id}`} className="card-title board-hit">
                {playlist.name}
              </Link>
              <div className="card-sub">{playlistSubtitle(playlist)}</div>
            </div>
            <span className="board-row-end">
              <button
                type="button"
                className="board-play"
                aria-label={`Play ${playlist.name}`}
                onClick={() => onPlay(playlist)}
              >
                <PlayIcon className="size-3.5" />
              </button>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export interface BoardArtistItem {
  id: string;
  name: string;
  /** What the tile says under the name, e.g. "96 plays". */
  detail: string;
  imageUrl: string | null;
  /** Open their page, play them, or neither (see `topArtistAction`). */
  action: TopArtistAction;
}

/**
 * Artists as tiles: each opens the artist's page, or plays the artist when
 * they have none, as on Replay.
 */
export function BoardArtistList<T extends BoardArtistItem>({
  artists,
  onPlay,
}: {
  artists: T[];
  onPlay: (artist: T) => void;
}) {
  return (
    <ul className="board-artists">
      {artists.map((artist) => (
        <li key={artist.id} className="board-artist" data-inert={!artist.action || undefined}>
          {/* The glyph shows over the picture on hover, so the name keeps
              the tile's width. */}
          <CoverArt className="board-avatar" src={artist.imageUrl} label={artist.name} radius={999}>
            <TopArtistGlyph action={artist.action} className="board-play" iconClassName="size-3.5" />
          </CoverArt>
          <div className="board-row-text">
            <TopArtistName
              action={artist.action}
              artistId={artist.id}
              name={displayText(artist.name)}
              onPlay={() => onPlay(artist)}
              className="card-title board-hit"
              plainClassName="card-title"
            />
            <div className="card-sub">{artist.detail}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * Stand-ins for rows still loading: the same 52px rows, so the panel keeps
 * its height when they arrive.
 */
export function BoardRowPlaceholders({ count, ranked }: { count: number; ranked?: boolean }) {
  return (
    <ul className="board-list" style={listStyle(count)} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="board-row board-placeholder" data-ranked={ranked || undefined}>
          {ranked && <span className="board-rank" />}
          <div className="board-art" />
          <SkeletonLines />
          <span className="board-row-end" />
        </li>
      ))}
    </ul>
  );
}

/** Stand-ins for artist tiles still loading. */
export function BoardArtistPlaceholders({ count }: { count: number }) {
  return (
    <ul className="board-artists" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="board-artist board-placeholder">
          <div className="board-avatar" />
          <SkeletonLines />
        </li>
      ))}
    </ul>
  );
}

function SkeletonLines() {
  return (
    <div className="board-row-text">
      <div className="card-title">
        <span className="skeleton-text" style={{ width: "70%" }} />
      </div>
      <div className="card-sub">
        <span className="skeleton-text" style={{ width: "45%" }} />
      </div>
    </div>
  );
}
