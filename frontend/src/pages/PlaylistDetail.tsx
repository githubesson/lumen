import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  HeartIcon,
  LockClosedIcon,
  MusicalNoteIcon,
  PencilSquareIcon,
  PlayIcon,
  PlusIcon,
  TrashIcon,
  UsersIcon,
} from "@heroicons/react/16/solid";
import {
  api,
  errorMessage,
  albumCoverUrl,
  coverUrl,
  toQueueItem,
  type Collaborator,
  type Playlist,
  type PlaylistTrackEntry,
  type TrackListItem,
} from "../api";
import { usePlayer } from "../context/Player";
import { Button } from "../components/Button";
import { Select, type SelectOption } from "../components/Select";
import SegmentedControl, {
  type SegmentedOption,
} from "../components/SegmentedControl";
import SearchInput from "../components/SearchInput";
import ListPageHeader from "../components/ListPageHeader";
import { useTrackContextMenu } from "../components/TrackContextMenu";
import ErrorBanner from "../components/ErrorBanner";
import EmptyState from "../components/EmptyState";
import LoadingState from "../components/LoadingState";
import { useFavorites } from "../context/Favorites";
import { usePopKey } from "../lib/useTransitionMount";
import { useKey } from "../lib/keybindings";
import { useTrackSelection } from "../lib/useTrackSelection";
import { displayText, fmtDurationMs, fmtTotalMs } from "../lib/format";
import { swatchFor } from "../lib/swatch";
import TrackCheckbox from "../components/TrackCheckbox";
import TrackSelectionToolbar from "../components/TrackSelectionToolbar";
import CollaboratorsPanel from "./playlist/CollaboratorsPanel";
import AddTracksDialog from "./playlist/AddTracksDialog";
import EditPlaylistDialog from "./playlist/EditPlaylistDialog";

type Tab = "tracks" | "collaborators";
const PLAYLIST_SELECTION_CONTROLS_ID = "playlist-track-selection-controls";

// ── Local sorting ────────────────────────────────────────────────────────────
// Display-only: never touches the saved playlist order on the server.

type SortKey = "custom" | "title" | "duration" | "plays";

const SORT_OPTIONS: SelectOption<SortKey>[] = [
  { value: "custom", label: "Custom order" },
  { value: "title", label: "Title" },
  { value: "duration", label: "Length" },
  { value: "plays", label: "Plays" },
];

// Ascending feels natural for names and lengths; play counts read best
// biggest-first.
const SORT_DEFAULT_ASC: Record<SortKey, boolean> = {
  custom: true,
  title: true,
  duration: true,
  plays: false,
};

// Emoji and pictographic symbols, mirroring the mobile app and the backend's
// share-card stripping, so "🔥 Song" sorts under S rather than before every
// letter.
const EMOJI_RE =
  /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}]/gu;

function sortTitleKey(title: string): string {
  const stripped = title.replace(EMOJI_RE, "").replace(/\s+/g, " ").trim();
  return stripped || title;
}

const titleCollator = new Intl.Collator(undefined, {
  sensitivity: "base",
  numeric: true,
});

function compareEntries(
  a: PlaylistTrackEntry,
  b: PlaylistTrackEntry,
  key: SortKey,
): number {
  const byTitle = () =>
    titleCollator.compare(sortTitleKey(a.title), sortTitleKey(b.title));
  switch (key) {
    case "title":
      return byTitle();
    case "duration":
      return a.duration_ms - b.duration_ms || byTitle();
    case "plays":
      return (a.play_count ?? 0) - (b.play_count ?? 0) || byTitle();
    case "custom":
      return 0;
  }
}

