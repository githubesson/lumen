import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Disc3 as DiscIcon,
  LayoutDashboard as CustomizeIcon,
  Play as PlayIcon,
  Sparkles as SparklesIcon,
} from "lucide-react";
import {
  api,
  albumCoverUrl,
  artistImageUrl,
  errorMessage,
  trackCoverUrl,
  type Playlist,
  type ReplayData,
  type TrackListItem,
} from "../api";
import CoverArt from "../components/CoverArt";
import MediaCard, { MediaCardPlaceholders } from "../components/MediaCard";
import { Button } from "../components/Button";
import {
  BoardArtistList,
  BoardArtistPlaceholders,
  BoardPanel,
  BoardPlaylistList,
  BoardRowPlaceholders,
  BoardTrackList,
  PanelStatus,
  type BoardArtistItem,
} from "../components/home/Board";
import { BoardSlot, useBoardEditor } from "../components/home/BoardEditing";
import { boardLayout, type BoardPanelId } from "../components/home/boardLayout";
import {
  CUSTOMIZE_PARAM,
  HOME_PANELS,
  arrangementTweak,
  panelIn,
  readArrangement,
  type HomePanelId,
} from "../components/home/homeArrangement";
import { homeAlbums } from "../components/home/homeAlbums";
import { BOARD_ROW_HEIGHT, useBoardFill } from "../components/home/useBoardFill";
import { useTrackContextMenu } from "../lib/useTrackContextMenu";
import { useAuth } from "../context/Auth";
import { useTheme } from "../context/Theme";
import { usePlayerControls } from "../context/Player";
import { useFavorites } from "../context/Favorites";
import { usePlaylists } from "../context/Playlists";
import { useApiResource } from "../lib/useApiResource";
import { displayText, fmtDurationMs, pluralize } from "../lib/format";
import { trackAlbumTarget } from "@music-library/core/entity-target";
import { startListPlayback, usePlayFromList } from "@music-library/core/player/play-list";
import { playableTracks, playlistEntryToTrack } from "@music-library/core/track";
import { periodKey, type Period } from "@music-library/core/replay/period";
import {
  playsById,
  replayQueries,
  topArtistAction,
  topArtistTracks,
} from "@music-library/core/replay/replay";

const EMPTY_TRACKS: TrackListItem[] = [];
const EMPTY_PLAYLISTS: Playlist[] = [];
const ALL_PANELS: BoardPanelId[] = ["repeat", "recent", "favorites", "albums", "playlists", "artists"];

const LAST_30_DAYS: Period = { kind: "last-30" };
const REPLAY_LINK = `/replay?period=${periodKey(LAST_30_DAYS)}`;

// How much each panel usually holds; more is behind its "view all". A panel
// whose slot has room to spare shows as many more as fit (see useBoardFill).
// Albums and Top artists fill a row of their grid, and show at least four.
const ON_REPEAT_ROWS = 8;
const LIST_ROWS = 5;
const PLAYLIST_ROWS = 4;
const A_ROW = (columns: number) => Math.max(4, columns);

// Recently played is asked for in steps of this many, enough to fill its
// panel.
const RECENT_STEP = 20;
// The newest tracks, per six album covers: usually enough to find them.
const TRACKS_PER_SIX_ALBUMS = 80;
// The most tracks the server sends in one page.
const MAX_TRACKS = 500;

type BindTrackMenu = ReturnType<typeof useTrackContextMenu>["bind"];

