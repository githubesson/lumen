import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { SquarePen as PencilSquareIcon } from "lucide-react";
import { trackCoverUrl, type TrackListItem } from "../api";
import { displayText, fmtDurationMs } from "../lib/format";
import { isLocalTrack } from "../lib/track";
import { trackActions } from "@music-library/core/track";
import CoverArt from "./CoverArt";
import { EditTrackDialog } from "./edit/EditTrackDialog";
import { MoveToAlbumDialog } from "./edit/MoveToAlbumDialog";
import Tooltip from "./Tooltip";
import { useTrackContextMenu } from "../lib/useTrackContextMenu";
import { useAuth } from "../context/Auth";
import { useTrackInfo } from "../context/TrackInfo";
import { useFavorites } from "../context/Favorites";
import { usePlayer, usePlayerControls } from "../context/Player";
import { usePlayFromList } from "@music-library/core/player/play-list";
import { useTrackSelection } from "../lib/useTrackSelection";
import { useWindowedSlice } from "../lib/useWindowedSlice";
import {
  FavoriteButton,
  SelectAllHeaderCell,
  TrackIndexCell,
  TrackSelectCell,
} from "./TrackRowCells";
import TrackSelectionToolbar from "./TrackSelectionToolbar";

interface Props {
  tracks: TrackListItem[];
  emptyState?: ReactNode;
  queueSource?: TrackListItem[];
  showCover?: boolean;
  showAlbum?: boolean;
  /** Column header row. Short curated lists (an artist's popular tracks) omit it. */
  showHeader?: boolean;
  /** Selection toolbar ("Select" / export). */
  selectable?: boolean;
  /** Per-row source badge; redundant when the whole page is one source. */
  showSourceBadge?: boolean;
  /** Optional column inserted between Album and Time. Used by /replay to show plays. */
  extraColumn?: {
    header: string;
    render: (t: TrackListItem) => ReactNode;
    className?: string;
  };
  selectionControlsHostId?: string;
}

const trackId = (track: TrackListItem) => track.id;
const exportTracks = (tracks: TrackListItem[]) => tracks;