export default function PlaylistDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { play, current, isPlaying } = usePlayer();
  const { isFavorite, toggle: toggleFav } = useFavorites();

  const [playlist, setPlaylist] = useState<Playlist | null>(null);
  const [tracks, setTracks] = useState<PlaylistTrackEntry[] | null>(null);
  const [collabs, setCollabs] = useState<Collaborator[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("tracks");
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("custom");
  const [sortAsc, setSortAsc] = useState(true);
  const searchInputRef = useRef<HTMLInputElement>(null);

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
      label: "Search in playlist",
      group: "Playlist",
      allowInInput: true,
    },
  );

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const p = await api.getPlaylist(id);
      setPlaylist(p);
      const t = await api.listPlaylistTracks(id);
      setTracks(t.tracks);
      if (p.effective_role === "owner" || p.visibility === "collaborative") {
        const c = await api.listCollaborators(id).catch(() => []);
        setCollabs(c);
      }
    } catch (err) {
      setError(errorMessage(err, "Failed to load playlist."));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

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

  if (error) {
    return (
      <div className="view">
        <ErrorBanner message={error} />
      </div>
    );
  }

  if (!playlist || tracks === null) {
    return <LoadingState />;
  }

  const role = playlist.effective_role ?? "";
  const isOwner = role === "owner";
  const canEdit = isOwner || role === "editor";

  const onPlayAll = () => {
    if (queue.length > 0) play(queue[0], queue);
  };

  const onRemove = async (position: number) => {
    if (!id) return;
    try {
      await api.removePlaylistTrack(id, position);
      await load();
    } catch (err) {
      setError(errorMessage(err, "Failed to remove track."));
    }
  };

  const onDelete = async () => {
    if (!id || !window.confirm(`Delete "${playlist.name}"? This cannot be undone.`)) return;
    try {
      await api.deletePlaylist(id);
      navigate("/playlists", { replace: true });
    } catch (err) {
      setError(errorMessage(err, "Failed to delete."));
    }
  };

  return (
    <div className="view" style={{ display: "grid", gap: 18 }}>
      <ListPageHeader
        kind={
          <>
            {playlist.visibility === "collaborative" ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <UsersIcon className="size-3" /> Collaborative
              </span>
            ) : (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
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
        title={playlist.name}
        description={playlist.description || undefined}
        heroTrack={firstCoverTrack}
        fallbackGradient={swatchFor(playlist.id)}
        fallbackIcon={
          <MusicalNoteIcon className="size-12" style={{ color: "var(--accent-fg)" }} />
        }
        meta={
          <>
            <span>
              {tracks.length} {tracks.length === 1 ? "track" : "tracks"}
            </span>
            {tracks.length > 0 && (
              <>
                <span className="dot" />
                <span>{fmtTotalMs(tracks.reduce((s, t) => s + t.duration_ms, 0))}</span>
              </>
            )}
          </>
        }
        actions={
          <>
            <Button
              variant="primary"
              onClick={onPlayAll}
              disabled={tracks.length === 0}
              leadingIcon={<PlayIcon className="size-4" />}
            >
              Play all
            </Button>
            {canEdit && (
              <Button
                onClick={() => setShowAddDialog(true)}
                leadingIcon={<PlusIcon className="size-4" />}
              >
                Add tracks
              </Button>
            )}
            {isOwner && (
              <>
                <Button
                  variant="ghost"
                  onClick={() => setShowEditDialog(true)}
                  leadingIcon={<PencilSquareIcon className="size-4" />}
                >
                  Edit
                </Button>
                <Button
                  variant="danger"
                  onClick={onDelete}
                  leadingIcon={<TrashIcon className="size-4" />}
                >
                  Delete
                </Button>
              </>
            )}
          </>
        }
      />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
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
                            style={{ color: "var(--fg-subtle)", marginLeft: 4 }}
                          >
                            {collabs.length}
                          </span>
                        )}
                      </>
                    ),
                  } satisfies SegmentedOption<Tab>,
                ]
              : []),
          ]}
        />
        <div style={{ flex: 1 }} />
        {tab === "tracks" && tracks.length > 1 && (
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <div
              id={PLAYLIST_SELECTION_CONTROLS_ID}
              className="track-selectbar-host"
            />
            <Select
              value={sortKey}
              onChange={(next) => {
                if (next !== sortKey) setSortAsc(SORT_DEFAULT_ASC[next]);
                setSortKey(next);
              }}
              options={SORT_OPTIONS}
              variant="minimal"
              aria-label="Sort playlist"
            />
            {sortKey !== "custom" && (
              <Button
                variant="ghost"
                style={{ paddingInline: 8 }}
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
        <SearchInput
          ref={searchInputRef}
          style={{ width: 260 }}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setSearchQuery("");
              (e.target as HTMLInputElement).blur();
            }
          }}
          placeholder="Search this playlist"
          aria-label="Search this playlist"
        />
      </div>

      {tab === "tracks" && (
        <TracksPanel
          tracks={filteredTracks}
          totalCount={tracks.length}
          searchActive={q.length > 0}
          searchQuery={searchQuery}
          queue={queue}
          queueById={queueById}
          canEdit={canEdit}
          onRemove={onRemove}
          onPlay={(entry) => {
            const item = queueById.get(entry.track_id);
            if (item) play(item, queue);
          }}
          onToggleFav={(id) => void toggleFav(id)}
          isFav={isFavorite}
          isCurrent={(tid) => current?.id === tid}
          isPlaying={isPlaying}
          selectionControlsHostId={PLAYLIST_SELECTION_CONTROLS_ID}
        />
      )}

      {tab === "collaborators" && (
        <CollaboratorsPanel
          playlistId={id!}
          collaborators={collabs}
          isOwner={isOwner}
          canInvite={isOwner && playlist.visibility === "collaborative"}
          onChanged={load}
        />
      )}

      {id && (
        <AddTracksDialog
          open={showAddDialog}
          playlistId={id}
          existingIds={new Set(tracks.map((t) => t.track_id))}
          onClose={() => setShowAddDialog(false)}
          onAdded={async () => {
            setShowAddDialog(false);
            await load();
          }}
        />
      )}

      {id && (
        <EditPlaylistDialog
          open={showEditDialog}
          playlist={playlist}
          onClose={() => setShowEditDialog(false)}
          onSaved={async () => {
            setShowEditDialog(false);
            await load();
          }}
        />
      )}
    </div>
  );
}

