import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowDown as ArrowDownIcon,
  ArrowUp as ArrowUpIcon,
  ImageUp as ImageUpIcon,
  Lock as LockClosedIcon,
  Music as MusicalNoteIcon,
  Play as PlayIcon,
  Plus as PlusIcon,
  Users as UsersIcon,
} from "lucide-react";
import {
  api,
  ApiError,
  errorMessage,
  playlistCoverUrl,
  toQueueItem,
  trackCoverUrl,
  type Collaborator,
  type Playlist,
  type PlaylistCover,
  type TrackListItem,
} from "../api";
import { useAuth } from "../context/Auth";
import { usePlayer } from "../context/Player";
import { Button } from "../components/Button";
import { Select } from "../components/Select";
import SegmentedControl, {
  type SegmentedOption,
} from "../components/SegmentedControl";
import SearchInput from "../components/SearchInput";
import ListPageHeader from "../components/ListPageHeader";
import ErrorBanner from "../components/ErrorBanner";
import LoadingState from "../components/LoadingState";
import { useFavorites } from "../context/Favorites";
import { usePlaylists } from "../context/Playlists";
import { dropCache, readCache, writeCache } from "../lib/resourceCache";
import { useKey } from "../lib/keybindings";
import { fmtTotalMs } from "../lib/format";
import CollaboratorsPanel from "./playlist/CollaboratorsPanel";
import AddTracksDialog from "./playlist/AddTracksDialog";
import PlaylistSettingsPanel, {
  type PlaylistDetails,
} from "./playlist/PlaylistSettingsPanel";
import PlaylistTracksPanel from "./playlist/PlaylistTracksPanel";
import {
  SORT_DEFAULT_ASC,
  SORT_OPTIONS,
  compareEntries,
  type SortKey,
} from "./playlist/trackSort";
import type { PlaylistTrackEntry } from "../api";

type Tab = "tracks" | "collaborators" | "settings";
const PLAYLIST_SELECTION_CONTROLS_ID = "playlist-track-selection-controls";
// The server's own upload cap, checked first to skip a doomed upload.
const MAX_COVER_BYTES = 16 << 20;
// Header art is 200px wide; enough for a 2x screen.
const HEADER_ART_SIZE = 400;
// While TIDAL tracks are queued for download, refresh so rows flip to their
// library copies without a manual reload.
const AUTO_DOWNLOAD_REFRESH_MS = 20_000;

interface CachedPlaylist {
  playlist: Playlist;
  tracks: PlaylistTrackEntry[];
  collabs: Collaborator[];
}
const cacheKey = (id: string | undefined) => (id ? `playlist:${id}` : undefined);
const showsCollaborators = (p: Playlist) =>
  p.effective_role === "owner" || p.visibility === "collaborative";

// The same pick as the header art, and as the server's list: the first track
// with an album, else the first.
function coverFor(entries: PlaylistTrackEntry[]): PlaylistCover | undefined {
  const entry = entries.find((t) => t.album_id) ?? entries[0];
  if (!entry) return undefined;
  return {
    track_id: entry.db_track_id ?? entry.track_id,
    album_id: entry.album_id,
    cover_url: entry.cover_url,
  };
}

function sameListing(row: Playlist, p: Playlist, cover: PlaylistCover | undefined) {
  return (
    row.name === p.name &&
    (row.description ?? "") === (p.description ?? "") &&
    row.visibility === p.visibility &&
    row.custom_cover === p.custom_cover &&
    Boolean(row.tidal_auto_download) === Boolean(p.tidal_auto_download) &&
    row.cover?.track_id === cover?.track_id &&
    row.cover?.album_id === cover?.album_id &&
    row.cover?.cover_url === cover?.cover_url
  );
}

export default function PlaylistDetail() {
  const { id } = useParams<{ id: string }>();
  // Keyed on the route id so switching playlists remounts with fresh state
  // (tracks, collaborators, search, sort, tab) and drops in-flight responses
  // for the previous playlist instead of letting them overwrite the new one.
  return <PlaylistDetailView key={id} id={id} />;
}

