import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import {
  Disc3 as DiscIcon,
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
  boardCellStyle,
  type BoardArtistItem,
} from "../components/home/Board";
import { boardLayout, type BoardCell, type BoardPanelId } from "../components/home/boardLayout";
import { homeAlbums } from "../components/home/homeAlbums";
import { useTrackContextMenu } from "../lib/useTrackContextMenu";
import { useAuth } from "../context/Auth";
import { usePlayerControls } from "../context/Player";
import { useFavorites } from "../context/Favorites";
import { usePlaylists } from "../context/Playlists";
import { useApiResource } from "../lib/useApiResource";
import { displayText, fmtDurationMs, pluralize } from "../lib/format";
import { trackAlbumTarget } from "@music-library/core/entity-target";
import { startListPlayback, usePlayFromList } from "@music-library/core/player/play-list";
import { playableTracks, playlistEntryToTrack } from "@music-library/core/track";
import { periodKey, type Period } from "@music-library/core/replay/period";
import { playsById, replayRequest, tracksByArtist } from "@music-library/core/replay/replay";

const EMPTY_TRACKS: TrackListItem[] = [];
const EMPTY_PLAYLISTS: Playlist[] = [];
const ALL_PANELS: BoardPanelId[] = ["repeat", "recent", "favorites", "albums", "playlists", "artists"];

const LAST_30_DAYS: Period = { kind: "last-30" };
const REPLAY_LINK = `/replay?period=${periodKey(LAST_30_DAYS)}`;

// How much each panel holds; more is behind its "view all". Albums and Top
// artists render up to six and their CSS shows as many as fit one row.
const ON_REPEAT_ROWS = 8;
const LIST_ROWS = 5;
const PLAYLIST_ROWS = 4;
const ALBUM_COVERS = 6;
const TOP_ARTISTS = 6;

