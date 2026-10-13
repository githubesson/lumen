import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import {
  Download as ArrowDownTrayIcon,
  Check as CheckIcon,
  Disc3 as DiscIcon,
  FolderInput as FolderInputIcon,
  Heart as HeartIcon,
  Info as InformationCircleIcon,
  SquarePen as PencilSquareIcon,
  Play as PlayIcon,
  Plus as PlusIcon,
  Share2 as ShareIcon,
  Trash2 as TrashIcon,
} from "lucide-react";
import {
  api,
  errorMessage,
  playlistArtUrl,
  trackCoverUrl,
  type Playlist,
  type TrackListItem,
} from "../api";
import { canAddToPlaylist } from "@music-library/core/playlist-permissions";
import { prepareTrackDownload } from "@music-library/core/audio-format";
import { resolveTrackAlbumTarget } from "@music-library/core/entity-target";
import { startListPlayback } from "@music-library/core/player/play-list";
import { deleteOwnUploadMessage, trackActions } from "@music-library/core/track";
import CoverArt from "./CoverArt";
import { libraryChanged } from "../lib/events";
import { triggerDownload } from "../lib/download";
import { displayText } from "../lib/format";
import { useModalKeyScope } from "../lib/keybindings";
import { focusReturnTarget, menuItems, menuKeyTarget } from "../lib/menuKeyboard";
import { playableTracks } from "../lib/track";
import {
  addBatches,
  favoriteState,
  favoriteToggleIds,
  runLimited,
  selectionArtists,
  selectionCovers,
  uniqueTracks,
} from "../lib/trackMenu";
import { useDismiss } from "../lib/useDismiss";
import { useAuth } from "../context/Auth";
import { useFavorites } from "../context/Favorites";
import { usePlayer } from "../context/Player";
import { usePlaylists } from "../context/Playlists";

/** The list's selection, for a right-click on one of its rows. */
export interface TrackMenuSelection {
  /** The selected tracks, in list order. Two or more make it a selection menu. */
  tracks: TrackListItem[];
  /** Exports the selected files, as the selection toolbar's Export does. */
  onExport?: () => void;
  /** Why Export can't run, when it can't (nothing selected is a library file). */
  exportDisabledReason?: string;
}

interface Props {
  /** Track the menu acts on: the right-clicked one. */
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
  /** The element that was right-clicked, so focus can go back to it. */
  anchor?: Element | null;
  /** Opened from the keyboard (Menu key, Shift+F10) rather than the pointer. */
  byKeyboard?: boolean;
  /**
   * Set when the right-clicked row is part of a selection of two or more:
   * the menu then acts on every selected track and drops the one-track
   * actions.
   */
  selection?: TrackMenuSelection;
  onClose: () => void;
}

// Covers in the header are drawn at 40px or less; the rows already loaded
// this size, so it comes from the cache.
const THUMB_SIZE = 64;

