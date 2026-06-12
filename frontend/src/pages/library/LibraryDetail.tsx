import { useState } from "react";
import {
  ArrowLeftIcon,
  PencilSquareIcon,
  PlayIcon,
} from "@heroicons/react/16/solid";
import {
  api,
  albumCoverUrl,
  trackCoverUrl,
  type Album,
  type Artist,
} from "../../api";
import { displayText, pluralize } from "../../lib/format";
import { useEntityDetail } from "../../lib/useEntityDetail";
import TrackList from "../../components/TrackList";
import CoverArt from "../../components/CoverArt";
import { Button } from "../../components/Button";
import { EditAlbumDialog } from "../../components/EditDialog";
import ErrorBanner from "../../components/ErrorBanner";
import ListPageHeader from "../../components/ListPageHeader";
import LoadingState from "../../components/LoadingState";
import { usePlayer } from "../../context/Player";
import { useAuth } from "../../context/Auth";

export function AlbumDetailView({
  id,
  onBack,
}: {
  id: string;
  onBack: () => void;
}) {
  const { entity, tracks, error } = useEntityDetail<Album>(id, {
    get: api.getAlbum,
    listTracks: api.listAlbumTracks,
    label: "album",
  });
  const [editing, setEditing] = useState(false);
  // Bumped whenever the album is saved so the cover <img> reloads — the cover
  // URL is stable even when an admin replaces the artwork.
  const [coverNonce, setCoverNonce] = useState(0);
  // Local override so an in-place save reflects immediately without refetching.
  const [saved, setSaved] = useState<Album | null>(null);
  const { play } = usePlayer();
  const { me } = useAuth();
  const isAdmin = me?.role === "admin";

  if (entity === "notfound") {
    return <NotFound kind="Album" onBack={onBack} />;
  }
  if (!entity || !tracks) {
    return (
      <div className="view">
        <LoadingState label="Loading library…" />
      </div>
    );
  }
  const album = saved ?? entity;
  return (
    <div className="view" style={{ display: "grid", gap: 18 }}>
      <DetailBackRow onBack={onBack} />
      <ListPageHeader
        kind="Album"
        title={displayText(album.title)}
        art={
          <CoverArt
            className="detail-art"
            src={
              album.has_cover
                ? `${albumCoverUrl(album.id)}${coverNonce ? `?v=${coverNonce}` : ""}`
                : null
            }
            seed={album.id}
            label={album.title}
          />
        }
        meta={
          <>
            {album.artist_name && (
              <>
                <span>{displayText(album.artist_name)}</span>
                <span className="dot" />
              </>
            )}
            <span>{pluralize(album.track_count, "track")}</span>
            {album.release_year ? (
              <>
                <span className="dot" />
                <span>{album.release_year}</span>
              </>
            ) : null}
          </>
        }
        actions={
          <>
            <Button
              variant="primary"
              onClick={() => tracks.length && play(tracks[0], tracks)}
              disabled={tracks.length === 0}
              leadingIcon={<PlayIcon className="size-4" />}
            >
              Play all
            </Button>
            {isAdmin && (
              <Button
                onClick={() => setEditing(true)}
                leadingIcon={<PencilSquareIcon className="size-3.5" />}
              >
                Edit
              </Button>
            )}
          </>
        }
      />
      {error && <ErrorBanner message={error} />}
      <TrackList tracks={tracks} queueSource={tracks} showAlbum={false} />
      <EditAlbumDialog
        open={editing}
        album={album}
        onClose={() => setEditing(false)}
        onSaved={(a) => {
          setSaved(a);
          setCoverNonce(Date.now());
        }}
      />
    </div>
  );
}

export function ArtistDetailView({
  id,
  onBack,
}: {
  id: string;
  onBack: () => void;
}) {
  const { entity: artist, tracks, error } = useEntityDetail<Artist>(id, {
    get: api.getArtist,
    listTracks: api.listArtistTracks,
    label: "artist",
  });
  const { play } = usePlayer();

  if (artist === "notfound") {
    return <NotFound kind="Artist" onBack={onBack} />;
  }
  if (!artist || !tracks) {
    return (
      <div className="view">
        <LoadingState label="Loading library…" />
      </div>
    );
  }
  const coverTrack = tracks[0];
  return (
    <div className="view" style={{ display: "grid", gap: 18 }}>
      <DetailBackRow onBack={onBack} />
      <ListPageHeader
        kind="Artist"
        title={displayText(artist.name)}
        art={
          <CoverArt
            className="detail-art"
            src={coverTrack ? trackCoverUrl(coverTrack) : null}
            seed={artist.id}
            label={artist.name}
            radius={999}
          />
        }
        meta={
          <>
            <span>{pluralize(artist.track_count, "track")}</span>
            {artist.album_count > 0 && (
              <>
                <span className="dot" />
                <span>{pluralize(artist.album_count, "album")}</span>
              </>
            )}
          </>
        }
        actions={
          <Button
            variant="primary"
            onClick={() => tracks.length && play(tracks[0], tracks)}
            disabled={tracks.length === 0}
            leadingIcon={<PlayIcon className="size-4" />}
          >
            Play all
          </Button>
        }
      />
      {error && <ErrorBanner message={error} />}
      <TrackList tracks={tracks} queueSource={tracks} />
    </div>
  );
}

/**
 * Renders inside `.detail-header` as the top strip — sits over the same
 * gradient as the cover/body below it so the ambient color feels continuous
 * from the top-bar down.
 */
function DetailBackRow({ onBack }: { onBack: () => void }) {
  return (
    <div>
      <Button
        variant="ghost"
        size="sm"
        onClick={onBack}
        leadingIcon={<ArrowLeftIcon className="size-3.5" />}
      >
        Library
      </Button>
    </div>
  );
}

function NotFound({
  kind,
  onBack,
}: {
  kind: "Album" | "Artist";
  onBack: () => void;
}) {
  return (
    <div className="view">
      <div
        style={{
          padding: 40,
          textAlign: "center",
          color: "var(--fg-muted)",
          fontSize: 13,
        }}
      >
        <p style={{ color: "var(--fg)", fontWeight: 500, fontSize: 14, margin: 0 }}>
          {kind} not found.
        </p>
        <p style={{ marginTop: 8 }}>It may have been removed or renamed.</p>
        <Button
          variant="ghost"
          onClick={onBack}
          style={{ marginTop: 16 }}
          leadingIcon={<ArrowLeftIcon className="size-3.5" />}
        >
          Back to library
        </Button>
      </div>
    </div>
  );
}
