import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { PlayIcon, SparklesIcon } from "@heroicons/react/16/solid";
import {
  api,
  albumCoverUrl,
  coverUrl,
  trackCoverUrl,
  type Playlist,
  type TrackListItem,
} from "../api";
import MediaCard from "../components/MediaCard";
import PlaylistCard from "../components/PlaylistCard";
import Section from "../components/Section";
import { Button } from "../components/Button";
import { useTrackContextMenu } from "../components/TrackContextMenu";
import { useAuth } from "../context/Auth";
import { usePlayer } from "../context/Player";
import { displayText } from "../lib/format";

export default function Home() {
  const { me } = useAuth();
  const { play } = usePlayer();
  const [recent, setRecent] = useState<TrackListItem[]>([]);
  const [tracks, setTracks] = useState<TrackListItem[]>([]);
  const [favs, setFavs] = useState<TrackListItem[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const { bind: bindCtx, menu: ctxMenu } = useTrackContextMenu();

  useEffect(() => {
    const ac = new AbortController();
    Promise.allSettled([
      api.listRecent(20, { signal: ac.signal }),
      api.listTracks({ limit: 24, signal: ac.signal }),
      api.listFavorites({ signal: ac.signal }),
      api.listPlaylists({ signal: ac.signal }),
    ]).then((results) => {
      if (ac.signal.aborted) return;
      if (results[0].status === "fulfilled") setRecent(results[0].value ?? []);
      if (results[1].status === "fulfilled") setTracks(results[1].value ?? []);
      if (results[2].status === "fulfilled") setFavs(results[2].value ?? []);
      if (results[3].status === "fulfilled") setPlaylists(results[3].value ?? []);
    });
    return () => ac.abort();
  }, []);

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
