import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowDownTrayIcon,
  CheckIcon,
  HeartIcon,
  InformationCircleIcon,
  PencilSquareIcon,
  PlayIcon,
  PlusIcon,
  RectangleStackIcon,
  ShareIcon,
  TrashIcon,
} from "@heroicons/react/16/solid";
import {
  api,
  errorMessage,
  type Playlist,
  type TrackDetail,
  type TrackListItem,
} from "../api";
import { libraryChanged } from "../lib/events";
import {
  extensionForFormat,
  extensionFromStream,
  triggerDownload,
} from "../lib/download";
import { useDismiss } from "../lib/useDismiss";
import { useAuth } from "../context/Auth";
import { useFavorites } from "../context/Favorites";
import { usePlayer } from "../context/Player";
import { useShare } from "../context/Share";
import { useTrackInfo } from "../context/TrackInfo";

interface Props {
  /** Track the menu acts on. */
  track: TrackListItem;
  /** Viewport coords of the original right-click. */
  x: number;
  y: number;
  /** Queue source for Play — the list the row belonged to. Falls back to [track]. */
  queue?: TrackListItem[];
  /** Trigger the track-edit dialog. Optional — admins only. */
  onEdit?: () => void;
  /** Trigger the move-to-album dialog. Optional — admins only. */
  onMoveToAlbum?: () => void;
  /** Trigger the read-only track-info dialog. */
  onInfo?: () => void;
  /** Trigger the share dialog (pick snippet + copy Discord-embeddable link). */
  onShare?: () => void;
  onClose: () => void;
}

/**
 * Right-click menu for a track row. Handles play, favorite toggle, add-to-
 * playlist (with inline picker), and edit-metadata for admins. Positions
 * itself at the click coords, flipping at viewport edges so the full menu
 * is always visible.
 */
