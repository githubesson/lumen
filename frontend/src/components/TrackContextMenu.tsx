import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import {
  Download as ArrowDownTrayIcon,
  Check as CheckIcon,
  Heart as HeartIcon,
  Info as InformationCircleIcon,
  SquarePen as PencilSquareIcon,
  Play as PlayIcon,
  Plus as PlusIcon,
  ListPlus as RectangleStackIcon,
  Share2 as ShareIcon,
  Trash2 as TrashIcon,
} from "lucide-react";
import {
  api,
  errorMessage,
  type Playlist,
  type TrackListItem,
} from "../api";
import { canAddToPlaylist } from "@music-library/core/playlist-permissions";
import { prepareTrackDownload } from "@music-library/core/audio-format";
import { resolveTrackAlbumTarget } from "@music-library/core/entity-target";
import { deleteOwnUploadMessage, trackActions } from "@music-library/core/track";
import { libraryChanged } from "../lib/events";
import { triggerDownload } from "../lib/download";
import { useDismiss } from "../lib/useDismiss";
import { useAuth } from "../context/Auth";
import { useFavorites } from "../context/Favorites";
import { usePlayerControls } from "../context/Player";
import { usePlaylists } from "../context/Playlists";

interface Props {
  /** Track the menu acts on. */
  track: TrackListItem;
  /** Viewport coords of the original right-click. */
  x: number;
  y: number;
  /** Queue source for Play — the list the row belonged to. Falls back to [track]. */
  queue?: TrackListItem[];
  /** Replaces Play's `play(track, queue)`, for rows that know their exact
   *  queue position (the same track can be queued twice). */
  onPlay?: () => void;
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
  onPlay,
  onEdit,
  onMoveToAlbum,
  onInfo,
  onShare,
  onClose,
}: Props) {
  const { play } = usePlayerControls();
  const navigate = useNavigate();
  const { isFavorite, toggle: toggleFav } = useFavorites();
  const { me } = useAuth();
  const isAdmin = me?.role === "admin";
  const actions = trackActions(track, { isAdmin });
  const fav = isFavorite(track.id);

  const ref = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState({ x, y });

  const {
    data: playlists,
    error: playlistsError,
    loading: playlistsLoading,
    reload: reloadPlaylists,
  } = usePlaylists();
  const playlistsChanged = useRef(false);
  const menuClosed = useRef(false);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set());
  const [downloading, setDownloading] = useState(false);
  const [viewingAlbum, setViewingAlbum] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Another client may have changed the playlists since the shell loaded
  // them, so revalidate on open. The add buttons wait for a successful fresh
  // read: a row can't move under the cursor when it arrives, and after a
  // failed read (or during a retry) the stale rows can't be acted on.
  const [playlistsFresh, setPlaylistsFresh] = useState(false);
  useEffect(() => {
    let active = true;
    void reloadPlaylists().then(() => {
      if (active) setPlaylistsFresh(true);
    });
    return () => {
      active = false;
    };
  }, [reloadPlaylists]);

  const canAddToPlaylists = playlistsFresh && !playlistsLoading && !playlistsError;

  // Adding tracks changes the server's playlist order. Refresh after closing
  // so a second click cannot land on a different playlist under the cursor.
  useEffect(() => {
    menuClosed.current = false;
    return () => {
      menuClosed.current = true;
      if (playlistsChanged.current) {
        playlistsChanged.current = false;
        void reloadPlaylists();
      }
    };
  }, [reloadPlaylists]);

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
    () => (playlists ?? []).filter(canAddToPlaylist),
    [playlists],
  );

  const runPlay = () => {
    // Dropped from TIDAL with no library copy: nothing to stream.
    if (onPlay) onPlay();
    else if (actions.play) {
      play(track, queue && queue.length > 0 ? queue : [track]);
    }
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
      // An add can finish after Escape, an outside click, or navigation.
      if (menuClosed.current) {
        void reloadPlaylists();
        return;
      }
      playlistsChanged.current = true;
      setAddedIds((prev) => new Set(prev).add(p.id));
    } catch (err) {
      setError(errorMessage(err, "Add failed."));
    } finally {
      setAddingId(null);
    }
  };

  const runDownload = async () => {
    if (downloading || !actions.download) return;
    setDownloading(true);
    setError(null);
    try {
      const { detail, ext } = await prepareTrackDownload(track);
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

  const runViewAlbum = async () => {
    if (viewingAlbum) return;
    setViewingAlbum(true);
    setError(null);
    try {
      const target = await resolveTrackAlbumTarget(track);
      if (target) {
        const param = target.kind === "tidal" ? "tidalAlbum" : "album";
        navigate(`/library?view=albums&${param}=${encodeURIComponent(target.id)}`);
        onClose();
        return;
      }
      setError("No album found for this track.");
      setViewingAlbum(false);
    } catch (err) {
      setError(errorMessage(err, "Album lookup failed."));
      setViewingAlbum(false);
    }
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
    confirmDelete(deleteOwnUploadMessage(track), () => api.deleteTrack(track.id));

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
      style={{
        top: coords.y,
        left: coords.x,
        // Scale out of the pointer. `coords` is the menu's clamped top-left,
        // so the origin is the cursor's offset inside the menu box — 0 0 in
        // the common case, non-zero when the menu was flipped or clamped
        // against a viewport edge.
        ["--ctx-origin-x" as string]: `${x - coords.x}px`,
        ["--ctx-origin-y" as string]: `${y - coords.y}px`,
      }}
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
        disabled={!actions.play}
        title={actions.play ? undefined : "No longer on TIDAL"}
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
      {actions.viewAlbum && (
        <button
          type="button"
          role="menuitem"
          className="ctx-item"
          onClick={() => void runViewAlbum()}
          disabled={viewingAlbum}
        >
          <RectangleStackIcon className="size-3.5" />
          <span>{viewingAlbum ? "Opening album..." : "View album"}</span>
        </button>
      )}
      {onShare && actions.share && (
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
        disabled={downloading || !actions.download}
        title={actions.download ? undefined : "No longer on TIDAL"}
      >
        <ArrowDownTrayIcon className="size-3.5" />
        <span>{downloading ? "Preparing download..." : "Download file"}</span>
      </button>
      {actions.editMetadata && onEdit && (
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
      {actions.moveToAlbum && onMoveToAlbum && (
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
      {actions.deleteOwnUpload && (
        <button
          type="button"
          role="menuitem"
          className="ctx-item"
          onClick={() => void runDelete()}
          disabled={deleting}
        >
          <TrashIcon
            className="size-3.5"
            style={{ color: "var(--destructive)" }}
          />
          <span style={{ color: "var(--destructive)" }}>
            {deleting ? "Deleting…" : "Delete from my library"}
          </span>
        </button>
      )}
      {actions.adminRemove && (
        <button
          type="button"
          role="menuitem"
          className="ctx-item"
          onClick={() => void runAdminDelete()}
          disabled={deleting}
        >
          <TrashIcon
            className="size-3.5"
            style={{ color: "var(--destructive)" }}
          />
          <span style={{ color: "var(--destructive)" }}>
            {deleting ? "Removing…" : "Remove from library"}
          </span>
        </button>
      )}

      <div className="ctx-sep" />

      <div className="ctx-heading">Add to playlist</div>
      {playlists === null && !playlistsError && <div className="ctx-hint">Loading…</div>}
      {playlistsError && (
        <>
          <div className="ctx-hint" role="alert">{playlistsError}</div>
          <button type="button" role="menuitem" className="ctx-item" onClick={() => void reloadPlaylists()}>
            Retry playlists
          </button>
        </>
      )}
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
                disabled={busy || added || !canAddToPlaylists}
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
                  <span className="mono" style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
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
          style={{ color: "var(--destructive)" }}
          role="alert"
        >
          {error}
        </div>
      )}
    </div>,
    document.body,
  );
}


export { useTrackContextMenu, useContextMenuClickGuard } from "../lib/useTrackContextMenu";
