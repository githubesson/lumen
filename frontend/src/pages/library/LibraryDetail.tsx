import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  ArrowLeft as ArrowLeftIcon,
  Library as LibraryIcon,
  SquarePen as PencilSquareIcon,
  Play as PlayIcon,
} from "lucide-react";
import {
  api,
  albumCoverUrl,
  errorMessage,
  type Album,
  type TidalAlbum,
  type TrackListItem,
} from "../../api";
import { displayText, pluralize } from "../../lib/format";
import { useEntityDetail } from "../../lib/useEntityDetail";
import TrackList from "../../components/TrackList";
import CoverArt from "../../components/CoverArt";
import { Button } from "../../components/Button";
import { EditAlbumDialog } from "../../components/edit/EditAlbumDialog";
import EmptyState from "../../components/EmptyState";
import ErrorBanner from "../../components/ErrorBanner";
import ListPageHeader from "../../components/ListPageHeader";
import LoadingState from "../../components/LoadingState";
import SearchInput from "../../components/SearchInput";
import { usePlayer } from "../../context/Player";
import { useAuth } from "../../context/Auth";
import { useKey } from "../../lib/keybindings";
import { playableTracks } from "../../lib/track";
import { AlbumDownloadControl } from "./AlbumDownloadControl";

export function AlbumDetailView({
  id,
  onBack,
}: {
  id: string;
  onBack: () => void;
}) {
  const { entity, tracks, error, refresh } = useEntityDetail<Album>(id, {
    get: api.getAlbum,
    listTracks: api.listAlbumTracks,
    label: "album",
  });
  const [actionError, setActionError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  // Bumped whenever the album is saved so the cover <img> reloads — the cover
  // URL is stable even when an admin replaces the artwork.
  const [coverNonce, setCoverNonce] = useState(0);
  // Local override so an in-place save reflects immediately without refetching.
  const [saved, setSaved] = useState<Album | null>(null);
  const { play } = usePlayer();
  const { me } = useAuth();
  const isAdmin = me?.role === "admin";
  const search = useDetailTrackSearch("album", tracks);
  const onDownloadChanged = useCallback(() => {
    setSaved(null); // the refetch carries fresh counts
    refresh();
  }, [refresh]);

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
  const playable = playableTracks(tracks);
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
            label={album.title}
          />
        }
        meta={
          <>
            {(album.artist_names?.length || album.artist_name) && (
              <>
                <span>
                  {displayText(album.artist_names?.join(", ") || album.artist_name)}
                </span>
                <span className="dot" />
              </>
            )}
            <span>{pluralize(album.track_count, "track")}</span>
            {album.tidal_album_id && album.saved_count !== undefined && (
              <>
                <span className="dot" />
                <span title="The rest of the release plays from TIDAL">
                  {album.saved_count} saved
                </span>
              </>
            )}
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
              onClick={() => playable.length && play(playable[0], playable)}
              disabled={playable.length === 0}
              leadingIcon={<PlayIcon className="size-4" />}
            >
              Play all
            </Button>
            {isAdmin && album.tidal_album_id && (
              <AlbumDownloadControl
                tidalAlbumId={album.tidal_album_id}
                tracks={tracks}
                queuedCount={album.queued_count ?? 0}
                onChanged={onDownloadChanged}
                onError={setActionError}
              />
            )}
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
        corner={
          <DetailTrackSearchBar
            kind="album"
            query={search.query}
            onQueryChange={search.setQuery}
            inputRef={search.inputRef}
            matchCount={search.filteredTracks.length}
            totalCount={tracks.length}
            searchActive={search.searchActive}
          />
        }
      />
      {(error || actionError) && <ErrorBanner message={(error || actionError)!} />}
      <TrackList
        tracks={search.filteredTracks}
        queueSource={tracks}
        showAlbum={false}
        emptyState={
          search.searchActive ? (
            <EmptyState
              title="No matches."
              hint={`Nothing in this album matches "${search.query}".`}
            />
          ) : undefined
        }
      />
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

export function TidalAlbumDetailView({
  id,
  onBack,
  onOpenAlbum,
}: {
  id: string;
  onBack: () => void;
  onOpenAlbum: (id: string) => void;
}) {
  const [album, setAlbum] = useState<TidalAlbum | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { play } = usePlayer();
  const { me } = useAuth();
  const isAdmin = me?.role === "admin";
  // Quiet refetch for download progress; failures keep the current view.
  const reload = useCallback(() => {
    api.getTidalAlbum(id).then(setAlbum).catch(() => {});
  }, [id]);
  const search = useDetailTrackSearch("album", album?.tracks ?? null);

  useEffect(() => {
    const ac = new AbortController();
    // A changed TIDAL album id invalidates the previous remote snapshot.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAlbum(null);
    setError(null);
    api
      .getTidalAlbum(id, { signal: ac.signal })
      .then((next) => {
        if (!ac.signal.aborted) setAlbum(next);
      })
      .catch((err) => {
        if (!ac.signal.aborted) {
          setError(errorMessage(err, "Failed to load TIDAL album."));
        }
      });
    return () => ac.abort();
  }, [id]);

  if (!album && !error) {
    return (
      <div className="view">
        <LoadingState label="Loading TIDAL album..." />
      </div>
    );
  }

  return (
    <div className="view" style={{ display: "grid", gap: 18 }}>
      <DetailBackRow onBack={onBack} />
      {album ? (
        <>
          <ListPageHeader
            kind="TIDAL Album"
            title={displayText(album.title)}
            art={
              <CoverArt
                className="detail-art"
                src={album.cover_url ?? null}
                label={album.title}
                forcePlaceholder={!album.cover_url}
              />
            }
            meta={
              <>
                {(album.artists?.length || album.artist) && (
                  <>
                    <span>{displayText(album.artists?.join(", ") || album.artist)}</span>
                    <span className="dot" />
                  </>
                )}
                <span>{pluralize(album.track_count, "track")}</span>
                {album.saved_count ? (
                  <>
                    <span className="dot" />
                    <span title="Played from the library instead of TIDAL">
                      {album.saved_count} saved
                    </span>
                  </>
                ) : null}
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
                  onClick={() => {
                    const playable = playableTracks(album.tracks);
                    if (playable.length) play(playable[0], playable);
                  }}
                  disabled={playableTracks(album.tracks).length === 0}
                  leadingIcon={<PlayIcon className="size-4" />}
                >
                  Play all
                </Button>
                {isAdmin && (
                  <AlbumDownloadControl
                    tidalAlbumId={album.id}
                    tracks={album.tracks}
                    queuedCount={album.queued_count ?? 0}
                    onChanged={reload}
                    onError={setError}
                  />
                )}
                {album.library_album_id && (
                  <Button
                    onClick={() => onOpenAlbum(album.library_album_id!)}
                    leadingIcon={<LibraryIcon className="size-4" />}
                  >
                    Open in library
                  </Button>
                )}
              </>
            }
            corner={
              <DetailTrackSearchBar
                kind="album"
                query={search.query}
                onQueryChange={search.setQuery}
                inputRef={search.inputRef}
                matchCount={search.filteredTracks.length}
                totalCount={album.tracks.length}
                searchActive={search.searchActive}
              />
            }
          />
          {error && <ErrorBanner message={error} />}
          <TrackList
            tracks={search.filteredTracks}
            queueSource={album.tracks}
            showAlbum={false}
            emptyState={
              search.searchActive ? (
                <EmptyState
                  title="No matches."
                  hint={`Nothing in this album matches "${search.query}".`}
                />
              ) : undefined
            }
          />
        </>
      ) : (
        <div
          style={{
            padding: 40,
            textAlign: "center",
            color: "var(--muted-foreground)",
            fontSize: 14,
          }}
        >
          {error && <ErrorBanner message={error} />}
          <p style={{ color: "var(--foreground)", fontWeight: 500, fontSize: 14 }}>
            TIDAL album unavailable.
          </p>
        </div>
      )}
    </div>
  );
}

export function useDetailTrackSearch(
  kind: "album" | "artist",
  tracks: TrackListItem[] | null,
) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const normalizedQuery = query.trim().toLowerCase();

  useKey(
    "mod+f",
    (e) => {
      e.preventDefault();
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    },
    {
      id: `library:${kind}:search`,
      allowInInput: true,
    },
  );

  const filteredTracks = useMemo(() => {
    const base = tracks ?? [];
    if (!normalizedQuery) return base;
    return base.filter((track) => trackMatchesQuery(track, normalizedQuery));
  }, [tracks, normalizedQuery]);

  return {
    query,
    setQuery,
    inputRef,
    filteredTracks,
    searchActive: normalizedQuery.length > 0,
  };
}

function trackMatchesQuery(track: TrackListItem, query: string): boolean {
  return [track.title, track.artist, track.album_title, track.aka, track.source]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(query);
}

export function DetailTrackSearchBar({
  kind,
  query,
  onQueryChange,
  inputRef,
  matchCount,
  totalCount,
  searchActive,
}: {
  kind: "album" | "artist";
  query: string;
  onQueryChange: (query: string) => void;
  inputRef: RefObject<HTMLInputElement>;
  matchCount: number;
  totalCount: number;
  searchActive: boolean;
}) {
  return (
    <div className="detail-track-search">
      {searchActive && (
        <div className="mono detail-track-search-count">
          {matchCount} of {totalCount} match
        </div>
      )}
      <SearchInput
        ref={inputRef}
        style={{ width: 260 }}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onClear={() => onQueryChange("")}
        placeholder={`Search this ${kind}`}
        aria-label={`Search this ${kind}`}
      />
    </div>
  );
}

/**
 * Renders inside `.detail-header` as the top strip, over the same card
 * gradient as the cover/body below it.
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

export function NotFound({
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
          color: "var(--muted-foreground)",
          fontSize: 14,
        }}
      >
        <p style={{ color: "var(--foreground)", fontWeight: 500, fontSize: 14, margin: 0 }}>
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