function TracksPanel({
  tracks,
  totalCount,
  searchActive,
  searchQuery,
  queue,
  queueById,
  canEdit,
  onRemove,
  onPlay,
  onToggleFav,
  isFav,
  isCurrent,
  isPlaying,
  selectionControlsHostId,
}: {
  tracks: PlaylistTrackEntry[];
  totalCount: number;
  searchActive: boolean;
  searchQuery: string;
  queue: TrackListItem[];
  queueById: Map<string, TrackListItem>;
  canEdit: boolean;
  onRemove: (position: number) => void;
  onPlay: (t: PlaylistTrackEntry) => void;
  onToggleFav: (id: string) => void;
  isFav: (id: string) => boolean;
  isCurrent: (id: string) => boolean;
  isPlaying: boolean;
  selectionControlsHostId?: string;
}) {
  if (totalCount === 0) {
    return (
      <EmptyState
        title="No tracks yet."
        hint={canEdit ? 'Click "Add tracks" above to pull some in from your library.' : undefined}
      />
    );
  }
  if (tracks.length === 0) {
    return (
      <EmptyState
        title="No matches."
        hint={`Nothing in this playlist matches "${searchQuery}".`}
      />
    );
  }
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {searchActive && (
        <div
          className="mono"
          style={{ fontSize: 11, color: "var(--fg-subtle)" }}
        >
          {tracks.length} of {totalCount} match
        </div>
      )}
      <TracksTable
        tracks={tracks}
        queue={queue}
        queueById={queueById}
        canEdit={canEdit}
        onRemove={onRemove}
        onPlay={onPlay}
        onToggleFav={onToggleFav}
        isFav={isFav}
        isCurrent={isCurrent}
        isPlaying={isPlaying}
        selectionControlsHostId={selectionControlsHostId}
      />
    </div>
  );
}