function PlaylistDetailView({ id }: { id: string | undefined }) {
  const navigate = useNavigate();
  const { play, current, isPlaying } = usePlayer();
  const { isFavorite, toggle: toggleFav } = useFavorites();
  const { me } = useAuth();
  const isAdmin = me?.role === "admin";

  // A revisit starts from what this page showed last time; a first visit
  // starts from the sidebar's row, so the header is up while tracks load.
  const [cached] = useState(() => readCache<CachedPlaylist>(cacheKey(id)));
  const {
    data: playlistRows,
    reload: reloadPlaylists,
    update: updatePlaylists,
  } = usePlaylists();
  // Deleted, or access lost: nothing cached or listed stands in for it.
  const [gone, setGone] = useState(false);
  const listed = gone ? null : (playlistRows?.find((p) => p.id === id) ?? null);
  const [loadedPlaylist, setPlaylist] = useState<Playlist | null>(cached?.playlist ?? null);
  const playlist = loadedPlaylist ?? listed;
  const listedRef = useRef(listed);
  useEffect(() => {
    listedRef.current = listed;
  }, [listed]);
  const [tracks, setTracks] = useState<PlaylistTrackEntry[] | null>(cached?.tracks ?? null);
  const [collabs, setCollabs] = useState<Collaborator[]>(cached?.collabs ?? []);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("tracks");
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("custom");
  const [sortAsc, setSortAsc] = useState(true);
  const [savingAutoDownload, setSavingAutoDownload] = useState(false);
  const [savingCover, setSavingCover] = useState(false);
  const coverInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useKey(
    "mod+f",
    (e) => {
      e.preventDefault();
      setTab("tracks");
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
    },
    {
      id: "playlist:search",
      allowInInput: true,
    },
  );

  // Only the newest load may commit. The page is usable while its first
  // load is out (seeded from the cache or sidebar), so a mutation and its
  // reload can overtake it, and its older rows mustn't land on top.
  const loadGenRef = useRef(0);
  const invalidateLoads = () => {
    loadGenRef.current += 1;
  };
  const load = useCallback(async () => {
    if (!id) return;
    const gen = ++loadGenRef.current;
    try {
      // Fetch collaborators alongside when the row we already have says the
      // tab exists, so its count lands with everything else.
      const known = listedRef.current;
      const [p, t, early] = await Promise.all([
        api.getPlaylist(id),
        api.listPlaylistTracks(id),
        known && showsCollaborators(known)
          ? api.listCollaborators(id).catch(() => undefined)
          : null,
      ]);
      // undefined: that request failed, so keep what's shown (a cached
      // list) rather than committing an empty one over it.
      const c = showsCollaborators(p)
        ? early !== null
          ? early
          : await api.listCollaborators(id).catch(() => undefined)
        : [];
      if (gen !== loadGenRef.current) return;
      setPlaylist(p);
      setTracks(t.tracks);
      if (c) setCollabs(c);
      setError(null);
      // Keep the sidebar's row (name, cover) in step without refetching the
      // list. Only when it's out of date: update() drops list reads in flight.
      const row = listedRef.current;
      const cover = coverFor(t.tracks);
      if (row && !sameListing(row, p, cover)) {
        // Optional fields are named outright: the response omits cleared
        // ones, and spreading it would keep the row's stale values.
        const fresh: Playlist = {
          ...row,
          ...p,
          description: p.description,
          custom_cover: p.custom_cover,
          cover,
        };
        updatePlaylists((rows) => rows?.map((r) => (r.id === p.id ? fresh : r)) ?? rows);
      }
    } catch (err) {
      if (gen !== loadGenRef.current) return;
      if (err instanceof ApiError && err.status === 404) {
        dropCache(cacheKey(id));
        setGone(true);
        setPlaylist(null);
        setTracks(null);
        // Take it out of the sidebar too.
        void reloadPlaylists();
        setError("This playlist was deleted, or you no longer have access to it.");
        return;
      }
      setError(errorMessage(err, "Failed to load playlist."));
    }
  }, [id, reloadPlaylists, updatePlaylists]);

  useEffect(() => {
    // The route id selects an external playlist resource to load.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  useEffect(() => {
    if (loadedPlaylist && tracks) {
      writeCache(cacheKey(id), { playlist: loadedPlaylist, tracks, collabs } satisfies CachedPlaylist);
    }
  }, [id, loadedPlaylist, tracks, collabs]);

  const autoDownload = Boolean(playlist?.tidal_auto_download);
  const queuedTidal = useMemo(
    () => (tracks ?? []).filter((t) => t.source === "tidal").length,
    [tracks],
  );
  useEffect(() => {
    if (!id || !autoDownload || queuedTidal === 0) return;
    const timer = window.setInterval(() => {
      // Quiet refresh: a transient failure must not replace the page with
      // the load error banner.
      const gen = loadGenRef.current;
      api
        .listPlaylistTracks(id)
        .then((t) => {
          if (gen === loadGenRef.current) setTracks(t.tracks);
        })
        .catch(() => {});
    }, AUTO_DOWNLOAD_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [id, autoDownload, queuedTidal]);

  // All hooks must run unconditionally — keep them above every early return so
  // an error/loading state never changes the hook count between renders.
  // What the table shows; the play queue follows this order too.
  const sortedTracks = useMemo(() => {
    const base = tracks ?? [];
    if (sortKey === "custom") return base;
    const sorted = [...base].sort((a, b) => compareEntries(a, b, sortKey));
    return sortAsc ? sorted : sorted.reverse();
  }, [tracks, sortKey, sortAsc]);
  const queue = useMemo(() => sortedTracks.map(toQueueItem), [sortedTracks]);
  const queueById = useMemo(() => {
    const map = new Map<string, TrackListItem>();
    for (const item of queue) map.set(item.id, item);
    return map;
  }, [queue]);
  // Header art follows the saved order so re-sorting doesn't swap the cover.
  const firstCoverTrack = useMemo(() => {
    const base = tracks ?? [];
    const entry = base.find((t) => t.album_id) ?? base[0];
    return entry ? toQueueItem(entry) : null;
  }, [tracks]);
  const q = searchQuery.trim().toLowerCase();
  const filteredTracks = useMemo(
    () =>
      q
        ? sortedTracks.filter((t) =>
            `${t.title} ${t.artist ?? ""} ${t.album_title ?? ""}`
              .toLowerCase()
              .includes(q),
          )
        : sortedTracks,
    [sortedTracks, q],
  );

  // With nothing to show, the error is the page; otherwise (a cached or
  // listed playlist, a failed refresh or action) it sits under the header.
  if (error && (gone || !playlist)) {
    return (
      <div className="view">
        <ErrorBanner message={error} />
      </div>
    );
  }

  if (!playlist) {
    return (
      <div className="view">
        <LoadingState />
      </div>
    );
  }

  const role = playlist.effective_role ?? "";
  const isOwner = role === "owner";
  const canEdit = isOwner || role === "editor";
  const hasSettings = isOwner || isAdmin;
  // Rows name who added them on a shared playlist, or once anyone but the
  // owner has (a playlist made private keeps its collaborators' tracks).
  const showAddedBy =
    playlist.visibility === "collaborative" ||
    (tracks ?? []).some(
      (t) => t.added_by_id != null && t.added_by_id !== playlist.owner_id,
    );

  const onPlayAll = () => {
    if (queue.length > 0) play(queue[0], queue);
  };

  // After a failed action, reload anyway (the action may have superseded a
  // pending load), then report the action's error, which a successful reload
  // would otherwise clear.
  const failAction = async (err: unknown, fallback: string) => {
    await load();
    setError(errorMessage(err, fallback));
  };

  const onRemove = async (position: number) => {
    if (!id) return;
    invalidateLoads();
    try {
      await api.removePlaylistTrack(id, position);
      await load();
    } catch (err) {
      await failAction(err, "Failed to remove track.");
    }
  };
  // Drag-reorder commits the full visible order, like mobile's reorder mode.
  // Optimistic: swap locally, PUT the new order, reload for fresh positions.
  const onReorder = async (from: number, to: number) => {
    if (!id || !tracks || from === to) return;
    const previous = tracks;
    const next = [...tracks];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    invalidateLoads();
    setTracks(next);
    try {
      await api.reorderPlaylist(
        id,
        next.map((t) => t.track_id),
      );
      await load();
    } catch (err) {
      setTracks(previous);
      await failAction(err, "Failed to reorder tracks.");
    }
  };

  // Dragging only makes sense against the saved order with nothing filtered
  // out — otherwise row indices wouldn't map to server positions.
  const canReorder = canEdit && sortKey === "custom" && q.length === 0;

  const onToggleAutoDownload = async () => {
    if (!id || savingAutoDownload) return;
    const next = !autoDownload;
    invalidateLoads();
    setSavingAutoDownload(true);
    try {
      await api.setPlaylistTidalAutoDownload(id, next);
      setPlaylist((p) => (p ? { ...p, tidal_auto_download: next } : p));
      // The load this may have superseded still has to happen.
      void load();
    } catch (err) {
      await failAction(err, "Failed to update TIDAL auto-download.");
    } finally {
      setSavingAutoDownload(false);
    }
  };

  const onSaveDetails = async (details: PlaylistDetails) => {
    if (!id) return;
    invalidateLoads();
    try {
      await api.updatePlaylist(id, details);
    } catch (err) {
      // The load this superseded still has to happen.
      void load();
      throw err;
    }
    // Show the new details right away, then reload (which also updates the
    // sidebar row).
    setPlaylist((p) => (p ? { ...p, ...details } : p));
    await load();
  };

  const pickCover = () => coverInputRef.current?.click();

  // Cover changes apply at once (like the TIDAL switch), from Settings or by
  // clicking the header art.
  const changeCover = async (change: () => Promise<Playlist>, fallback: string) => {
    if (!id || savingCover) return;
    invalidateLoads();
    setSavingCover(true);
    try {
      const updated = await change();
      setPlaylist((p) => (p ? { ...p, custom_cover: updated.custom_cover } : p));
      // Also brings the sidebar row and cards up to date.
      void load();
    } catch (err) {
      await failAction(err, fallback);
    } finally {
      setSavingCover(false);
    }
  };

  const onCoverFile = (file: File) => {
    if (!id) return;
    if (file.size > MAX_COVER_BYTES) {
      setError("That image is over 16 MB. Choose a smaller one.");
      return;
    }
    void changeCover(() => api.setPlaylistCover(id, file), "Couldn't use that image.");
  };

  const onRemoveCover = () => {
    if (!id) return;
    void changeCover(() => api.removePlaylistCover(id), "Failed to remove the cover.");
  };

  // The owner renames from the title: it opens Settings on the name field.
  const openSettingsOnName = () => {
    setTab("settings");
    requestAnimationFrame(() => {
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
    });
  };

  const onDelete = async () => {
    if (
      !id ||
      !window.confirm(`Delete "${playlist.name}"? This cannot be undone.`)
    )
      return;
    try {
      await api.deletePlaylist(id);
      // Gone from the sidebar, the Playlists page and the cache before we
      // land there, rather than whenever a refetch succeeds.
      invalidateLoads();
      dropCache(cacheKey(id));
      updatePlaylists((rows) => rows?.filter((p) => p.id !== id) ?? rows);
      navigate("/playlists", { replace: true });
    } catch (err) {
      setError(errorMessage(err, "Failed to delete."));
    }
  };

  return (
    <div className="view" style={{ display: "grid", gap: 18 }}>
      {isOwner && (
        <input
          ref={coverInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Cleared so picking the same file again still fires a change.
            e.target.value = "";
            if (file) onCoverFile(file);
          }}
        />
      )}
      <ListPageHeader
        kind={
          <>
            {playlist.visibility === "collaborative" ? (
              <span
                style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
              >
                <UsersIcon className="size-3" /> Collaborative
              </span>
            ) : (
              <span
                style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
              >
                <LockClosedIcon className="size-3" /> Private
              </span>
            )}
            {role && role !== "owner" && (
              <>
                <span style={{ margin: "0 8px" }}>·</span>
                <span>{role}</span>
              </>
            )}
          </>
        }
        title={
          isOwner ? (
            <button
              type="button"
              className="detail-title-edit"
              title="Edit details"
              onClick={openSettingsOnName}
            >
              {playlist.name}
            </button>
          ) : (
            playlist.name
          )
        }
        description={playlist.description || undefined}
        art={
          <PlaylistHeaderArt
            src={
              playlist.custom_cover
                ? playlistCoverUrl(playlist.id, playlist.custom_cover, HEADER_ART_SIZE)
                : firstCoverTrack
                  ? trackCoverUrl(firstCoverTrack)
                  : null
            }
            // Plain art until the tracks say whether there's a cover, rather
            // than a note that gets swapped for one.
            showFallbackIcon={tracks !== null}
            onPick={isOwner ? pickCover : undefined}
            saving={savingCover}
          />
        }
        meta={
          <>
            <span>
              {tracks === null
                ? "—"
                : `${tracks.length} ${tracks.length === 1 ? "track" : "tracks"}`}
            </span>
            {tracks && tracks.length > 0 && (
              <>
                <span className="dot" />
                <span>
                  {fmtTotalMs(tracks.reduce((s, t) => s + t.duration_ms, 0))}
                </span>
              </>
            )}
            {autoDownload && queuedTidal > 0 && (
              <>
                <span className="dot" />
                <span>{queuedTidal} queued for download</span>
              </>
            )}
          </>
        }
        actions={
          <>
            <Button
              variant="primary"
              onClick={onPlayAll}
              disabled={!tracks || tracks.length === 0}
              leadingIcon={<PlayIcon className="size-4" />}
            >
              Play all
            </Button>
            {canEdit && (
              <Button
                // The dialog marks tracks already in the playlist; until they
                // load it would offer them again as duplicates.
                disabled={tracks === null}
                onClick={() => setShowAddDialog(true)}
                leadingIcon={<PlusIcon className="size-4" />}
              >
                Add tracks
              </Button>
            )}
          </>
        }
      />

      {error && <ErrorBanner message={error} />}

      <div className="playlist-toolbar">
        <SegmentedControl
          value={tab}
          onChange={setTab}
          options={[
            { value: "tracks", label: "Tracks" },
            ...(playlist.visibility === "collaborative" || isOwner
              ? [
                  {
                    value: "collaborators",
                    label: (
                      <>
                        Collaborators
                        {collabs.length > 0 && (
                          <span
                            className="mono"
                            style={{ color: "var(--muted-foreground)", marginLeft: 4 }}
                          >
                            {collabs.length}
                          </span>
                        )}
                      </>
                    ),
                  } satisfies SegmentedOption<Tab>,
                ]
              : []),
            ...(hasSettings
              ? [{ value: "settings", label: "Settings" } satisfies SegmentedOption<Tab>]
              : []),
          ]}
        />
        <div className="playlist-toolbar-spacer" />
        {tab === "tracks" && tracks && tracks.length > 1 && (
          <div
            className="toolbar-group playlist-sort-controls"
            role="group"
            aria-label="Track list options"
          >
            <div
              id={PLAYLIST_SELECTION_CONTROLS_ID}
              className="track-selectbar-host"
            />
            <span className="toolbar-group-sep" aria-hidden="true" />
            <Select
              value={sortKey}
              onChange={(next) => {
                if (next !== sortKey) setSortAsc(SORT_DEFAULT_ASC[next]);
                setSortKey(next);
              }}
              options={SORT_OPTIONS}
              variant="toolbar"
              aria-label="Sort playlist"
            />
            {sortKey !== "custom" && (
              <Button
                variant="ghost"
                onClick={() => setSortAsc((asc) => !asc)}
                aria-label={
                  sortAsc
                    ? "Sorted ascending, switch to descending"
                    : "Sorted descending, switch to ascending"
                }
              >
                {sortAsc ? (
                  <ArrowUpIcon className="size-3.5" />
                ) : (
                  <ArrowDownIcon className="size-3.5" />
                )}
              </Button>
            )}
          </div>
        )}
        {tab === "tracks" && (
          <SearchInput
            ref={searchInputRef}
            className="playlist-search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onClear={() => setSearchQuery("")}
            placeholder="Search this playlist"
            aria-label="Search this playlist"
          />
        )}
      </div>

      {/* Collaborators land with the tracks, so both tabs wait on them. */}
      {tab !== "settings" && tracks === null && !error && <LoadingState />}
      {tab === "tracks" && tracks && (
        <PlaylistTracksPanel
          tracks={filteredTracks}
          totalCount={tracks.length}
          searchActive={q.length > 0}
          searchQuery={searchQuery}
          queue={queue}
          queueById={queueById}
          canEdit={canEdit}
          showAddedBy={showAddedBy}
          onRemove={onRemove}
          onReorder={canReorder ? onReorder : undefined}
          onPlay={(entry) => {
            const item = queueById.get(entry.track_id);
            if (item) play(item, queue);
          }}
          onToggleFav={(id) => void toggleFav(id)}
          isFav={isFavorite}
          currentTrackId={current?.id ?? null}
          isPlaying={isPlaying}
          selectionControlsHostId={PLAYLIST_SELECTION_CONTROLS_ID}
        />
      )}

      {tab === "collaborators" && tracks !== null && (
        <CollaboratorsPanel
          playlistId={id!}
          collaborators={collabs}
          isOwner={isOwner}
          canInvite={isOwner && playlist.visibility === "collaborative"}
          onChanged={load}
        />
      )}

      {hasSettings && (
        <PlaylistSettingsPanel
          hidden={tab !== "settings"}
          playlist={playlist}
          isOwner={isOwner}
          isAdmin={isAdmin}
          nameInputRef={nameInputRef}
          onSaveDetails={onSaveDetails}
          savingCover={savingCover}
          onPickCover={pickCover}
          onRemoveCover={onRemoveCover}
          autoDownload={autoDownload}
          savingAutoDownload={savingAutoDownload}
          queuedTidal={queuedTidal}
          onToggleAutoDownload={() => void onToggleAutoDownload()}
          onDelete={() => void onDelete()}
        />
      )}

      {id && (
        <AddTracksDialog
          open={showAddDialog}
          playlistId={id}
          existingIds={new Set((tracks ?? []).map((t) => t.track_id))}
          onClose={() => setShowAddDialog(false)}
          onAdded={async () => {
            setShowAddDialog(false);
            await load();
          }}
        />
      )}

    </div>
  );
}

/**
 * The playlist's header art. For the owner it's also a button that picks a
 * new cover image, with a hint over the art on hover.
 */
function PlaylistHeaderArt({
  src,
  showFallbackIcon,
  onPick,
  saving,
}: {
  src: string | null;
  showFallbackIcon: boolean;
  onPick?: () => void;
  saving: boolean;
}) {
  const style = src ? { backgroundImage: `url(${src})` } : undefined;
  const fallback = !src && showFallbackIcon && (
    <MusicalNoteIcon
      className="size-12"
      style={{ color: "var(--muted-foreground)" }}
    />
  );
  if (!onPick) {
    return (
      <div className="detail-art" style={style}>
        {fallback}
      </div>
    );
  }
  return (
    <button
      type="button"
      className="detail-art detail-art-edit"
      style={style}
      onClick={onPick}
      disabled={saving}
      aria-label="Choose cover image"
    >
      {fallback}
      <span className="detail-art-edit-hint" aria-hidden="true">
        <ImageUpIcon className="size-5" />
        {saving ? "Uploading…" : "Choose image"}
      </span>
    </button>
  );
}
