import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowDownTrayIcon,
  CheckIcon,
  HeartIcon,
  PencilSquareIcon,
  XMarkIcon,
} from "@heroicons/react/16/solid";
import { trackCoverUrl, type TrackListItem } from "../api";
import { displayText, fmtDurationMs } from "../lib/format";
import CoverArt from "./CoverArt";
import { EditTrackDialog, MoveToAlbumDialog } from "./EditDialog";
import Tooltip from "./Tooltip";
import { useTrackContextMenu } from "./TrackContextMenu";
import { useAuth } from "../context/Auth";
import { useFavorites } from "../context/Favorites";
import { usePlayer } from "../context/Player";
import { exportTracksAsFiles } from "../lib/download";
import { useKey } from "../lib/keybindings";
import { usePopKey } from "../lib/useTransitionMount";
import { useWindowedSlice } from "../lib/useWindowedSlice";

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
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const lastSelectedIndexRef = useRef<number | null>(null);
  const { bind, menu } = useTrackContextMenu();

  const tracksById = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks]);
  const selectedTracks = useMemo(
    () => tracks.filter((track) => selectedIds.has(track.id)),
    [tracks, selectedIds],
  );
  const selectedLocalTracks = useMemo(
    () => selectedTracks.filter(isLocalTrack),
    [selectedTracks],
  );
  const allSelected = tracks.length > 0 && selectedIds.size === tracks.length;
  const someSelected = selectedIds.size > 0;

  useEffect(() => {
    setSelectedIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (tracksById.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [tracksById]);

  useEffect(() => {
    if (selectedIds.size === 0) lastSelectedIndexRef.current = null;
  }, [selectedIds.size]);

  useKey(
    "v",
    (e) => {
      e.preventDefault();
      setSelectionMode((value) => !value);
      setExportNotice(null);
    },
    { id: "tracks:selection-mode", label: "Toggle track selection", group: "Selection" },
  );

  useKey(
    "esc",
    (e) => {
      e.preventDefault();
      setSelectionMode(false);
      setSelectedIds(new Set());
      setExportNotice(null);
    },
    {
      id: "tracks:selection-clear",
      label: "Clear track selection",
      group: "Selection",
      enabled: selectionMode,
      priority: 5,
    },
  );

  useKey(
    "mod+a",
    (e) => {
      e.preventDefault();
      setSelectedIds(new Set(tracks.map((track) => track.id)));
      setSelectionMode(true);
      setExportNotice(null);
    },
    {
      id: "tracks:selection-all",
      label: "Select all tracks",
      group: "Selection",
      enabled: selectionMode,
    },
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
      setSelectionMode(true);
      setExportNotice(null);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (range && lastSelectedIndexRef.current !== null) {
          const from = Math.min(lastSelectedIndexRef.current, index);
          const to = Math.max(lastSelectedIndexRef.current, index);
          for (let pos = from; pos <= to; pos += 1) {
            const rangeTrack = tracks[pos];
            if (rangeTrack) next.add(rangeTrack.id);
          }
        } else if (next.has(track.id)) {
          next.delete(track.id);
        } else {
          next.add(track.id);
        }
        return next;
      });
      lastSelectedIndexRef.current = index;
    },
    [tracks],
  );
  const handleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      if (tracks.length > 0 && prev.size === tracks.length) return new Set();
      return new Set(tracks.map((track) => track.id));
    });
    setSelectionMode(true);
    setExportNotice(null);
  }, [tracks]);
  const handleClearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setExportNotice(null);
  }, []);
  const handleExportSelected = useCallback(async () => {
    if (exporting || selectedLocalTracks.length === 0) return;
    setExporting(true);
    setExportNotice(null);
    try {
      const result = await exportTracksAsFiles(selectedTracks);
      if (result.canceled) {
        setExportNotice("Export canceled.");
        return;
      }
      const parts: string[] = [];
      if (result.failed > 0) parts.push(`${result.failed} failed`);
      if (result.skipped > 0) parts.push(`${result.skipped} streaming-only skipped`);
      const suffix = parts.length > 0 ? `, ${parts.join(", ")}` : "";
      setExportNotice(
        result.usedFolderPicker
          ? `Exported ${result.exported} file${result.exported === 1 ? "" : "s"}${suffix}.`
          : `Export started for ${result.exported} file${result.exported === 1 ? "" : "s"}${suffix}.`,
      );
    } catch (e) {
      setExportNotice((e as Error).message || "Export failed.");
    } finally {
      setExporting(false);
    }
  }, [exporting, selectedLocalTracks.length, selectedTracks]);
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
  const selectionControlsHost =
    selectionControlsHostId && typeof document !== "undefined"
      ? document.getElementById(selectionControlsHostId)
      : null;
  const selectionControls = (
    <div
      className={`track-selectbar${selectionControlsHost ? " track-selectbar-attached" : ""}`}
      data-selecting={selectionMode}
    >
      <div className="track-selectbar-status" aria-live="polite">
        {selectionMode
          ? `${selectedIds.size} selected`
          : `${tracks.length} track${tracks.length === 1 ? "" : "s"}`}
        {exportNotice && <span>{exportNotice}</span>}
      </div>
      {selectionMode ? (
        <>
          <button type="button" className="btn" onClick={handleSelectAll}>
            {allSelected ? "Deselect all" : "Select all"}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void handleExportSelected()}
            disabled={!someSelected || selectedLocalTracks.length === 0 || exporting}
            title={
              selectedLocalTracks.length === 0 && someSelected
                ? "Selected streaming tracks cannot be exported as files."
                : undefined
            }
          >
            <ArrowDownTrayIcon className="size-3.5" />
            {exporting ? "Exporting..." : "Export files"}
          </button>
          <button
            type="button"
            className="iconbtn track-selectbar-close"
            aria-label="Clear selection"
            onClick={() => {
              setSelectionMode(false);
              handleClearSelection();
            }}
          >
            <XMarkIcon className="size-4" />
          </button>
        </>
      ) : (
        <button
          type="button"
          className="btn"
          onClick={() => {
            setSelectionMode(true);
            setExportNotice(null);
          }}
        >
          <CheckIcon className="size-3.5" />
          Select
        </button>
      )}
    </div>
  );

  return (
    <>
      {selectionControlsHost
        ? createPortal(selectionControls, selectionControlsHost)
        : selectionControls}
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
                  onChange={handleSelectAll}
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

function TrackCheckbox({
  checked,
  indeterminate = false,
  ariaLabel,
  onChange,
}: {
  checked: boolean;
  indeterminate?: boolean;
  ariaLabel: string;
  onChange: (e: ReactMouseEvent<HTMLInputElement>) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <input
      ref={ref}
      type="checkbox"
      className="track-check"
      checked={checked}
      aria-label={ariaLabel}
      onClick={(e) => {
        e.stopPropagation();
        onChange(e);
      }}
      onChange={() => {}}
    />
  );
}

function isLocalTrack(track: TrackListItem): boolean {
  return !track.source || track.source === "local";
}