function TracksTable({
  tracks,
  queue,
  queueById,
  canEdit,
  onRemove,
  onPlay,
  onToggleFav,
  isFav,
  isCurrent,
  isPlaying,
  selectionControlsHostId,
}: {
  tracks: PlaylistTrackEntry[];
  queue: TrackListItem[];
  queueById: Map<string, TrackListItem>;
  canEdit: boolean;
  onRemove: (position: number) => void;
  onPlay: (t: PlaylistTrackEntry) => void;
  onToggleFav: (id: string) => void;
  isFav: (id: string) => boolean;
  isCurrent: (id: string) => boolean;
  isPlaying: boolean;
  selectionControlsHostId?: string;
}) {
  const { bind, menu } = useTrackContextMenu();
  const {
    selectionMode,
    setSelectionMode,
    selectedIds,
    selectedItems,
    allSelected,
    someSelected,
    exporting,
    exportNotice,
    toggleSelection,
    selectAll,
    clearSelection,
    exportSelected,
  } = useTrackSelection<PlaylistTrackEntry>({
    items: tracks,
    getId: (t) => t.track_id,
    toExportItems: (items) => items.map(toQueueItem),
  });

  const selectedLocalTracks = useMemo(
    () => selectedItems.map(toQueueItem).filter(isLocalTrack),
    [selectedItems],
  );

  const handleExportSelected = useCallback(() => {
    void exportSelected();
  }, [exportSelected]);

  return (
    <>
      {menu}
      <TrackSelectionToolbar
        selectionMode={selectionMode}
        selectedCount={selectedIds.size}
        totalCount={tracks.length}
        exportNotice={exportNotice}
        allSelected={allSelected}
        someSelected={someSelected}
        exporting={exporting}
        exportDisabled={selectedLocalTracks.length === 0}
        exportDisabledReason="Selected streaming tracks cannot be exported as files."
        onToggleMode={() => {
          setSelectionMode(!selectionMode);
        }}
        onSelectAll={selectAll}
        onExport={handleExportSelected}
        onClear={() => {
          setSelectionMode(false);
          clearSelection();
        }}
        hostId={selectionControlsHostId}
      />
      <table className={`table${selectionMode ? " table-selecting" : ""}`}>
        <thead>
          <tr>
            {selectionMode && (
              <th className="col-select">
                <TrackCheckbox
                  checked={allSelected}
                  indeterminate={someSelected && !allSelected}
                  ariaLabel={allSelected ? "Deselect all tracks" : "Select all tracks"}
                  onChange={selectAll}
                />
              </th>
            )}
            <th className="col-idx">#</th>
            <th className="col-art" />
            <th>Title</th>
            <th>Album</th>
            <th className="col-added">Added</th>
            <th className="col-dur">Time</th>
            <th className="col-acts" />
          </tr>
        </thead>
        <tbody>
          {tracks.map((t, i) => {
            const queueItem = queueById.get(t.track_id);
            return (
              <PlaylistRow
                key={`${t.position}-${t.track_id}`}
                entry={t}
                index={i}
                isNow={isCurrent(t.track_id)}
                isPlaying={isPlaying && isCurrent(t.track_id)}
                fav={isFav(t.track_id)}
                canEdit={canEdit}
                selectionMode={selectionMode}
                selected={selectedIds.has(t.track_id)}
                onPlay={() => onPlay(t)}
                onToggleSelect={(range) => toggleSelection(t, i, range)}
                onToggleFav={() => onToggleFav(t.track_id)}
                onRemove={() => onRemove(t.position)}
                onContextMenu={
                  queueItem ? bind(queueItem, { queue }) : undefined
                }
              />
            );
          })}
        </tbody>
      </table>
    </>
  );
}

