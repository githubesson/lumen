import { memo, useCallback, useMemo } from "react";
import { TrashIcon } from "@heroicons/react/16/solid";
import {
  albumCoverUrl,
  coverUrl,
  toQueueItem,
  type PlaylistTrackEntry,
  type TrackListItem,
} from "../../api";
import EmptyState from "../../components/EmptyState";
import { useTrackContextMenu } from "../../components/TrackContextMenu";
import {
  FavoriteButton,
  SelectAllHeaderCell,
  TrackIndexCell,
  TrackSelectCell,
} from "../../components/TrackRowCells";
import TrackSelectionToolbar from "../../components/TrackSelectionToolbar";
import { displayText, fmtDurationMs } from "../../lib/format";
import { isLocalTrack } from "../../lib/track";
import { useTrackSelection } from "../../lib/useTrackSelection";

/**
 * The Tracks tab of the playlist page: search-result count, selection
 * toolbar, and the tracks table with its playlist-specific columns
 * (Added date, added-by attribution, remove-from-playlist action).
 */
export default function PlaylistTracksPanel({
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
              <SelectAllHeaderCell
                allSelected={allSelected}
                someSelected={someSelected}
                onToggle={selectAll}
              />
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
        <TrackSelectCell
          selected={selected}
          label={displayText(entry.title, "track")}
          onToggle={onToggleSelect}
        />
      )}
      <TrackIndexCell
        index={index}
        isPlaying={isNow && isPlaying}
        onPlay={onPlay}
        playLabel={`Play ${entry.title}`}
      />
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
          <FavoriteButton fav={fav} onToggle={onToggleFav} />
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
