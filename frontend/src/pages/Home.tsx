import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  Disc3 as DiscIcon,
  Play as PlayIcon,
  Sparkles as SparklesIcon,
} from "lucide-react";
import {
  api,
  albumCoverUrl,
  coverUrl,
  trackCoverUrl,
  type TrackListItem,
} from "../api";
import CoverArt from "../components/CoverArt";
import MediaCard, { MediaCardPlaceholders } from "../components/MediaCard";
import PlaylistCard from "../components/PlaylistCard";
import Section from "../components/Section";
import ShelfScroller from "../components/ShelfScroller";
import { Button } from "../components/Button";
import { useTrackContextMenu } from "../components/TrackContextMenu";
import { useAuth } from "../context/Auth";
import { usePlayer } from "../context/Player";
import { useFavorites } from "../context/Favorites";
import { usePlaylists } from "../context/Playlists";
import { useApiResource } from "../lib/useApiResource";
import { displayText, pluralize } from "../lib/format";

const EMPTY_TRACKS: TrackListItem[] = [];

export default function Home() {
  const { me } = useAuth();
  const { play } = usePlayer();
  const recentResource = useApiResource(
    (signal) => api.listRecent(20, { signal }), "Could not load recently played tracks.",
    { cacheKey: "recent:20" },
  );
  const tracksResource = useApiResource(
    (signal) => api.listTracks({ limit: 24, signal }), "Could not load your library.",
    { cacheKey: "home:tracks" },
  );
  const favorites = useFavorites();
  const playlistResource = usePlaylists();
  const recent = recentResource.data ?? EMPTY_TRACKS;
  const tracks = tracksResource.data ?? EMPTY_TRACKS;
  const favs = favorites.tracks.filter((track) => favorites.ids.has(track.id));
  const playlists = playlistResource.data ?? [];
  const { bind: bindCtx, menu: ctxMenu } = useTrackContextMenu();

  // Wait for recently played before picking the hero, so a library track
  // doesn't take the slot and then get swapped out when it lands.
  const recentSettled = recentResource.data !== null || !recentResource.loading;
  const hero = recentSettled ? recent[0] ?? tracks[0] ?? null : null;
  const albums = useMemo(() => groupAlbums(tracks), [tracks]);

  return (
    <div className="view">
      {ctxMenu}
      {hero ? (
        <HeroAlbum
          key={hero.id}
          track={hero}
          fromRecent={recent.length > 0}
          fallbackQueue={recent.length ? recent : tracks}
        />
      ) : recentResource.loading || tracksResource.loading ? (
        <div className="hero" aria-busy="true">
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
      ) : recentResource.error || tracksResource.error ? (
        <div className="hero">
          <div className="hero-body">
            <h1 className="hero-title">Your library</h1>
            <p>Some music could not be loaded. Retry the sections below.</p>
          </div>
        </div>
      ) : (
        <div className="hero">
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
      )}

      {(recent.length > 0 || recentResource.loading || recentResource.error) && (
        <Shelf sub="Picked up where you left off" title="Recently played" to="/recent" status={<ShelfStatus title="Recently played" loading={recentResource.loading} error={recentResource.error} reload={recentResource.reload} />}>
          {recent.length === 0 && recentResource.loading && <MediaCardPlaceholders />}
          {recent.slice(0, 12).map((t) => (
            <MediaCard
              key={t.id}
              coverUrl={trackCoverUrl(t)}
              title={displayText(t.title)}
              subtitle={displayText(t.artist, "Unknown artist")}
              onPlay={() => play(t, recent)}
              onContextMenu={bindCtx(t, { queue: recent })}
              playLabel={`Play ${t.title}`}
            />
          ))}
        </Shelf>
      )}

      {(albums.length > 0 || tracksResource.loading || tracksResource.error) && (
        <Shelf sub="Your library" title="Albums" to="/library?view=albums" status={<ShelfStatus title="Albums" loading={tracksResource.loading} error={tracksResource.error} reload={tracksResource.reload} />}>
          {albums.length === 0 && tracksResource.loading && <MediaCardPlaceholders />}
          {albums.slice(0, 12).map((a) => (
            <MediaCard
              key={a.key}
              to={
                a.albumID
                  ? `/library?view=albums&album=${encodeURIComponent(a.albumID)}&by=${encodeURIComponent(a.artist)}`
                  : undefined
              }
              coverUrl={a.albumID ? albumCoverUrl(a.albumID) : coverUrl(a.coverTrackId)}
              title={displayText(a.title)}
              subtitle={displayText(a.artist)}
            />
          ))}
        </Shelf>
      )}

      {(favs.length > 0 || favorites.loading || favorites.error) && (
        <Shelf sub="Hearts" title="Your favorites" to="/favorites" status={<ShelfStatus title="Your favorites" loading={favorites.loading} error={favorites.error} reload={() => void favorites.refresh()} />}>
          {favs.length === 0 && favorites.loading && <MediaCardPlaceholders />}
          {favs.slice(0, 12).map((t) => (
            <MediaCard
              key={t.id}
              coverUrl={trackCoverUrl(t)}
              title={displayText(t.title)}
              subtitle={displayText(t.artist, "Unknown artist")}
              onPlay={() => play(t, favs)}
              onContextMenu={bindCtx(t, { queue: favs })}
              playLabel={`Play ${t.title}`}
            />
          ))}
        </Shelf>
      )}

      {(playlists.length > 0 || playlistResource.loading || playlistResource.error) && (
        <Shelf sub="Curated" title="Playlists" to="/playlists" status={<ShelfStatus title="Playlists" loading={playlistResource.loading} error={playlistResource.error} reload={playlistResource.reload} />}>
          {playlists.length === 0 && playlistResource.loading && <MediaCardPlaceholders />}
          {playlists.slice(0, 12).map((p) => (
            <PlaylistCard key={p.id} playlist={p} />
          ))}
        </Shelf>
      )}
    </div>
  );
}