export default function TrackContextMenu({
  track,
  x,
  y,
  queue,
  onEdit,
  onMoveToAlbum,
  onInfo,
  onShare,
  onClose,
}: Props) {
  const { play } = usePlayer();
  const { isFavorite, toggle: toggleFav } = useFavorites();
  const { me } = useAuth();
  const isAdmin = me?.role === "admin";
  const fav = isFavorite(track.id);

  const ref = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState({ x, y });

  const [playlists, setPlaylists] = useState<Playlist[] | null>(null);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set());
  const [downloading, setDownloading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load playlists once on mount. Viewers can't really "add to" other
  // people's playlists, but the API enforces that — we list whatever
  // listPlaylists returns.
  useEffect(() => {
    let cancelled = false;
    api
      .listPlaylists()
      .then((p) => {
        if (!cancelled) setPlaylists(p ?? []);
      })
      .catch(() => {
        if (!cancelled) setPlaylists([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Close on outside click or Escape.
  useDismiss(ref, { onDismiss: onClose });

  // Flip away from the right/bottom viewport edges after the menu measures itself.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    let nx = x;
    let ny = y;
    if (x + rect.width + pad > window.innerWidth) nx = window.innerWidth - rect.width - pad;
    if (y + rect.height + pad > window.innerHeight) ny = window.innerHeight - rect.height - pad;
    if (nx < pad) nx = pad;
    if (ny < pad) ny = pad;
    if (nx !== coords.x || ny !== coords.y) setCoords({ x: nx, y: ny });
  }, [x, y, playlists, coords.x, coords.y]);

  const editablePlaylists = useMemo(
    () =>
      (playlists ?? []).filter(
        (p) => p.effective_role === "owner" || p.effective_role === "editor",
      ),
    [playlists],
  );

  const runPlay = () => {
    play(track, queue && queue.length > 0 ? queue : [track]);
    onClose();
  };

  const runFav = async () => {
    await toggleFav(track.id);
    onClose();
  };

  const runAddToPlaylist = async (p: Playlist) => {
    if (addingId) return;
    setAddingId(p.id);
    setError(null);
    try {
      await api.addPlaylistTracks(p.id, [track.id]);
      setAddedIds((prev) => new Set(prev).add(p.id));
    } catch (err) {
      setError(errorMessage(err, "Add failed."));
    } finally {
      setAddingId(null);
    }
  };

  const runDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    setError(null);
    try {
      let detail: TrackDetail | null = null;
      try {
        detail = await api.getTrack(track.id);
      } catch {
        // The stream URL is enough; detail just gives the download a nicer name.
      }
      const ext = extensionForFormat(detail?.format) ?? await extensionFromStream(track.id);
      triggerDownload(track, detail, ext);
      onClose();
    } catch (err) {
      setError(errorMessage(err, "Download failed."));
      setDownloading(false);
    }
  };

  const runEdit = () => {
    onEdit?.();
    onClose();
  };

  const runMoveToAlbum = () => {
    onMoveToAlbum?.();
    onClose();
  };

  const runInfo = () => {
    onInfo?.();
    onClose();
  };

  const runShare = () => {
    onShare?.();
    onClose();
  };

  // Shared confirm + hard-delete flow. Both deletes are irreversible (server
  // drops the DB row and unlinks the file), so confirm before firing.
  const confirmDelete = async (message: string, del: () => Promise<void>) => {
    if (deleting) return;
    if (!window.confirm(message)) return;
    setDeleting(true);
    setError(null);
    try {
      await del();
      libraryChanged.emit();
      onClose();
    } catch (err) {
      setError(errorMessage(err, "Delete failed."));
      setDeleting(false);
    }
  };

  // Personal uploads only (track.owned): removes the DB row and the file the
  // user uploaded.
  const runDelete = () =>
    confirmDelete(
      `Delete "${track.title}" from your library? This permanently removes the file you uploaded.`,
      () => api.deleteTrack(track.id),
    );

  // Admin-only, for global (shared-library) tracks: unlinks the file(s) from
  // disk so a rescan won't re-add it — removes the song for everyone.
  const runAdminDelete = () =>
    confirmDelete(
      `Remove "${track.title}" from the shared library? This permanently deletes the file from the server for everyone.`,
      () => api.deleteGlobalTrack(track.id),
    );

  return createPortal(
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      style={{ top: coords.y, left: coords.x }}
      onContextMenu={(e) => e.preventDefault()}
      // Prevent cmdk / Radix from treating clicks on menu items as "outside"
      // events and dismissing parent dialogs before onClick fires. Stop at
      // both the React synthetic level and the underlying native event so
      // document-level bubble listeners (like Radix's dismissable layer)
      // never get a chance to run.
      onPointerDown={(e) => {
        e.stopPropagation();
        e.nativeEvent.stopImmediatePropagation();
      }}
      onMouseDown={(e) => {
        e.stopPropagation();
        e.nativeEvent.stopImmediatePropagation();
      }}
    >
      <button
        type="button"
        role="menuitem"
        className="ctx-item"
        onClick={runPlay}
      >
        <PlayIcon className="size-3.5" />
        <span>Play</span>
      </button>
      <button
        type="button"
        role="menuitem"
        className={"ctx-item" + (fav ? " ctx-item-active" : "")}
        onClick={runFav}
      >
        <HeartIcon className="size-3.5" />
        <span>{fav ? "Remove from favorites" : "Add to favorites"}</span>
      </button>
      {onInfo && (
        <button
          type="button"
          role="menuitem"
          className="ctx-item"
          onClick={runInfo}
        >
          <InformationCircleIcon className="size-3.5" />
          <span>Song info</span>
        </button>
      )}
      {onShare && (
        <button
          type="button"
          role="menuitem"
          className="ctx-item"
          onClick={runShare}
        >
          <ShareIcon className="size-3.5" />
          <span>Share…</span>
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        className="ctx-item"
        onClick={() => void runDownload()}
        disabled={downloading}
      >
        <ArrowDownTrayIcon className="size-3.5" />
        <span>{downloading ? "Preparing download..." : "Download file"}</span>
      </button>
      {isAdmin && onEdit && (
        <button
          type="button"
          role="menuitem"
          className="ctx-item"
          onClick={runEdit}
        >
          <PencilSquareIcon className="size-3.5" />
          <span>Edit metadata</span>
        </button>
      )}
      {isAdmin && onMoveToAlbum && (
        <button
          type="button"
          role="menuitem"
          className="ctx-item"
          onClick={runMoveToAlbum}
        >
          <RectangleStackIcon className="size-3.5" />
          <span>Move to album…</span>
        </button>
      )}
      {track.owned && (
        <button
          type="button"
          role="menuitem"
          className="ctx-item"
          onClick={() => void runDelete()}
          disabled={deleting}
        >
          <TrashIcon
            className="size-3.5"
            style={{ color: "var(--danger-fg)" }}
          />
          <span style={{ color: "var(--danger-fg)" }}>
            {deleting ? "Deleting…" : "Delete from my library"}
          </span>
        </button>
      )}
      {isAdmin && !track.owned && (
        <button
          type="button"
          role="menuitem"
          className="ctx-item"
          onClick={() => void runAdminDelete()}
          disabled={deleting}
        >
          <TrashIcon
            className="size-3.5"
            style={{ color: "var(--danger-fg)" }}
          />
          <span style={{ color: "var(--danger-fg)" }}>
            {deleting ? "Removing…" : "Remove from library"}
          </span>
        </button>
      )}

      <div className="ctx-sep" />

      <div className="ctx-heading">Add to playlist</div>
      {playlists === null && <div className="ctx-hint">Loading…</div>}
      {playlists !== null && editablePlaylists.length === 0 && (
        <div className="ctx-hint">No playlists you can edit.</div>
      )}
      {editablePlaylists.length > 0 && (
        <div className="ctx-scroll">
          {editablePlaylists.map((p) => {
            const added = addedIds.has(p.id);
            const busy = addingId === p.id;
            return (
              <button
                key={p.id}
                type="button"
                role="menuitem"
                className="ctx-item"
                onClick={() => void runAddToPlaylist(p)}
                disabled={busy || added}
              >
                {added ? (
                  <CheckIcon className="size-3.5" />
                ) : (
                  <PlusIcon className="size-3.5" />
                )}
                <span
                  style={{
                    flex: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {p.name}
                </span>
                {busy && (
                  <span className="mono" style={{ fontSize: 10, color: "var(--fg-subtle)" }}>
                    …
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
      {error && (
        <div
          className="ctx-hint"
          style={{ color: "var(--danger-fg)" }}
          role="alert"
        >
          {error}
        </div>
      )}
    </div>,
    document.body,
  );
}

/**
 * Convenience hook that packages up the state + event handlers for binding
 * a right-click menu to any element that renders a track. Returns:
 *
 *   - `bind(track, { queue?, onEdit? })` — spread the return value onto the
 *     element's `onContextMenu` to open the menu.
 *   - `menu` — the JSX to render inside the component tree (it portals
 *     itself, so placement doesn't matter).
 *
 * Usage:
 *   const { bind, menu } = useTrackContextMenu();
 *   <div onContextMenu={bind(track, { queue })}>…</div>
 *   {menu}
 */
export function useTrackContextMenu() {
  const [state, setState] = useState<{
    track: TrackListItem;
    x: number;
    y: number;
    queue?: TrackListItem[];
    onEdit?: () => void;
    onMoveToAlbum?: () => void;
    onInfo?: () => void;
    onShare?: () => void;
  } | null>(null);

  // Default onInfo wiring: every right-click menu gets "Song info" as long
  // as a TrackInfoProvider is mounted (it is in main.tsx). Callers can still
  // override per-call via opts.onInfo — useful if a specific surface wants
  // a different dialog or a no-op.
  const trackInfo = useTrackInfo();
  const share = useShare();

  const bind = useCallback(
    (
      track: TrackListItem,
      opts: {
        queue?: TrackListItem[];
        onEdit?: () => void;
        onMoveToAlbum?: () => void;
        onInfo?: () => void;
        onShare?: () => void;
      } = {},
    ) =>
      (e: { preventDefault: () => void; clientX: number; clientY: number }) => {
        e.preventDefault();
        setState({
          track,
          x: e.clientX,
          y: e.clientY,
          queue: opts.queue,
          onEdit: opts.onEdit,
          onMoveToAlbum: opts.onMoveToAlbum,
          onInfo:
            opts.onInfo ??
            (trackInfo ? () => trackInfo.open(track.id) : undefined),
          onShare:
            opts.onShare ??
            (share ? () => share.open(track.id) : undefined),
        });
      },
    [trackInfo, share],
  );

  const close = useCallback(() => setState(null), []);

  const menu = state ? (
    <TrackContextMenu
      track={state.track}
      x={state.x}
      y={state.y}
      queue={state.queue}
      onEdit={state.onEdit}
      onMoveToAlbum={state.onMoveToAlbum}
      onInfo={state.onInfo}
      onShare={state.onShare}
      onClose={close}
    />
  ) : null;

  return { bind, menu, close, isOpen: state !== null };
}