/**
 * Right-click menu for a track row: a card naming the track, its everyday
 * actions as a row of labelled icons, album and info rows, one-click add to
 * any playlist you can edit, and admin edits in a quiet footer. Inside a
 * selection it acts on every selected track instead. Positions itself at the
 * click coords, flipping at viewport edges so the full menu is always
 * visible.
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
  anchor,
  byKeyboard = false,
  selection,
  onClose,
}: Props) {
  // Displayed state: `shuffle` is the controlled device's while casting.
  const { play, shuffle } = usePlayer();
  const navigate = useNavigate();
  const { isFavorite, toggle: toggleFav } = useFavorites();
  const { me } = useAuth();
  const isAdmin = me?.role === "admin";
  const actions = trackActions(track, { isAdmin });

  // Two or more selected tracks: every action applies to all of them.
  const many = useMemo(() => {
    const tracks = selection ? uniqueTracks(selection.tracks) : [];
    return tracks.length > 1 ? tracks : null;
  }, [selection]);
  const trackIds = useMemo(() => (many ?? [track]).map((t) => t.id), [many, track]);
  // The exact tracks, in order: what a batched add's progress is counted in.
  const trackIdsKey = useMemo(() => trackIds.join("\n"), [trackIds]);
  const playable = useMemo(() => (many ? playableTracks(many) : []), [many]);
  const canPlay = many ? playable.length > 0 : actions.play;
  const fav = many ? favoriteState(many, isFavorite) : isFavorite(track.id) ? "all" : "none";

  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const playlistsHeadingId = useId();
  const [coords, setCoords] = useState({ x, y });

  const {
    data: playlists,
    error: playlistsError,
    loading: playlistsLoading,
    reload: reloadPlaylists,
  } = usePlaylists();
  const playlistsChanged = useRef(false);
  const menuClosed = useRef(false);
  // How many of `trackIds` each playlist already took from this menu. A
  // selection goes in batches, and a retry after a failed one resumes there
  // instead of adding the earlier batches twice. The count is only good for
  // the same tracks in the same order, so it's kept with them: a different
  // set starts from its first track.
  const landed = useRef(new Map<string, { ids: string; count: number }>());
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

  // Page shortcuts pause while the menu is open, so Escape only closes it
  // (instead of also clearing the list's selection) and Space presses the
  // focused item instead of toggling playback.
  useModalKeyScope(true);

  // Focus the first item, as a native menu does, so the arrow keys work. On
  // close, focus goes back (see focusReturnTarget) unless the user already
  // moved it, by clicking elsewhere. A modal that opened the menu (the
  // command palette) traps focus and would pull it straight back, selecting
  // its search text, so it keeps focus.
  const firstItem = useRef<HTMLElement | null>(null);
  // Opened with the pointer, nothing is highlighted yet, as in a native
  // menu: the first item has focus but doesn't show it until a key moves.
  const [pointerOpen, setPointerOpen] = useState(!byKeyboard);
  useEffect(() => {
    const menu = ref.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!menu || opener?.closest('[aria-modal="true"], [cmdk-dialog]')) return;
    firstItem.current = menuItems(menu)[0] ?? null;
    (firstItem.current ?? menu).focus({ preventScroll: true });
    return () => {
      const active = document.activeElement;
      if (active && active !== document.body && !menu.contains(active)) return;
      focusReturnTarget(opener, anchor)?.focus({ preventScroll: true });
    };
  }, [anchor]);

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
  }, [x, y, playlists, error, coords.x, coords.y]);

  const editablePlaylists = useMemo(
    () => (playlists ?? []).filter(canAddToPlaylist),
    [playlists],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Tab leaves the menu: close it, and focus goes back.
    if (e.key === "Tab") {
      e.preventDefault();
      onClose();
      return;
    }
    const menu = ref.current;
    if (!menu) return;
    // With nothing highlighted yet, the first arrow key highlights the first
    // item (or Up the last) rather than moving past it.
    const active = pointerOpen && document.activeElement === firstItem.current
      ? null
      : document.activeElement;
    const next = menuKeyTarget(menu, active, e.key);
    if (!next) return;
    e.preventDefault();
    setPointerOpen(false);
    // Focusing it again makes the browser show keyboard focus on it.
    if (next === document.activeElement) next.blur();
    next.focus();
  };

  const runPlay = () => {
    // Dropped from TIDAL with no library copy: nothing to stream, so those
    // are left out. With shuffle on it starts at a random one.
    if (many) startListPlayback(play, many, shuffle);
    else if (onPlay) onPlay();
    else if (actions.play) {
      play(track, queue && queue.length > 0 ? queue : [track]);
    }
    onClose();
  };

  const runFav = async () => {
    if (!many) {
      await toggleFav(track.id);
      onClose();
      return;
    }
    // One request per track, a few at a time. The hearts in the list fill
    // as each lands, so the menu needn't wait.
    const ids = favoriteToggleIds(many, isFavorite);
    onClose();
    await runLimited(ids, 4, toggleFav);
  };

  const runExport = () => {
    onClose();
    selection?.onExport?.();
  };

  const runAddToPlaylist = async (p: Playlist) => {
    if (addingId) return;
    setAddingId(p.id);
    setError(null);
    const prior = landed.current.get(p.id);
    const start = prior?.ids === trackIdsKey ? prior.count : 0;
    let done = start;
    try {
      for (const batch of addBatches(trackIds.slice(start))) {
        await api.addPlaylistTracks(p.id, batch);
        done += batch.length;
        landed.current.set(p.id, { ids: trackIdsKey, count: done });
      }
    } catch (err) {
      const message = errorMessage(err, "Add failed.");
      setError(
        done > 0
          ? `${message} ${done} of ${trackIds.length} were added; click again to add the rest.`
          : message,
      );
    } finally {
      setAddingId(null);
    }
    if (done === start) return;
    // An add can finish after Escape, an outside click, or navigation.
    if (menuClosed.current) {
      void reloadPlaylists();
      return;
    }
    playlistsChanged.current = true;
    if (done === trackIds.length) setAddedIds((prev) => new Set(prev).add(p.id));
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

  const showEdit = !many && actions.editMetadata && !!onEdit;
  const showMove = !many && actions.moveToAlbum && !!onMoveToAlbum;
  const showDelete = !many && actions.deleteOwnUpload;
  const showRemove = !many && actions.adminRemove;
  const showRows = !many && (actions.viewAlbum || !!onInfo);

  return createPortal(
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      aria-labelledby={titleId}
      tabIndex={-1}
      data-pointer-open={pointerOpen || undefined}
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
      onKeyDown={onKeyDown}
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
      {many ? (
        <SelectionHeader tracks={many} titleId={titleId} />
      ) : (
        <TrackHeader track={track} titleId={titleId} />
      )}

      <div className="ctx-tiles" data-menu-row="">
        <button
          type="button"
          role="menuitem"
          className="ctx-item ctx-tile"
          onClick={runPlay}
          disabled={!canPlay}
          title={canPlay ? undefined : "No longer on TIDAL"}
        >
          <PlayIcon className="size-4" />
          <span>Play</span>
        </button>
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={fav === "all" ? true : fav === "some" ? "mixed" : false}
          className="ctx-item ctx-tile"
          onClick={() => void runFav()}
        >
          <HeartIcon className="size-4" />
          <span>Favorite</span>
        </button>
        {!many && onShare && actions.share && (
          <button
            type="button"
            role="menuitem"
            className="ctx-item ctx-tile"
            onClick={runShare}
          >
            <ShareIcon className="size-4" />
            <span>Share</span>
          </button>
        )}
        {!many && (
          <button
            type="button"
            role="menuitem"
            className="ctx-item ctx-tile"
            onClick={() => void runDownload()}
            disabled={downloading || !actions.download}
            title={actions.download ? undefined : "No longer on TIDAL"}
          >
            <ArrowDownTrayIcon className="size-4" />
            <span>{downloading ? "Preparing…" : "Download"}</span>
          </button>
        )}
        {many && selection?.onExport && (
          <button
            type="button"
            role="menuitem"
            className="ctx-item ctx-tile"
            onClick={runExport}
            disabled={!!selection.exportDisabledReason}
            title={selection.exportDisabledReason}
          >
            <ArrowDownTrayIcon className="size-4" />
            <span>Export</span>
          </button>
        )}
      </div>

      {showRows && (
        <>
          <div className="ctx-sep" />
          {actions.viewAlbum && (
            <button
              type="button"
              role="menuitem"
              className="ctx-item"
              onClick={() => void runViewAlbum()}
              disabled={viewingAlbum}
            >
              <DiscIcon className="size-3.5" />
              <span>{viewingAlbum ? "Opening album..." : "View album"}</span>
            </button>
          )}
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
        </>
      )}

      <div className="ctx-sep" />
      <div id={playlistsHeadingId} className="ctx-heading">
        {many ? `Add ${many.length} tracks to playlist` : "Add to playlist"}
      </div>
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
        <div className="ctx-scroll" role="group" aria-labelledby={playlistsHeadingId}>
          {editablePlaylists.map((p) => {
            const added = addedIds.has(p.id);
            const busy = addingId === p.id;
            // Your own playlists go unlabelled; a shared one names its owner.
            const owner = p.effective_role !== "owner" ? p.owner_name : undefined;
            return (
              <button
                key={p.id}
                type="button"
                role="menuitem"
                className="ctx-item ctx-pl"
                onClick={() => void runAddToPlaylist(p)}
                disabled={busy || added || !canAddToPlaylists}
              >
                <CoverArt
                  className="ctx-pl-art"
                  src={playlistArtUrl(p, THUMB_SIZE)}
                  label={p.name}
                />
                <span className="ctx-pl-name">{p.name}</span>
                {/* Keeps the name and owner apart in the accessible name;
                    a flex container doesn't render it. */}
                {" "}
                <span className="ctx-pl-end">
                  {busy ? (
                    <span className="mono">…</span>
                  ) : added ? (
                    <CheckIcon className="size-3.5" />
                  ) : (
                    <>
                      {owner && <span className="ctx-pl-owner">{owner}</span>}
                      <PlusIcon className="ctx-pl-plus size-3.5" />
                    </>
                  )}
                </span>
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

      {(showEdit || showMove || showDelete || showRemove) && (
        <>
          <div className="ctx-sep" />
          <div className="ctx-foot" data-menu-row="">
            {showEdit && (
              <button
                type="button"
                role="menuitem"
                className="ctx-item"
                aria-label="Edit metadata"
                onClick={runEdit}
              >
                <PencilSquareIcon className="size-3.5" />
                <span>Edit</span>
              </button>
            )}
            {showMove && (
              <button
                type="button"
                role="menuitem"
                className="ctx-item"
                aria-label="Move to album…"
                onClick={runMoveToAlbum}
              >
                <FolderInputIcon className="size-3.5" />
                <span>Move</span>
              </button>
            )}
            {showDelete && (
              <button
                type="button"
                role="menuitem"
                className="ctx-item ctx-danger"
                aria-label="Delete from my library"
                onClick={() => void runDelete()}
                disabled={deleting}
              >
                <TrashIcon className="size-3.5" />
                <span>{deleting ? "Deleting…" : "Delete"}</span>
              </button>
            )}
            {showRemove && (
              <button
                type="button"
                role="menuitem"
                className="ctx-item ctx-danger"
                aria-label="Remove from library"
                onClick={() => void runAdminDelete()}
                disabled={deleting}
              >
                <TrashIcon className="size-3.5" />
                <span>{deleting ? "Removing…" : "Remove"}</span>
              </button>
            )}
          </div>
        </>
      )}
    </div>,
    document.body,
  );
}

