import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Disc3 as DiscIcon, Play as PlayIcon, Sparkles as SparklesIcon } from "lucide-react";
import {
  api,
  albumCoverUrl,
  artistImageUrl,
  trackCoverUrl,
  type Playlist,
  type ReplayData,
  type TrackListItem,
} from "../../api";
import CoverArt from "../CoverArt";
import MediaCard, { MediaCardPlaceholders } from "../MediaCard";
import ActivityChart from "../ActivityChart";
import { Button } from "../Button";
import {
  BoardArtistList,
  BoardArtistPlaceholders,
  BoardPanel,
  BoardPlaylistList,
  BoardRowPlaceholders,
  BoardTrackList,
  PanelStatus,
  type BoardArtistItem,
} from "./Board";
import { panelTitle, type HomePanel, type HomePanelId } from "./homeArrangement";
import type { HomeAlbum } from "./homeAlbums";
import { DEFAULT_PERIOD, periodSub } from "./panelKinds";
import { BOARD_ROW_HEIGHT, useBoardFill } from "./useBoardFill";
import type { useTrackContextMenu } from "../../lib/useTrackContextMenu";
import { useAuth } from "../../context/Auth";
import { usePlayerControls } from "../../context/Player";
import type { FavoritesState } from "../../context/Favorites";
import { useApiResource, type ApiResource } from "../../lib/useApiResource";
import { displayText, fmtDurationMs, pluralize } from "../../lib/format";
import { replayAlbumTarget, trackAlbumTarget, type EntityTarget } from "@music-library/core/entity-target";
import { startListPlayback, usePlayFromList } from "@music-library/core/player/play-list";
import { playableTracks, playlistEntryToTrack } from "@music-library/core/track";
import { formatListeningTime, periodKey, type Period } from "@music-library/core/replay/period";
import {
  activitySeries,
  genreShares,
  playsById,
  replayAlbumSubtitle,
  replayCalendar,
  replayQueries,
  topArtistAction,
  topArtistTracks,
} from "@music-library/core/replay/replay";

/**
 * Home's panels, one component per kind. Home loads what they list (one
 * request per source, however many panels draw on it) and hands it over in
 * a `PanelContext`; each panel works out how many items its slot has room
 * for, and the paged ones tell Home how many to ask for.
 */

const EMPTY_TRACKS: TrackListItem[] = [];

// How much each panel usually holds; more is behind its "view all". A panel
// whose slot has room to spare shows as many more as fit (see useBoardFill).
// Cover and artist grids fill a row of their grid, and show at least four.
export const ON_REPEAT_ROWS = 8;
export const LIST_ROWS = 5;
export const PLAYLIST_ROWS = 4;
export const GENRE_ROWS = 5;
export const A_ROW = (columns: number) => Math.max(4, columns);

type BindTrackMenu = ReturnType<typeof useTrackContextMenu>["bind"];
type Play = ReturnType<typeof usePlayerControls>["play"];

/** A source's state as panels read it: unknown and loading until it reports. */
export interface SourceState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export interface PanelContext {
  play: Play;
  bindCtx: BindTrackMenu;
  /** Plays a list fetched on demand, saying in `failure` why one didn't. */
  playFetched: (panel: HomePanelId, label: string, load: (signal: AbortSignal) => Promise<TrackListItem[]>) => void;
  failure: { panel: HomePanelId; message: string } | null;
  /** Show placeholders: nothing to list yet, and no error to show instead. */
  pending: (count: number, loading: boolean, error: string | null) => boolean;
  /** The panel shows its source's load state: the first on the board drawing on it. */
  ownsSource: (id: HomePanelId) => boolean;
  /** How many items a paged panel's room asks for; null when it goes. */
  want: (id: HomePanelId, count: number | null) => void;
  recent: ApiResource<TrackListItem[]>;
  tracks: ApiResource<TrackListItem[]>;
  albums: HomeAlbum[];
  favorites: FavoritesState;
  playlists: ApiResource<Playlist[]>;
  replay: (period: Period | undefined) => SourceState<ReplayData>;
  playlistTracks: (id: string | undefined) => SourceState<TrackListItem[]>;
  /** Jump back in's track, or null while recently played loads. */
  hero: TrackListItem | null;
}

interface PanelProps {
  panel: HomePanel;
  ctx: PanelContext;
}

export function replayLink(period: Period | undefined) {
  return `/replay?period=${periodKey(period ?? DEFAULT_PERIOD)}`;
}

