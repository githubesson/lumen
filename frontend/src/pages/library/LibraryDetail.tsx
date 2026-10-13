import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  ArrowLeft as ArrowLeftIcon,
  Library as LibraryIcon,
} from "lucide-react";
import {
  api,
  ApiError,
  albumArtUrl,
  errorMessage,
  type Album,
  type TidalAlbum,
  type TrackListItem,
} from "../../api";
import {
  albumCredits,
  libraryAlbumFacts,
  tidalAlbumFacts,
  type AlbumCredit,
} from "@music-library/core/entity-labels";
import type { EntityTarget } from "@music-library/core/entity-target";
import { albumDownloadState } from "@music-library/core/track";
import { useEntityDetail } from "../../lib/useEntityDetail";
import { dropCache, readCache, writeCache } from "../../lib/resourceCache";
import TrackList from "../../components/TrackList";
import { Button } from "../../components/Button";
import { EditAlbumDialog } from "../../components/edit/EditAlbumDialog";
import EmptyState from "../../components/EmptyState";
import ErrorBanner from "../../components/ErrorBanner";
import {
  ALBUM_SELECTION_HOST_ID,
  AlbumSleeve,
  type AlbumSleeveAlbum,
  type AlbumSleeveSearch,
} from "../../components/library/AlbumSleeve";
import SearchInput from "../../components/SearchInput";
import { useAuth } from "../../context/Auth";
import { useKey } from "../../lib/keybindings";
import { AlbumDownloadControl } from "./AlbumDownloadControl";

/** What "Saved" means on each kind of album page. */
const LIBRARY_SAVED_HINT = "The rest of the release plays from TIDAL";
const TIDAL_SAVED_HINT = "Played from the library instead of TIDAL";