/** The track the menu acts on: its cover, title, and artist · album. */
function TrackHeader({ track, titleId }: { track: TrackListItem; titleId: string }) {
  const title = displayText(track.title);
  const sub = [
    displayText(track.artist, "Unknown artist"),
    track.album_title ? displayText(track.album_title) : "",
  ].filter(Boolean).join(" · ");
  return (
    <div className="ctx-head">
      <CoverArt
        className="ctx-head-art"
        src={trackCoverUrl(track, THUMB_SIZE)}
        label={track.album_title || track.title}
      />
      <div className="ctx-head-text">
        <div id={titleId} className="ctx-head-title" title={title}>{title}</div>
        <div className="ctx-head-sub" title={sub}>{sub}</div>
      </div>
    </div>
  );
}

/** A selection: its covers stacked, how many tracks, and their artists. */
function SelectionHeader({ tracks, titleId }: { tracks: TrackListItem[]; titleId: string }) {
  const covers = selectionCovers(tracks);
  const artists = selectionArtists(tracks);
  return (
    <div className="ctx-head">
      <div className="ctx-stack" style={{ width: 32 + 12 * (covers.length - 1) }}>
        {covers.map((t) => (
          <CoverArt
            key={t.id}
            className="ctx-stack-art"
            src={trackCoverUrl(t, THUMB_SIZE)}
            label={t.album_title || t.title}
          />
        ))}
      </div>
      <div className="ctx-head-text">
        <div id={titleId} className="ctx-head-title">{tracks.length} tracks</div>
        {artists && <div className="ctx-head-sub" title={artists}>{artists}</div>}
      </div>
    </div>
  );
}

export { useTrackContextMenu, useContextMenuClickGuard } from "../lib/useTrackContextMenu";
