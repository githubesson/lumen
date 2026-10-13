import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { TrackListItem } from "../api";
import type { TrackMenuSelection } from "../components/TrackContextMenu";
import { canShareTrack } from "./track";
import { lazyChunk, openWhenLoaded } from "./lazyChunk";
import { useShare } from "../context/Share";
import { useTrackInfo } from "../context/TrackInfo";

// The menu is its own chunk, fetched once a menu can be opened; opens go
// through `openWhenLoaded` so a dismissal while it loads is honored.
const menuChunk = lazyChunk(() => import("../components/TrackContextMenu"));
const TrackContextMenu = lazy(menuChunk.load);

/** What `bind` needs from the right-click: a React mouse event fits. */
export interface ContextMenuEvent {
  preventDefault: () => void;
  clientX: number;
  clientY: number;
  /** The right-clicked element; focus goes back to it when the menu closes. */
  currentTarget?: EventTarget | null;
  nativeEvent?: Event;
}

/**
 * Chromium sends a keyboard-opened context menu (the Menu key, Shift+F10) as
 * a PointerEvent with no pointer type. Anything else counts as the pointer.
 */
function openedByKeyboard(e: ContextMenuEvent): boolean {
  return typeof PointerEvent !== "undefined" &&
    e.nativeEvent instanceof PointerEvent &&
    e.nativeEvent.pointerType === "";
}

/**
 * Convenience hook that packages up the state + event handlers for binding
 * a right-click menu to any element that renders a track. Returns:
 *
 *   - `bind(track, { queue?, onEdit?, selection? })` — spread the return
 *     value onto the element's `onContextMenu` to open the menu. Pass the
 *     list's `selection` when the row is part of one, and the menu acts on
 *     every selected track.
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
    /** Which open this is. Keys the menu, so every open starts fresh. */
    key: number;
    track: TrackListItem;
    x: number;
    y: number;
    queue?: TrackListItem[];
    onPlay?: () => void;
    onEdit?: () => void;
    onMoveToAlbum?: () => void;
    onInfo?: () => void;
    onShare?: () => void;
    selection?: TrackMenuSelection;
    anchor?: Element | null;
    byKeyboard?: boolean;
  } | null>(null);

  // Default onInfo wiring: every right-click menu gets "Song info" as long
  // as a TrackInfoProvider is mounted (it is in main.tsx). Callers can still
  // override per-call via opts.onInfo — useful if a specific surface wants
  // a different dialog or a no-op.
  const trackInfo = useTrackInfo();
  const share = useShare();

  useEffect(() => {
    void menuChunk.load().catch(() => {});
  }, []);

  const cancelPendingOpen = useRef<() => boolean>(() => false);
  useEffect(() => () => {
    cancelPendingOpen.current();
  }, []);
  // A bind while the menu is open (a long-press on Android, where no
  // mousedown closes it first) opens a new menu rather than re-targeting the
  // old one, so nothing it did for one track or selection, like how far a
  // batched add got, carries over to the next.
  const opens = useRef(0);
  const open = useCallback((next: Omit<NonNullable<typeof state>, "key">) => {
    cancelPendingOpen.current();
    cancelPendingOpen.current = openWhenLoaded(menuChunk, () => {
      opens.current += 1;
      setState({ ...next, key: opens.current });
    });
  }, []);

  const bind = useCallback(
    (
      track: TrackListItem,
      opts: {
        queue?: TrackListItem[];
        onPlay?: () => void;
        onEdit?: () => void;
        onMoveToAlbum?: () => void;
        onInfo?: () => void;
        onShare?: () => void;
        selection?: TrackMenuSelection;
      } = {},
    ) =>
      (e: ContextMenuEvent) => {
        e.preventDefault();
        open({
          track,
          x: e.clientX,
          y: e.clientY,
          // Read now: React resets currentTarget once the handler returns.
          anchor: e.currentTarget instanceof Element ? e.currentTarget : null,
          byKeyboard: openedByKeyboard(e),
          queue: opts.queue,
          onPlay: opts.onPlay,
          onEdit: opts.onEdit,
          onMoveToAlbum: opts.onMoveToAlbum,
          onInfo:
            opts.onInfo ??
            (trackInfo ? () => trackInfo.open(track.id) : undefined),
          onShare:
            opts.onShare ??
            (share && canShareTrack(track) ? () => share.open(track.id) : undefined),
          selection: opts.selection,
        });
      },
    [open, trackInfo, share],
  );

  const close = useCallback(() => {
    cancelPendingOpen.current();
    setState(null);
  }, []);

  const menu = state ? (
    <Suspense key={state.key} fallback={null}><TrackContextMenu
      track={state.track}
      x={state.x}
      y={state.y}
      queue={state.queue}
      onPlay={state.onPlay}
      onEdit={state.onEdit}
      onMoveToAlbum={state.onMoveToAlbum}
      onInfo={state.onInfo}
      onShare={state.onShare}
      selection={state.selection}
      anchor={state.anchor}
      byKeyboard={state.byKeyboard}
      onClose={close}
    /></Suspense>
  ) : null;

  return { bind, menu, close, isOpen: state !== null };
}