/** The phrase a period's load error ends with. */
function periodPhrase(period: Period): string {
  switch (period.kind) {
    case "last-30":
      return " in the last 30 days";
    case "this-month":
      return " this month";
    case "this-year":
      return " this year";
    case "year":
      return ` in ${period.year}`;
    case "all":
      return "";
  }
}

/** What a period's source says when it can't load. */
export function replayError(period: Period) {
  return `Could not load what you've played${periodPhrase(period)}.`;
}

/** The Replay request a period panel's numbers come from. */
export function replayRequest(period: Period | undefined) {
  return replayQueries(period ?? DEFAULT_PERIOD);
}

const albumHref = (target: EntityTarget) =>
  `/library?view=albums&${target.kind === "tidal" ? "tidalAlbum" : "album"}=${encodeURIComponent(target.id)}`;

/** Tells Home how many items the panel's room asks for, while it's on the board. */
function useWant(ctx: PanelContext, id: HomePanelId, count: number | null) {
  const { want } = ctx;
  useEffect(() => want(id, count), [want, id, count]);
  useEffect(() => () => want(id, null), [want, id]);
}

export function HomePanelView({ panel, ctx }: PanelProps) {
  switch (panel.kind) {
    case "resume":
      return <ResumePanel ctx={ctx} />;
    case "repeat":
      return <RepeatPanel panel={panel} ctx={ctx} />;
    case "artists":
      return <ArtistsPanel panel={panel} ctx={ctx} />;
    case "top-albums":
      return <TopAlbumsPanel panel={panel} ctx={ctx} />;
    case "stats":
      return <StatsPanel panel={panel} ctx={ctx} />;
    case "genres":
      return <GenresPanel panel={panel} ctx={ctx} />;
    case "activity":
      return <ActivityPanel panel={panel} ctx={ctx} />;
    case "recent":
      return <RecentPanel panel={panel} ctx={ctx} />;
    case "favorites":
      return <FavoritesPanel panel={panel} ctx={ctx} />;
    case "added":
      return <AddedPanel panel={panel} ctx={ctx} />;
    case "albums":
      return <AlbumsPanel panel={panel} ctx={ctx} />;
    case "playlists":
      return <PlaylistsPanel panel={panel} ctx={ctx} />;
    case "playlist":
      return <PlaylistPanel panel={panel} ctx={ctx} />;
  }
}

/** The panel's load state, for the panel that shows it. */
function status(ctx: PanelContext, panel: HomePanel, title: string, source: SourceState<unknown>) {
  if (!ctx.ownsSource(panel.id)) return null;
  return <PanelStatus title={title} loading={source.loading} error={source.error} reload={source.reload} />;
}

function RepeatPanel({ panel, ctx }: PanelProps) {
  const fill = useBoardFill(ON_REPEAT_ROWS);
  const source = ctx.replay(panel.period);
  const replay = source.data;
  const top = replay?.top_tracks;
  const empty = replay ? replay.summary.total_plays === 0 : false;
  const onRepeat: TrackListItem[] = (top ?? []).slice(0, fill.count);
  const plays = playsById(top);
  const player = usePlayFromList(ctx.play, onRepeat);
  const title = panelTitle(panel);
  const loading = ctx.pending(empty ? 0 : onRepeat.length, source.loading, source.error);
  return (
    <BoardPanel
      sub={periodSub(panel.period)}
      title={title}
      to={replayLink(panel.period)}
      status={status(ctx, panel, title, source)}
      footer={
        (onRepeat.length > 0 || loading) && (
          <Button
            disabled={onRepeat.length === 0}
            onClick={() => startListPlayback(ctx.play, onRepeat, false)}
            leadingIcon={<PlayIcon className="size-4" />}
          >
            {onRepeat.length > 0 ? `Play all ${onRepeat.length}` : "Play all"}
          </Button>
        )
      }
    >
      <div {...fill.area}>
        {loading ? (
          <BoardRowPlaceholders count={fill.count} ranked />
        ) : (
          <BoardTrackList
            tracks={onRepeat}
            ranked
            meta={(t) => (
              <>
                {(plays.get(t.id) ?? 0).toLocaleString()}
                <span className="sr-only"> plays</span>
              </>
            )}
            onPlay={player.playTrack}
            onContextMenu={(t) => ctx.bindCtx(t, { queue: onRepeat })}
          />
        )}
      </div>
    </BoardPanel>
  );
}

