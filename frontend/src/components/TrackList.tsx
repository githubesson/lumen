import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { HeartIcon, PencilSquareIcon } from "@heroicons/react/16/solid";
import { trackCoverUrl, type TrackListItem } from "../api";
import { displayText, fmtDurationMs } from "../lib/format";
import CoverArt from "./CoverArt";
import { EditTrackDialog, MoveToAlbumDialog } from "./EditDialog";
import Tooltip from "./Tooltip";
import { useTrackContextMenu } from "./TrackContextMenu";
import { useAuth } from "../context/Auth";
import { useFavorites } from "../context/Favorites";
import { usePlayer } from "../context/Player";
import { usePopKey } from "../lib/useTransitionMount";
import { useTrackSelection } from "../lib/useTrackSelection";
import { useWindowedSlice } from "../lib/useWindowedSlice";
import TrackCheckbox from "./TrackCheckbox";
import TrackSelectionToolbar from "./TrackSelectionToolbar";

interface Props {
  tracks: TrackListItem[];
  emptyState?: ReactNode;
  queueSource?: TrackListItem[];
  showCover?: boolean;
  showAlbum?: boolean;
  /** Optional column inserted between Album and Time. Used by /replay to show plays. */
  extraColumn?: {
    header: string;
    render: (t: TrackListItem) => ReactNode;
    className?: string;
  };
  selectionControlsHostId?: string;
}

/** @deprecated import `fmtDurationMs` from `../lib/format` instead. */
export const fmtDuration = fmtDurationMs;

