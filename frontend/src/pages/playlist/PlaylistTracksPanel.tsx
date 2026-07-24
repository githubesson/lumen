import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import CoverArt from "../../components/CoverArt";
import { displayText, fmtDurationMs } from "../../lib/format";
import { isLocalTrack } from "../../lib/track";
import { useTrackSelection } from "../../lib/useTrackSelection";
import { findScrollParent, useWindowedSlice } from "../../lib/useWindowedSlice";

const playlistEntryId = (entry: PlaylistTrackEntry) => entry.track_id;
const playlistEntriesToQueue = (items: PlaylistTrackEntry[]) =>
  items.map(toQueueItem);

// Drag auto-scroll: holding a dragged row within this many px of the
// scroller's edge scrolls it, speed scaling with proximity up to the max.
const DRAG_SCROLL_ZONE = 56;
const DRAG_SCROLL_MAX_STEP = 16;

/**
 * One frame of drag auto-scroll, re-scheduling itself until the drag ends
 * (`clientY` nulled by `stopAutoScroll`).
 *
 * Lives at module scope because it is self-recursive: a `useCallback` that
 * references itself in its own initializer is rejected by the React Compiler.
 */
function autoScrollStep(
  clientY: React.MutableRefObject<number | null>,
  scrollerRef: React.MutableRefObject<HTMLElement | null>,
  rafRef: React.MutableRefObject<number>,
) {
  const y = clientY.current;
  if (y === null) {
    rafRef.current = 0;
    return;
  }
  const scroller = scrollerRef.current;
  // Clamp the scroller's edges to the viewport so a page-tall container
  // still gets usable zones at the visible top and bottom.
  const rect = scroller?.getBoundingClientRect();
  const top = Math.max(rect?.top ?? 0, 0);
  const bottom = Math.min(rect?.bottom ?? window.innerHeight, window.innerHeight);
  let delta = 0;
  if (y < top + DRAG_SCROLL_ZONE) {
    delta = -Math.ceil(((top + DRAG_SCROLL_ZONE - y) / DRAG_SCROLL_ZONE) * DRAG_SCROLL_MAX_STEP);
  } else if (y > bottom - DRAG_SCROLL_ZONE) {
    delta = Math.ceil(((y - (bottom - DRAG_SCROLL_ZONE)) / DRAG_SCROLL_ZONE) * DRAG_SCROLL_MAX_STEP);
  }
  if (delta !== 0) {
    if (scroller) scroller.scrollTop += delta;
    else window.scrollBy(0, delta);
  }
  rafRef.current = requestAnimationFrame(() =>
    autoScrollStep(clientY, scrollerRef, rafRef),
  );
}

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
  onReorder,
  onPlay,
  onToggleFav,
  isFav,
  currentTrackId,
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
  onReorder?: (from: number, to: number) => void;
  onPlay: (t: PlaylistTrackEntry) => void;
  onToggleFav: (id: string) => void;
  isFav: (id: string) => boolean;
  currentTrackId: string | null;
  isPlaying: boolean;
  selectionControlsHostId?: string;
}) {
  if (totalCount === 0) {
    return (
      <EmptyState
        title="No tracks yet."
        hint={
          canEdit
            ? 'Click "Add tracks" above to pull some in from your library.'
            : undefined
        }
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
        onReorder={onReorder}
        onPlay={onPlay}
        onToggleFav={onToggleFav}
        isFav={isFav}
        currentTrackId={currentTrackId}
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
  onReorder,
  onPlay,
  onToggleFav,
  isFav,
  currentTrackId,
  isPlaying,
  selectionControlsHostId,
}: {
  tracks: PlaylistTrackEntry[];
  queue: TrackListItem[];
  queueById: Map<string, TrackListItem>;
  canEdit: boolean;
  onRemove: (position: number) => void;
  onReorder?: (from: number, to: number) => void;
  onPlay: (t: PlaylistTrackEntry) => void;
  onToggleFav: (id: string) => void;
  isFav: (id: string) => boolean;
  currentTrackId: string | null;
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
    getId: playlistEntryId,
    toExportItems: playlistEntriesToQueue,
  });

  const selectedLocalTracks = useMemo(
    () => selectedItems.map(toQueueItem).filter(isLocalTrack),
    [selectedItems],
  );

  const handleExportSelected = useCallback(() => {
    void exportSelected();
  }, [exportSelected]);

  // Parent actions and queue references change as playlist/player state moves.
  // Rows receive stable dispatchers and read the latest values through refs, so
  // React.memo can skip every unaffected visible row.
  const queueRef = useRef(queue);
  const queueByIdRef = useRef(queueById);
  const bindRef = useRef(bind);
  const onRemoveRef = useRef(onRemove);
  const onPlayRef = useRef(onPlay);
  const onToggleFavRef = useRef(onToggleFav);
  const toggleSelectionRef = useRef(toggleSelection);
  // Refresh from an effect, not during render: a render that React throws away
  // must not mutate a ref (illegal under concurrent React, rejected by the
  // React Compiler). Every reader below runs from an event handler, so
  // committing one tick later is harmless.
  useEffect(() => {
    queueRef.current = queue;
    queueByIdRef.current = queueById;
    bindRef.current = bind;
    onRemoveRef.current = onRemove;
    onPlayRef.current = onPlay;
    onToggleFavRef.current = onToggleFav;
    toggleSelectionRef.current = toggleSelection;
  }, [queue, queueById, bind, onRemove, onPlay, onToggleFav, toggleSelection]);

  const handlePlay = useCallback(
    (entry: PlaylistTrackEntry) => onPlayRef.current(entry),
    [],
  );
  const handleToggleSelection = useCallback(
    (entry: PlaylistTrackEntry, index: number, range: boolean) =>
      toggleSelectionRef.current(entry, index, range),
    [],
  );
  const handleToggleFav = useCallback(
    (id: string) => onToggleFavRef.current(id),
    [],
  );
  const handleRemove = useCallback(
    (position: number) => onRemoveRef.current(position),
    [],
  );
  const handleContextMenu = useCallback(
    (
      entry: PlaylistTrackEntry,
      event: React.MouseEvent<HTMLTableRowElement>,
    ) => {
      const queueItem = queueByIdRef.current.get(entry.track_id);
      if (!queueItem) return;
      bindRef.current(queueItem, { queue: queueRef.current })(event);
    },
    [],
  );

  // Native HTML5 drag-reorder. `dropSlot` is the insertion gap (0..length);
  // refs mirror the state so drop/end handlers stay referentially stable.
  const reorderable = !!onReorder && !selectionMode;
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropSlot, setDropSlot] = useState<number | null>(null);
  const dragIndexRef = useRef<number | null>(null);
  const onReorderProp = useRef(onReorder);
  useEffect(() => {
    onReorderProp.current = onReorder;
  }, [onReorder]);

  const slotFromEvent = (index: number, e: React.DragEvent<HTMLTableRowElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return e.clientY < rect.top + rect.height / 2 ? index : index + 1;
  };

  // HTML5 drag suppresses normal wheel/keyboard scrolling targets in odd
  // ways and never auto-scrolls custom containers, so we run our own rAF
  // loop for the whole drag: it nudges the scroll parent whenever the last
  // known pointer Y sits inside the edge zones.
  const dragClientYRef = useRef<number | null>(null);
  const dragScrollerRef = useRef<HTMLElement | null>(null);
  const autoScrollRafRef = useRef(0);

  const stopAutoScroll = useCallback(() => {
    dragClientYRef.current = null;
    dragScrollerRef.current = null;
    if (autoScrollRafRef.current) {
      cancelAnimationFrame(autoScrollRafRef.current);
      autoScrollRafRef.current = 0;
    }
  }, []);
  useEffect(() => stopAutoScroll, [stopAutoScroll]);

  const startAutoScroll = useCallback(() => {
    autoScrollRafRef.current = requestAnimationFrame(() =>
      autoScrollStep(dragClientYRef, dragScrollerRef, autoScrollRafRef),
    );
  }, []);

  const handleDragStartRow = useCallback(
    (index: number, e: React.DragEvent<HTMLTableRowElement>) => {
      e.dataTransfer.effectAllowed = "move";
      // Firefox refuses to start a drag without payload data.
      e.dataTransfer.setData("text/plain", String(index));
      dragIndexRef.current = index;
      setDragIndex(index);
      dragScrollerRef.current = tableRef.current
        ? findScrollParent(tableRef.current)
        : null;
      dragClientYRef.current = e.clientY;
      startAutoScroll();
    },
    [startAutoScroll],
  );
  const handleDragOverRow = useCallback(
    (index: number, e: React.DragEvent<HTMLTableRowElement>) => {
      if (dragIndexRef.current === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      dragClientYRef.current = e.clientY;
      setDropSlot(slotFromEvent(index, e));
    },
    [],
  );
  const handleDropRow = useCallback(
    (index: number, e: React.DragEvent<HTMLTableRowElement>) => {
      e.preventDefault();
      const from = dragIndexRef.current;
      const slot = slotFromEvent(index, e);
      dragIndexRef.current = null;
      setDragIndex(null);
      setDropSlot(null);
      stopAutoScroll();
      if (from === null) return;
      const to = slot > from ? slot - 1 : slot;
      if (to !== from) onReorderProp.current?.(from, to);
    },
    [stopAutoScroll],
  );
  const handleDragEndRow = useCallback(() => {
    dragIndexRef.current = null;
    setDragIndex(null);
    setDropSlot(null);
    stopAutoScroll();
  }, [stopAutoScroll]);

  const dropEdgeFor = (index: number): "above" | "below" | null => {
    if (dragIndex === null || dropSlot === null) return null;
    // Hide the line on no-op slots (right where the row already sits).
    if (dropSlot === dragIndex || dropSlot === dragIndex + 1) return null;
    if (dropSlot === index) return "above";
    if (dropSlot === index + 1 && index === tracks.length - 1) return "below";
    return null;
  };

  const tableRef = useRef<HTMLTableElement>(null);
  const { start, end, topSpacerPx, bottomSpacerPx } = useWindowedSlice(
    tableRef,
    tracks.length,
  );
  const visibleTracks = tracks.slice(start, end);
  const columnCount = 7 + (selectionMode ? 1 : 0);

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
      <div className="table-scroll" data-horizontal-scroll="">
        <div className="table-scroll-inner">
          <table
            ref={tableRef}
            className={`table${selectionMode ? " table-selecting" : ""}`}
          >
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
              {topSpacerPx > 0 && (
                <tr aria-hidden="true" className="vt-spacer">
                  <td colSpan={columnCount} style={{ height: topSpacerPx }} />
                </tr>
              )}
              {visibleTracks.map((t, i) => {
                const index = start + i;
                const isNow = currentTrackId === t.track_id;
                return (
                  <PlaylistRow
                    key={`${t.position}-${t.track_id}`}
                    entry={t}
                    index={index}
                    isNow={isNow}
                    isPlaying={isPlaying && isNow}
                    fav={isFav(t.track_id)}
                    canEdit={canEdit}
                    selectionMode={selectionMode}
                    selected={selectedIds.has(t.track_id)}
                    onPlay={handlePlay}
                    onToggleSelect={handleToggleSelection}
                    onToggleFav={handleToggleFav}
                    onRemove={handleRemove}
                    onContextMenu={handleContextMenu}
                    reorderable={reorderable}
                    dragSource={dragIndex === index}
                    dropEdge={dropEdgeFor(index)}
                    onDragStartRow={handleDragStartRow}
                    onDragOverRow={handleDragOverRow}
                    onDropRow={handleDropRow}
                    onDragEndRow={handleDragEndRow}
                  />
                );
              })}
              {bottomSpacerPx > 0 && (
                <tr aria-hidden="true" className="vt-spacer">
                  <td
                    colSpan={columnCount}
                    style={{ height: bottomSpacerPx }}
                  />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
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
  reorderable,
  dragSource,
  dropEdge,
  onDragStartRow,
  onDragOverRow,
  onDropRow,
  onDragEndRow,
}: {
  entry: PlaylistTrackEntry;
  index: number;
  isNow: boolean;
  isPlaying: boolean;
  fav: boolean;
  canEdit: boolean;
  selectionMode: boolean;
  selected: boolean;
  onPlay: (entry: PlaylistTrackEntry) => void;
  onToggleSelect: (
    entry: PlaylistTrackEntry,
    index: number,
    range: boolean,
  ) => void;
  onToggleFav: (id: string) => void;
  onRemove: (position: number) => void;
  onContextMenu: (
    entry: PlaylistTrackEntry,
    event: React.MouseEvent<HTMLTableRowElement>,
  ) => void;
  reorderable: boolean;
  dragSource: boolean;
  dropEdge: "above" | "below" | null;
  onDragStartRow: (index: number, e: React.DragEvent<HTMLTableRowElement>) => void;
  onDragOverRow: (index: number, e: React.DragEvent<HTMLTableRowElement>) => void;
  onDropRow: (index: number, e: React.DragEvent<HTMLTableRowElement>) => void;
  onDragEndRow: () => void;
}) {
  const added = entry.added_at
    ? new Date(entry.added_at).toLocaleDateString()
    : "—";
  return (
    <tr
      className={
        `${isNow ? "playing" : ""}${selected ? " selected" : ""}${
          dragSource ? " drag-source" : ""
        }${
          dropEdge ? (dropEdge === "above" ? " drop-above" : " drop-below") : ""
        }`.trim() || undefined
      }
      aria-selected={selectionMode ? selected : undefined}
      draggable={reorderable || undefined}
      onDragStart={reorderable ? (e) => onDragStartRow(index, e) : undefined}
      onDragOver={reorderable ? (e) => onDragOverRow(index, e) : undefined}
      onDrop={reorderable ? (e) => onDropRow(index, e) : undefined}
      onDragEnd={reorderable ? onDragEndRow : undefined}
      onClick={(e) => {
        if (selectionMode) onToggleSelect(entry, index, e.shiftKey);
      }}
      onDoubleClick={() => {
        if (!selectionMode) onPlay(entry);
      }}
      onContextMenu={(event) => onContextMenu(entry, event)}
    >
      {selectionMode && (
        <TrackSelectCell
          selected={selected}
          label={displayText(entry.title, "track")}
          onToggle={(range) => onToggleSelect(entry, index, range)}
        />
      )}
      <TrackIndexCell
        index={index}
        isPlaying={isNow && isPlaying}
        onPlay={() => onPlay(entry)}
        playLabel={`Play ${entry.title}`}
      />
      <td className="col-art">
        <CoverArt
          className="mini-art"
          src={
            entry.album_id
              ? albumCoverUrl(entry.album_id)
              : coverUrl(entry.track_id)
          }
          seed={entry.album_id ?? entry.track_id}
          label={entry.album_title || entry.title}
        />
      </td>
      <td
        onClick={() => {
          if (!selectionMode) onPlay(entry);
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
          <FavoriteButton
            fav={fav}
            onToggle={() => onToggleFav(entry.track_id)}
          />
          {canEdit && (
            <button
              type="button"
              aria-label="Remove from playlist"
              onClick={(e) => {
                e.stopPropagation();
                onRemove(entry.position);
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