export default function Home() {
  const { play } = usePlayerControls();
  const repeatFill = useBoardFill(ON_REPEAT_ROWS);
  const recentFill = useBoardFill(LIST_ROWS);
  const favoritesFill = useBoardFill(LIST_ROWS);
  const albumsFill = useBoardFill(A_ROW);
  const playlistsFill = useBoardFill(PLAYLIST_ROWS);
  const artistsFill = useBoardFill(A_ROW);

  const recentLimit = Math.ceil(recentFill.count / RECENT_STEP) * RECENT_STEP;
  const recentResource = useApiResource(
    (signal) => api.listRecent(recentLimit, { signal }), "Could not load recently played tracks.",
    { cacheKey: "home:recent" },
  );
  useReloadWhenLarger(recentResource.reload, recentLimit);
  // The newest tracks, for the hero before anything is played and for
  // Albums.
  const trackLimit = Math.min(MAX_TRACKS, TRACKS_PER_SIX_ALBUMS * Math.ceil(Math.max(albumsFill.count, 6) / 6));
  const tracksResource = useApiResource(
    (signal) => api.listTracks({ limit: trackLimit, signal }), "Could not load your library.",
    { cacheKey: "home:tracks" },
  );
  useReloadWhenLarger(tracksResource.reload, trackLimit);
  // The Replay screen's "Last 30 days": the same request under the same
  // key, so either page warms the other.
  const replayResource = useApiResource<ReplayData>(
    (signal) => api.getReplay(replayQueries(LAST_30_DAYS).daily.params, { signal }),
    "Could not load what you've had on repeat.",
    { cacheKey: replayQueries(LAST_30_DAYS).daily.cacheKey },
  );
  const favorites = useFavorites();
  const playlistResource = usePlaylists();
  const { bind: bindCtx, menu: ctxMenu } = useTrackContextMenu();
  const { playFetched, failure } = useFetchAndPlay();

  const recent = recentResource.data ?? EMPTY_TRACKS;
  const tracks = tracksResource.data ?? EMPTY_TRACKS;
  const favs = favorites.tracks;
  const playlists = playlistResource.data ?? EMPTY_PLAYLISTS;
  const replay = replayResource.data;
  const topTracks = replay?.top_tracks;
  const onRepeat = useMemo<TrackListItem[]>(
    () => (topTracks ?? []).slice(0, repeatFill.count),
    [topTracks, repeatFill.count],
  );
  const plays = useMemo(() => playsById(topTracks), [topTracks]);
  const topArtists = useMemo<(BoardArtistItem & { tracks: TrackListItem[] })[]>(() => {
    const artists = replay?.top_artists ?? [];
    // Their tracks among the window's top tracks: the picture, and what
    // plays when they have no page to open (streamed only).
    const byArtist = topArtistTracks(artists, topTracks ?? []);
    return artists.map((artist) => {
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
  }, [replay?.top_artists, topTracks]);
  const albums = useMemo(() => homeAlbums(tracks), [tracks]);

  const recentPlayer = usePlayFromList(play, recent);
  const favoritesPlayer = usePlayFromList(play, favs);
  const repeatPlayer = usePlayFromList(play, onRepeat);

  // Wait for recently played before picking the hero, so a library track
  // doesn't take the slot and then get swapped out when it lands.
  const recentSettled = recentResource.data !== null || !recentResource.loading;
  const hero = recentSettled ? recent[0] ?? tracks[0] ?? null : null;

  // Until every list has settled once (arrived or failed), the board keeps
  // its full shape, with placeholders where a list hasn't come in or came in
  // empty. Then it swaps to the panels that have something, in one change
  // rather than one per list. Latched, so a later retry or refresh doesn't
  // bring the placeholder board back.
  const allSettled =
    (replay !== null || !replayResource.loading) &&
    (recentResource.data !== null || !recentResource.loading) &&
    (favorites.loaded || !favorites.loading) &&
    (tracksResource.data !== null || !tracksResource.loading) &&
    (playlistResource.data !== null || !playlistResource.loading);
  const [settled, setSettled] = useState(allSettled);
  if (allSettled && !settled) setSettled(true);
  /** Show placeholders: nothing to list yet, and no error to show instead. */
  const pending = (count: number, loading: boolean, error: string | null) =>
    count === 0 && !error && (!settled || loading);

  // Once settled, a panel shows while it has something, or to offer a retry.
  // One whose list is unknown and loading again (a retry) stays as it was
  // until real data arrives: the panel whose Retry was pressed keeps its
  // place, with placeholders, and one already gone (Top artists, when On
  // repeat failed) doesn't come back as placeholders only to vanish again
  // if the retry fails. A list known to be empty stays hidden while it
  // revalidates, so revisits don't flash it and reflow the board.
  const replayEmpty = replay ? replay.summary.total_plays === 0 : false;
  const [shown, setShown] = useState<readonly BoardPanelId[]>(ALL_PANELS);
  const present = useMemo(() => {
    if (!settled) return ALL_PANELS;
    const out: BoardPanelId[] = [];
    const show = (id: BoardPanelId, count: number, known: boolean, loading: boolean, error: string | null) => {
      if (count > 0 || error || (!known && loading && shown.includes(id))) out.push(id);
    };
    show("repeat", replayEmpty ? 0 : onRepeat.length, replay !== null, replayResource.loading, replayResource.error);
    show("recent", recent.length, recentResource.data !== null, recentResource.loading, recentResource.error);
    show("favorites", favs.length, favorites.loaded, favorites.loading, favorites.error);
    show("albums", albums.length, tracksResource.data !== null, tracksResource.loading, tracksResource.error);
    show("playlists", playlists.length, playlistResource.data !== null, playlistResource.loading, playlistResource.error);
    // Its error shows once, in On repeat.
    show("artists", replayEmpty ? 0 : topArtists.length, replay !== null, replayResource.loading, null);
    return out;
  }, [
    settled, shown,
    replay, replayEmpty, onRepeat.length, replayResource.loading, replayResource.error,
    recent.length, recentResource.data, recentResource.loading, recentResource.error,
    favs.length, favorites.loaded, favorites.loading, favorites.error,
    albums.length, tracksResource.data, tracksResource.loading, tracksResource.error,
    playlists.length, playlistResource.data, playlistResource.loading, playlistResource.error,
    topArtists.length,
  ]);
  if (present.length !== shown.length || present.some((id, i) => id !== shown[i])) setShown(present);

  // The board's slots keep their shapes; the arrangement says which panel
  // fills each, and which are hidden. While customizing, every panel that
  // isn't hidden is on the board, empty or not, so it can be moved.
  const { homeBoard, setHomeBoard, tweaksLoaded } = useTheme();
  const arrangement = useMemo(() => readArrangement(homeBoard), [homeBoard]);
  const [params, setParams] = useSearchParams();
  const editing = params.has(CUSTOMIZE_PARAM);
  const setEditing = (on: boolean) =>
    setParams(
      (p) => {
        if (on) p.set(CUSTOMIZE_PARAM, "");
        else p.delete(CUSTOMIZE_PARAM);
        return p;
      },
      { replace: true },
    );
  const hasContent = (id: HomePanelId) => id === "resume" || present.includes(id);
  const onBoard = (id: HomePanelId) => !arrangement.hidden.has(id) && (editing || hasContent(id));
  const layout = boardLayout(HOME_PANELS.filter((slot) => onBoard(panelIn(arrangement, slot))));
  const editor = useBoardEditor({
    editing,
    arrangement,
    onChange: (next) => setHomeBoard(arrangementTweak(next)),
    onDone: () => setEditing(false),
  });

  const panel = (id: HomePanelId) => {
    switch (id) {
      case "resume":
        return (
          <ResumePanel
            hero={hero}
            bindCtx={bindCtx}
            fromRecent={recent.length > 0}
            fallbackQueue={recent.length ? recent : tracks}
            loading={recentResource.loading || tracksResource.loading}
            error={!!(recentResource.error || tracksResource.error)}
          />
        );
      case "repeat": {
        const loading = pending(replayEmpty ? 0 : onRepeat.length, replayResource.loading, replayResource.error);
        return (
          <BoardPanel
            sub="Last 30 days"
            title="On repeat"
            to={REPLAY_LINK}
            status={<PanelStatus title="On repeat" loading={replayResource.loading} error={replayResource.error} reload={replayResource.reload} />}
            footer={
              (onRepeat.length > 0 || loading) && (
                <Button
                  disabled={onRepeat.length === 0}
                  onClick={() => startListPlayback(play, onRepeat, false)}
                  leadingIcon={<PlayIcon className="size-4" />}
                >
                  {onRepeat.length > 0 ? `Play all ${onRepeat.length}` : "Play all"}
                </Button>
              )
            }
          >
            <div {...repeatFill.area}>
              {loading ? (
                <BoardRowPlaceholders count={repeatFill.count} ranked />
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
                  onPlay={repeatPlayer.playTrack}
                  onContextMenu={(t) => bindCtx(t, { queue: onRepeat })}
                />
              )}
            </div>
          </BoardPanel>
        );
      }
      case "recent":
        return (
          <BoardPanel
            sub="Picked up where you left off"
            title="Recently played"
            to="/recent"
            status={<PanelStatus title="Recently played" loading={recentResource.loading} error={recentResource.error} reload={recentResource.reload} />}
          >
            <div {...recentFill.area}>
              {pending(recent.length, recentResource.loading, recentResource.error) ? (
                <BoardRowPlaceholders count={recentFill.count} />
              ) : (
                <BoardTrackList
                  tracks={recent.slice(0, recentFill.count)}
                  meta={(t) => fmtDurationMs(t.duration_ms)}
                  onPlay={recentPlayer.playTrack}
                  onContextMenu={(t) => bindCtx(t, { queue: recent })}
                />
              )}
            </div>
          </BoardPanel>
        );
      case "favorites":
        return (
          <BoardPanel
            sub="Hearts"
            title="Your favorites"
            to="/favorites"
            status={<PanelStatus title="Your favorites" loading={favorites.loading} error={favorites.error} reload={() => void favorites.refresh()} />}
          >
            <div {...favoritesFill.area}>
              {pending(favs.length, favorites.loading, favorites.error) ? (
                <BoardRowPlaceholders count={favoritesFill.count} />
              ) : (
                <BoardTrackList
                  tracks={favs.slice(0, favoritesFill.count)}
                  meta={(t) => fmtDurationMs(t.duration_ms)}
                  onPlay={favoritesPlayer.playTrack}
                  onContextMenu={(t) => bindCtx(t, { queue: favs })}
                />
              )}
            </div>
          </BoardPanel>
        );
      case "albums":
        return (
          <BoardPanel
            sub="Your library"
            title="Albums"
            to="/library?view=albums"
            status={<PanelStatus title="Albums" loading={tracksResource.loading} error={tracksResource.error} reload={tracksResource.reload} />}
            alert={failure?.panel === "albums" ? failure.message : null}
          >
            <div {...albumsFill.area}>
              <div className="board-covers">
                {pending(albums.length, tracksResource.loading, tracksResource.error) && (
                  <MediaCardPlaceholders count={albumsFill.count} />
                )}
                {albums.slice(0, albumsFill.count).map((a) => (
                  <MediaCard
                    key={a.id}
                    to={`/library?view=albums&album=${encodeURIComponent(a.id)}&by=${encodeURIComponent(a.artist)}`}
                    coverUrl={albumCoverUrl(a.id, 384)}
                    title={displayText(a.title)}
                    subtitle={displayText(a.artist)}
                    onPlay={() => playFetched("albums", a.title, (signal) => api.listAlbumTracks(a.id, { signal }))}
                    playLabel={`Play ${a.title}`}
                  />
                ))}
              </div>
            </div>
          </BoardPanel>
        );
      case "playlists":
        return (
          <BoardPanel
            sub="Curated"
            title="Playlists"
            to="/playlists"
            status={<PanelStatus title="Playlists" loading={playlistResource.loading} error={playlistResource.error} reload={playlistResource.reload} />}
            alert={failure?.panel === "playlists" ? failure.message : null}
          >
            <div {...playlistsFill.area}>
              {pending(playlists.length, playlistResource.loading, playlistResource.error) ? (
                <BoardRowPlaceholders count={playlistsFill.count} />
              ) : (
                <BoardPlaylistList
                  playlists={playlists.slice(0, playlistsFill.count)}
                  onPlay={(p) =>
                    playFetched("playlists", p.name, async (signal) =>
                      (await api.listPlaylistTracks(p.id, { signal })).tracks.map(playlistEntryToTrack),
                    )
                  }
                />
              )}
            </div>
          </BoardPanel>
        );
      case "artists":
        return (
          <BoardPanel
            sub="Last 30 days"
            title="Top artists"
            to={REPLAY_LINK}
            alert={failure?.panel === "artists" ? failure.message : null}
          >
            <div {...artistsFill.area}>
              {pending(replayEmpty ? 0 : topArtists.length, replayResource.loading, replayResource.error) ? (
                <BoardArtistPlaceholders count={artistsFill.count} />
              ) : (
                <BoardArtistList
                  artists={topArtists.slice(0, artistsFill.count)}
                  // Only an artist without a page plays from here: the
                  // library has nothing by them, so their top tracks are
                  // what there is. Through playFetched all the same, so it
                  // supersedes an album or playlist still loading.
                  onPlay={(artist) => playFetched("artists", artist.name, () => Promise.resolve(artist.tracks))}
                />
              )}
            </div>
          </BoardPanel>
        );
    }
  };

  // The desktop app reads the arrangement from its config file; until then
  // the board would take the default shape and then jump.
  if (!tweaksLoaded) return <div className="view board-view" />;

  return (
    <div className="view board-view">
      {ctxMenu}
      {editing && editor.bar}
      {layout.length > 0 ? (
        <div className="board">
          {layout.map((cell, i) => {
            const id = panelIn(arrangement, cell.id);
            const next = layout[i + 1] ?? layout[i - 1];
            return (
              <BoardSlot
                key={id}
                cell={cell}
                panel={id}
                editing={editing ? editor.slot(id, next && panelIn(arrangement, next.id), !hasContent(id) && settled) : null}
              >
                {panel(id)}
              </BoardSlot>
            );
          })}
        </div>
      ) : (
        !editing && (
          <div className="board-empty">
            <p>Every panel on Home is hidden.</p>
            <Button onClick={() => setEditing(true)} leadingIcon={<CustomizeIcon className="size-4" />}>
              Customize Home
            </Button>
          </div>
        )
      )}
    </div>
  );
}

/**
 * Asks again once `size` (which the fetcher reads) grows past what the last
 * request asked for: a panel moved somewhere roomier gets the rows to fill
 * it. A smaller size waits for the next load.
 */
function useReloadWhenLarger(reload: () => Promise<void>, size: number) {
  const asked = useRef(size);
  useEffect(() => {
    if (size <= asked.current) return;
    asked.current = size;
    void reload();
  }, [reload, size]);
}

/**
 * Plays a list fetched on demand (an album's, a playlist's) or already at
 * hand (an artist's top tracks). When it can't play, `failure` says why, for
 * the panel the Play came from to show. Starting another one, or leaving
 * Home, aborts the fetch, so a late reply never starts playback somewhere
 * the user has moved on from.
 */
function useFetchAndPlay() {
  const { play } = usePlayerControls();
  const request = useRef<AbortController | null>(null);
  const [failure, setFailure] = useState<{ panel: BoardPanelId; message: string } | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const playFetched = useCallback(
    async (
      panel: BoardPanelId,
      label: string,
      load: (signal: AbortSignal) => Promise<TrackListItem[]>,
    ) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setFailure(null);
      let loaded: TrackListItem[] = [];
      let error: unknown = null;
      try {
        loaded = await load(controller.signal);
      } catch (err) {
        error = err;
      }
      if (controller.signal.aborted) return;
      if (playableTracks(loaded).length > 0) {
        startListPlayback(play, loaded, false);
        return;
      }
      setFailure({
        panel,
        message: error
          ? errorMessage(error, `Could not play ${displayText(label)}. Check your connection and try again.`)
          : `${displayText(label)} has nothing that can be played.`,
      });
    },
    [play],
  );
  return { playFetched, failure };
}

/**
 * Jump back in: the album of the last track you played (or, before you've
 * played anything, a library track), a placeholder of the same shape while
 * that loads, or a welcome for an empty library.
 */
function ResumePanel({
  hero,
  bindCtx,
  fromRecent,
  fallbackQueue,
  loading,
  error,
}: {
  hero: TrackListItem | null;
  bindCtx: BindTrackMenu;
  fromRecent: boolean;
  fallbackQueue: TrackListItem[];
  loading: boolean;
  error: boolean;
}) {
  const { me } = useAuth();
  if (hero) {
    return <HeroAlbum key={hero.id} track={hero} fromRecent={fromRecent} fallbackQueue={fallbackQueue} bindCtx={bindCtx} />;
  }
  if (loading) {
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
  if (error) {
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
  const albumHref = target
    ? `/library?view=albums&${target.kind === "tidal" ? "tidalAlbum" : "album"}=${encodeURIComponent(target.id)}`
    : null;
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
        <CoverArt
          className="hero-art"
          src={trackCoverUrl(track)}
          label={track.album_title ?? track.title}
        />
        <div className="hero-body">
          <div className="hero-eyebrow">
            {fromRecent ? "Jump back in" : "From your library"}
          </div>
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
            <Button
              variant="primary"
              onClick={() => void onPlay()}
              disabled={starting}
              leadingIcon={<PlayIcon className="size-4" />}
            >
              Play
            </Button>
            {albumHref && (
              <Link to={albumHref} className="btn">
                <DiscIcon className="size-4" />
                Open album
              </Link>
            )}
          </div>
        </div>
      </div>
      <div {...fill.area}>
        {albumID && fill.count > 0 ? (
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
 * the album from there. Loaded only once there's room.
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
    return album.loading ? (
      <BoardRowPlaceholders count={Math.min(rows, trackCount ?? rows)} ranked bare />
    ) : (
      <div className="board-list" />
    );
  }
  const at = Math.max(0, tracks.findIndex((t) => t.id === track.id));
  const start = Math.max(0, Math.min(at, tracks.length - rows));
  return (
    <BoardTrackList
      tracks={tracks.slice(start, start + rows)}
      ranked
      bare
      rank={(t, i) => t.track_no || start + i + 1}
      current={track.id}
      meta={(t) => fmtDurationMs(t.duration_ms)}
      onPlay={(t) => play(t, queue)}
      onContextMenu={(t) => bindCtx(t, { queue })}
    />
  );
}