function ArtistsPanel({ panel, ctx }: PanelProps) {
  const fill = useBoardFill(A_ROW);
  const source = ctx.replay(panel.period);
  const replay = source.data;
  const empty = replay ? replay.summary.total_plays === 0 : false;
  const list = replay?.top_artists ?? [];
  // Their tracks among the window's top tracks: the picture, and what plays
  // when they have no page to open (streamed only).
  const byArtist = topArtistTracks(list, replay?.top_tracks ?? []);
  const artists: (BoardArtistItem & { tracks: TrackListItem[] })[] = list.map((artist) => {
    const own = byArtist.get(artist.id) ?? [];
    return {
      id: artist.id,
      name: artist.name,
      detail: pluralize(artist.plays, "play", undefined, { locale: true }),
      imageUrl: artistImageUrl({ name: artist.name }, own, 128),
      action: topArtistAction(artist, own),
      tracks: own,
    };
  });
  const title = panelTitle(panel);
  return (
    <BoardPanel
      sub={periodSub(panel.period)}
      title={title}
      to={replayLink(panel.period)}
      status={status(ctx, panel, title, source)}
      alert={ctx.failure?.panel === panel.id ? ctx.failure.message : null}
    >
      <div {...fill.area}>
        {ctx.pending(empty ? 0 : artists.length, source.loading, source.error) ? (
          <BoardArtistPlaceholders count={fill.count} />
        ) : (
          <BoardArtistList
            artists={empty ? [] : artists.slice(0, fill.count)}
            // Only an artist without a page plays from here: the library has
            // nothing by them, so their top tracks are what there is. Through
            // playFetched all the same, so it supersedes an album or
            // playlist still loading.
            onPlay={(artist) => ctx.playFetched(panel.id, artist.name, () => Promise.resolve(artist.tracks))}
          />
        )}
      </div>
    </BoardPanel>
  );
}

function TopAlbumsPanel({ panel, ctx }: PanelProps) {
  const fill = useBoardFill(A_ROW);
  const source = ctx.replay(panel.period);
  const replay = source.data;
  const albums = replay && replay.summary.total_plays > 0 ? replay.top_albums : [];
  const title = panelTitle(panel);
  return (
    <BoardPanel
      sub={periodSub(panel.period)}
      title={title}
      to={replayLink(panel.period)}
      status={status(ctx, panel, title, source)}
      alert={ctx.failure?.panel === panel.id ? ctx.failure.message : null}
    >
      <div {...fill.area}>
        <div className="board-covers">
          {ctx.pending(albums.length, source.loading, source.error) && <MediaCardPlaceholders count={fill.count} />}
          {albums.slice(0, fill.count).map((album, i) => {
            const target = replayAlbumTarget(album);
            return (
              <MediaCard
                key={album.id}
                to={albumHref(target)}
                coverUrl={albumCoverUrl(album.id, 384)}
                title={displayText(album.title)}
                subtitle={replayAlbumSubtitle(album)}
                rankBadge={<span className="replay-rank">{i + 1}</span>}
                // A streamed album plays from its page.
                onPlay={
                  target.kind === "local"
                    ? () => ctx.playFetched(panel.id, album.title, (signal) => api.listAlbumTracks(target.id, { signal }))
                    : undefined
                }
                playLabel={`Play ${album.title}`}
              />
            );
          })}
        </div>
      </div>
    </BoardPanel>
  );
}