export function AlbumDetailView({
  id,
  onBack,
}: {
  id: string;
  onBack: () => void;
}) {
  const { entity, tracks, error, refresh, replace } = useEntityDetail<Album>(id, {
    get: api.getAlbum,
    listTracks: api.listAlbumTracks,
    label: "album",
  });
  const [actionError, setActionError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  // Bumped whenever the album is saved so the cover <img> reloads — the cover
  // URL is stable even when an admin replaces the artwork.
  const [coverNonce, setCoverNonce] = useState(0);
  const { me } = useAuth();
  const isAdmin = me?.role === "admin";
  const search = useDetailTrackSearch("album", tracks);
  // The refetch carries fresh counts.
  const onDownloadChanged = useCallback(() => refresh(), [refresh]);
  const album = entity && entity !== "notfound" ? entity : null;
  const sleeve = useMemo<AlbumSleeveAlbum | null>(
    () =>
      album && tracks
        ? {
            title: album.title,
            coverSrc: albumArtUrl(album, undefined, coverNonce),
            credits: albumCredits(album),
            facts: libraryAlbumFacts(album, tracks),
            factHints: { saved: LIBRARY_SAVED_HINT },
            tracks,
          }
        : null,
    [album, tracks, coverNonce],
  );

  if (entity === "notfound") {
    return <NotFound kind="Album" onBack={onBack} />;
  }
  if (!sleeve || !album || !tracks) {
    // A failed first load: the way back and the error, not a frame that
    // would never fill.
    if (error) return <DetailLoadError error={error} onBack={onBack} />;
    return (
      <AlbumSleeve
        kind="Album"
        onBack={onBack}
        album={null}
        loadingLabel="Loading album…"
        search={sleeveSearch(search, 0)}
        searchRef={search.inputRef}
      />
    );
  }
  return (
    <AlbumSleeve
      kind="Album"
      onBack={onBack}
      album={sleeve}
      loadingLabel="Loading album…"
      onEdit={isAdmin ? () => setEditing(true) : undefined}
      actions={
        isAdmin && album.tidal_album_id ? (
          <AlbumDownloadControl
            tidalAlbumId={album.tidal_album_id}
            tracks={tracks}
            queuedCount={album.queued_count ?? 0}
            onChanged={onDownloadChanged}
            onError={setActionError}
          />
        ) : undefined
      }
      search={sleeveSearch(search, tracks.length)}
      searchRef={search.inputRef}
    >
      {(error || actionError) && <ErrorBanner message={(error || actionError)!} />}
      <AlbumTrackList
        tracks={search.filteredTracks}
        queueSource={tracks}
        credits={sleeve.credits}
        query={search.searchActive ? search.query : null}
      />
      <EditAlbumDialog
        open={editing}
        album={album}
        onClose={() => setEditing(false)}
        onSaved={(a) => {
          // In place and in the cache, so a revisit doesn't show the old one.
          replace(a);
          setCoverNonce(Date.now());
        }}
      />
    </AlbumSleeve>
  );
}

export function TidalAlbumDetailView({
  id,
  onBack,
  onOpenAlbum,
}: {
  id: string;
  onBack: () => void;
  onOpenAlbum: (target: EntityTarget) => void;
}) {
  const [album, setAlbum] = useState<TidalAlbum | null>(
    () => readCache<TidalAlbum>(`tidal-album:${id}`) ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  // Kept apart from the load error: a later successful read clears that one,
  // but it says nothing about a download or cancel that failed.
  const [actionError, setActionError] = useState<string | null>(null);
  const { me } = useAuth();
  const isAdmin = me?.role === "admin";
  // Only the newest read may commit: a revisit's mount read is still out
  // while the (cached) page's download controls are usable, and it mustn't
  // land on top of the reload that follows a download or cancel.
  const readGenRef = useRef(0);
  // Quiet refetch for download progress; failures keep the current view.
  const reload = useCallback(() => {
    const gen = ++readGenRef.current;
    api
      .getTidalAlbum(id)
      .then((next) => {
        if (gen !== readGenRef.current) return;
        writeCache(`tidal-album:${id}`, next);
        setAlbum(next);
        setError(null);
      })
      .catch(() => {});
  }, [id]);
  const search = useDetailTrackSearch("album", album?.tracks ?? null);
  const sleeve = useMemo<AlbumSleeveAlbum | null>(
    () =>
      album
        ? {
            title: album.title,
            coverSrc: albumArtUrl({ ...album, source: "tidal" }),
            coverMissing: !album.cover_url,
            credits: albumCredits(album),
            facts: tidalAlbumFacts(album, album.tracks),
            factHints: { saved: TIDAL_SAVED_HINT },
            tracks: album.tracks,
          }
        : null,
    [album],
  );

  useEffect(() => {
    const ac = new AbortController();
    // A changed TIDAL album id invalidates the previous remote snapshot; a
    // revisit starts from its own last load.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAlbum(readCache<TidalAlbum>(`tidal-album:${id}`) ?? null);
    setError(null);
    const gen = ++readGenRef.current;
    api
      .getTidalAlbum(id, { signal: ac.signal })
      .then((next) => {
        if (ac.signal.aborted || gen !== readGenRef.current) return;
        writeCache(`tidal-album:${id}`, next);
        setAlbum(next);
      })
      .catch((err) => {
        if (ac.signal.aborted || gen !== readGenRef.current) return;
        // Gone from TIDAL: don't keep showing (or caching) the old copy.
        if (err instanceof ApiError && err.status === 404) {
          dropCache(`tidal-album:${id}`);
          setAlbum(null);
        }
        setError(errorMessage(err, "Failed to load TIDAL album."));
      });
    return () => ac.abort();
  }, [id]);

  if (!album || !sleeve) {
    if (error) {
      return (
        <div className="view" style={{ display: "grid", gap: 18 }}>
          <DetailBackRow onBack={onBack} />
          <div
            style={{
              padding: 40,
              textAlign: "center",
              color: "var(--muted-foreground)",
              fontSize: 14,
            }}
          >
            <ErrorBanner message={error} />
            <p style={{ color: "var(--foreground)", fontWeight: 500, fontSize: 14 }}>
              TIDAL album unavailable.
            </p>
          </div>
        </div>
      );
    }
    return (
      <AlbumSleeve
        kind="TIDAL Album"
        onBack={onBack}
        album={null}
        loadingLabel="Loading TIDAL album…"
        // An admin always gets one row: the album download, or the library
        // copy once all of it is saved. (A library album only has a row when
        // it copies a TIDAL release, which nothing says before it loads.)
        reserveActions={isAdmin}
        search={sleeveSearch(search, 0)}
        searchRef={search.inputRef}
      />
    );
  }

  // The actions row holds one thing, so it never wraps and the loading frame
  // (which holds a row for an admin) matches it: the admin's download
  // control, or once the whole release is saved, its library copy. Anywhere
  // else the library copy is a quiet link under the details.
  const libraryAlbumId = album.library_album_id;
  const canDownload = isAdmin && albumDownloadState(album.tracks, album.queued_count ?? 0).kind !== "none";
  const openInLibrary = libraryAlbumId ? () => onOpenAlbum({ kind: "local", id: libraryAlbumId }) : null;
  return (
    <AlbumSleeve
      kind="TIDAL Album"
      onBack={onBack}
      album={sleeve}
      loadingLabel="Loading TIDAL album…"
      actions={
        canDownload ? (
          <AlbumDownloadControl
            tidalAlbumId={album.id}
            tracks={album.tracks}
            queuedCount={album.queued_count ?? 0}
            onChanged={reload}
            onError={setActionError}
          />
        ) : isAdmin && openInLibrary ? (
          <Button onClick={openInLibrary} leadingIcon={<LibraryIcon className="size-4" />}>
            Open in library
          </Button>
        ) : undefined
      }
      detailsLink={
        openInLibrary &&
        (canDownload || !isAdmin) && (
          <button type="button" className="album-sleeve-link" onClick={openInLibrary}>
            <LibraryIcon className="size-3.5" aria-hidden="true" />
            Open in library
          </button>
        )
      }
      search={sleeveSearch(search, album.tracks.length)}
      searchRef={search.inputRef}
    >
      {(error || actionError) && <ErrorBanner message={(error || actionError)!} />}
      <AlbumTrackList
        tracks={search.filteredTracks}
        queueSource={album.tracks}
        credits={sleeve.credits}
        query={search.searchActive ? search.query : null}
      />
    </AlbumSleeve>
  );
}

/** An album's list: no row covers, since every row has the album's. */
function AlbumTrackList({
  tracks,
  queueSource,
  credits,
  query,
}: {
  tracks: TrackListItem[];
  queueSource: TrackListItem[];
  /** The album's own artists: a row crediting only them leaves its artist line out. */
  credits: AlbumCredit[];
  /** The search, when one is filtering the list. */
  query: string | null;
}) {
  const artists = useMemo(() => credits.map((credit) => credit.name), [credits]);
  return (
    <TrackList
      tracks={tracks}
      queueSource={queueSource}
      showCover={false}
      showAlbum={false}
      omitArtists={artists}
      selectionControlsHostId={ALBUM_SELECTION_HOST_ID}
      emptyState={
        query !== null ? (
          <EmptyState title="No matches." hint={`Nothing in this album matches "${query}".`} />
        ) : undefined
      }
    />
  );
}

function sleeveSearch(
  search: ReturnType<typeof useDetailTrackSearch>,
  totalCount: number,
): AlbumSleeveSearch {
  return {
    query: search.query,
    setQuery: search.setQuery,
    matchCount: search.filteredTracks.length,
    totalCount,
    searchActive: search.searchActive,
  };
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

  // Built once per track list, not per keystroke. Only computed once a
  // search starts, so pages that are never searched skip it.
  const searchActive = normalizedQuery.length > 0;
  const searchKeys = useMemo(
    () => (searchActive ? (tracks ?? []).map(trackSearchKey) : null),
    [tracks, searchActive],
  );
  const filteredTracks = useMemo(() => {
    const base = tracks ?? [];
    if (!normalizedQuery || !searchKeys) return base;
    return base.filter((_, index) => searchKeys[index].includes(normalizedQuery));
  }, [tracks, normalizedQuery, searchKeys]);

  return {
    query,
    setQuery,
    inputRef,
    filteredTracks,
    searchActive,
  };
}

function trackSearchKey(track: TrackListItem): string {
  return [track.title, track.artist, track.album_title, track.aka, track.source]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
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

/** A failed first load: the way back and the error. */
function DetailLoadError({ error, onBack }: { error: string; onBack: () => void }) {
  return (
    <div className="view" style={{ display: "grid", gap: 18 }}>
      <DetailBackRow onBack={onBack} />
      <ErrorBanner message={error} />
    </div>
  );
}

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