export default function Home() {
  const { play } = usePlayerControls();
  const recentResource = useApiResource(
    (signal) => api.listRecent(20, { signal }), "Could not load recently played tracks.",
    { cacheKey: "recent:20" },
  );
  // The newest tracks, for the hero before anything is played and for
  // Albums. Enough of them to usually find six albums.
  const tracksResource = useApiResource(
    (signal) => api.listTracks({ limit: 80, signal }), "Could not load your library.",
    { cacheKey: "home:tracks:80" },
  );
  // The Replay screen's "Last 30 days" entry, so either page warms the other.
  const replayResource = useApiResource<ReplayData>(
    (signal) => api.getReplay(replayRequest(LAST_30_DAYS).range, { signal }),
    "Could not load what you've had on repeat.",
    { cacheKey: `replay:${replayRequest(LAST_30_DAYS).cacheKey}` },
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
  const onRepeat = useMemo<TrackListItem[]>(() => (topTracks ?? []).slice(0, ON_REPEAT_ROWS), [topTracks]);
  const plays = useMemo(() => playsById(topTracks), [topTracks]);
  const topArtists = useMemo<(BoardArtistItem & { tracks: TrackListItem[] })[]>(
    () =>
      (replay?.top_artists ?? []).slice(0, TOP_ARTISTS).map((artist) => {
        // Their tracks among the window's top tracks: the picture, and what
        // plays when the library has nothing by them (streamed only).
        const own = tracksByArtist(artist.name, topTracks ?? []);
        return {
          id: artist.id,
          name: artist.name,
          detail: pluralize(artist.plays, "play", undefined, { locale: true }),
          imageUrl: artistImageUrl({ name: artist.name }, own, 128),
          tracks: own,
        };
      }),
    [replay?.top_artists, topTracks],
  );
  const albums = useMemo(() => homeAlbums(tracks).slice(0, ALBUM_COVERS), [tracks]);

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

  // Once settled, a panel shows while it has something, while a load it
  // started empty is under way (a retry), or to offer a retry. A list known
  // to be empty stays hidden while it revalidates, so revisits don't flash
  // it and reflow the board.
  const replayEmpty = replay ? replay.summary.total_plays === 0 : false;
  const present = useMemo(() => {
    if (!settled) return ALL_PANELS;
    const out: BoardPanelId[] = [];
    const show = (id: BoardPanelId, count: number, known: boolean, loading: boolean, error: string | null) => {
      if (count > 0 || (!known && loading) || error) out.push(id);
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
    settled,
    replay, replayEmpty, onRepeat.length, replayResource.loading, replayResource.error,
    recent.length, recentResource.data, recentResource.loading, recentResource.error,
    favs.length, favorites.loaded, favorites.loading, favorites.error,
    albums.length, tracksResource.data, tracksResource.loading, tracksResource.error,
    playlists.length, playlistResource.data, playlistResource.loading, playlistResource.error,
    topArtists.length,
  ]);
  const layout = useMemo(() => boardLayout(present), [present]);

  const panel = (cell: BoardCell) => {
    switch (cell.id) {
      case "resume":
        return (
          <ResumePanel
            key={cell.id}
            style={boardCellStyle(cell)}
            hero={hero}
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
            key={cell.id}
            cell={cell}
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
            {loading ? (
              <BoardRowPlaceholders count={ON_REPEAT_ROWS} ranked />
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
          </BoardPanel>
        );
      }
      case "recent":
        return (
          <BoardPanel
            key={cell.id}
            cell={cell}
            sub="Picked up where you left off"
            title="Recently played"
            to="/recent"
            status={<PanelStatus title="Recently played" loading={recentResource.loading} error={recentResource.error} reload={recentResource.reload} />}
          >
            {pending(recent.length, recentResource.loading, recentResource.error) ? (
              <BoardRowPlaceholders count={LIST_ROWS} />
            ) : (
              <BoardTrackList
                tracks={recent.slice(0, LIST_ROWS)}
                meta={(t) => fmtDurationMs(t.duration_ms)}
                onPlay={recentPlayer.playTrack}
                onContextMenu={(t) => bindCtx(t, { queue: recent })}
              />
            )}
          </BoardPanel>
        );
      case "favorites":
        return (
          <BoardPanel
            key={cell.id}
            cell={cell}
            sub="Hearts"
            title="Your favorites"
            to="/favorites"
            status={<PanelStatus title="Your favorites" loading={favorites.loading} error={favorites.error} reload={() => void favorites.refresh()} />}
          >
            {pending(favs.length, favorites.loading, favorites.error) ? (
              <BoardRowPlaceholders count={LIST_ROWS} />
            ) : (
              <BoardTrackList
                tracks={favs.slice(0, LIST_ROWS)}
                meta={(t) => fmtDurationMs(t.duration_ms)}
                onPlay={favoritesPlayer.playTrack}
                onContextMenu={(t) => bindCtx(t, { queue: favs })}
              />
            )}
          </BoardPanel>
        );
      case "albums":
        return (
          <BoardPanel
            key={cell.id}
            cell={cell}
            sub="Your library"
            title="Albums"
            to="/library?view=albums"
            status={<PanelStatus title="Albums" loading={tracksResource.loading} error={tracksResource.error} reload={tracksResource.reload} />}
            alert={failure?.panel === "albums" ? failure.message : null}
          >
            <div className="board-covers">
              {pending(albums.length, tracksResource.loading, tracksResource.error) && <MediaCardPlaceholders count={ALBUM_COVERS} />}
              {albums.map((a) => (
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
          </BoardPanel>
        );
      case "playlists":
        return (
          <BoardPanel
            key={cell.id}
            cell={cell}
            sub="Curated"
            title="Playlists"
            to="/playlists"
            status={<PanelStatus title="Playlists" loading={playlistResource.loading} error={playlistResource.error} reload={playlistResource.reload} />}
            alert={failure?.panel === "playlists" ? failure.message : null}
          >
            {pending(playlists.length, playlistResource.loading, playlistResource.error) ? (
              <BoardRowPlaceholders count={PLAYLIST_ROWS} />
            ) : (
              <BoardPlaylistList
                playlists={playlists.slice(0, PLAYLIST_ROWS)}
                onPlay={(p) =>
                  playFetched("playlists", p.name, async (signal) =>
                    (await api.listPlaylistTracks(p.id, { signal })).tracks.map(playlistEntryToTrack),
                  )
                }
              />
            )}
          </BoardPanel>
        );
      case "artists":
        return (
          <BoardPanel
            key={cell.id}
            cell={cell}
            sub="Last 30 days"
            title="Top artists"
            to={REPLAY_LINK}
            alert={failure?.panel === "artists" ? failure.message : null}
          >
            {pending(replayEmpty ? 0 : topArtists.length, replayResource.loading, replayResource.error) ? (
              <BoardArtistPlaceholders count={TOP_ARTISTS} />
            ) : (
              <BoardArtistList
                artists={topArtists}
                // The artist's library tracks, as on their page; their top
                // tracks here when the library has none (streamed only).
                onPlay={(artist) =>
                  playFetched("artists", artist.name, (signal) => api.listArtistTracks(artist.id, { signal }), artist.tracks)
                }
              />
            )}
          </BoardPanel>
        );
    }
  };

  return (
    <div className="view board-view">
      {ctxMenu}
      <div className="board">{layout.map(panel)}</div>
    </div>
  );
}

/**
 * Plays a list fetched on demand (an album's, a playlist's, an artist's
 * tracks), or `fallback` when it has nothing playable. When neither can play,
 * `failure` says why, for the panel the Play came from to show. Starting
 * another one, or leaving Home, aborts the fetch, so a late reply never
 * starts playback somewhere the user has moved on from.
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
      fallback: TrackListItem[] = [],
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
      const queue = playableTracks(loaded).length > 0 ? loaded : fallback;
      if (playableTracks(queue).length > 0) {
        startListPlayback(play, queue, false);
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
  style,
  hero,
  fromRecent,
  fallbackQueue,
  loading,
  error,
}: {
  style: CSSProperties;
  hero: TrackListItem | null;
  fromRecent: boolean;
  fallbackQueue: TrackListItem[];
  loading: boolean;
  error: boolean;
}) {
  const { me } = useAuth();
  if (hero) {
    return <HeroAlbum key={hero.id} style={style} track={hero} fromRecent={fromRecent} fallbackQueue={fallbackQueue} />;
  }
  if (loading) {
    return (
      <div className="hero board-resume" style={style} aria-busy="true">
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
    );
  }
  if (error) {
    return (
      <div className="hero board-resume" style={style}>
        <div className="hero-body">
          <h1 className="hero-title">Your library</h1>
          <p>Some music could not be loaded. Retry the sections below.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="hero board-resume" style={style}>
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
 * anything, a library track), with Play picking up from that track.
 */
function HeroAlbum({
  style,
  track,
  fromRecent,
  fallbackQueue,
}: {
  style: CSSProperties;
  track: TrackListItem;
  fromRecent: boolean;
  /** Queue for a track with no local album to play through. */
  fallbackQueue: TrackListItem[];
}) {
  const { play } = usePlayerControls();
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

  // Plays the album in order from the featured track, falling back to the
  // list the track came from if the album can't be loaded.
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
      const start = albumTracks.find((t) => t.id === track.id) ?? albumTracks[0];
      if (start) play(start, albumTracks);
      else play(track, fallbackQueue);
    } catch {
      if (!request.signal.aborted) play(track, fallbackQueue);
    } finally {
      if (!request.signal.aborted) setStarting(false);
    }
  };

  return (
    <div className="hero board-resume" style={style}>
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
  );
}