export default function TrackList({
  tracks,
  emptyState,
  queueSource,
  showCover = true,
  showAlbum = true,
  showHeader = true,
  selectable = true,
  showSourceBadge = true,
  extraColumn,
  selectionControlsHostId,
}: Props) {
  const { current, isPlaying } = usePlayer();
  const { play } = usePlayerControls();
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
    getId: trackId,
    toExportItems: exportTracks,
    disabled: !selectable,
  });

  const selectedLocalTracks = useMemo(
    () => selectedTracks.filter(isLocalTrack),
    [selectedTracks],
  );

  // Stable action callbacks: each takes the track (or id) at event time,
  // instead of closing over a new function per row on every parent render.
  // The queue is read at event time too, so pagination doesn't invalidate
  // React.memo on every page.
  const { playTrack: handlePlay, getQueue } = usePlayFromList(
    play,
    queueSource ?? tracks,
  );
  const handleToggleFav = useCallback(
    (id: string) => void toggle(id),
    [toggle],
  );
  const handleExportSelected = useCallback(() => {
    void exportSelected();
  }, [exportSelected]);
  const handleContextMenu = useCallback(
    (
      t: TrackListItem,
      e: { preventDefault: () => void; clientX: number; clientY: number },
    ) => {
      const actions = trackActions(t, { isAdmin });
      // onInfo is wired by default via TrackInfoProvider; the bind() helper
      // falls back to the app-wide dialog when we don't override it here.
      bind(t, {
        queue: getQueue(),
        onEdit: actions.editMetadata ? () => setEditId(t.id) : undefined,
        onMoveToAlbum: actions.moveToAlbum ? () => setMoveTrack(t) : undefined,
      })(e);
    },
    [bind, getQueue, isAdmin],
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
  // The select column is always rendered (collapsed to zero width when
  // selection mode is off), so it counts unconditionally.
  const columnCount =
    5 +
    (showCover ? 1 : 0) +
    (showAlbum ? 1 : 0) +
    (extraColumn ? 1 : 0);
  const visible = tracks.slice(start, end);
  return (
    <>
      {selectable && (
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
      )}
      <div className="table-scroll" data-horizontal-scroll="">
        <div className="table-scroll-inner">
          <table
            className={`table table-tracks${selectionMode ? " table-selecting" : ""}${showHeader ? "" : " table-headless"}`}
            ref={tableRef}
          >
            {/* A headless table keeps its <thead> for fixed-layout column
                widths; the class hides the row. */}
            <thead>
              <tr>
                <SelectAllHeaderCell
                  hidden={!selectionMode}
                  allSelected={allSelected}
                  someSelected={someSelected}
                  onToggle={selectAll}
                />
                <th className="col-idx">#</th>
                {showCover && <th className="col-art" aria-label="Cover" />}
                <th>Title</th>
                {showAlbum && <th className="col-album">Album</th>}
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
                  showSourceBadge={showSourceBadge}
                  renderExtra={extraColumn?.render}
                  extraClassName={extraColumn?.className}
                  isNow={current?.id === t.id}
                  isPlaying={isPlaying && current?.id === t.id}
                  fav={isFavorite(t.id)}
                  canEdit={trackActions(t, { isAdmin }).editMetadata}
                  selectionMode={selectionMode}
                  selected={selectedIds.has(t.id)}
                  onPlay={handlePlay}
                  onToggleSelect={toggleSelection}
                  onToggleFav={handleToggleFav}
                  onEdit={isAdmin ? setEditId : undefined}
                  onContextMenu={handleContextMenu}
                />
              ))}
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
  showSourceBadge: boolean;
  renderExtra?: (track: TrackListItem) => ReactNode;
  extraClassName?: string;
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
  showSourceBadge,
  renderExtra,
  extraClassName,
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
  const akaParts = useMemo(
    () => (track.aka ? track.aka.split(" • ") : null),
    [track.aka],
  );
  const trackInfo = useTrackInfo();

  return (
    <tr
      className={
        `${isNow ? "playing" : ""}${selected ? " selected" : ""}`.trim() ||
        undefined
      }
      aria-selected={selectionMode ? selected : undefined}
      aria-disabled={track.unavailable || undefined}
      style={track.unavailable ? { opacity: 0.45 } : undefined}
      title={track.unavailable ? "No longer on TIDAL" : undefined}
      onClick={(e) => {
        if (!selectionMode) return;
        onToggleSelect(track, index, e.shiftKey);
      }}
      onDoubleClick={() => {
        if (!selectionMode) onPlay(track);
      }}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && e.key === "Enter" && !selectionMode) {
          e.preventDefault();
          onPlay(track);
        }
      }}
      onContextMenu={(e) => onContextMenu(track, e)}
    >
      <TrackSelectCell
        hidden={!selectionMode}
        selected={selected}
        label={displayText(track.title, "track")}
        onToggle={(range) => onToggleSelect(track, index, range)}
      />
      <TrackIndexCell index={index} isPlaying={isNow && isPlaying} onPlay={() => onPlay(track)} playLabel={`Play ${track.title}`} />
      {showCover && (
        <td className="col-art">
          <CoverArt
            className="mini-art"
            src={trackCoverUrl(track, 64)}
            label={track.album_title || track.title}
          />
        </td>
      )}
      <td
        onClick={() => {
          if (!selectionMode) onPlay(track);
        }}
      >
        <div className="track-title" title={displayText(track.title)}>
          {displayText(track.title)}
          {showSourceBadge && track.source === "tidal" && (
            <span className="badge" style={{ marginLeft: 8 }}>
              {track.unavailable ? "Removed from TIDAL" : "TIDAL"}
            </span>
          )}
          {akaParts && (
            <Tooltip
              content={
                <div style={{ display: "grid", gap: 2 }}>
                  <div className="eyebrow">
                    Also known as
                  </div>
                  {akaParts.map((t) => (
                    <div key={t}>{t}</div>
                  ))}
                  {trackInfo && (
                    <div className="track-aka-tip-hint">Click to compare versions</div>
                  )}
                </div>
              }
            >
              <button
                type="button"
                className="track-aka-hint"
                aria-label={`Compare versions, also known as ${track.aka}`}
                onClick={(e) => {
                  e.stopPropagation();
                  trackInfo?.open(track.id);
                }}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                (+{akaParts.length})
              </button>
            </Tooltip>
          )}
        </div>
        <div className="track-sub" title={displayText(track.artist, "Unknown artist")}>
          {displayText(track.artist, "Unknown artist")}
        </div>
      </td>
      {showAlbum && (
        <td
          className="col-album mono"
          title={track.album_title ? displayText(track.album_title) : undefined}
          style={{ color: "var(--muted-foreground)", fontSize: 12 }}
        >
          {track.album_title ? displayText(track.album_title) : "—"}
        </td>
      )}
      {renderExtra && (
        <td className={extraClassName ?? "col-extra"}>{renderExtra(track)}</td>
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
          <FavoriteButton fav={fav} onToggle={() => onToggleFav(track.id)} />
        </div>
      </td>
    </tr>
  );
});