function StatsPanel({ panel, ctx }: PanelProps) {
  const source = ctx.replay(panel.period);
  const summary = source.data?.summary;
  const title = panelTitle(panel);
  const loading = ctx.pending(summary?.total_plays ?? 0, source.loading, source.error);
  const stats: [label: string, value: string][] = summary
    ? [
        ["Plays", summary.total_plays.toLocaleString()],
        ["Listening time", formatListeningTime(summary.total_ms, "verbose")],
        ["Tracks", summary.unique_tracks.toLocaleString()],
        ["Artists", summary.unique_artists.toLocaleString()],
      ]
    : [];
  const headline = summary?.headline_artist;
  return (
    <BoardPanel sub={periodSub(panel.period)} title={title} to={replayLink(panel.period)} status={status(ctx, panel, title, source)}>
      {loading ? (
        <dl className="board-stats" aria-hidden="true">
          {["Plays", "Listening time", "Tracks", "Artists"].map((label) => (
            <div key={label} className="board-stat board-placeholder">
              <dt>{label}</dt>
              <dd>
                <span className="skeleton-text" style={{ width: "4ch" }} />
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        summary &&
        summary.total_plays > 0 && (
          <>
            <dl className="board-stats">
              {stats.map(([label, value]) => (
                <div key={label} className="board-stat">
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            {headline && (
              <p className="board-stats-note">
                Most played: <span>{displayText(headline.name)}</span>
              </p>
            )}
          </>
        )
      )}
    </BoardPanel>
  );
}

function GenresPanel({ panel, ctx }: PanelProps) {
  const fill = useBoardFill(GENRE_ROWS);
  const source = ctx.replay(panel.period);
  const replay = source.data;
  const genres = replay && replay.summary.total_plays > 0 ? genreShares(replay.top_genres) : [];
  const title = panelTitle(panel);
  return (
    <BoardPanel sub={periodSub(panel.period)} title={title} to={replayLink(panel.period)} status={status(ctx, panel, title, source)}>
      <div {...fill.area}>
        {ctx.pending(genres.length, source.loading, source.error) ? (
          <ul className="board-genres" aria-hidden="true">
            {Array.from({ length: fill.count }, (_, i) => (
              <li key={i} className="board-genre board-placeholder">
                <span className="skeleton-text" style={{ width: "60%" }} />
              </li>
            ))}
          </ul>
        ) : (
          <ul className="board-genres">
            {genres.slice(0, fill.count).map((genre) => (
              <li key={genre.genre} className="board-genre">
                <span className="board-genre-name">{displayText(genre.genre)}</span>
                <span className="board-genre-share">
                  {genre.share.toFixed(0)}%<span className="sr-only"> of plays, {pluralize(genre.plays, "play", undefined, { locale: true })}</span>
                </span>
                <span className="board-genre-bar" aria-hidden="true">
                  <span style={{ width: `${genre.share}%` }} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </BoardPanel>
  );
}

function ActivityPanel({ panel, ctx }: PanelProps) {
  const source = ctx.replay(panel.period);
  const replay = source.data;
  const { range } = replayRequest(panel.period);
  const calendar = replay ? replayCalendar(replay, range) : null;
  // As Replay charts it: by day for a month, by month for longer.
  const series = calendar
    ? activitySeries(calendar, range.bucket ?? "month")
    : replay && { bucket: replay.bucket, buckets: replay.activity };
  const title = panelTitle(panel);
  const loading = ctx.pending(replay?.summary.total_plays ?? 0, source.loading, source.error);
  return (
    <BoardPanel sub={periodSub(panel.period)} title={title} to={replayLink(panel.period)} status={status(ctx, panel, title, source)}>
      <div className="board-chart" aria-busy={loading || undefined}>
        {!loading && series && replay && replay.summary.total_plays > 0 && (
          <ActivityChart buckets={series.buckets} bucket={series.bucket} />
        )}
      </div>
    </BoardPanel>
  );
}

/** A panel of track rows, each playing the list from there. */
function TrackRowsPanel({
  panel,
  ctx,
  sub,
  to,
  tracks,
  loading,
  error,
  reload,
  usual = LIST_ROWS,
  paged,
  footer,
}: PanelProps & {
  sub: string;
  to: string;
  tracks: TrackListItem[];
  loading: boolean;
  error: string | null;
  reload: () => void;
  usual?: number;
  /** Home asks for as many as its room wants. */
  paged?: boolean;
  footer?: (shown: TrackListItem[]) => ReactNode;
}) {
  const fill = useBoardFill(usual);
  useWant(ctx, panel.id, paged ? fill.count : null);
  const player = usePlayFromList(ctx.play, tracks);
  const title = panelTitle(panel, ctx.playlists.data);
  const shown = tracks.slice(0, fill.count);
  const placeholders = ctx.pending(tracks.length, loading, error);
  return (
    <BoardPanel
      sub={sub}
      title={title}
      to={to}
      status={ctx.ownsSource(panel.id) && <PanelStatus title={title} loading={loading} error={error} reload={reload} />}
      footer={footer?.(shown)}
    >
      <div {...fill.area}>
        {placeholders ? (
          <BoardRowPlaceholders count={fill.count} />
        ) : (
          <BoardTrackList
            tracks={shown}
            meta={(t) => fmtDurationMs(t.duration_ms)}
            onPlay={player.playTrack}
            onContextMenu={(t) => ctx.bindCtx(t, { queue: tracks })}
          />
        )}
      </div>
    </BoardPanel>
  );
}

function RecentPanel({ panel, ctx }: PanelProps) {
  const { recent } = ctx;
  return (
    <TrackRowsPanel
      panel={panel}
      ctx={ctx}
      sub="Picked up where you left off"
      to="/recent"
      tracks={recent.data ?? EMPTY_TRACKS}
      loading={recent.loading}
      error={recent.error}
      reload={() => void recent.reload()}
      paged
    />
  );
}

function FavoritesPanel({ panel, ctx }: PanelProps) {
  const { favorites } = ctx;
  return (
    <TrackRowsPanel
      panel={panel}
      ctx={ctx}
      sub="Hearts"
      to="/favorites"
      tracks={favorites.tracks}
      loading={favorites.loading}
      error={favorites.error}
      reload={() => void favorites.refresh()}
    />
  );
}

function AddedPanel({ panel, ctx }: PanelProps) {
  const { tracks } = ctx;
  return (
    <TrackRowsPanel
      panel={panel}
      ctx={ctx}
      sub="New in your library"
      to="/library"
      tracks={tracks.data ?? EMPTY_TRACKS}
      loading={tracks.loading}
      error={tracks.error}
      reload={() => void tracks.reload()}
      paged
    />
  );
}

function PlaylistPanel({ panel, ctx }: PanelProps) {
  const source = ctx.playlistTracks(panel.playlist);
  const tracks = source.data ?? EMPTY_TRACKS;
  return (
    <TrackRowsPanel
      panel={panel}
      ctx={ctx}
      sub="Playlist"
      to={`/playlists/${encodeURIComponent(panel.playlist ?? "")}`}
      tracks={tracks}
      loading={source.loading}
      error={source.error}
      reload={source.reload}
      usual={LIST_ROWS}
      footer={() =>
        tracks.length > 0 && (
          <Button onClick={() => startListPlayback(ctx.play, tracks, false)} leadingIcon={<PlayIcon className="size-4" />}>
            {`Play all ${tracks.length}`}
          </Button>
        )
      }
    />
  );
}

function AlbumsPanel({ panel, ctx }: PanelProps) {
  const fill = useBoardFill(A_ROW);
  useWant(ctx, panel.id, fill.count);
  const { tracks, albums } = ctx;
  const title = panelTitle(panel);
  return (
    <BoardPanel
      sub="Your library"
      title={title}
      to="/library?view=albums"
      status={ctx.ownsSource(panel.id) && <PanelStatus title={title} loading={tracks.loading} error={tracks.error} reload={tracks.reload} />}
      alert={ctx.failure?.panel === panel.id ? ctx.failure.message : null}
    >
      <div {...fill.area}>
        <div className="board-covers">
          {ctx.pending(albums.length, tracks.loading, tracks.error) && <MediaCardPlaceholders count={fill.count} />}
          {albums.slice(0, fill.count).map((a) => (
            <MediaCard
              key={a.id}
              to={`/library?view=albums&album=${encodeURIComponent(a.id)}&by=${encodeURIComponent(a.artist)}`}
              coverUrl={albumCoverUrl(a.id, 384)}
              title={displayText(a.title)}
              subtitle={displayText(a.artist)}
              onPlay={() => ctx.playFetched(panel.id, a.title, (signal) => api.listAlbumTracks(a.id, { signal }))}
              playLabel={`Play ${a.title}`}
            />
          ))}
        </div>
      </div>
    </BoardPanel>
  );
}

function PlaylistsPanel({ panel, ctx }: PanelProps) {
  const fill = useBoardFill(PLAYLIST_ROWS);
  const { playlists: resource } = ctx;
  const playlists = resource.data ?? [];
  const title = panelTitle(panel);
  return (
    <BoardPanel
      sub="Curated"
      title={title}
      to="/playlists"
      status={<PanelStatus title={title} loading={resource.loading} error={resource.error} reload={resource.reload} />}
      alert={ctx.failure?.panel === panel.id ? ctx.failure.message : null}
    >
      <div {...fill.area}>
        {ctx.pending(playlists.length, resource.loading, resource.error) ? (
          <BoardRowPlaceholders count={fill.count} />
        ) : (
          <BoardPlaylistList
            playlists={playlists.slice(0, fill.count)}
            onPlay={(p) =>
              ctx.playFetched(panel.id, p.name, async (signal) =>
                (await api.listPlaylistTracks(p.id, { signal })).tracks.map(playlistEntryToTrack),
              )
            }
          />
        )}
      </div>
    </BoardPanel>
  );
}

/**
 * Jump back in: the album of the last track you played (or, before you've
 * played anything, a library track), a placeholder of the same shape while
 * that loads, or a welcome for an empty library.
 */
function ResumePanel({ ctx }: { ctx: PanelContext }) {
  const { me } = useAuth();
  const recent = ctx.recent.data ?? EMPTY_TRACKS;
  const tracks = ctx.tracks.data ?? EMPTY_TRACKS;
  const hero = ctx.hero;
  if (hero) {
    return (
      <HeroAlbum
        key={hero.id}
        track={hero}
        fromRecent={recent.length > 0}
        fallbackQueue={recent.length ? recent : tracks}
        bindCtx={ctx.bindCtx}
      />
    );
  }
  if (ctx.recent.loading || ctx.tracks.loading) {
    return (
      <div className="hero board-resume" aria-busy="true">
        <div className="board-resume-head">
          <div className="hero-art" aria-hidden="true" />
          <div className="hero-body">
            <div className="hero-eyebrow">Jump back in</div>
            <h1 className="hero-title">
              <span className="skeleton-text" style={{ width: "12ch" }} />
            </h1>
            {/* Same rows as the loaded hero, so its text doesn't jump. */}
            <div className="hero-meta">
              <span role="status">Loading your music…</span>
            </div>
            <div className="hero-actions">
              <Button variant="primary" disabled leadingIcon={<PlayIcon className="size-4" />}>
                Play
              </Button>
              <Button disabled leadingIcon={<DiscIcon className="size-4" />}>
                Open album
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }
  if (ctx.recent.error || ctx.tracks.error) {
    return (
      <div className="hero board-resume">
        <div className="hero-body">
          <h1 className="hero-title">Your library</h1>
          <p>Some music could not be loaded. Retry the sections below.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="hero board-resume">
      <div className="hero-body">
        <div className="hero-eyebrow">Welcome, {me?.username}</div>
        <h1 className="hero-title">Your library is quiet</h1>
        <div className="hero-meta">
          <span>Nothing ingested yet</span>
        </div>
        <div className="hero-actions">
          <Link to="/library" className="btn btn-primary">
            <SparklesIcon className="size-4" />
            Explore
          </Link>
        </div>
      </div>
    </div>
  );
}

/**
 * The hero: the album of the last track you played (or, before you've played
 * anything, a library track), with Play picking up from that track. When its
 * slot has room under the cover, the album's tracks fill it.
 */
function HeroAlbum({
  track,
  fromRecent,
  fallbackQueue,
  bindCtx,
}: {
  track: TrackListItem;
  fromRecent: boolean;
  /** Queue for a track with no local album to play through. */
  fallbackQueue: TrackListItem[];
  bindCtx: BindTrackMenu;
}) {
  const { play } = usePlayerControls();
  // None in its usual slot, where the hero is as tall as its row.
  const fill = useBoardFill(0, BOARD_ROW_HEIGHT);
  const target = trackAlbumTarget(track);
  // Only a library album has a page to describe it and tracks to play through
  // here; a TIDAL track links to its release.
  const albumID = target?.kind === "local" ? target.id : undefined;
  const album = useApiResource(
    (signal) => (albumID ? api.getAlbum(albumID, { signal }) : Promise.resolve(null)),
    "Could not load the album.",
    { cacheKey: albumID ? `home:hero-album:${albumID}` : undefined },
  );
  const [starting, setStarting] = useState(false);
  const albumHrefValue = target ? albumHref(target) : null;
  const showTracks = !!albumID && fill.count > 0;
  const year = album.data?.release_year;
  const trackCount = album.data?.track_count;

  // The album's tracks are fetched on Play. Leaving Home (or a new hero
  // replacing this one) aborts the fetch, so a late reply never starts
  // playback somewhere the user has moved on from.
  const playRequest = useRef<AbortController | null>(null);
  useEffect(() => () => playRequest.current?.abort(), []);

  // Plays the album in order from the featured track (from its first playable
  // track when the listing doesn't have that one), falling back to the list
  // the track came from if the album can't be loaded or has nothing to play.
  const onPlay = async () => {
    if (!albumID) {
      play(track, fallbackQueue);
      return;
    }
    playRequest.current?.abort();
    const request = new AbortController();
    playRequest.current = request;
    setStarting(true);
    try {
      const albumTracks = await api.listAlbumTracks(albumID, { signal: request.signal });
      if (request.signal.aborted) return;
      // Rows dropped from TIDAL with no library copy can't be streamed.
      const queue = playableTracks(albumTracks);
      const start = queue.find((t) => t.id === track.id) ?? queue[0];
      if (start) play(start, queue);
      else play(track, fallbackQueue);
    } catch {
      if (!request.signal.aborted) play(track, fallbackQueue);
    } finally {
      if (!request.signal.aborted) setStarting(false);
    }
  };

  return (
    <div className="hero board-resume">
      <div className="board-resume-head">
        <CoverArt className="hero-art" src={trackCoverUrl(track)} label={track.album_title ?? track.title} />
        <div className="hero-body">
          <div className="hero-eyebrow">{fromRecent ? "Jump back in" : "From your library"}</div>
          <h1 className="hero-title">{displayText(track.album_title ?? track.title)}</h1>
          <div className="hero-meta">
            <span>{displayText(track.artist, "Unknown artist")}</span>
            {year ? (
              <>
                <span className="dot" aria-hidden="true" />
                <span>{year}</span>
              </>
            ) : null}
            {trackCount ? (
              <>
                <span className="dot" aria-hidden="true" />
                <span>{pluralize(trackCount, "track")}</span>
              </>
            ) : null}
          </div>
          <div className="hero-actions">
            <Button variant="primary" onClick={() => void onPlay()} disabled={starting} leadingIcon={<PlayIcon className="size-4" />}>
              Play
            </Button>
            {albumHrefValue && (
              <Link to={albumHrefValue} className="btn">
                <DiscIcon className="size-4" />
                Open album
              </Link>
            )}
          </div>
        </div>
      </div>
      <div {...fill.area} data-tracks={showTracks || undefined}>
        {showTracks ? (
          <HeroTracks albumID={albumID} track={track} rows={fill.count} trackCount={trackCount} bindCtx={bindCtx} />
        ) : (
          // Empty, but spaced like the list, so the room measures the same
          // with or without it.
          <div className="board-list" />
        )}
      </div>
    </div>
  );
}

/**
 * The album's tracks under Jump back in, as many as there's room for: from
 * the one you were on, or fewer before it near the album's end. A row plays
 * the album from there. Loaded only once there's room. Numbered by place on
 * the album, since track numbers start over on each disc.
 */
function HeroTracks({
  albumID,
  track,
  rows,
  trackCount,
  bindCtx,
}: {
  albumID: string;
  track: TrackListItem;
  rows: number;
  /** The album's length, when known, for the placeholders. */
  trackCount: number | undefined;
  bindCtx: BindTrackMenu;
}) {
  const { play } = usePlayerControls();
  const album = useApiResource(
    (signal) => api.listAlbumTracks(albumID, { signal }),
    "Could not load the album's tracks.",
    { cacheKey: `home:hero-tracks:${albumID}` },
  );
  const tracks = album.data ?? EMPTY_TRACKS;
  const queue = useMemo(() => playableTracks(tracks), [tracks]);
  if (tracks.length === 0) {
    if (album.loading) return <BoardRowPlaceholders count={Math.min(rows, trackCount ?? rows)} ranked bare />;
    // The empty list keeps the area measuring as it would with rows.
    return (
      <>
        <div className="board-list" />
        {album.error && (
          <div role="status" className="board-resume-status">
            <span title={album.error}>{album.error}</span>
            <Button size="sm" onClick={() => void album.reload()} aria-label="Retry the album's tracks">
              Retry
            </Button>
          </div>
        )}
      </>
    );
  }
  const at = Math.max(0, tracks.findIndex((t) => t.id === track.id));
  const start = Math.max(0, Math.min(at, tracks.length - rows));
  return (
    <BoardTrackList
      tracks={tracks.slice(start, start + rows)}
      ranked
      bare
      rank={(_t, i) => start + i + 1}
      current={track.id}
      meta={(t) => fmtDurationMs(t.duration_ms)}
      onPlay={(t) => play(t, queue)}
      onContextMenu={(t) => bindCtx(t, { queue })}
    />
  );
}