/**
 * For a selectable track table: what a right-click on the row with `id`
 * acts on. A row inside a selection of two or more opens the menu for the
 * whole selection; any other row opens its own, and the selection stays as
 * it is. The returned function keeps its identity and reads the latest
 * selection, so memoized rows don't re-render when it changes.
 */
export function useMenuSelection({
  selectionMode,
  selectedIds,
  tracks,
  onExport,
  exportDisabledReason,
}: {
  selectionMode: boolean;
  selectedIds: ReadonlySet<string>;
  /** The selected tracks, in list order. */
  tracks: TrackListItem[];
  onExport?: () => void;
  exportDisabledReason?: string;
}): (id: string) => TrackMenuSelection | undefined {
  const latest = useRef<(id: string) => TrackMenuSelection | undefined>(() => undefined);
  // Refreshed from an effect: every reader is a right-click handler.
  useEffect(() => {
    latest.current = (id) =>
      selectionMode && selectedIds.size > 1 && selectedIds.has(id)
        ? { tracks, onExport, exportDisabledReason }
        : undefined;
  }, [selectionMode, selectedIds, tracks, onExport, exportDisabledReason]);
  return useCallback((id: string) => latest.current(id), []);
}

/**
 * For a list whose rows act on a single click, like the queue: while a
 * context menu is open, the next click in the list only closes the menu. The
 * click is swallowed, so it can't also play the row under it. Spread the
 * handlers on the list's container. Pass `closeMenu` when the container stops
 * mousedown from reaching the menu's own outside-click listener.
 */
export function useContextMenuClickGuard(closeMenu?: () => void) {
  const swallowClick = useRef(false);
  // A menu rendered as a React child of the list passes its own clicks
  // through these handlers too; leave those alone.
  const inMenu = (e: React.SyntheticEvent) =>
    e.target instanceof Element && !!e.target.closest(".ctx-menu");
  // Capture phase runs before the menu's window listener closes it, so the
  // menu is still in the document here.
  const onMouseDownCapture = (e: React.MouseEvent) => {
    if (inMenu(e)) return;
    const menuOpen = !!document.querySelector(".ctx-menu");
    swallowClick.current = menuOpen && e.button === 0;
    if (swallowClick.current) {
      // Only this gesture's click: if it's released elsewhere (no click
      // here), don't let the flag eat a later one, e.g. a keyboard Enter.
      window.addEventListener(
        "mouseup",
        () => window.setTimeout(() => (swallowClick.current = false), 0),
        { once: true, capture: true },
      );
    }
    if (menuOpen) closeMenu?.();
  };
  const onClickCapture = (e: React.MouseEvent) => {
    if (inMenu(e) || !swallowClick.current) return;
    swallowClick.current = false;
    e.preventDefault();
    e.stopPropagation();
  };
  return { onMouseDownCapture, onClickCapture };
}
