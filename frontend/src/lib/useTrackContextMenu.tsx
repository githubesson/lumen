import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { TrackListItem } from "../api";
import { canShareTrack } from "./track";
import { useShare } from "../context/Share";
import { useTrackInfo } from "../context/TrackInfo";

// The menu is its own chunk. It's fetched once a menu can be opened and
// only shown once loaded: while the chunk is still out, the menu's own
// dismiss listeners don't exist, so a request is held here instead.
let menuModule: Promise<typeof import("../components/TrackContextMenu")> | null = null;
let menuLoaded = false;
function loadTrackContextMenu() {
  menuModule ??= import("../components/TrackContextMenu").then(
    (module) => {
      menuLoaded = true;
      return module;
    },
    (error: unknown) => {
      menuModule = null;
      throw error;
    },
  );
  return menuModule;
}
const TrackContextMenu = lazy(loadTrackContextMenu);

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
    onPlay?: () => void;
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

  useEffect(() => {
    void loadTrackContextMenu().catch(() => {});
  }, []);

  // Bumped by each open request and by a dismissal gesture while the chunk
  // loads, so only the latest undismissed request opens.
  const openRequestRef = useRef(0);
  const open = useCallback((next: NonNullable<typeof state>) => {
    const request = ++openRequestRef.current;
    if (menuLoaded) {
      setState(next);
      return;
    }
    const dismiss = () => {
      if (openRequestRef.current === request) openRequestRef.current += 1;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    const stopWatching = () => {
      window.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", dismiss);
    };
    window.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", dismiss);
    loadTrackContextMenu().then(
      () => {
        stopWatching();
        if (openRequestRef.current === request) setState(next);
      },
      stopWatching,
    );
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
      } = {},
    ) =>
      (e: { preventDefault: () => void; clientX: number; clientY: number }) => {
        e.preventDefault();
        open({
          track,
          x: e.clientX,
          y: e.clientY,
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
        });
      },
    [open, trackInfo, share],
  );

  const close = useCallback(() => {
    openRequestRef.current += 1;
    setState(null);
  }, []);

  const menu = state ? (
    <Suspense fallback={null}><TrackContextMenu
      track={state.track}
      x={state.x}
      y={state.y}
      queue={state.queue}
      onPlay={state.onPlay}
      onEdit={state.onEdit}
      onMoveToAlbum={state.onMoveToAlbum}
      onInfo={state.onInfo}
      onShare={state.onShare}
      onClose={close}
    /></Suspense>
  ) : null;

  return { bind, menu, close, isOpen: state !== null };
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