export default function TrackList({
  tracks,
  emptyState,
  queueSource,
  showCover = true,
  showAlbum = true,
  extraColumn,
  selectionControlsHostId,
}: Props) {
  const { play, current, isPlaying } = usePlayer();
  const { isFavorite, toggle } = useFavorites();
  const { me } = useAuth();
  const isAdmin = me?.role === "admin";
  const [editId, setEditId] = useState<string | null>(null);
  const [moveTrack, setMoveTrack] = useState<TrackListItem | null>(null);
  const { bind, menu } = useTrackContextMenu();

  const {
    selectionMode,
    setSelectionMode,
    selectedIds,
    selectedItems: selectedTracks,
    allSelected,
    someSelected,
    exporting,
    exportNotice,
    toggleSelection,
    selectAll,
    clearSelection,
    exportSelected,
  } = useTrackSelection<TrackListItem>({
    items: tracks,
    getId: (t) => t.id,
    toExportItems: (items) => items,
  });

  const selectedLocalTracks = useMemo(
    () => selectedTracks.filter(isLocalTrack),
    [selectedTracks],
  );

  // Queue reference held in a ref so stable per-track callbacks can read the
  // latest list without invalidating React.memo on every pagination page.
  const queue = queueSource ?? tracks;
  const queueRef = useRef(queue);
  queueRef.current = queue;

  // Stable action callbacks: each takes the track (or id) at event time,
  // instead of closing over a new function per row on every parent render.
  const handlePlay = useCallback(
    (t: TrackListItem) => play(t, queueRef.current),
    [play],
  );
  const handleToggleFav = useCallback(
    (id: string) => void toggle(id),
    [toggle],
  );
  const handleEdit = useCallback((id: string) => setEditId(id), []);
  const handleToggleSelection = useCallback(
    (track: TrackListItem, index: number, range: boolean) => {
      toggleSelection(track, index, range);
    },
    [toggleSelection],
  );
  const handleExportSelected = useCallback(() => {
    void exportSelected();
  }, [exportSelected]);
  const handleContextMenu = useCallback(
    (
      t: TrackListItem,
      e: { preventDefault: () => void; clientX: number; clientY: number },
    ) => {
      const canModifyLocal = isAdmin && isLocalTrack(t);
      // onInfo is wired by default via TrackInfoProvider; the bind() helper
      // falls back to the app-wide dialog when we don't override it here.
      bind(t, {
        queue: queueRef.current,
        onEdit: canModifyLocal ? () => setEditId(t.id) : undefined,
        onMoveToAlbum: canModifyLocal ? () => setMoveTrack(t) : undefined,
      })(e);
    },
    [bind, isAdmin],
  );

  const tableRef = useRef<HTMLTableElement>(null);
  const { start, end, topSpacerPx, bottomSpacerPx } = useWindowedSlice(
    tableRef,
    tracks.length,
  );

  if (tracks.length === 0) {
    return <>{emptyState}</>;
  }

  // Column count kept in sync with the <thead> below — used for spacer
  // `colSpan` so the spacer row doesn't push the columns out of alignment.
  const columnCount =
    3 +
    (selectionMode ? 1 : 0) +
    (showCover ? 1 : 0) +
    (showAlbum ? 1 : 0) +
    (extraColumn ? 1 : 0);
  const visible = tracks.slice(start, end);
  return (
    <>
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
      <table
        className={`table${selectionMode ? " table-selecting" : ""}`}
        ref={tableRef}
      >
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
            {showCover && <th className="col-art" aria-label="Cover" />}
            <th>Title</th>
            {showAlbum && <th>Album</th>}
            {extraColumn && (
              <th className={extraColumn.className ?? "col-extra"}>
                {extraColumn.header}
              </th>
            )}
            <th className="col-dur">Time</th>
            <th className="col-acts" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {topSpacerPx > 0 && (
            <tr aria-hidden="true" className="vt-spacer">
              <td colSpan={columnCount} style={{ height: topSpacerPx }} />
            </tr>
          )}
          {visible.map((t, i) => (
            <TrackRow
              key={t.id}
              track={t}
              index={start + i}
              showCover={showCover}
              showAlbum={showAlbum}
              extra={
                extraColumn
                  ? {
                      content: extraColumn.render(t),
                      className: extraColumn.className,
                    }
                  : undefined
              }
              isNow={current?.id === t.id}
              isPlaying={isPlaying && current?.id === t.id}
              fav={isFavorite(t.id)}
              canEdit={isAdmin && isLocalTrack(t)}
              selectionMode={selectionMode}
              selected={selectedIds.has(t.id)}
              onPlay={handlePlay}
              onToggleSelect={handleToggleSelection}
              onToggleFav={handleToggleFav}
              onEdit={isAdmin ? handleEdit : undefined}
              onContextMenu={handleContextMenu}
            />
          ))}
          {bottomSpacerPx > 0 && (
            <tr aria-hidden="true" className="vt-spacer">
              <td colSpan={columnCount} style={{ height: bottomSpacerPx }} />
            </tr>
          )}
        </tbody>
      </table>
      <EditTrackDialog
        open={editId !== null}
        trackId={editId}
        onClose={() => setEditId(null)}
      />
      <MoveToAlbumDialog
        open={moveTrack !== null}
        track={moveTrack}
        onClose={() => setMoveTrack(null)}
      />
      {menu}
    </>
  );
}

interface TrackRowProps {
  track: TrackListItem;
  index: number;
  showCover: boolean;
  showAlbum: boolean;
  extra?: { content: ReactNode; className?: string };
  isNow: boolean;
  isPlaying: boolean;
  fav: boolean;
  canEdit?: boolean;
  selectionMode: boolean;
  selected: boolean;
  onPlay: (t: TrackListItem) => void;
  onToggleSelect: (t: TrackListItem, index: number, range: boolean) => void;
  onToggleFav: (id: string) => void;
  onEdit?: (id: string) => void;
  onContextMenu: (
    t: TrackListItem,
    e: { preventDefault: () => void; clientX: number; clientY: number },
  ) => void;
}