/**
 * The hero: the album of the last track you played (or, before you've played
 * anything, a library track), with Play picking up from that track.
 */
function HeroAlbum({
  track,
  fromRecent,
  fallbackQueue,
}: {
  track: TrackListItem;
  fromRecent: boolean;
  /** Queue for a track with no local album to play through. */
  fallbackQueue: TrackListItem[];
}) {
  const { play } = usePlayer();
  const albumID = track.album_id;
  const album = useApiResource(
    (signal) => (albumID ? api.getAlbum(albumID, { signal }) : Promise.resolve(null)),
    "Could not load the album.",
    { cacheKey: albumID ? `home:hero-album:${albumID}` : undefined },
  );
  const [starting, setStarting] = useState(false);
  const tidalAlbumID = track.source === "tidal" ? track.source_album_id : undefined;
  const albumHref = albumID
    ? `/library?view=albums&album=${encodeURIComponent(albumID)}`
    : tidalAlbumID
      ? `/library?view=albums&tidalAlbum=${encodeURIComponent(tidalAlbumID)}`
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
    <div className="hero">
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

function ShelfStatus({ title, loading, error, reload }: {
  title: string;
  loading: boolean;
  error: string | null;
  reload: () => void;
}) {
  if (!loading && !error) return null;
  // While loading, the shelf's placeholder cards show it; the text is for
  // screen readers only, so it doesn't push the shelf down and back up.
  return (
    <div role="status" aria-busy={loading} className={loading ? "sr-only" : undefined}>
      {loading ? `Loading ${title.toLowerCase()}…` : (
        <><p>{error}</p><Button onClick={reload}>Retry {title.toLowerCase()}</Button></>
      )}
    </div>
  );
}

function Shelf({
  sub,
  title,
  to,
  children,
  status,
}: {
  sub: string;
  title: string;
  to: string;
  children: React.ReactNode;
  status?: React.ReactNode;
}) {
  return (
    <Section
      sub={sub}
      title={title}
      action={
        <Link to={to} className="section-link">
          view all →
        </Link>
      }
    >
      {status}
      <ShelfScroller>{children}</ShelfScroller>
    </Section>
  );
}

interface AlbumTile {
  key: string;
  title: string;
  artist: string;
  trackCount: number;
  albumID?: string;
  coverTrackId: string;
}

function groupAlbums(tracks: TrackListItem[]): AlbumTile[] {
  const byKey = new Map<string, AlbumTile>();
  for (const t of tracks) {
    const title = t.album_title?.trim();
    if (!title) continue;
    const artist = t.artist?.trim() || "Unknown artist";
    const key = JSON.stringify([artist, title]);
    const existing = byKey.get(key);
    if (existing) {
      existing.trackCount++;
      if (!existing.albumID) existing.albumID = t.album_id;
    } else {
      byKey.set(key, {
        key,
        title,
        artist,
        trackCount: 1,
        albumID: t.album_id,
        coverTrackId: t.id,
      });
    }
  }
  return [...byKey.values()];
}