const PlaylistRow = memo(function PlaylistRow({
  entry,
  index,
  isNow,
  isPlaying,
  fav,
  canEdit,
  selectionMode,
  selected,
  onPlay,
  onToggleSelect,
  onToggleFav,
  onRemove,
  onContextMenu,
}: {
  entry: PlaylistTrackEntry;
  index: number;
  isNow: boolean;
  isPlaying: boolean;
  fav: boolean;
  canEdit: boolean;
  selectionMode: boolean;
  selected: boolean;
  onPlay: () => void;
  onToggleSelect: (range: boolean) => void;
  onToggleFav: () => void;
  onRemove: () => void;
  onContextMenu?: React.MouseEventHandler<HTMLTableRowElement>;
}) {
  const popKey = usePopKey(fav);
  const added = entry.added_at
    ? new Date(entry.added_at).toLocaleDateString()
    : "—";
  return (
    <tr
      className={`${isNow ? "playing" : ""}${selected ? " selected" : ""}`.trim() || undefined}
      aria-selected={selectionMode ? selected : undefined}
      onClick={(e) => {
        if (selectionMode) onToggleSelect(e.shiftKey);
      }}
      onDoubleClick={() => {
        if (!selectionMode) onPlay();
      }}
      onContextMenu={onContextMenu}
    >
      {selectionMode && (
        <td className="col-select">
          <TrackCheckbox
            checked={selected}
            ariaLabel={`Select ${displayText(entry.title, "track")}`}
            onChange={(e) => onToggleSelect(e.shiftKey)}
          />
        </td>
      )}
      <td className="col-idx">
        <span className="play-cell">
          {isNow && isPlaying ? (
            <span className="playing-bars idx-bars" aria-label="now playing">
              <span />
              <span />
              <span />
            </span>
          ) : (
            <>
              <span className="idx-num">{String(index + 1).padStart(2, "0")}</span>
              <button
                type="button"
                className="idx-play"
                onClick={(e) => {
                  e.stopPropagation();
                  onPlay();
                }}
                aria-label={`Play ${entry.title}`}
                style={{
                  background: "transparent",
                  border: 0,
                  color: "var(--fg)",
                  cursor: "pointer",
                  display: "inline-grid",
                  placeItems: "center",
                }}
              >
                <PlayIcon className="size-3.5" />
              </button>
            </>
          )}
        </span>
      </td>
      <td className="col-art">
        <div
          className="mini-art"
          style={{
            backgroundImage: `url(${entry.album_id ? albumCoverUrl(entry.album_id) : coverUrl(entry.track_id)})`,
          }}
          aria-hidden="true"
        />
      </td>
      <td
        onClick={() => {
          if (!selectionMode) onPlay();
        }}
      >
        <div className="track-title">{displayText(entry.title)}</div>
        <div className="track-sub">
          {displayText(entry.artist, "Unknown artist")}
          {entry.added_by ? ` · added by ${entry.added_by}` : ""}
        </div>
      </td>
      <td className="mono" style={{ color: "var(--fg-subtle)", fontSize: 11 }}>
        {entry.album_title ? displayText(entry.album_title) : "—"}
      </td>
      <td className="col-added">{added}</td>
      <td className="col-dur">{fmtDurationMs(entry.duration_ms)}</td>
      <td className="col-acts">
        <div className="row-actions">
          <button
            type="button"
            className={fav ? "active" : undefined}
            aria-label={fav ? "Remove from favorites" : "Add to favorites"}
            aria-pressed={fav}
            onClick={(e) => {
              e.stopPropagation();
              onToggleFav();
            }}
          >
            <HeartIcon
              key={popKey}
              className={`size-3.5 ${popKey > 0 ? "motion-safe:animate-heart-pop" : ""}`}
            />
          </button>
          {canEdit && (
            <button
              type="button"
              aria-label="Remove from playlist"
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
            >
              <TrashIcon className="size-3.5" />
            </button>
          )}
        </div>
      </td>
    </tr>
  );
});

function isLocalTrack(track: TrackListItem): boolean {
  return !track.source || track.source === "local";
}
