import { useMemo } from "react";
import { Link } from "react-router-dom";
import { PlayIcon, SparklesIcon } from "@heroicons/react/16/solid";
import {
  api,
  albumCoverUrl,
  coverUrl,
  trackCoverUrl,
  type TrackListItem,
} from "../api";
import MediaCard from "../components/MediaCard";
import PlaylistCard from "../components/PlaylistCard";
import Section from "../components/Section";
import { Button } from "../components/Button";
import { useTrackContextMenu } from "../components/TrackContextMenu";
import { useAuth } from "../context/Auth";
import { usePlayer } from "../context/Player";
import { useFavorites } from "../context/Favorites";
import { usePlaylists } from "../context/Playlists";
import { useApiResource } from "../lib/useApiResource";
import { displayText } from "../lib/format";

const EMPTY_TRACKS: TrackListItem[] = [];

export default function Home() {
  const { me } = useAuth();
  const { play } = usePlayer();
  const recentResource = useApiResource(
    (signal) => api.listRecent(20, { signal }), "Could not load recently played tracks.",
  );
  const tracksResource = useApiResource(
    (signal) => api.listTracks({ limit: 24, signal }), "Could not load your library.",
  );
  const favorites = useFavorites();
  const playlistResource = usePlaylists();
  const recent = recentResource.data ?? EMPTY_TRACKS;
  const tracks = tracksResource.data ?? EMPTY_TRACKS;
  const favs = favorites.tracks.filter((track) => favorites.ids.has(track.id));
  const playlists = playlistResource.data ?? [];
  const { bind: bindCtx, menu: ctxMenu } = useTrackContextMenu();

  const hero = recent[0] ?? tracks[0] ?? null;
  const albums = useMemo(() => groupAlbums(tracks), [tracks]);

  return (
    <div className="view">
      {ctxMenu}
      {hero ? (
        <div className="hero">
          <div
            className="hero-art"
            style={{ backgroundImage: `url(${trackCoverUrl(hero)})` }}
            aria-hidden="true"
          />
          <div className="hero-body">
            <div className="hero-eyebrow">Welcome back, {me?.username}</div>
            <h1 className="hero-title">{displayText(hero.album_title ?? hero.title)}</h1>
            <div className="hero-meta">
              <span>{displayText(hero.artist, "Unknown artist")}</span>
              <span className="dot" aria-hidden="true" />
              <span>{tracks.length} tracks in library</span>
            </div>
            <div className="hero-actions">
              <Button
                variant="primary"
                onClick={() => play(hero, recent.length ? recent : tracks)}
                leadingIcon={<PlayIcon className="size-4" />}
              >
                Play
              </Button>
              <Link to="/library" className="btn">
                Browse library
              </Link>
            </div>
          </div>
        </div>
      ) : recentResource.loading || tracksResource.loading ? (
        <div className="hero" aria-busy="true">
          <div className="hero-body">
            <div className="hero-eyebrow">Welcome, {me?.username}</div>
            <h1 className="hero-title">Your library</h1>
            <p role="status">Loading your music…</p>
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

      <ShelfStatus title="Recently played" to="/recent" loading={recentResource.loading} error={recentResource.error} reload={recentResource.reload} />
      {recent.length > 0 && (
        <Shelf sub="Picked up where you left off" title="Recently played" to="/recent">
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

      <ShelfStatus title="Albums" to="/library?view=albums" loading={tracksResource.loading} error={tracksResource.error} reload={tracksResource.reload} />
      {albums.length > 0 && (
        <Shelf sub="Your library" title="Albums" to="/library?view=albums">
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

      <ShelfStatus title="Your favorites" to="/favorites" loading={favorites.loading} error={favorites.error} reload={() => void favorites.refresh()} />
      {favs.length > 0 && (
        <Shelf sub="Hearts" title="Your favorites" to="/favorites">
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

      <ShelfStatus title="Playlists" to="/playlists" loading={playlistResource.loading} error={playlistResource.error} reload={playlistResource.reload} />
      {playlists.length > 0 && (
        <Shelf sub="Curated" title="Playlists" to="/playlists">
          {playlists.slice(0, 12).map((p) => (
            <PlaylistCard key={p.id} playlist={p} />
          ))}
        </Shelf>
      )}
    </div>
  );
}

function ShelfStatus({ title, to, loading, error, reload }: {
  title: string;
  to: string;
  loading: boolean;
  error: string | null;
  reload: () => void;
}) {
  if (!loading && !error) return null;
  return (
    <Shelf sub="Your music" title={title} to={to}>
      <div role="status" aria-busy={loading}>
        {loading ? `Loading ${title.toLowerCase()}…` : (
          <><p>{error}</p><Button onClick={reload}>Retry {title.toLowerCase()}</Button></>
        )}
      </div>
    </Shelf>
  );
}

function Shelf({
  sub,
  title,
  to,
  children,
}: {
  sub: string;
  title: string;
  to: string;
  children: React.ReactNode;
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
      <div className="shelf">{children}</div>
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