// React.memo so a parent re-render (pagination, play/pause flip, favorite
// toggle on another row) doesn't cascade into every visible row. All props
// are either primitives, stable callbacks, or the `track` object itself
// (which only changes when the row's underlying data changes).
export const TrackRow = memo(function TrackRow({
  track,
  index,
  showCover,
  showAlbum,
  extra,
  isNow,
  isPlaying,
  fav,
  canEdit,
  selectionMode,
  selected,
  onPlay,
  onToggleSelect,
  onToggleFav,
  onEdit,
  onContextMenu,
}: TrackRowProps) {
  const popKey = usePopKey(fav);
  const akaParts = useMemo(
    () => (track.aka ? track.aka.split(" • ") : null),
    [track.aka],
  );

  return (
    <tr
      className={`${isNow ? "playing" : ""}${selected ? " selected" : ""}`.trim() || undefined}
      aria-selected={selectionMode ? selected : undefined}
      onClick={(e) => {
        if (!selectionMode) return;
        onToggleSelect(track, index, e.shiftKey);
      }}
      onDoubleClick={() => {
        if (!selectionMode) onPlay(track);
      }}
      onContextMenu={(e) => onContextMenu(track, e)}
    >
      {selectionMode && (
        <td className="col-select">
          <TrackCheckbox
            checked={selected}
            ariaLabel={`Select ${displayText(track.title, "track")}`}
            onChange={(e) => onToggleSelect(track, index, e.shiftKey)}
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
            <span className="idx-num">{String(index + 1).padStart(2, "0")}</span>
          )}
        </span>
      </td>
      {showCover && (
        <td className="col-art">
          <CoverArt
            className="mini-art"
            src={trackCoverUrl(track)}
            seed={track.album_id ?? track.id}
            label={track.album_title || track.title}
          />
        </td>
      )}
      <td
        onClick={() => {
          if (!selectionMode) onPlay(track);
        }}
      >
        <div className="track-title">
          {displayText(track.title)}
          {track.source === "tidal" && (
            <span className="badge" style={{ marginLeft: 8 }}>
              TIDAL
            </span>
          )}
          {akaParts && (
            <Tooltip
              content={
                <div style={{ display: "grid", gap: 2 }}>
                  <div
                    className="mono"
                    style={{
                      fontSize: 9,
                      letterSpacing: "0.12em",
                      textTransform: "uppercase",
                      color: "var(--fg-subtle)",
                    }}
                  >
                    Also known as
                  </div>
                  {akaParts.map((t) => (
                    <div key={t}>{t}</div>
                  ))}
                </div>
              }
            >
              <span
                className="track-aka-hint"
                aria-label={`also known as ${track.aka}`}
                onClick={(e) => e.stopPropagation()}
              >
                (+{akaParts.length})
              </span>
            </Tooltip>
          )}
        </div>
        <div className="track-sub">{displayText(track.artist, "Unknown artist")}</div>
      </td>
      {showAlbum && (
        <td className="mono" style={{ color: "var(--fg-subtle)", fontSize: 11 }}>
          {track.album_title ? displayText(track.album_title) : "—"}
        </td>
      )}
      {extra && (
        <td className={extra.className ?? "col-extra"}>{extra.content}</td>
      )}
      <td className="col-dur">{fmtDurationMs(track.duration_ms)}</td>
      <td className="col-acts">
        <div className="row-actions">
          {canEdit && onEdit && (
            <button
              type="button"
              aria-label="Edit metadata"
              onClick={(e) => {
                e.stopPropagation();
                onEdit(track.id);
              }}
            >
              <PencilSquareIcon className="size-3.5" />
            </button>
          )}
          <button
            type="button"
            className={fav ? "active" : undefined}
            aria-label={fav ? "Remove from favorites" : "Add to favorites"}
            aria-pressed={fav}
            onClick={(e) => {
              e.stopPropagation();
              onToggleFav(track.id);
            }}
          >
            <HeartIcon
              key={popKey}
              className={`size-3.5 ${popKey > 0 ? "motion-safe:animate-heart-pop" : ""}`}
            />
          </button>
        </div>
      </td>
    </tr>
  );
});

function isLocalTrack(track: TrackListItem): boolean {
  return !track.source || track.source === "local";
}
